'use strict';
// T878 — Server-Only Automatic Plan-Activation Engine Sync & Controlled Cohort Renewal.
// Called automatically by App Coach right after any plan activation (Pegar JSON, import,
// manual, template, duplicate, AI draft_approved) via POST /api/autonomous-progression-trigger?action=plan-activation-sync.
//
// Security invariants:
// - Verifies Coach Firebase ID token server-side; zero admin privileges in browser.
// - Never enables global NUMERIC_APPLY_ENABLED; respects all T876 commercial boundaries
//   (strictly the 25 confirmed active clients; 4 inactive / 39 unconfirmed never authorized).
// - Bundles .release/commercial-roster-t876.json via literal require() so Vercel NFT
//   statically traces it; fails closed if absent or invalid.
// - Mandatory runtime shard sync: NEVER re-arms Firestore fences unless syncCohortRuntimeEnv
//   is configured, executes, and verifies shard alignment (fail-closed BEFORE STOP if absent,
//   and stays STOPPED if shard sync fails).
// - Never touches unaffected cohorts.

const crypto = require('node:crypto');
const C = require('./_numericPilotContract');

const RELEASE_SCHEMA = 'vdsen-autonomous-release-v1';
const LEDGER_SCHEMA = 'vdsen-numeric-operations-ledger-v1';
const MAX_COHORT_CLIENTS = C.COHORT_MAX_CLIENTS || 10;
const ENV_SHARD_MAX_CLIENTS = 5;
const ENV_SHARD_MAX_BYTES = 3900;

function _data(snap) {
  return snap && snap.exists === true ? snap.data() : null;
}

function _sameSorted(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function validateCommercialRoster(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('COMMERCIAL_ROSTER_INVALID');
  }
  if (raw.schema !== 'vdsen-commercial-roster-v1') throw new Error('COMMERCIAL_ROSTER_INVALID_SCHEMA');
  if (raw.firebaseProject && raw.firebaseProject !== 'vdsen-ecosistema') throw new Error('COMMERCIAL_ROSTER_PROJECT_MISMATCH');
  if (raw.confirmedBy !== undefined && raw.confirmedBy !== 'owner') throw new Error('COMMERCIAL_ROSTER_UNAPPROVED');
  if (raw.confirmedAt !== undefined && (typeof raw.confirmedAt !== 'string' || !Number.isFinite(Date.parse(raw.confirmedAt)))) {
    throw new Error('COMMERCIAL_ROSTER_INVALID_CONFIRMED_AT');
  }
  const activeUids = Array.isArray(raw.activeUids) ? raw.activeUids : null;
  if (!activeUids || activeUids.length < 1) throw new Error('COMMERCIAL_ROSTER_EMPTY_ACTIVE_UIDS');
  const activeSet = new Set();
  for (const uid of activeUids) {
    if (typeof uid !== 'string' || uid.trim().length < 8 || uid !== uid.trim()) throw new Error('COMMERCIAL_ROSTER_INVALID_UID');
    if (activeSet.has(uid)) throw new Error('COMMERCIAL_ROSTER_DUPLICATE_ACTIVE_UID');
    activeSet.add(uid);
  }
  const inactiveUids = Array.isArray(raw.inactiveUids) ? raw.inactiveUids : [];
  const inactiveSet = new Set();
  for (const uid of inactiveUids) {
    if (typeof uid !== 'string' || uid.trim().length < 8 || uid !== uid.trim()) throw new Error('COMMERCIAL_ROSTER_INVALID_INACTIVE_UID');
    if (inactiveSet.has(uid)) throw new Error('COMMERCIAL_ROSTER_DUPLICATE_INACTIVE_UID');
    if (activeSet.has(uid)) throw new Error('COMMERCIAL_ROSTER_OVERLAP');
    inactiveSet.add(uid);
  }
  return {
    schema: raw.schema,
    firebaseProject: raw.firebaseProject || 'vdsen-ecosistema',
    confirmedBy: raw.confirmedBy || 'owner',
    confirmedAt: raw.confirmedAt || null,
    activeUids: activeUids.slice(),
    inactiveUids: [...inactiveSet],
    activeSet,
    inactiveSet,
  };
}

// Literal require() guarantees Vercel NFT traces and bundles the reviewed T876 commercial roster.
function loadBundledCommercialRoster() {
  const bundled = require('../.release/commercial-roster-t876.json');
  return validateCommercialRoster(bundled);
}

function loadCommercialRosterSafe(customRoster) {
  if (customRoster === null) throw new Error('COMMERCIAL_ROSTER_MISSING');
  if (typeof customRoster === 'function') {
    const loaded = customRoster();
    if (!loaded) throw new Error('COMMERCIAL_ROSTER_MISSING');
    return validateCommercialRoster(loaded);
  }
  if (customRoster !== undefined) {
    return validateCommercialRoster(customRoster);
  }
  return loadBundledCommercialRoster();
}

