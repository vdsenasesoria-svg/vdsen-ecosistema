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

const PILOT_SCOPE_SCHEMA = 'vdsen-auto-renewal-pilot-scope-v1';
const PILOT_SCOPE_MAX_DURATION_MS = 168 * 3600 * 1000;
const GLOBAL_LOCK_LEASE_MS = 15 * 60 * 1000;
const GITHUB_OWNER = 'vdsenasesoria-svg';
const GITHUB_REPO = 'vdsen-ecosistema';
const GITHUB_REF = 'codex/client-app-next';
const GITHUB_WORKFLOW_FILE = 'vdsen-numeric-pilot.yml';

const RENEWAL_STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  AUTHORIZATION_PENDING: 'AUTHORIZATION_PENDING',
  QUEUED: 'QUEUED',
  VALIDATING: 'VALIDATING',
  PREPARING_RUNTIME: 'PREPARING_RUNTIME',
  DEPLOYING: 'DEPLOYING',
  VERIFYING_RUNTIME: 'VERIFYING_RUNTIME',
  PROMOTING: 'PROMOTING',
  REARMING: 'REARMING',
  RENEWED_VERIFIED: 'RENEWED_VERIFIED',
  FAILED: 'FAILED',
  ROLLBACK_REQUIRED: 'ROLLBACK_REQUIRED',
  ROLLED_BACK_VERIFIED: 'ROLLED_BACK_VERIFIED',
});

const IN_FLIGHT_RENEWAL_STATES = new Set([
  RENEWAL_STATES.REQUESTED,
  RENEWAL_STATES.QUEUED,
  RENEWAL_STATES.VALIDATING,
  RENEWAL_STATES.PREPARING_RUNTIME,
  RENEWAL_STATES.DEPLOYING,
  RENEWAL_STATES.VERIFYING_RUNTIME,
  RENEWAL_STATES.PROMOTING,
  RENEWAL_STATES.REARMING,
]);

/**
 * Explicitly distinguishes DISABLED, PILOT_RESTRICTED, and GENERAL_AUTHORIZED.
 * Fail-closed on incomplete or unrecognized configuration so partial pilot config
 * can never escalate into accidental global activation.
 */
function resolveAutoRenewalMode(env, deps) {
  env = env || process.env;
  deps = deps || {};
  const enabled = deps.autoRenewalEnabled !== undefined
    ? deps.autoRenewalEnabled === true
    : env.VDSEN_AUTO_COHORT_RENEWAL_ENABLED === 'true';
  if (!enabled) return 'DISABLED';

  const rawMode = deps.autoRenewalMode !== undefined
    ? deps.autoRenewalMode
    : env.VDSEN_AUTO_COHORT_RENEWAL_MODE;
  const rawScope = deps.pilotScope !== undefined
    ? deps.pilotScope
    : env.VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE;
  const hasScope = rawScope !== undefined && rawScope !== null && String(rawScope).trim() !== '';
  const modeStr = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';

  if (modeStr === 'pilot') return 'PILOT_RESTRICTED';
  if (modeStr === 'general') {
    // If a pilot scope is still present, stay restricted fail-closed
    return hasScope ? 'PILOT_RESTRICTED' : 'GENERAL_AUTHORIZED';
  }
  if (modeStr === '') {
    if (hasScope) return 'PILOT_RESTRICTED';
    // Backward compatibility only for explicit unit/emulator test injection (deps.autoRenewalEnabled === true)
    if (deps.autoRenewalEnabled === true && deps.autoRenewalMode === undefined) return 'GENERAL_AUTHORIZED';
    return 'DISABLED';
  }
  return 'DISABLED';
}

/**
 * T882 hardened fail-closed pilot scope guard.
 * During PILOT_RESTRICTED mode, requires ALL of:
 *   schema, uid, planId (mandatory — never optional in pilot), cohortId, operationId,
 *   startsAt, expiresAt (<=168h), matching requestedOperationId (if provided), and non-consumed auth.
 */