function shardKeysForCohort(cohortId, windowCount) {
  const m = /^cohort-(\d+)$/.exec(String(cohortId || ''));
  if (!m) return null;
  const idx = parseInt(m[1], 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > 10) return null;
  const startShard = (idx - 1) * 2 + 1;
  const needed = Math.max(1, Math.ceil(windowCount / ENV_SHARD_MAX_CLIENTS));
  if (needed > 2) return null;
  const keys = [];
  for (let i = 0; i < needed; i++) keys.push('VDSEN_NUMERIC_COHORT_' + (startShard + i));
  return keys;
}

// Server-only Vercel cohort shard synchronizer WITH mandatory served-deployment verification
// and automatic project-env rollback on failure (prevents silent poisoning of future deployments).
// Returns null when scoped credentials are absent (fail-closed BEFORE any Firestore fence is touched).
function computeServedCohortDigest(windows) {
  const canonical = (Array.isArray(windows) ? windows : [])
    .map(w => ({
      uidHash: crypto.createHash('sha256').update(String(w.uid || '')).digest('hex'),
      planId: String(w.planId || ''),
      pidsHash: String(w.pidsHash || ''),
      pidCount: Number(w.pidCount || 0),
      operationId: String(w.operationId || ''),
      runtimeSha: String(w.runtimeSha || ''),
      expiresAt: String(w.expiresAt || ''),
    }))
    .sort((a, b) => a.uidHash.localeCompare(b.uidHash));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function buildServedCohortProbePayload(env, cohortId) {
  env = env || process.env;
  const matched = [];
  for (let s = 1; s <= 20; s++) {
    const raw = env['VDSEN_NUMERIC_COHORT_' + s];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
      for (const item of arr) {
        if (item && item.cohortId === cohortId) matched.push(item);
      }
    } catch (_) { /* ignore malformed shard */ }
  }
  return {
    schema: 'vdsen-served-cohort-probe-v1',
    cohortId,
    deploymentId: env.VERCEL_DEPLOYMENT_ID || null,
    runtimeSha: env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA || env.VERCEL_GIT_COMMIT_SHA || null,
    windowCount: matched.length,
    windowsDigest: computeServedCohortDigest(matched),
  };
}

function createVercelCohortShardSyncer(env, fetcher) {
  env = env || process.env;
  const token = typeof env.VERCEL_TOKEN === 'string' ? env.VERCEL_TOKEN.trim() : '';
  const projectId = typeof env.VERCEL_PROJECT_ID === 'string' ? env.VERCEL_PROJECT_ID.trim() : '';
  const orgId = typeof env.VERCEL_ORG_ID === 'string' ? env.VERCEL_ORG_ID.trim() : '';
  if (!token || !projectId || !orgId) return null;
  const doFetch = fetcher || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;

  return async function syncCohortRuntimeEnv(payload) {
    const qs = 'teamId=' + encodeURIComponent(orgId);
    const envBaseUrl = 'https://api.vercel.com/v10/projects/' + encodeURIComponent(projectId) + '/env';
    const prevSnapshot = [];

    const rollbackShards = async () => {
      for (const prev of prevSnapshot) {
        try {
          if (prev.hadPrevious) {
            await doFetch(envBaseUrl + '?upsert=true&' + qs, {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: prev.key, value: prev.value, type: 'plain', target: ['production'] }),
              signal: AbortSignal.timeout(10000),
            });
          } else if (prev.createdId) {
            await doFetch(envBaseUrl + '/' + encodeURIComponent(prev.createdId) + '?' + qs, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer ' + token },
              signal: AbortSignal.timeout(10000),
            });
          }
        } catch (_) { /* best-effort rollback */ }
      }
    };

    try {
      const windows = Array.isArray(payload && payload.windows) ? payload.windows : [];
      if (!windows.length || windows.length > MAX_COHORT_CLIENTS) {
        return { ok: false, verified: false, servedDeploymentVerified: false, errorCode: 'INVALID_SHARD_WINDOWS' };
      }
      const shardKeys = shardKeysForCohort(payload.cohortId, windows.length);
      if (!shardKeys) return { ok: false, verified: false, servedDeploymentVerified: false, errorCode: 'UNSUPPORTED_COHORT_SHARD_ID' };

      const shards = [];
      for (let i = 0; i < shardKeys.length; i++) {
        const slice = windows.slice(i * ENV_SHARD_MAX_CLIENTS, (i + 1) * ENV_SHARD_MAX_CLIENTS);
        const serialized = JSON.stringify(slice);
        if (Buffer.byteLength(serialized, 'utf8') > ENV_SHARD_MAX_BYTES) {
          return { ok: false, verified: false, servedDeploymentVerified: false, errorCode: 'SHARD_PAYLOAD_EXCEEDS_LIMIT' };
        }
        shards.push({ key: shardKeys[i], value: serialized, expectedSlice: slice });
      }

      // Step 1: Capture previous project env values for rollback safety
      const preResp = await doFetch(envBaseUrl + '?' + qs, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000),
      });
      const preData = preResp && preResp.ok ? await preResp.json().catch(() => null) : null;
      const preEnvs = Array.isArray(preData && preData.envs) ? preData.envs : [];

      // Step 2: Upsert ONLY the affected cohort shard(s)
      for (const sh of shards) {
        const old = preEnvs.find(e => e && e.key === sh.key && Array.isArray(e.target) && e.target.includes('production'));
        const snapEntry = { key: sh.key, hadPrevious: !!old, value: old ? old.value : null, createdId: null };
        const resp = await doFetch(envBaseUrl + '?upsert=true&' + qs, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: sh.key, value: sh.value, type: 'plain', target: ['production'] }),
          signal: AbortSignal.timeout(10000),
        });
        if (!resp || !resp.ok) {
          await rollbackShards();
          return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'VERCEL_ENV_UPSERT_FAILED' };
        }
        const created = await resp.json().catch(() => null);
        if (created && created.created && created.created.id) snapEntry.createdId = created.created.id;
        prevSnapshot.push(snapEntry);
      }

      // Step 3: Trigger a new deployment pinned to runtimeSha so the updated shard enters the served runtime
      const deployResp = await doFetch('https://api.vercel.com/v13/deployments?' + qs, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'vdsen-ecosistema',
          project: projectId,
          target: 'production',
          gitSource: { type: 'github', ref: 'codex/client-app-next', sha: payload.runtimeSha },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!deployResp || !deployResp.ok) {
        await rollbackShards();
        return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'VERCEL_DEPLOYMENT_CREATE_FAILED' };
      }
      const dep = await deployResp.json().catch(() => null);
      const deploymentId = dep && (dep.id || dep.uid);
      const deploymentUrl = dep && dep.url ? ('https://' + String(dep.url).replace(/^https?:\/\//, '')) : null;
      if (!deploymentId || !deploymentUrl || dep.readyState === 'ERROR' || dep.readyState === 'CANCELED') {
        await rollbackShards();
        return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'VERCEL_DEPLOYMENT_NOT_READY' };
      }

      // Step 4: Verify the ACTUALLY SERVED production deployment reports the exact expected windowsDigest
      // AND verify the production alias actually points to deploymentId (prevents READY-but-unserved false positives).
      const aliasResp = await doFetch('https://api.vercel.com/v2/aliases/vdsen-ecosistema.vercel.app?' + qs, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000),
      });
      if (!aliasResp || !aliasResp.ok) {
        await rollbackShards();
        return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'PRODUCTION_ALIAS_CHECK_FAILED' };
      }
      const aliasData = await aliasResp.json().catch(() => null);
      const liveAliasDeploymentId = aliasData && (aliasData.deploymentId || (aliasData.deployment && aliasData.deployment.id));
      if (liveAliasDeploymentId !== deploymentId) {
        await rollbackShards();
        return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'DEPLOYMENT_NOT_SERVING_PRODUCTION_ALIAS' };
      }

      const expectedDigest = computeServedCohortDigest(windows);
      const probeUrl = deploymentUrl + '/api/autonomous-progression-trigger?check=cohort-shard&cohortId=' + encodeURIComponent(payload.cohortId);
      const probeHeaders = {};
      if (payload.authHeader) probeHeaders.Authorization = payload.authHeader;
      const probeResp = await doFetch(probeUrl, {
        method: 'GET',
        headers: probeHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (!probeResp || !probeResp.ok) {
        await rollbackShards();
        return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'SERVED_DEPLOYMENT_PROBE_FAILED' };
      }
      const probeData = await probeResp.json().catch(() => null);
      const exactServed = !!(
        probeData &&
        probeData.schema === 'vdsen-served-cohort-probe-v1' &&
        probeData.cohortId === payload.cohortId &&
        probeData.runtimeSha === payload.runtimeSha &&
        probeData.windowCount === windows.length &&
        probeData.windowsDigest === expectedDigest
      );
      if (!exactServed) {
        await rollbackShards();
        return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'SERVED_DEPLOYMENT_SHARD_MISMATCH' };
      }

      return { ok: true, verified: true, servedDeploymentVerified: true, deploymentId, deploymentUrl, windowsDigest: expectedDigest, shardKeys };
    } catch (_) {
      await rollbackShards();
      return { ok: false, verified: false, servedDeploymentVerified: false, rolledBack: true, errorCode: 'VERCEL_SHARD_SYNC_EXCEPTION' };
    }
  };
}