function parseAndEvaluatePilotScope(rawScope, ctx) {
  ctx = ctx || {};
  const requireScope = ctx.requireScope === true;
  if (rawScope === undefined || rawScope === null || (typeof rawScope === 'string' && rawScope.trim() === '')) {
    if (requireScope) {
      return { active: true, allowed: false, reason: 'PILOT_SCOPE_MISSING', scope: null };
    }
    return { active: false, allowed: true, reason: null, scope: null };
  }
  let scope = null;
  if (typeof rawScope === 'string') {
    try { scope = JSON.parse(rawScope); } catch (_) {
      return { active: true, allowed: false, reason: 'PILOT_SCOPE_INVALID_JSON', scope: null };
    }
  } else if (typeof rawScope === 'object' && !Array.isArray(rawScope)) {
    scope = rawScope;
  } else {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_INVALID_TYPE', scope: null };
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || scope.schema !== PILOT_SCOPE_SCHEMA) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_INVALID_SCHEMA', scope: null };
  }
  const uid = typeof scope.uid === 'string' ? scope.uid.trim() : '';
  const scopedPlanId = typeof scope.planId === 'string' ? scope.planId.trim() : '';
  const scopedCohortId = typeof scope.cohortId === 'string' ? scope.cohortId.trim() : '';
  const opId = typeof scope.operationId === 'string' ? scope.operationId.trim() : '';
  const startsAt = typeof scope.startsAt === 'string' ? scope.startsAt.trim() : '';
  const expiresAt = typeof scope.expiresAt === 'string' ? scope.expiresAt.trim() : '';

  if (!uid || !/^[a-zA-Z0-9-]{8,80}$/.test(opId)) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_INVALID_IDENTITY', scope: null };
  }
  if (!scopedPlanId) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_PLAN_ID_REQUIRED', scope: null };
  }
  if (!/^cohort-\d{2}$/.test(scopedCohortId)) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_COHORT_ID_REQUIRED', scope: null };
  }
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!isoRe.test(startsAt) || !isoRe.test(expiresAt)) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_INVALID_WINDOW', scope: null };
  }
  const startsMs = Date.parse(startsAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(startsMs) || !Number.isFinite(expiresMs) || expiresMs <= startsMs || (expiresMs - startsMs) > PILOT_SCOPE_MAX_DURATION_MS) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_WINDOW_BOUNDS_INVALID', scope: null };
  }
  const nowMs = Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now();
  if (nowMs < startsMs) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_NOT_STARTED', scope: null };
  }
  if (nowMs >= expiresMs) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_EXPIRED', scope: null };
  }
  if (ctx.clientId !== uid) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_UID_MISMATCH', scope: null };
  }
  if (ctx.planId !== scopedPlanId) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_PLAN_MISMATCH', scope: null };
  }
  if (ctx.cohortId && ctx.cohortId !== scopedCohortId) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_COHORT_MISMATCH', scope: null };
  }
  if (ctx.requestedOperationId && String(ctx.requestedOperationId).trim() !== opId) {
    return { active: true, allowed: false, reason: 'PILOT_SCOPE_OPERATION_ID_MISMATCH', scope: null };
  }
  if (ctx.consumedAuth && typeof ctx.consumedAuth === 'object') {
    const sameBinding = ctx.consumedAuth.uid === uid && ctx.consumedAuth.planId === scopedPlanId && ctx.consumedAuth.cohortId === scopedCohortId;
    if (!sameBinding || ctx.consumedAuth.consumed === true) {
      return { active: true, allowed: false, reason: 'PILOT_SCOPE_ALREADY_CONSUMED', scope: null };
    }
  }
  return {
    active: true,
    allowed: true,
    reason: null,
    scope: { schema: PILOT_SCOPE_SCHEMA, uid, planId: scopedPlanId, cohortId: scopedCohortId, operationId: opId, startsAt, expiresAt },
  };
}

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createGitHubAppJwt(appId, privateKeyPem, nowSec) {
  const iat = (Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000)) - 60;
  const exp = iat + 540; // 9 min (< 10 min GitHub max)
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = _b64url(JSON.stringify({ iat, exp, iss: String(appId) }));
  const signingInput = header + '.' + payload;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem);
  return signingInput + '.' + _b64url(sig);
}

/**
 * T882 Option 1 Credential Isolation:
 * Dispatches ONLY `vdsen-numeric-pilot.yml` (`action: renew-cohort`) on canonical repo/branch
 * using a short-lived GitHub App installation token (`actions:write` only on this repo).
 * NEVER reads or uses VERCEL_TOKEN.
 */