function validateNewPlanForEngine(plan) {
  const reasons = [];
  if (!plan || typeof plan !== 'object') return { ok: false, reasons: ['PLAN_NOT_FOUND'], pids: [], pidCount: 0, pidsHash: null };
  // T546 fail-closed: updatedAt must be a valid ISO string (never fall back to createdAt)
  if (typeof plan.updatedAt !== 'string' || !Number.isFinite(Date.parse(plan.updatedAt))) {
    reasons.push('PLAN_UPDATED_AT_MISSING_OR_INVALID');
  }
  const seen = new Set();
  let duplicatePids = 0;
  let missingPidExercises = 0;
  const days = Array.isArray(plan.days) ? plan.days : [];
  if (!days.length) reasons.push('PLAN_DAYS_EMPTY');
  for (const d of days) {
    for (const ex of Array.isArray(d && d.exercises) ? d.exercises : []) {
      if (!ex || ex.exerciseType === 'cardio' || ex.tipo === 'cardio') continue;
      const pid = typeof ex.prescriptionExerciseId === 'string' ? ex.prescriptionExerciseId.trim() : '';
      if (!pid) {
        missingPidExercises++;
      } else if (seen.has(pid)) {
        duplicatePids++;
      } else {
        seen.add(pid);
      }
    }
  }
  if (missingPidExercises > 0) reasons.push('MISSING_PRESCRIPTION_EXERCISE_ID');
  if (duplicatePids > 0) reasons.push('DUPLICATE_PRESCRIPTION_EXERCISE_ID');
  const pids = [...seen].sort();
  if (pids.length === 0) reasons.push('NO_STRENGTH_PIDS');
  return {
    ok: reasons.length === 0,
    reasons,
    pids,
    pidCount: pids.length,
    pidsHash: pids.length ? C.computePidsHash(pids) : null,
  };
}

function resolveCohortIdForClient(clientId, roster, liveCohortDocs) {
  for (const [cid, docData] of Object.entries(liveCohortDocs || {})) {
    const winMap = docData && docData.windows && typeof docData.windows === 'object' ? docData.windows : null;
    if (winMap && Object.prototype.hasOwnProperty.call(winMap, clientId)) return cid;
  }
  const idx = roster.activeUids.indexOf(clientId);
  if (idx < 0) return null;
  const num = Math.floor(idx / MAX_COHORT_CLIENTS) + 1;
  return 'cohort-' + String(num).padStart(2, '0');
}

function buildRenewalOperationId(cohortId, clientId, planId, pidsHash) {
  const digest = crypto.createHash('sha256')
    .update(String(cohortId) + '|' + String(clientId) + '|' + String(planId) + '|' + String(pidsHash))
    .digest('hex')
    .slice(0, 12);
  return ('t878-renew-' + cohortId + '-' + digest).slice(0, 80);
}

function makeHandler(deps) {
  deps = deps || {};
  return async function handler(req, res) {
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

    const authHeader = String((req.headers && req.headers.authorization) || '').trim();
    const tokenMatch = /^Bearer\s+(\S+)$/.exec(authHeader);
    if (!tokenMatch) return res.status(401).json({ error: 'AUTH_MISSING' });

    let identity;
    try {
      identity = await deps.verifyIdToken(tokenMatch[1]);
    } catch (_) {
      return res.status(401).json({ error: 'AUTH_INVALID' });
    }
    const coachUid = identity && typeof identity.uid === 'string' ? identity.uid : '';
    if (!coachUid) return res.status(401).json({ error: 'AUTH_INVALID' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
    if (!clientId || !planId) return res.status(400).json({ error: 'CLIENT_AND_PLAN_REQUIRED' });

    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'ADMIN_DB_UNAVAILABLE' });

    const clock = deps.clock || (() => new Date().toISOString());
    const nowIso = clock();
    const nowMs = Date.parse(nowIso);

    let roster;
    try {
      roster = loadCommercialRosterSafe(deps.commercialRoster);
    } catch (err) {
      return res.status(500).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'RENEWAL_FAILED',
        engineState: 'COACH_INTERVENTION_REQUIRED',
        commercialAuthorized: false,
        numericApplyAuthorized: false,
        renewed: false,
        errorCode: (err && err.message && err.message.startsWith('COMMERCIAL_ROSTER_'))
          ? err.message
          : 'COMMERCIAL_ROSTER_UNAVAILABLE',
      });
    }

    // 1. Verify Coach, Client ownership, and activePlanId in Firestore
    const coachRef = db.collection('coaches').doc(coachUid);
    const clientRef = db.collection('clients').doc(clientId);
    const planRef = db.collection('plans').doc(planId);
    const [coachSnap, clientSnap, planSnap] = await Promise.all([coachRef.get(), clientRef.get(), planRef.get()]);
    const coachDoc = _data(coachSnap);
    const clientDoc = _data(clientSnap);
    const planDoc = _data(planSnap);

    if (!coachDoc) return res.status(403).json({ error: 'COACH_NOT_FOUND' });
    if (!clientDoc || clientDoc.coachId !== coachUid) return res.status(403).json({ error: 'CLIENT_NOT_OWNED' });
    if (!planDoc || planDoc.coachId !== coachUid || planDoc.clientId !== clientId) {
      return res.status(403).json({ error: 'PLAN_NOT_OWNED' });
    }
    if (clientDoc.activePlanId !== planId) {
      return res.status(409).json({
        status: 'PLAN_NOT_ACTIVE',
        engineState: 'BLOCKED_INCOMPATIBLE',
        commercialAuthorized: roster.activeSet.has(clientId),
        numericApplyAuthorized: false,
        renewed: false,
        errorCode: 'ACTIVE_PLAN_MISMATCH',
      });
    }

    // 2. Commercial boundary (T876): strictly the 25 confirmed active clients
    if (!roster.activeSet.has(clientId)) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'NOT_COMMERCIALLY_AUTHORIZED',
        engineState: 'BLOCKED_COMMERCIAL',
        commercialAuthorized: false,
        numericApplyAuthorized: false,
        renewed: false,
        cohortId: null,
        clientId,
        planId,
        pidsHash: null,
        pidCount: 0,
      });
    }

    // 3. Validate new plan integrity (T546 ISO updatedAt + unique non-cardio PIDs)
    const planCheck = validateNewPlanForEngine(planDoc);
    if (!planCheck.ok) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'BLOCKED_PLAN_INVALID',
        engineState: 'BLOCKED_INCOMPATIBLE',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        cohortId: null,
        clientId,
        planId,
        pidsHash: planCheck.pidsHash,
        pidCount: planCheck.pidCount,
        reasons: planCheck.reasons,
      });
    }

    // 4. Discover cohort & inspect live fences
    const liveCohortDocs = {};
    const candidateCohortIds = ['cohort-01', 'cohort-02', 'cohort-03'];
    for (const cid of candidateCohortIds) {
      const snap = await db.collection('releaseControl').doc('numericPilot_cohort_' + cid).get();
      const d = _data(snap);
      if (d) liveCohortDocs[cid] = d;
    }
    const cohortId = resolveCohortIdForClient(clientId, roster, liveCohortDocs);
    if (!cohortId) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'AUTHORIZATION_PENDING',
        engineState: 'AUTHORIZATION_PENDING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        cohortId: null,
        clientId,
        planId,
        pidsHash: planCheck.pidsHash,
        pidCount: planCheck.pidCount,
      });
    }

    const relRef = db.collection('releaseControl').doc('autonomousProgression_cohort_' + cohortId);
    const numRef = db.collection('releaseControl').doc('numericPilot_cohort_' + cohortId);
    const [relSnap, numSnap] = await Promise.all([relRef.get(), numRef.get()]);
    const relDoc = _data(relSnap);
    const numDoc = _data(numSnap);
    const coachCohorts = (coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.cohorts) || {};
    const ccDoc = coachCohorts[cohortId] || null;
    const prevWin = numDoc && numDoc.windows && numDoc.windows[clientId] ? numDoc.windows[clientId] : null;
    const previousPlanId = prevWin ? (prevWin.planId || null) : null;

    // 5. Idempotency check: if already exact-match & unexpired, no writes needed
    const expiresAt = (relDoc && relDoc.expiresAt) || (numDoc && numDoc.expiresAt) || deps.defaultExpiresAt || null;
    const startsAt = (relDoc && relDoc.startsAt) || (numDoc && numDoc.startsAt) || nowIso.replace(/\.\d{3}Z$/, 'Z');
    const runtimeSha = (numDoc && numDoc.runtimeSha) || deps.runtimeSha || process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA || null;
    const unexpired = typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > nowMs;

    const alreadyExact = !!(
      relDoc && relDoc.enabled === true &&
      numDoc && numDoc.enabled === true &&
      ccDoc && ccDoc.enabled === true &&
      prevWin && prevWin.enabled === true &&
      unexpired &&
      prevWin.planId === planId &&
      prevWin.pidsHash === planCheck.pidsHash &&
      prevWin.pidCount === planCheck.pidCount &&
      _sameSorted(prevWin.pids, planCheck.pids)
    );
    if (alreadyExact) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'AUTHORIZED_VERIFIED',
        engineState: 'MOTOR_INTEGRATED_AUTHORIZED',
        commercialAuthorized: true,
        numericApplyAuthorized: true,
        renewed: false,
        idempotent: true,
        cohortId,
        clientId,
        previousPlanId,
        planId,
        pidsHash: planCheck.pidsHash,
        pidCount: planCheck.pidCount,
        planUpdatedAt: planDoc.updatedAt,
        expiresAt,
      });
    }

    // 6. Drift detected -> Controlled server-side renewal ONLY if explicitly enabled
    const autoRenewalEnabled = deps.autoRenewalEnabled !== undefined
      ? deps.autoRenewalEnabled === true
      : process.env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED === 'true';

    if (!autoRenewalEnabled || !unexpired || !runtimeSha || !/^[0-9a-f]{40}$/.test(runtimeSha)) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'AUTHORIZATION_PENDING',
        engineState: 'AUTHORIZATION_PENDING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        cohortId,
        clientId,
        previousPlanId,
        planId,
        pidsHash: planCheck.pidsHash,
        pidCount: planCheck.pidCount,
        planUpdatedAt: planDoc.updatedAt,
        expiresAt: expiresAt || null,
      });
    }

    // MANDATORY FAIL-CLOSED GUARD: Never STOP or re-arm Firestore fences without a verified
    // runtime shard synchronizer. Prevents Firestore-vs-Vercel split-brain.
    if (typeof deps.syncCohortRuntimeEnv !== 'function') {
      return res.status(503).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'RENEWAL_BLOCKED_NO_SHARD_SYNC',
        engineState: 'AUTHORIZATION_PENDING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        cohortId,
        clientId,
        previousPlanId,
        planId,
        pidsHash: planCheck.pidsHash,
        pidCount: planCheck.pidCount,
        planUpdatedAt: planDoc.updatedAt,
        errorCode: 'RUNTIME_SHARD_SYNC_UNAVAILABLE',
      });
    }

    const renewalOpId = buildRenewalOperationId(cohortId, clientId, planId, planCheck.pidsHash);
    const opRef = db.collection('releaseControl').doc('numericPilot').collection('operations').doc(renewalOpId);

    try {
      // Step 6A: Concurrency guard — reserve renewal lock atomically
      // (IN_PROGRESS blocks overlapping concurrent callers; FAILED allows safe retry)
      const lockOutcome = await db.runTransaction(async (tx) => {
        const opSnap = await tx.get(opRef);
        const existingOp = _data(opSnap);
        if (existingOp && existingOp.status === 'IN_PROGRESS') {
          return { locked: false, reason: 'CONCURRENT_RENEWAL_IN_PROGRESS' };
        }
        if (existingOp && existingOp.status === 'RESERVED') {
          return { locked: false, reason: 'OPERATION_ALREADY_EXISTS' };
        }
        tx.set(opRef, {
          schema: LEDGER_SCHEMA,
          status: 'IN_PROGRESS',
          cohortId,
          operationId: renewalOpId,
          runtimeSha,
          clientId,
          planId,
          pidsHash: planCheck.pidsHash,
          startedAt: nowIso,
        });
        return { locked: true };
      });

      if (!lockOutcome.locked) {
        return res.status(409).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: 'RENEWAL_CONFLICT',
          engineState: lockOutcome.reason === 'CONCURRENT_RENEWAL_IN_PROGRESS' ? 'AUTHORIZATION_PREPARING' : 'COACH_INTERVENTION_REQUIRED',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          cohortId,
          clientId,
          previousPlanId,
          planId,
          pidsHash: planCheck.pidsHash,
          pidCount: planCheck.pidCount,
          errorCode: lockOutcome.reason,
        });
      }

      // Step 6B: STOP incompatible authorization ONLY for this cohort + verify STOPPED_VERIFIED
      const updatedCoachCohortsStopped = Object.assign({}, coachCohorts, {
        [cohortId]: Object.assign({}, ccDoc || { cohortId }, { enabled: false, stoppedAt: nowIso, stopReason: 'PLAN_CHANGE_RENEWAL:' + renewalOpId }),
      });
      await db.runTransaction(async (tx) => {
        tx.set(relRef, Object.assign({}, relDoc || { schema: RELEASE_SCHEMA, cohortId }, { enabled: false, stoppedAt: nowIso, stopReason: 'PLAN_CHANGE_RENEWAL:' + renewalOpId }));
        tx.set(numRef, Object.assign({}, numDoc || { schema: C.COHORT_SCHEMA, mode: 'NUMERIC_APPLY', cohortId }, { enabled: false, stoppedAt: nowIso, stopReason: 'PLAN_CHANGE_RENEWAL:' + renewalOpId }));
        tx.set(coachRef, { autoApplyCanary: Object.assign({}, coachDoc.autoApplyCanary || { enabled: true }, { cohorts: updatedCoachCohortsStopped }) }, { merge: true });
      });

      const [stopRelSnap, stopNumSnap, stopCoachSnap] = await Promise.all([relRef.get(), numRef.get(), coachRef.get()]);
      const stopRel = _data(stopRelSnap), stopNum = _data(stopNumSnap), stopCoach = _data(stopCoachSnap);
      const stopCc = stopCoach && stopCoach.autoApplyCanary && stopCoach.autoApplyCanary.cohorts && stopCoach.autoApplyCanary.cohorts[cohortId];
      const stoppedVerified = !!(
        (!stopRel || stopRel.enabled === false) &&
        (!stopNum || stopNum.enabled === false) &&
        (!stopCc || stopCc.enabled === false)
      );
      if (!stoppedVerified) {
        await opRef.set({ status: 'FAILED', errorCode: 'STOP_INCOMPLETE', failedAt: nowIso }, { merge: true });
        return res.status(500).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: 'RENEWAL_FAILED',
          engineState: 'COACH_INTERVENTION_REQUIRED',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          cohortId,
          clientId,
          planId,
          errorCode: 'STOP_INCOMPLETE',
        });
      }

      // Step 6C: Build updated windows for ONLY this cohort (strictly commercial roster activeSet, <= 10 cap)
      const existingWindows = (numDoc && numDoc.windows && typeof numDoc.windows === 'object') ? numDoc.windows : {};
      const nextWindows = {};
      for (const [uid, w] of Object.entries(existingWindows)) {
        if (!roster.activeSet.has(uid)) continue;
        if (uid === clientId) continue;
        nextWindows[uid] = Object.assign({}, w, {
          schema: C.COHORT_SCHEMA,
          mode: 'NUMERIC_APPLY',
          cohortId,
          enabled: true,
          runtimeSha,
          operationId: renewalOpId,
          startsAt,
          expiresAt,
        });
      }
      nextWindows[clientId] = {
        schema: C.COHORT_SCHEMA,
        mode: 'NUMERIC_APPLY',
        cohortId,
        enabled: true,
        uid: clientId,
        planId,
        pids: planCheck.pids,
        pidCount: planCheck.pidCount,
        pidsHash: planCheck.pidsHash,
        runtimeSha,
        operationId: renewalOpId,
        startsAt,
        expiresAt,
      };
      const cohortClientIds = Object.keys(nextWindows).sort();
      if (cohortClientIds.length < 1 || cohortClientIds.length > MAX_COHORT_CLIENTS) {
        await opRef.set({ status: 'FAILED', errorCode: 'COHORT_CAP_VIOLATED', failedAt: nowIso }, { merge: true });
        return res.status(500).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: 'RENEWAL_FAILED',
          engineState: 'COACH_INTERVENTION_REQUIRED',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          cohortId,
          clientId,
          planId,
          errorCode: 'COHORT_CAP_VIOLATED',
        });
      }
      const allCohortPids = [...new Set(Object.values(nextWindows).flatMap((w) => Array.isArray(w.pids) ? w.pids : []))].sort();
      const compactWindows = {};
      for (const [uid, w] of Object.entries(nextWindows)) {
        compactWindows[uid] = {
          schema: C.COHORT_SCHEMA,
          mode: 'NUMERIC_APPLY',
          cohortId,
          uid,
          planId: w.planId,
          pidsHash: w.pidsHash,
          pidCount: w.pidCount,
          runtimeSha,
          operationId: renewalOpId,
          startsAt,
          expiresAt,
        };
      }

      // Step 6D: Mandatory runtime shard sync & SERVED deployment verification.
      // Never re-arms Firestore fences based only on project env upsert!
      const shardRes = await deps.syncCohortRuntimeEnv({
        cohortId,
        operationId: renewalOpId,
        runtimeSha,
        startsAt,
        expiresAt,
        authHeader,
        windows: Object.values(compactWindows),
      });
      if (!shardRes || shardRes.ok !== true || shardRes.verified !== true || shardRes.servedDeploymentVerified !== true) {
        const errCode = (shardRes && shardRes.errorCode) ||
          (shardRes && shardRes.ok === true && shardRes.servedDeploymentVerified !== true ? 'SERVED_DEPLOYMENT_NOT_VERIFIED' : 'RUNTIME_SHARD_SYNC_FAILED');
        await opRef.set({ status: 'FAILED', errorCode: errCode, failedAt: nowIso }, { merge: true });
        return res.status(500).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: 'RENEWAL_FAILED',
          engineState: 'COACH_INTERVENTION_REQUIRED',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          stoppedVerified: true,
          servedDeploymentVerified: false,
          cohortId,
          clientId,
          planId,
          errorCode: errCode,
        });
      }

      // Step 6E: Atomic re-arm of ONLY this cohort + ledger RESERVED
      const updatedCoachCohortsArmed = Object.assign({}, coachCohorts, {
        [cohortId]: {
          enabled: true,
          cohortId,
          operationId: renewalOpId,
          startsAt,
          expiresAt,
          clientIds: cohortClientIds,
          prescriptionExerciseIds: allCohortPids,
        },
      });
      await db.runTransaction(async (tx) => {
        tx.set(relRef, {
          schema: RELEASE_SCHEMA,
          enabled: true,
          cohortId,
          operationId: renewalOpId,
          startsAt,
          expiresAt,
          clientIds: cohortClientIds,
        });
        tx.set(numRef, {
          schema: C.COHORT_SCHEMA,
          mode: 'NUMERIC_APPLY',
          enabled: true,
          cohortId,
          operationId: renewalOpId,
          runtimeSha,
          startsAt,
          expiresAt,
          windows: nextWindows,
        });
        tx.set(coachRef, {
          autoApplyCanary: Object.assign({}, coachDoc.autoApplyCanary || {}, {
            enabled: true,
            cohorts: updatedCoachCohortsArmed,
          }),
        }, { merge: true });
        tx.set(opRef, {
          schema: LEDGER_SCHEMA,
          status: 'RESERVED',
          cohortId,
          operationId: renewalOpId,
          runtimeSha,
          startsAt,
          expiresAt,
          windows: compactWindows,
          scope: {
            enabled: true,
            clientIds: cohortClientIds,
            prescriptionExerciseIds: allCohortPids,
          },
          appliedRecordKeys: [],
          renewedAt: nowIso,
        });
      });

      // Step 6F: Post-renewal exact verification
      const [vRelSnap, vNumSnap, vCoachSnap, vOpSnap] = await Promise.all([
        relRef.get(), numRef.get(), coachRef.get(), opRef.get(),
      ]);
      const vRel = _data(vRelSnap), vNum = _data(vNumSnap), vCoach = _data(vCoachSnap), vOp = _data(vOpSnap);
      const vWin = vNum && vNum.windows && vNum.windows[clientId];
      const vCc = vCoach && vCoach.autoApplyCanary && vCoach.autoApplyCanary.cohorts && vCoach.autoApplyCanary.cohorts[cohortId];
      const verified = !!(
        vRel && vRel.enabled === true && vRel.operationId === renewalOpId && _sameSorted(vRel.clientIds, cohortClientIds) &&
        vNum && vNum.enabled === true && vNum.operationId === renewalOpId &&
        vWin && vWin.enabled === true && vWin.planId === planId && vWin.pidsHash === planCheck.pidsHash &&
        vWin.pidCount === planCheck.pidCount && _sameSorted(vWin.pids, planCheck.pids) &&
        vCc && vCc.enabled === true && vCc.operationId === renewalOpId && _sameSorted(vCc.clientIds, cohortClientIds) &&
        vOp && vOp.status === 'RESERVED' && vOp.operationId === renewalOpId
      );
      if (!verified) {
        await opRef.set({ status: 'FAILED', errorCode: 'POST_RENEWAL_VERIFY_FAILED', failedAt: nowIso }, { merge: true }).catch(() => {});
        return res.status(500).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: 'RENEWAL_FAILED',
          engineState: 'COACH_INTERVENTION_REQUIRED',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          cohortId,
          clientId,
          planId,
          errorCode: 'POST_RENEWAL_VERIFY_FAILED',
        });
      }

      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'RENEWED_VERIFIED',
        engineState: 'MOTOR_INTEGRATED_AUTHORIZED',
        commercialAuthorized: true,
        numericApplyAuthorized: true,
        renewed: true,
        stoppedVerified: true,
        shardSyncedVerified: true,
        servedDeploymentVerified: true,
        deploymentId: shardRes.deploymentId || null,
        cohortId,
        clientId,
        previousPlanId,
        planId,
        pidsHash: planCheck.pidsHash,
        pidCount: planCheck.pidCount,
        planUpdatedAt: planDoc.updatedAt,
        operationId: renewalOpId,
        expiresAt,
      });
    } catch (_) {
      await opRef.set({ status: 'FAILED', errorCode: 'RENEWAL_EXECUTION_ERROR', failedAt: nowIso }, { merge: true }).catch(() => {});
      return res.status(500).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'RENEWAL_FAILED',
        engineState: 'COACH_INTERVENTION_REQUIRED',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        cohortId,
        clientId,
        planId,
        errorCode: 'RENEWAL_EXECUTION_ERROR',
      });
    }
  };
}