function createGitHubActionsRenewalDispatcher(env, fetcher) {
  env = env || process.env;
  const appId = typeof env.VDSEN_GH_RENEWAL_APP_ID === 'string' ? env.VDSEN_GH_RENEWAL_APP_ID.trim() : '';
  const installationId = typeof env.VDSEN_GH_RENEWAL_APP_INSTALLATION_ID === 'string' ? env.VDSEN_GH_RENEWAL_APP_INSTALLATION_ID.trim() : '';
  const rawKey = typeof env.VDSEN_GH_RENEWAL_APP_PRIVATE_KEY === 'string' ? env.VDSEN_GH_RENEWAL_APP_PRIVATE_KEY.trim() : '';
  if (!appId || !installationId || !rawKey) return null;
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const doFetch = fetcher || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;

  return async function dispatchRenewalWorkflow(payload) {
    try {
      if (!payload || !payload.operationId || !payload.cohortId || !payload.clientId || !payload.planId || !payload.coachUid || !payload.runtimeSha) {
        return { ok: false, errorCode: 'DISPATCH_PAYLOAD_INVALID' };
      }
      if (!/^cohort-\d{2}$/.test(payload.cohortId) || !/^[0-9a-f]{40}$/.test(payload.runtimeSha)) {
        return { ok: false, errorCode: 'DISPATCH_PAYLOAD_INVALID' };
      }
      const jwt = createGitHubAppJwt(appId, privateKey);
      const tokResp = await doFetch(
        'https://api.github.com/app/installations/' + encodeURIComponent(installationId) + '/access_tokens',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + jwt,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repositories: [GITHUB_REPO],
            permissions: { actions: 'write' },
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!tokResp || !tokResp.ok) {
        return { ok: false, errorCode: 'GITHUB_APP_TOKEN_FAILED' };
      }
      const tokData = await tokResp.json().catch(() => null);
      const instToken = tokData && typeof tokData.token === 'string' ? tokData.token : '';
      if (!instToken) {
        return { ok: false, errorCode: 'GITHUB_APP_TOKEN_MISSING' };
      }
      const dispatchUrl = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO +
        '/actions/workflows/' + GITHUB_WORKFLOW_FILE + '/dispatches';
      const dispResp = await doFetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + instToken,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: GITHUB_REF,
          inputs: {
            action: 'renew-cohort',
            operation_id: payload.operationId,
            runtime_sha: payload.runtimeSha,
            pilot_uid: 'COHORT:' + payload.cohortId,
            plan_id: payload.planId,
            coach_id: payload.coachUid,
            prescription_exercise_id: payload.clientId,
            starts_at: payload.startsAt || '',
            expires_at: payload.expiresAt || '',
            stop_reason: payload.renewalMode || '',
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!dispResp || (dispResp.status !== 204 && !dispResp.ok)) {
        return { ok: false, errorCode: 'GITHUB_DISPATCH_FAILED' };
      }
      return {
        ok: true,
        dispatched: true,
        workflow: GITHUB_WORKFLOW_FILE,
        ref: GITHUB_REF,
        operationId: payload.operationId,
      };
    } catch (_) {
      return { ok: false, errorCode: 'GITHUB_DISPATCH_EXCEPTION' };
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

    // 6. Drift detected -> Controlled renewal ONLY if explicitly enabled & not stopped in Firestore
    const renewalMode = resolveAutoRenewalMode(process.env, deps);

    // T882 Section 8: Effective STOP fence in Firestore (blocks renewals immediately without needing redeployment)
    const stopControlRef = db.collection('releaseControl').doc('autoCohortRenewalControl');
    const stopControlSnap = await stopControlRef.get();
    const stopControlDoc = _data(stopControlSnap);
    if (stopControlDoc && (stopControlDoc.stopped === true || stopControlDoc.enabled === false)) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: 'RENEWAL_STOPPED',
        engineState: 'AUTHORIZATION_PENDING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        stoppedEffective: true,
        stopReason: stopControlDoc.reason || 'AUTO_RENEWAL_STOPPED',
        renewalMode,
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

    if (renewalMode === 'DISABLED' || !unexpired || !runtimeSha || !/^[0-9a-f]{40}$/.test(runtimeSha)) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: RENEWAL_STATES.AUTHORIZATION_PENDING,
        engineState: 'AUTHORIZATION_PENDING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        renewalMode,
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

    // T882 Section 7: Hardened pilot scope guard (fail-closed in PILOT_RESTRICTED mode)
    const rawPilotScope = deps.pilotScope !== undefined
      ? deps.pilotScope
      : process.env.VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE;
    const requestedOperationId = typeof body.operationId === 'string' && body.operationId.trim()
      ? body.operationId.trim()
      : null;
    let consumedAuth = null;
    if (renewalMode === 'PILOT_RESTRICTED' && rawPilotScope) {
      const preCheck = parseAndEvaluatePilotScope(rawPilotScope, {
        requireScope: true,
        clientId,
        planId,
        cohortId,
        requestedOperationId,
        nowMs,
      });
      if (preCheck.allowed && preCheck.scope) {
        const pilotAuthSnap = await db.collection('releaseControl').doc('numericPilot')
          .collection('pilotAuthorizations').doc(preCheck.scope.operationId).get();
        consumedAuth = _data(pilotAuthSnap);
      }
    }
    const pilotCheck = parseAndEvaluatePilotScope(rawPilotScope, {
      requireScope: renewalMode === 'PILOT_RESTRICTED',
      clientId,
      planId,
      cohortId,
      requestedOperationId,
      consumedAuth,
      nowMs,
    });
    if (pilotCheck.active && !pilotCheck.allowed) {
      return res.status(200).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: RENEWAL_STATES.AUTHORIZATION_PENDING,
        engineState: 'AUTHORIZATION_PENDING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        renewalMode,
        pilotScopeBlocked: true,
        pilotScopeReason: pilotCheck.reason,
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

    const renewalOpId = (renewalMode === 'PILOT_RESTRICTED' && pilotCheck.scope)
      ? pilotCheck.scope.operationId
      : buildRenewalOperationId(cohortId, clientId, planId, planCheck.pidsHash);
    const opRef = db.collection('releaseControl').doc('numericPilot').collection('operations').doc(renewalOpId);

    // T882 Option 1: Asynchronous GitHub Actions orchestration (preferred production path).
    // Never waits for a Vercel build inside a serverless request and never holds VERCEL_TOKEN.
    // T883: Supports strictly read-only Vercel Firestore IAM (roles/datastore.viewer):
    // if db.runTransaction fails with 7 PERMISSION_DENIED, validates state read-only and
    // delegates ledger/lock/pilotAuth writes to GitHub Actions (vdsen-release-bot WIF).
    if (typeof deps.dispatchRenewalWorkflow === 'function') {
      const isPermDenied = (err) => Boolean(err && (err.code === 7 || /PERMISSION_DENIED/i.test(String(err.message || ''))));
      const globalLockRef = db.collection('releaseControl').doc('numericPilotGlobalLock');
      const leaseMs = Number.isFinite(deps.globalLockLeaseMs) ? deps.globalLockLeaseMs : GLOBAL_LOCK_LEASE_MS;
      const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      const pilotAuthRef = (renewalMode === 'PILOT_RESTRICTED' && pilotCheck.scope)
        ? db.collection('releaseControl').doc('numericPilot').collection('pilotAuthorizations').doc(pilotCheck.scope.operationId)
        : null;

      let readOnlyFirestoreMode = false;
      let enqueueOutcome;
      try {
        enqueueOutcome = await db.runTransaction(async (tx) => {
        const [opSnap, lockSnap, pAuthSnap] = await Promise.all([
          tx.get(opRef),
          tx.get(globalLockRef),
          pilotAuthRef ? tx.get(pilotAuthRef) : Promise.resolve(null),
        ]);
        const existingOp = _data(opSnap);
        const lockDoc = _data(lockSnap) || { version: 0, activeOperationId: null, pendingQueue: [] };
        const pAuth = pAuthSnap ? _data(pAuthSnap) : null;

        if (pilotAuthRef && pAuth && pAuth.consumed === true) {
          return { action: 'PILOT_CONSUMED' };
        }
        if (existingOp && existingOp.status === RENEWAL_STATES.RENEWED_VERIFIED) {
          return { action: 'ALREADY_VERIFIED', op: existingOp };
        }
        if (existingOp && IN_FLIGHT_RENEWAL_STATES.has(existingOp.status)) {
          const opLeaseMs = Date.parse(existingOp.leaseExpiresAt || '');
          if (Number.isFinite(opLeaseMs) && opLeaseMs > nowMs) {
            return { action: 'ALREADY_IN_FLIGHT', op: existingOp };
          }
        }

        const activeOpId = lockDoc.activeOperationId || null;
        const activeLeaseMs = Date.parse(lockDoc.leaseExpiresAt || '');
        const lockHeldByOther = Boolean(
          activeOpId &&
          (['PROMOTING', 'ROLLBACK_REQUIRED'].includes(lockDoc.status) ||
            (activeOpId !== renewalOpId && Number.isFinite(activeLeaseMs) && activeLeaseMs > nowMs))
        );
        const recoveredExpiredLock = Boolean(
          activeOpId &&
          activeOpId !== renewalOpId &&
          (!Number.isFinite(activeLeaseMs) || activeLeaseMs <= nowMs)
        );
        const attemptCount = ((existingOp && Number(existingOp.attemptCount)) || 0) + 1;
        const prevHistory = Array.isArray(existingOp && existingOp.history) ? existingOp.history.slice(-20) : [];
        const baseOpRecord = {
          schema: LEDGER_SCHEMA,
          operationId: renewalOpId,
          renewalMode,
          cohortId,
          clientId,
          coachUid,
          previousPlanId,
          planId,
          pids: planCheck.pids,
          pidCount: planCheck.pidCount,
          pidsHash: planCheck.pidsHash,
          runtimeSha,
          startsAt,
          expiresAt,
          attemptCount,
          requestedAt: (existingOp && existingOp.requestedAt) || nowIso,
          updatedAt: nowIso,
          leaseExpiresAt,
          workflowRunId: (existingOp && existingOp.workflowRunId) || null,
          deploymentId: (existingOp && existingOp.deploymentId) || null,
        };

        if (lockHeldByOther) {
          const queue = Array.isArray(lockDoc.pendingQueue) ? lockDoc.pendingQueue.slice() : [];
          if (!queue.some((q) => q && q.operationId === renewalOpId)) {
            queue.push({ operationId: renewalOpId, cohortId, clientId, planId, coachUid, requestedAt: nowIso });
          }
          tx.set(opRef, Object.assign({}, baseOpRecord, {
            status: RENEWAL_STATES.QUEUED,
            queuedBehindOperationId: activeOpId,
            history: prevHistory.concat([{ state: RENEWAL_STATES.QUEUED, at: nowIso, queuedBehind: activeOpId }]),
          }));
          tx.set(globalLockRef, Object.assign({}, lockDoc, {
            pendingQueue: queue,
            updatedAt: nowIso,
          }));
          return { action: 'QUEUED_BEHIND_LOCK', queuedBehindOperationId: activeOpId, attemptCount };
        }

        const nextQueue = (Array.isArray(lockDoc.pendingQueue) ? lockDoc.pendingQueue : [])
          .filter((q) => q && q.operationId !== renewalOpId);
        const nextLockVersion = (Number(lockDoc.version) || 0) + 1;
        tx.set(opRef, Object.assign({}, baseOpRecord, {
          status: RENEWAL_STATES.REQUESTED,
          queuedBehindOperationId: null,
          recoveredExpiredLock,
          lockVersion: nextLockVersion,
          history: prevHistory.concat([{ state: RENEWAL_STATES.REQUESTED, at: nowIso, attempt: attemptCount, lockVersion: nextLockVersion }]),
        }));
        tx.set(globalLockRef, {
          schema: 'vdsen-numeric-global-lock-v1',
          activeOperationId: renewalOpId,
          cohortId,
          clientId,
          planId,
          status: RENEWAL_STATES.REQUESTED,
          acquiredAt: nowIso,
          updatedAt: nowIso,
          leaseExpiresAt,
          pendingQueue: nextQueue,
          version: nextLockVersion,
        });
        if (pilotAuthRef) {
          tx.set(pilotAuthRef, {
            schema: PILOT_SCOPE_SCHEMA,
            operationId: pilotCheck.scope.operationId,
            uid: clientId,
            planId,
            cohortId,
            consumed: true,
            consumedAt: nowIso,
          });
        }
        return { action: 'DISPATCH_NOW', recoveredExpiredLock, attemptCount };
        });
      } catch (txErr) {
        if (!isPermDenied(txErr)) throw txErr;
        readOnlyFirestoreMode = true;
        const [opSnap, lockSnap, pAuthSnap] = await Promise.all([
          opRef.get(),
          globalLockRef.get(),
          pilotAuthRef ? pilotAuthRef.get() : Promise.resolve(null),
        ]);
        const existingOp = _data(opSnap);
        const lockDoc = _data(lockSnap) || { version: 0, activeOperationId: null, pendingQueue: [] };
        const pAuth = pAuthSnap ? _data(pAuthSnap) : null;
        if (pilotAuthRef && pAuth && pAuth.consumed === true) {
          enqueueOutcome = { action: 'PILOT_CONSUMED' };
        } else if (existingOp && existingOp.status === RENEWAL_STATES.RENEWED_VERIFIED) {
          enqueueOutcome = { action: 'ALREADY_VERIFIED', op: existingOp };
        } else if (existingOp && IN_FLIGHT_RENEWAL_STATES.has(existingOp.status) && Number.isFinite(Date.parse(existingOp.leaseExpiresAt || '')) && Date.parse(existingOp.leaseExpiresAt || '') > nowMs) {
          enqueueOutcome = { action: 'ALREADY_IN_FLIGHT', op: existingOp };
        } else {
          const activeOpId = lockDoc.activeOperationId || null;
          const activeLeaseMs = Date.parse(lockDoc.leaseExpiresAt || '');
          const lockHeldByOther = Boolean(activeOpId && (['PROMOTING', 'ROLLBACK_REQUIRED'].includes(lockDoc.status) ||
            (activeOpId !== renewalOpId && Number.isFinite(activeLeaseMs) && activeLeaseMs > nowMs)));
          if (lockHeldByOther) {
            enqueueOutcome = { action: 'QUEUED_BEHIND_LOCK', queuedBehindOperationId: activeOpId, attemptCount: 1 };
          } else {
            const recoveredExpiredLock = Boolean(activeOpId && activeOpId !== renewalOpId && (!Number.isFinite(activeLeaseMs) || activeLeaseMs <= nowMs));
            enqueueOutcome = { action: 'DISPATCH_NOW', recoveredExpiredLock, attemptCount: 1 };
          }
        }
      }

      if (enqueueOutcome.action === 'PILOT_CONSUMED') {
        return res.status(200).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: RENEWAL_STATES.AUTHORIZATION_PENDING,
          engineState: 'AUTHORIZATION_PENDING',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          renewalMode,
          pilotScopeBlocked: true,
          pilotScopeReason: 'PILOT_SCOPE_ALREADY_CONSUMED',
          cohortId,
          clientId,
          previousPlanId,
          planId,
          pidsHash: planCheck.pidsHash,
          pidCount: planCheck.pidCount,
        });
      }
      if (enqueueOutcome.action === 'ALREADY_VERIFIED') {
        return res.status(200).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: RENEWAL_STATES.RENEWED_VERIFIED,
          engineState: 'MOTOR_INTEGRATED_AUTHORIZED',
          commercialAuthorized: true,
          numericApplyAuthorized: true,
          renewed: false,
          idempotent: true,
          operationId: renewalOpId,
          deploymentId: enqueueOutcome.op.deploymentId || null,
          workflowRunId: enqueueOutcome.op.workflowRunId || null,
          cohortId,
          clientId,
          previousPlanId,
          planId,
          pidsHash: planCheck.pidsHash,
          pidCount: planCheck.pidCount,
          expiresAt,
        });
      }
      if (enqueueOutcome.action === 'ALREADY_IN_FLIGHT') {
        return res.status(202).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: enqueueOutcome.op.status,
          engineState: 'AUTHORIZATION_PREPARING',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          alreadyInProgress: true,
          operationId: renewalOpId,
          workflowRunId: enqueueOutcome.op.workflowRunId || null,
          cohortId,
          clientId,
          previousPlanId,
          planId,
          pidsHash: planCheck.pidsHash,
          pidCount: planCheck.pidCount,
          expiresAt,
        });
      }
      if (enqueueOutcome.action === 'QUEUED_BEHIND_LOCK') {
        return res.status(202).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: RENEWAL_STATES.QUEUED,
          engineState: 'AUTHORIZATION_PREPARING',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          workflowDispatched: false,
          queuedBehindOperationId: enqueueOutcome.queuedBehindOperationId,
          operationId: renewalOpId,
          cohortId,
          clientId,
          previousPlanId,
          planId,
          pidsHash: planCheck.pidsHash,
          pidCount: planCheck.pidCount,
          expiresAt,
        });
      }

      // Dispatch GitHub Actions `renew-cohort` workflow (short-lived token, zero VERCEL_TOKEN here)
      const dispRes = await deps.dispatchRenewalWorkflow({
        operationId: renewalOpId,
        cohortId,
        clientId,
        planId,
        coachUid,
        runtimeSha,
        startsAt,
        expiresAt,
        renewalMode,
      });
      if (!dispRes || dispRes.ok !== true) {
        const errCode = (dispRes && dispRes.errorCode) || 'GITHUB_DISPATCH_FAILED';
        if (!readOnlyFirestoreMode) {
          await db.runTransaction(async (tx) => {
            const [curOpSnap, curLockSnap] = await Promise.all([tx.get(opRef), tx.get(globalLockRef)]);
            const curOp = _data(curOpSnap) || {};
            const curLock = _data(curLockSnap) || {};
            if (curOp.status !== RENEWAL_STATES.REQUESTED || curLock.activeOperationId !== renewalOpId ||
                curLock.version !== curOp.lockVersion) return;
            const hist = Array.isArray(curOp.history) ? curOp.history.slice(-20) : [];
            tx.set(opRef, Object.assign({}, curOp, {
              status: RENEWAL_STATES.FAILED,
              errorCode: errCode,
              failedAt: nowIso,
              updatedAt: nowIso,
              history: hist.concat([{ state: RENEWAL_STATES.FAILED, at: nowIso, errorCode: errCode }]),
            }));
            if (curLock.activeOperationId === renewalOpId) {
              tx.set(globalLockRef, Object.assign({}, curLock, {
                activeOperationId: null,
                status: 'IDLE',
                updatedAt: nowIso,
                leaseExpiresAt: null,
                version: (Number(curLock.version) || 0) + 1,
              }));
            }
            if (pilotAuthRef) {
              tx.set(pilotAuthRef, { consumed: false, releasedOnDispatchFailureAt: nowIso }, { merge: true });
            }
          });
        }
        return res.status(502).json({
          schema: 'vdsen-plan-activation-sync-v1',
          status: RENEWAL_STATES.FAILED,
          engineState: 'COACH_INTERVENTION_REQUIRED',
          commercialAuthorized: true,
          numericApplyAuthorized: false,
          renewed: false,
          retryable: true,
          operationId: renewalOpId,
          cohortId,
          clientId,
          previousPlanId,
          planId,
          pidsHash: planCheck.pidsHash,
          pidCount: planCheck.pidCount,
          errorCode: errCode,
        });
      }

      if (!readOnlyFirestoreMode) {
        await db.runTransaction(async (tx) => {
          const [curOpSnap, curLockSnap] = await Promise.all([tx.get(opRef), tx.get(globalLockRef)]);
          const curOp = _data(curOpSnap) || {};
          const curLock = _data(curLockSnap) || {};
          if (curOp.status !== RENEWAL_STATES.REQUESTED || curLock.activeOperationId !== renewalOpId ||
              curLock.version !== curOp.lockVersion) return;
          const hist = Array.isArray(curOp.history) ? curOp.history.slice(-20) : [];
          tx.set(opRef, Object.assign({}, curOp, {
            status: RENEWAL_STATES.QUEUED,
            workflow: dispRes.workflow || GITHUB_WORKFLOW_FILE,
            workflowRef: dispRes.ref || GITHUB_REF,
            dispatchedAt: nowIso,
            updatedAt: nowIso,
            history: hist.concat([{ state: RENEWAL_STATES.QUEUED, at: nowIso, workflow: dispRes.workflow || GITHUB_WORKFLOW_FILE }]),
          }));
          if (curLock.activeOperationId === renewalOpId) {
            tx.set(globalLockRef, Object.assign({}, curLock, {
              status: RENEWAL_STATES.QUEUED,
              updatedAt: nowIso,
            }));
          }
        });
      }

      return res.status(202).json({
        schema: 'vdsen-plan-activation-sync-v1',
        status: RENEWAL_STATES.QUEUED,
        engineState: 'AUTHORIZATION_PREPARING',
        commercialAuthorized: true,
        numericApplyAuthorized: false,
        renewed: false,
        workflowDispatched: true,
        readOnlyFirestoreMode,
        recoveredExpiredLock: enqueueOutcome.recoveredExpiredLock === true,
        operationId: renewalOpId,
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

    // MANDATORY FAIL-CLOSED GUARD: Never STOP or re-arm Firestore fences without a verified
    // orchestrator or runtime shard synchronizer. Prevents Firestore-vs-Vercel split-brain.
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

// T883-B4: Authenticated, Coach+client-isolated read-only status endpoint for async renewal operations.
function makeStatusHandler(deps) {
  deps = deps || {};
  return async function statusHandler(req, res) {
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    const authHeader = (req.headers && req.headers.authorization) || '';
    const tokenMatch = typeof authHeader === 'string' && /^Bearer\s+(\S+)$/.exec(authHeader.trim());
    if (!tokenMatch) return res.status(401).json({ error: 'AUTH_MISSING' });
    if (typeof deps.verifyIdToken !== 'function') return res.status(503).json({ error: 'AUTH_UNAVAILABLE' });
    let identity;
    try { identity = await deps.verifyIdToken(tokenMatch[1]); } catch (_) { return res.status(401).json({ error: 'AUTH_INVALID' }); }
    const coachUid = identity && typeof identity.uid === 'string' ? identity.uid : '';
    if (!coachUid) return res.status(401).json({ error: 'AUTH_INVALID' });

    const q = (req.query && typeof req.query === 'object') ? req.query : {};
    const operationId = typeof q.operationId === 'string' ? q.operationId.trim() : '';
    const clientId = typeof q.clientId === 'string' ? q.clientId.trim() : '';
    if (!operationId || !/^[a-zA-Z0-9_-]{8,80}$/.test(operationId) || !clientId) {
      return res.status(400).json({ error: 'OPERATION_AND_CLIENT_REQUIRED' });
    }
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'ADMIN_DB_UNAVAILABLE' });

    const [clientSnap, opSnap] = await Promise.all([
      db.collection('clients').doc(clientId).get(),
      db.collection('releaseControl').doc('numericPilot').collection('operations').doc(operationId).get(),
    ]);
    const clientDoc = _data(clientSnap);
    if (!clientDoc || clientDoc.coachId !== coachUid) {
      return res.status(403).json({ error: 'CLIENT_NOT_OWNED' });
    }
    const opDoc = _data(opSnap);
    if (!opDoc) return res.status(404).json({ error: 'OPERATION_NOT_FOUND' });
    if (opDoc.clientId !== clientId || (opDoc.coachUid && opDoc.coachUid !== coachUid)) {
      return res.status(403).json({ error: 'OPERATION_NOT_OWNED' });
    }

    const st = opDoc.status || RENEWAL_STATES.AUTHORIZATION_PENDING;
    let engineState = 'AUTHORIZATION_PENDING';
    let numericApplyAuthorized = false;
    let retryable = false;
    if (st === RENEWAL_STATES.RENEWED_VERIFIED) {
      engineState = 'MOTOR_INTEGRATED_AUTHORIZED';
      numericApplyAuthorized = true;
    } else if (IN_FLIGHT_RENEWAL_STATES.has(st)) {
      engineState = 'AUTHORIZATION_PREPARING';
    } else if (st === RENEWAL_STATES.FAILED || st === RENEWAL_STATES.ROLLED_BACK_VERIFIED || st === RENEWAL_STATES.ROLLBACK_REQUIRED) {
      engineState = 'COACH_INTERVENTION_REQUIRED';
      retryable = st !== RENEWAL_STATES.ROLLBACK_REQUIRED;
    }

    return res.status(200).json({
      schema: 'vdsen-plan-activation-status-v1',
      operationId: opDoc.operationId || operationId,
      status: st,
      engineState,
      numericApplyAuthorized,
      retryable,
      cohortId: opDoc.cohortId || null,
      clientId,
      planId: opDoc.planId || null,
      pidCount: opDoc.pidCount || null,
      deploymentId: opDoc.deploymentId || null,
      workflowRunId: opDoc.workflowRunId || null,
      errorCode: opDoc.errorCode || null,
      updatedAt: opDoc.updatedAt || null,
    });
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
      autoRenewalMode: process.env.VDSEN_AUTO_COHORT_RENEWAL_MODE,
      pilotScope: process.env.VDSEN_AUTO_COHORT_RENEWAL_PILOT_SCOPE,
      runtimeSha: process.env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null,
      dispatchRenewalWorkflow: createGitHubActionsRenewalDispatcher(process.env),
    });
  }
  return _defaultHandler(req, res);
}

defaultHandler.makeHandler = makeHandler;
defaultHandler.makeStatusHandler = makeStatusHandler;
defaultHandler.RENEWAL_STATES = RENEWAL_STATES;
defaultHandler.resolveAutoRenewalMode = resolveAutoRenewalMode;
defaultHandler.parseAndEvaluatePilotScope = parseAndEvaluatePilotScope;
defaultHandler.createGitHubAppJwt = createGitHubAppJwt;
defaultHandler.createGitHubActionsRenewalDispatcher = createGitHubActionsRenewalDispatcher;
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