let _defaultHandler = null;
function defaultHandler(req, res) {
  if (!_defaultHandler) {
    const fbAdmin = require('./_firebaseAdmin');
    _defaultHandler = makeHandler({
      db: fbAdmin.getDb(),
      verifyIdToken: (tok) => fbAdmin.getAuth().verifyIdToken(tok),
      commercialRoster: () => loadBundledCommercialRoster(),
      autoRenewalEnabled: process.env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED === 'true',
      runtimeSha: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null,
      syncCohortRuntimeEnv: createVercelCohortShardSyncer(process.env),
    });
  }
  return _defaultHandler(req, res);
}

defaultHandler.makeHandler = makeHandler;
defaultHandler.validateNewPlanForEngine = validateNewPlanForEngine;
defaultHandler.buildRenewalOperationId = buildRenewalOperationId;
defaultHandler.validateCommercialRoster = validateCommercialRoster;
defaultHandler.loadBundledCommercialRoster = loadBundledCommercialRoster;
defaultHandler.loadCommercialRosterSafe = loadCommercialRosterSafe;
defaultHandler.createVercelCohortShardSyncer = createVercelCohortShardSyncer;
defaultHandler.shardKeysForCohort = shardKeysForCohort;
defaultHandler.computeServedCohortDigest = computeServedCohortDigest;
defaultHandler.buildServedCohortProbePayload = buildServedCohortProbePayload;
module.exports = defaultHandler;
