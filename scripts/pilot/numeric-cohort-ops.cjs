'use strict';
// T875 — Multi-Cohort General Numeric Activation Coordinator.
// Strictly preserves <= 10 clients per independent cohort, explicit per-client/plan/PID
// authorization (cryptographically bound via pidsHash), atomic ledger reservation,
// per-cohort preflight GO gating, independent STOP/RESTORE, and OFF project Numeric Guard.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const C = require('../../api/_numericPilotContract.js');
const eligibility = require('../../api/_clientEligibility.js');
const A = require('../release/app-live.cjs');
const G = require('../release/numeric-guard.cjs');

const DEFAULT_PROJECT_ID = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN';
const DEFAULT_TEAM_ID = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const EXPECTED_ALIAS = 'vdsen-ecosistema.vercel.app';
const MAX_COHORT_CLIENTS = C.COHORT_MAX_CLIENTS || 10;

function fromFsValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFsValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsDoc(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, val] of Object.entries(doc.fields)) out[k] = fromFsValue(val);
  out._id = doc.name ? doc.name.split('/').pop() : null;
  return out;
}

function toFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) fields[k] = toFsValue(v);
  return fields;
}

function extractPlanPids(plan) {
  const pidSet = new Set();
  let totalExercises = 0;
  let missingPidExercises = 0;
  for (const d of Array.isArray(plan && plan.days) ? plan.days : []) {
    for (const ex of Array.isArray(d && d.exercises) ? d.exercises : []) {
      if (!ex || ex.exerciseType === 'cardio') continue;
      totalExercises++;
      if (typeof ex.prescriptionExerciseId === 'string' && ex.prescriptionExerciseId.trim()) {
        pidSet.add(ex.prescriptionExerciseId.trim());
      } else {
        missingPidExercises++;
      }
    }
  }
  return { pids: [...pidSet].sort(), totalExercises, missingPidExercises };
}

const COMMERCIAL_ROSTER_PATH = path.resolve(__dirname, '../../.release/commercial-roster-t876.json');

function loadCommercialRoster(filePath = COMMERCIAL_ROSTER_PATH) {
  assert.ok(typeof filePath === 'string' && filePath.trim(), 'COMMERCIAL_ROSTER_PATH_INVALID');
  assert.ok(fs.existsSync(filePath), 'COMMERCIAL_ROSTER_MISSING: ' + filePath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error('COMMERCIAL_ROSTER_INVALID_JSON: ' + (err && err.message ? err.message : String(err)));
  }
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'COMMERCIAL_ROSTER_INVALID_OBJECT');
  assert.equal(raw.schema, 'vdsen-commercial-roster-v1', 'COMMERCIAL_ROSTER_INVALID_SCHEMA');
  assert.equal(raw.firebaseProject, 'vdsen-ecosistema', 'COMMERCIAL_ROSTER_PROJECT_MISMATCH');
  assert.equal(raw.confirmedBy, 'owner', 'COMMERCIAL_ROSTER_UNAPPROVED');
  assert.ok(typeof raw.confirmedAt === 'string' && Number.isFinite(Date.parse(raw.confirmedAt)), 'COMMERCIAL_ROSTER_INVALID_CONFIRMED_AT');
  assert.ok(Array.isArray(raw.activeUids) && raw.activeUids.length >= 1, 'COMMERCIAL_ROSTER_EMPTY_ACTIVE_UIDS');
  assert.ok(Array.isArray(raw.inactiveUids), 'COMMERCIAL_ROSTER_INVALID_INACTIVE_UIDS');

  const activeSet = new Set();
  for (const uid of raw.activeUids) {
    assert.ok(typeof uid === 'string' && uid.trim().length >= 8 && uid === uid.trim(), 'COMMERCIAL_ROSTER_INVALID_ACTIVE_UID_' + String(uid));
    assert.ok(!activeSet.has(uid), 'COMMERCIAL_ROSTER_DUPLICATE_ACTIVE_UID_' + uid);
    activeSet.add(uid);
  }
  const inactiveSet = new Set();
  for (const uid of raw.inactiveUids) {
    assert.ok(typeof uid === 'string' && uid.trim().length >= 8 && uid === uid.trim(), 'COMMERCIAL_ROSTER_INVALID_INACTIVE_UID_' + String(uid));
    assert.ok(!inactiveSet.has(uid), 'COMMERCIAL_ROSTER_DUPLICATE_INACTIVE_UID_' + uid);
    assert.ok(!activeSet.has(uid), 'COMMERCIAL_ROSTER_OVERLAP_' + uid);
    inactiveSet.add(uid);
  }
  return {
    schema: raw.schema,
    task: raw.task || null,
    firebaseProject: raw.firebaseProject,
    confirmedAt: raw.confirmedAt,
    confirmedBy: raw.confirmedBy,
    activeSet,
    inactiveSet,
  };
}

/**
 * Pure, deterministic cohort builder: classifies eligible vs excluded clients and partitions
 * eligible clients into isolated cohorts of <= 10 clients each.
 * Separates commercialStatus (ACTIVE|INACTIVE|UNCONFIRMED), planStatus (VALID|PENDING_FINALIZATION|INVALID),
 * numericStatus (ACTIVE|AUTHORIZED_PENDING|EXCLUDED), and cohortId.
 */
function buildCohortsFromRoster(clients, plansById, opts = {}) {
  const runtimeSha = opts.runtimeSha || '';
  const baseOpId = opts.operationId || 'T875-FLEET-OP';
  const startsAt = opts.startsAt || '';
  const expiresAt = opts.expiresAt || '';
  const reg = opts.commercialRegistry || null;
  const activeSet = reg ? (reg.activeSet || new Set(reg.activeUids || [])) : null;
  const inactiveSet = reg ? (reg.inactiveSet || new Set(reg.inactiveUids || [])) : null;
  const eligible = [];
  const excluded = [];
  const classifications = [];

  const sortedClients = (Array.isArray(clients) ? clients : []).slice().sort((a, b) => String(a._id || a.uid || '').localeCompare(String(b._id || b.uid || '')));
  for (const c of sortedClients) {
    const uid = c._id || c.uid;
    if (!uid) continue;
    const commercialStatus = reg
      ? (activeSet.has(uid) ? 'ACTIVE' : inactiveSet.has(uid) ? 'INACTIVE' : 'UNCONFIRMED')
      : 'UNCONFIRMED';
    const plan = c.activePlanId && plansById ? plansById[c.activePlanId] : null;
    const extracted = plan ? extractPlanPids(plan) : { pids: [], totalExercises: 0, missingPidExercises: 0 };
    const hasValidUpdatedAt = typeof (plan && plan.updatedAt) === 'string' && Number.isFinite(Date.parse(plan.updatedAt));
    const planValidStructure = !!(
      c.activePlanId && plan &&
      eligibility.isPlanStatusValid(plan, c) &&
      (!plan.clientId || plan.clientId === uid) &&
      extracted.pids.length > 0
    );
    const planStatus = !planValidStructure ? 'INVALID' : (hasValidUpdatedAt ? 'VALID' : 'PENDING_FINALIZATION');

    if (reg && commercialStatus === 'INACTIVE') {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId || null, commercialStatus, planStatus, reason: 'COMMERCIAL_INACTIVE' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId || null, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: extracted.pids.length });
      continue;
    }
    if (reg && commercialStatus === 'UNCONFIRMED') {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId || null, commercialStatus, planStatus, reason: 'COMMERCIAL_UNCONFIRMED' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId || null, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: extracted.pids.length });
      continue;
    }
    if (!eligibility.isClientStatusValid(c)) {
      excluded.push({ uid, coachId: c.coachId || null, commercialStatus, planStatus, reason: 'CLIENT_INACTIVE_OR_SUSPENDED' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId || null, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: 0 });
      continue;
    }
    if (!c.activePlanId) {
      excluded.push({ uid, coachId: c.coachId || null, commercialStatus, planStatus, reason: 'NO_ACTIVE_PLAN_ID' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: null, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: 0 });
      continue;
    }
    if (!plan) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, reason: 'ACTIVE_PLAN_NOT_FOUND' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: 0 });
      continue;
    }
    if (!eligibility.isPlanStatusValid(plan, c)) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, reason: 'PLAN_STATUS_INVALID' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: 0 });
      continue;
    }
    if (plan.clientId && plan.clientId !== uid) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, reason: 'PLAN_CLIENT_MISMATCH' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: 0 });
      continue;
    }
    const { pids, totalExercises, missingPidExercises } = extracted;
    if (pids.length === 0) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, totalExercises, missingPidExercises, commercialStatus, planStatus, reason: 'NO_PRESCRIPTION_EXERCISE_IDS' });
      classifications.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, commercialStatus, planStatus, numericStatus: 'EXCLUDED', cohortId: null, pidCount: 0 });
      continue;
    }
    const pidsHash = C.computePidsHash(pids);
    assert.ok(pidsHash, 'INVALID_PIDS_HASH_FOR_' + uid);
    eligible.push({
      uid,
      coachId: c.coachId || null,
      planId: c.activePlanId,
      createdAt: plan.createdAt || null,
      updatedAt: plan.updatedAt || null,
      commercialStatus,
      planStatus,
      pids,
      pidCount: pids.length,
      pidsHash,
    });
  }

  const cohorts = [];
  const ENV_SHARD_MAX_CLIENTS = 5;
  let nextShardIdx = 1;
  for (let i = 0; i < eligible.length; i += MAX_COHORT_CLIENTS) {
    const idx = Math.floor(i / MAX_COHORT_CLIENTS) + 1;
    const cohortId = 'cohort-' + String(idx).padStart(2, '0');
    const slice = eligible.slice(i, i + MAX_COHORT_CLIENTS);
    assert.ok(slice.length >= 1 && slice.length <= MAX_COHORT_CLIENTS, 'COHORT_CAP_VIOLATED');
    for (const x of slice) {
      classifications.push({
        uid: x.uid,
        coachId: x.coachId,
        activePlanId: x.planId,
        commercialStatus: x.commercialStatus,
        planStatus: x.planStatus,
        numericStatus: x.planStatus === 'VALID' ? 'ACTIVE' : 'AUTHORIZED_PENDING',
        cohortId,
        pidCount: x.pidCount,
      });
    }
    const cohortOpId = (baseOpId + '-' + cohortId).slice(0, 80);
    const allPids = [...new Set(slice.flatMap(x => x.pids))].sort();
    const coachIds = [...new Set(slice.map(x => x.coachId).filter(Boolean))].sort();
    const compactWindows = slice.map(x => ({
      schema: C.COHORT_SCHEMA,
      mode: 'NUMERIC_APPLY',
      cohortId,
      uid: x.uid,
      planId: x.planId,
      pidsHash: x.pidsHash,
      pidCount: x.pidCount,
      runtimeSha,
      operationId: cohortOpId,
      startsAt,
      expiresAt,
    }));
    const envShards = [];
    for (let j = 0; j < compactWindows.length; j += ENV_SHARD_MAX_CLIENTS) {
      assert.ok(nextShardIdx <= 20, 'COHORT_ENV_SHARD_CAP_EXCEEDED_20');
      const shardName = 'VDSEN_NUMERIC_COHORT_' + nextShardIdx++;
      const shardWindows = compactWindows.slice(j, j + ENV_SHARD_MAX_CLIENTS);
      const shardJson = JSON.stringify(shardWindows);
      const shardBytes = Buffer.byteLength(shardJson, 'utf8');
      assert.ok(shardBytes < 4000, 'COHORT_ENV_SHARD_EXCEEDS_4KB: ' + shardName + ' (' + shardBytes + 'B)');
      envShards.push({ name: shardName, bytes: shardBytes, windows: shardWindows });
    }
    const envVarName = envShards[0].name;
    const envVarNames = envShards.map(sh => sh.name);
    cohorts.push({
      index: idx,
      cohortId,
      envVarName,
      envVarNames,
      envShards,
      envVarBytes: envShards.reduce((s, sh) => s + sh.bytes, 0),
      operationId: cohortOpId,
      coachIds,
      clientIds: slice.map(x => x.uid),
      clientCount: slice.length,
      pidCount: allPids.length,
      allPids,
      clients: slice,
      compactWindows,
    });
  }

  const excludedByReason = {};
  excluded.forEach(x => { excludedByReason[x.reason] = (excludedByReason[x.reason] || 0) + 1; });

  return {
    schema: 'vdsen-fleet-cohort-manifest-v1',
    totalClients: sortedClients.length,
    eligibleCount: eligible.length,
    eligibleWithUpdatedAt: eligible.filter(x => !!x.updatedAt).length,
    eligibleMissingUpdatedAt: eligible.filter(x => !x.updatedAt).length,
    eligibleWithCanonicalTimestamp: eligible.filter(x => x.planStatus === 'VALID').length,
    eligibleMissingCanonicalTimestamp: eligible.filter(x => x.planStatus !== 'VALID').length,
    excludedCount: excluded.length,
    excludedByReason,
    totalEligiblePids: eligible.reduce((s, x) => s + x.pidCount, 0),
    cohortCount: cohorts.length,
    maxClientsPerCohort: MAX_COHORT_CLIENTS,
    cohorts,
    excluded,
    classifications,
  };
}

// ── Firestore REST helpers (WIF GOOGLE_ACCESS_TOKEN) ─────────────────────────────────────────
function fsBase(projectId) {
  return 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents';
}

async function fsList(projectId, token, col, fetcher = globalThis.fetch) {
  const docs = [];
  let pageToken = '';
  while (true) {
    const url = fsBase(projectId) + '/' + col + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetcher(url, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(res.status, 200, 'FS_LIST_FAILED_' + col + '_' + res.status);
    const data = await res.json();
    if (Array.isArray(data.documents)) docs.push(...data.documents.map(fromFsDoc));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return docs;
}

async function fsGet(projectId, token, docPath, fetcher = globalThis.fetch) {
  const res = await fetcher(fsBase(projectId) + '/' + docPath, { headers: { authorization: 'Bearer ' + token } });
  if (res.status === 404) return null;
  assert.equal(res.status, 200, 'FS_GET_FAILED_' + docPath + '_' + res.status);
  return fromFsDoc(await res.json());
}

async function fsCommit(projectId, token, writes, fetcher = globalThis.fetch) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents:commit';
  const res = await fetcher(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    throw new Error('FS_COMMIT_FAILED_' + res.status + ': ' + JSON.stringify(body).slice(0, 400));
  }
  return body;
}

function docName(projectId, docPath) {
  return 'projects/' + projectId + '/databases/(default)/documents/' + docPath;
}

async function loadLiveRoster(projectId, token, opts = {}) {
  const fetcher = opts.fetcher || globalThis.fetch;
  // Fail-closed: real operational paths always enforce the owner-confirmed commercial roster.
  const commercialRegistry = opts.commercialRegistry !== undefined
    ? opts.commercialRegistry
    : loadCommercialRoster(opts.commercialRosterPath);
  assert.ok(
    commercialRegistry && commercialRegistry.activeSet instanceof Set && commercialRegistry.activeSet.size >= 1,
    'COMMERCIAL_ROSTER_REQUIRED'
  );
  const clients = await fsList(projectId, token, 'clients', fetcher);
  const plansById = {};
  const planIds = [...new Set(clients.map(c => c.activePlanId).filter(Boolean))];
  for (const pid of planIds) {
    const p = await fsGet(projectId, token, 'plans/' + pid, fetcher);
    if (p) plansById[pid] = p;
  }
  return buildCohortsFromRoster(clients, plansById, Object.assign({}, opts, { commercialRegistry }));
}

async function fetchCohortFences(projectId, token, cohortId, coachId, fetcher = globalThis.fetch) {
  const relDoc = await fsGet(projectId, token, 'releaseControl/autonomousProgression_cohort_' + cohortId, fetcher);
  const numDoc = await fsGet(projectId, token, 'releaseControl/numericPilot_cohort_' + cohortId, fetcher);
  const coachDoc = coachId ? await fsGet(projectId, token, 'coaches/' + coachId, fetcher) : null;
  const canaryCohort = coachDoc && coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.cohorts && coachDoc.autoApplyCanary.cohorts[cohortId] || null;
  return { releaseFence: relDoc, numericFence: numDoc, coachCanaryCohort: canaryCohort, coachCanaryEnabled: !!(coachDoc && coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.enabled === true) };
}

async function vget(vercelToken, p, fetcher = globalThis.fetch) {
  const url = 'https://api.vercel.com' + p + (p.includes('?') ? '&' : '?') + 'teamId=' + DEFAULT_TEAM_ID;
  const r = await fetcher(url, { headers: { authorization: 'Bearer ' + vercelToken }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200, 'VERCEL_GET_FAILED_' + r.status + '_' + p);
  return r.json();
}

async function verifyFleetDeploymentLive(vercelToken, deploymentId, expectedSha, expectedCohortEnvName, fetcher = globalThis.fetch) {
  const d = await vget(vercelToken, '/v13/deployments/' + encodeURIComponent(deploymentId), fetcher);
  assert.equal(d.id || d.uid, deploymentId, 'DEPLOYMENT_ID_MISMATCH');
  assert.equal(d.projectId, DEFAULT_PROJECT_ID, 'PROJECT_ID_MISMATCH');
  assert.equal(d.teamId || d.ownerId, DEFAULT_TEAM_ID, 'TEAM_ID_MISMATCH');
  assert.equal(d.readyState, 'READY', 'DEPLOYMENT_NOT_READY');
  assert.equal(d.target, 'production', 'DEPLOYMENT_NOT_PRODUCTION');
  assert.equal(d.meta && d.meta.githubCommitSha, expectedSha, 'DEPLOYMENT_SHA_MISMATCH');
  const envNames = (Array.isArray(d.env) ? d.env : []).map(e => typeof e === 'string' ? e : (e && e.key)).filter(Boolean);
  assert.ok(!envNames.includes('CRON_SECRET'), 'CRON_SECRET_FORBIDDEN');
  for (const req of ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'VDSEN_NUMERIC_PILOT_ENABLED', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA']) {
    assert.ok(envNames.includes(req), 'MISSING_REQUIRED_ENV_' + req);
  }
  if (expectedCohortEnvName) {
    const expectedList = Array.isArray(expectedCohortEnvName) ? expectedCohortEnvName : [expectedCohortEnvName];
    for (const shardName of expectedList) {
      assert.ok(envNames.includes(shardName), 'MISSING_COHORT_SHARD_' + shardName);
    }
  }
  const aliasData = await vget(vercelToken, '/v2/aliases/' + encodeURIComponent(EXPECTED_ALIAS), fetcher);
  const liveId = aliasData.deploymentId || (aliasData.deployment && aliasData.deployment.id);
  assert.equal(liveId, deploymentId, 'LIVE_ALIAS_TARGET_MISMATCH: expected=' + deploymentId + ' actual=' + liveId);
  return { attested: true, deploymentId, runtimeSha: expectedSha, alias: EXPECTED_ALIAS, envNames };
}

async function prepareFleetRuntime(opts) {
  const { projectId, googleToken, vercelToken, runtimeSha, operationId, startsAt, expiresAt, coachId, outFile } = opts;
  const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  assert.equal(s.runtime_sha, runtimeSha, 'BASELINE_SHA_MISMATCH');
  const baselineDeployment = s.production_deployment;
  assert.equal(await A.currentApp(s), baselineDeployment, 'LIVE_ALIAS_NOT_ON_BASELINE');

  // Verify project-level Numeric Guard is OFF
  const envBefore = await vget(vercelToken, '/v9/projects/' + DEFAULT_PROJECT_ID + '/env?decrypt=false');
  const offBefore = G.evaluateProductionEnv(envBefore.envs, { project: DEFAULT_PROJECT_ID, team: DEFAULT_TEAM_ID });
  assert.equal(offBefore.status, 'DISARMED', 'PROJECT_NUMERIC_GUARD_NOT_DISARMED');

  // Load live roster and build isolated cohorts (<= 10 clients each)
  const manifest = await loadLiveRoster(projectId, googleToken, { runtimeSha, operationId, startsAt, expiresAt });
  assert.ok(manifest.cohortCount >= 1 && manifest.cohortCount <= 20, 'INVALID_COHORT_COUNT_' + manifest.cohortCount);

  // Confirm all cohort fences are CLOSED before promotion
  for (const co of manifest.cohorts) {
    const f = await fetchCohortFences(projectId, googleToken, co.cohortId, coachId);
    assert.ok(!(f.releaseFence && f.releaseFence.enabled === true), 'COHORT_RELEASE_FENCE_ALREADY_OPEN_' + co.cohortId);
    assert.ok(!(f.numericFence && f.numericFence.enabled === true), 'COHORT_NUMERIC_FENCE_ALREADY_OPEN_' + co.cohortId);
  }

  const tmpRoot = path.resolve(process.env.RUNNER_TEMP || require('node:os').tmpdir());
  const dest = path.resolve(tmpRoot, 'vdsen-fleet-' + (process.env.GITHUB_RUN_ID || Date.now()));
  A.exportCandidateTree(runtimeSha, dest);
  A.verifyExportedTree(runtimeSha, dest, A.servedSurface());

  const args = [
    'deploy', '--prod', '--skip-domain', '--yes',
    '-e', 'AUTONOMOUS_PROGRESSION_ENABLED=true',
    '-e', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=true',
    '-e', 'VDSEN_NUMERIC_PILOT_ENABLED=true',
    '-e', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA=' + runtimeSha,
    '-m', 'githubCommitSha=' + runtimeSha,
    '-m', 'vdsenPilotOperation=' + operationId,
    '-m', 'vdsenFleetCohorts=' + String(manifest.cohortCount),
    '-m', 'vdsenBaselineDeployment=' + baselineDeployment,
  ];
  for (const co of manifest.cohorts) {
    for (const sh of co.envShards) {
      args.push('-e', sh.name + '=' + JSON.stringify(sh.windows));
    }
  }

  const r = await A.runVercelCli(args, dest, { VERCEL_ORG_ID: DEFAULT_TEAM_ID, VERCEL_PROJECT_ID: DEFAULT_PROJECT_ID });
  assert.equal(r.code, 0, 'FLEET_DEPLOY_FAILED: ' + String(r.err || r.out).slice(0, 400));
  const match = (String(r.out) + '\n' + String(r.err)).match(/https:\/\/([A-Za-z0-9.-]+\.vercel\.app)/);
  assert.ok(match, 'FLEET_DEPLOY_URL_MISSING');
  const staged = await A.deployment(s, match[1]);
  const stagedId = staged.id || staged.uid;

  // Confirm project Numeric Guard stayed DISARMED
  const envAfter = await vget(vercelToken, '/v9/projects/' + DEFAULT_PROJECT_ID + '/env?decrypt=false');
  const offAfter = G.evaluateProductionEnv(envAfter.envs, { project: DEFAULT_PROJECT_ID, team: DEFAULT_TEAM_ID });
  G.assertPromotionAllowed({ preflight: offBefore, fresh: offAfter });

  try {
    await A.promote(s, stagedId);
    const verifiedPaths = await A.verifyPublicBytes(s, runtimeSha, A.servedSurface());
    const allShardNames = manifest.cohorts.flatMap(co => co.envVarNames);
    const att = await verifyFleetDeploymentLive(vercelToken, stagedId, runtimeSha, allShardNames);
    const report = {
      schema: 'vdsen-fleet-runtime-prep-v1',
      status: 'FLEET_RUNTIME_READY_FENCES_CLOSED',
      operationId,
      runtimeSha,
      baselineDeployment,
      fleetDeployment: stagedId,
      fleetUrl: staged.url,
      verifiedPublicPaths: verifiedPaths.length,
      attestation: att,
      rosterSummary: {
        totalClients: manifest.totalClients,
        eligibleCount: manifest.eligibleCount,
        eligibleWithUpdatedAt: manifest.eligibleWithUpdatedAt,
        eligibleMissingUpdatedAt: manifest.eligibleMissingUpdatedAt,
        excludedCount: manifest.excludedCount,
        excludedByReason: manifest.excludedByReason,
        totalEligiblePids: manifest.totalEligiblePids,
        cohortCount: manifest.cohortCount,
      },
      cohorts: manifest.cohorts.map(co => ({
        cohortId: co.cohortId,
        envVarName: co.envVarName,
        envVarNames: co.envVarNames,
        envVarBytes: co.envVarBytes,
        operationId: co.operationId,
        clientCount: co.clientCount,
        pidCount: co.pidCount,
        clientIds: co.clientIds,
      })),
      preparedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (err) {
    await A.revertApp(s, baselineDeployment).catch(() => {});
    throw err;
  }
}

async function preflightCohort(opts) {
  const { projectId, googleToken, vercelToken, cohortId, deploymentId, runtimeSha, operationId, startsAt, expiresAt, coachId, outFile, fetcher = globalThis.fetch, commercialRosterPath } = opts;
  const manifest = await loadLiveRoster(projectId, googleToken, { runtimeSha, operationId, startsAt, expiresAt, fetcher, commercialRosterPath });
  const co = manifest.cohorts.find(x => x.cohortId === cohortId);
  assert.ok(co, 'COHORT_NOT_FOUND_' + cohortId);

  const att = await verifyFleetDeploymentLive(vercelToken, deploymentId, runtimeSha, co.envVarNames, fetcher);
  const fences = await fetchCohortFences(projectId, googleToken, cohortId, coachId, fetcher);
  const priorLedger = await fsGet(projectId, googleToken, 'releaseControl/numericPilot/operations/' + co.operationId, fetcher);

  const blockers = [];
  if (fences.releaseFence && fences.releaseFence.enabled === true) blockers.push('COHORT_RELEASE_FENCE_ALREADY_ACTIVE');
  if (fences.numericFence && fences.numericFence.enabled === true) blockers.push('COHORT_NUMERIC_FENCE_ALREADY_ACTIVE');
  if (priorLedger) blockers.push('OPERATION_ALREADY_IN_LEDGER');
  if (co.clientCount < 1 || co.clientCount > MAX_COHORT_CLIENTS) blockers.push('COHORT_CAP_VIOLATION');
  const now = Date.now();
  for (const w of co.compactWindows) {
    if (!C.windowValid(w, now)) blockers.push('WINDOW_INVALID_' + w.uid);
  }

  const decision = blockers.length === 0 ? 'GO' : 'NO-GO';
  const result = {
    schema: 'vdsen-cohort-preflight-v1',
    decision,
    cohortId,
    operationId: co.operationId,
    deploymentId,
    runtimeSha,
    clientCount: co.clientCount,
    pidCount: co.pidCount,
    clientIds: co.clientIds,
    attestation: att,
    blockers,
    checkedAt: new Date().toISOString(),
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  }
  return { result, cohort: co, manifest };
}

async function armCohort(opts) {
  const { projectId, googleToken, cohortId, coachId, runId, outFile } = opts;
  const { result: pf, cohort: co } = await preflightCohort(opts);
  assert.equal(pf.decision, 'GO', 'COHORT_PREFLIGHT_NOT_GO: ' + JSON.stringify(pf.blockers));

  const nowIso = new Date().toISOString();
  const windowsMap = {};
  for (const client of co.clients) {
    const w = co.compactWindows.find(x => x.uid === client.uid);
    windowsMap[client.uid] = Object.assign({}, w, { pids: client.pids, enabled: true });
  }
  const ledgerWindows = {};
  for (const w of co.compactWindows) ledgerWindows[w.uid] = w;

  const writes = [
    {
      update: {
        name: docName(projectId, 'releaseControl/numericPilot/operations/' + co.operationId),
        fields: toFsFields({
          schema: 'vdsen-numeric-operations-ledger-v1',
          status: 'RESERVED',
          operationId: co.operationId,
          cohortId: co.cohortId,
          runtimeSha: opts.runtimeSha,
          deploymentId: opts.deploymentId,
          runId: String(runId || ''),
          reservedAt: nowIso,
          windows: ledgerWindows,
          scope: {
            schema: 'vdsen-canary-cohort-v1',
            enabled: true,
            cohort: true,
            cohortId: co.cohortId,
            clientIds: co.clientIds,
            prescriptionExerciseIds: co.allPids,
          },
          appliedRecordKeys: [],
          history: [{ sequence: 1, action: 'COHORT_RESERVED', at: nowIso, actor: 'vdsen-release-bot' }],
        }),
      },
      currentDocument: { exists: false },
    },
    {
      update: {
        name: docName(projectId, 'releaseControl/autonomousProgression_cohort_' + co.cohortId),
        fields: toFsFields({
          schema: 'vdsen-autonomous-release-v1',
          enabled: true,
          cohortId: co.cohortId,
          operationId: co.operationId,
          clientIds: co.clientIds,
          expiresAt: opts.expiresAt,
          updatedAt: nowIso,
        }),
      },
    },
    {
      update: {
        name: docName(projectId, 'releaseControl/numericPilot_cohort_' + co.cohortId),
        fields: toFsFields({
          schema: C.COHORT_SCHEMA,
          enabled: true,
          cohortId: co.cohortId,
          operationId: co.operationId,
          runtimeSha: opts.runtimeSha,
          expiresAt: opts.expiresAt,
          windows: windowsMap,
          updatedAt: nowIso,
        }),
      },
    },
    {
      update: {
        name: docName(projectId, 'coaches/' + coachId),
        fields: toFsFields({
          autoApplyCanary: {
            enabled: true,
            schema: 'vdsen-canary-cohort-v1',
            cohort: true,
            cohorts: {
              [co.cohortId]: {
                enabled: true,
                cohortId: co.cohortId,
                operationId: co.operationId,
                clientIds: co.clientIds,
                prescriptionExerciseIds: co.allPids,
                expiresAt: opts.expiresAt,
                updatedAt: nowIso,
              },
            },
          },
        }),
      },
      updateMask: {
        fieldPaths: [
          'autoApplyCanary.enabled',
          'autoApplyCanary.schema',
          'autoApplyCanary.cohort',
          'autoApplyCanary.cohorts.`' + co.cohortId + '`',
        ],
      },
    },
  ];

  const fetcher = opts.fetcher || globalThis.fetch;
  await fsCommit(projectId, googleToken, writes, fetcher);
  const verifiedFences = await fetchCohortFences(projectId, googleToken, co.cohortId, coachId, fetcher);
  assert.equal(verifiedFences.releaseFence && verifiedFences.releaseFence.enabled, true, 'VERIFY_RELEASE_FENCE_FAILED');
  assert.equal(verifiedFences.numericFence && verifiedFences.numericFence.enabled, true, 'VERIFY_NUMERIC_FENCE_FAILED');
  assert.equal(verifiedFences.coachCanaryCohort && verifiedFences.coachCanaryCohort.enabled, true, 'VERIFY_COACH_COHORT_FAILED');

  const out = {
    schema: 'vdsen-cohort-arm-result-v1',
    status: 'COHORT_ARMED_VERIFIED',
    cohortId: co.cohortId,
    operationId: co.operationId,
    deploymentId: opts.deploymentId,
    runtimeSha: opts.runtimeSha,
    clientCount: co.clientCount,
    pidCount: co.pidCount,
    clientIds: co.clientIds,
    armedAt: nowIso,
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  }
  return out;
}

async function discoverOpenCohortIds(projectId, googleToken, coachId, fetcher = globalThis.fetch) {
  const discovered = new Set();
  const discoveryErrors = [];
  try {
    const rcDocs = await fsList(projectId, googleToken, 'releaseControl', fetcher);
    for (const d of rcDocs) {
      const id = String(d && d._id || '');
      if (id.startsWith('autonomousProgression_cohort_')) discovered.add(id.slice('autonomousProgression_cohort_'.length));
      if (id.startsWith('numericPilot_cohort_')) discovered.add(id.slice('numericPilot_cohort_'.length));
    }
  } catch (err) {
    discoveryErrors.push('RELEASE_CONTROL_LIST_FAILED: ' + (err && err.message ? err.message : String(err)));
  }
  if (coachId) {
    try {
      const coachDoc = await fsGet(projectId, googleToken, 'coaches/' + coachId, fetcher);
      const cohortsMap = coachDoc && coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.cohorts;
      if (cohortsMap && typeof cohortsMap === 'object') {
        for (const cid of Object.keys(cohortsMap)) discovered.add(cid);
      }
    } catch (err) {
      discoveryErrors.push('COACH_DOC_READ_FAILED: ' + (err && err.message ? err.message : String(err)));
    }
  }
  return {
    cohortIds: [...discovered].filter(Boolean).sort(),
    discoveryErrors,
    complete: discoveryErrors.length === 0,
  };
}

function _sameSortedArray(a, b) {
  const sa = (Array.isArray(a) ? a : []).map(String).sort();
  const sb = (Array.isArray(b) ? b : []).map(String).sort();
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function _verifyCohortAuthorizationExact(co, f, activeSet, expectedRuntimeSha) {
  const mismatches = [];
  const outOfRoster = new Set();
  const rel = f.releaseFence;
  const num = f.numericFence;
  const cc = f.coachCanaryCohort;
  const relEnabled = !!(rel && rel.enabled === true);
  const numEnabled = !!(num && num.enabled === true);
  const ccEnabled = !!(cc && cc.enabled === true);

  if (rel && Array.isArray(rel.clientIds)) {
    for (const u of rel.clientIds) if (activeSet && !activeSet.has(u)) outOfRoster.add(u);
  }
  if (num && num.windows && typeof num.windows === 'object') {
    for (const u of Object.keys(num.windows)) if (activeSet && !activeSet.has(u)) outOfRoster.add(u);
  }
  if (cc && Array.isArray(cc.clientIds)) {
    for (const u of cc.clientIds) if (activeSet && !activeSet.has(u)) outOfRoster.add(u);
  }

  if (!relEnabled) mismatches.push('RELEASE_FENCE_DISABLED');
  if (!numEnabled) mismatches.push('NUMERIC_FENCE_DISABLED');
  if (!ccEnabled) mismatches.push('COACH_COHORT_DISABLED');
  if (!f.coachCanaryEnabled) mismatches.push('COACH_CANARY_DISABLED');

  if (relEnabled && !_sameSortedArray(rel.clientIds, co.clientIds)) mismatches.push('RELEASE_CLIENT_IDS_MISMATCH');
  if (ccEnabled && !_sameSortedArray(cc.clientIds, co.clientIds)) mismatches.push('COACH_CLIENT_IDS_MISMATCH');
  if (ccEnabled && !_sameSortedArray(cc.prescriptionExerciseIds, co.allPids)) mismatches.push('COACH_PIDS_MISMATCH');

  const opId = (num && num.operationId) || null;
  const expAt = (rel && rel.expiresAt) || null;
  const rtSha = (num && num.runtimeSha) || null;
  if (relEnabled && numEnabled && ccEnabled) {
    if (!opId || rel.operationId !== opId || cc.operationId !== opId) mismatches.push('OPERATION_ID_MISMATCH');
    if (!expAt || num.expiresAt !== expAt || cc.expiresAt !== expAt) mismatches.push('EXPIRES_AT_MISMATCH');
    if (expAt && (!Number.isFinite(Date.parse(expAt)) || Date.parse(expAt) <= Date.now())) mismatches.push('WINDOW_EXPIRED');
    if (!rtSha || !/^[0-9a-f]{40}$/.test(rtSha)) mismatches.push('RUNTIME_SHA_INVALID');
    if (expectedRuntimeSha && rtSha !== expectedRuntimeSha) mismatches.push('RUNTIME_SHA_MISMATCH');
  }

  if (numEnabled) {
    const winMap = (num.windows && typeof num.windows === 'object') ? num.windows : {};
    if (!_sameSortedArray(Object.keys(winMap), co.clientIds)) {
      mismatches.push('NUMERIC_WINDOW_CLIENTS_MISMATCH');
    } else {
      for (const client of co.clients) {
        const w = winMap[client.uid];
        if (!w || w.enabled !== true) { mismatches.push('WINDOW_DISABLED_' + client.uid); continue; }
        if (w.planId !== client.planId) mismatches.push('PLAN_ID_MISMATCH_' + client.uid);
        if (w.pidsHash !== client.pidsHash) mismatches.push('PIDS_HASH_MISMATCH_' + client.uid);
        if (w.pidCount !== client.pidCount) mismatches.push('PID_COUNT_MISMATCH_' + client.uid);
        if (!_sameSortedArray(w.pids, client.pids)) mismatches.push('PIDS_LIST_MISMATCH_' + client.uid);
        if (w.runtimeSha !== rtSha) mismatches.push('WINDOW_RUNTIME_SHA_MISMATCH_' + client.uid);
        if (w.operationId !== opId) mismatches.push('WINDOW_OPERATION_ID_MISMATCH_' + client.uid);
        if (w.expiresAt !== expAt) mismatches.push('WINDOW_EXPIRES_AT_MISMATCH_' + client.uid);
      }
    }
  }

  return {
    releaseFenceEnabled: relEnabled,
    numericFenceEnabled: numEnabled,
    coachCohortEnabled: ccEnabled,
    runtimeSha: rtSha,
    expiresAt: expAt,
    operationId: opId,
    exactMatch: mismatches.length === 0 && outOfRoster.size === 0,
    mismatches,
    outOfRosterClients: [...outOfRoster].sort(),
  };
}

async function auditFleet(opts) {
  const { projectId, googleToken, coachId, outFile, expectedRuntimeSha, fetcher = globalThis.fetch, commercialRosterPath } = opts;
  const reg = loadCommercialRoster(commercialRosterPath);
  const manifest = await loadLiveRoster(projectId, googleToken, { fetcher, commercialRegistry: reg });
  const expectedCohortSet = new Set(manifest.cohorts.map(c => c.cohortId));
  const discovery = await discoverOpenCohortIds(projectId, googleToken, coachId, fetcher);

  const cohortStates = [];
  const allOutOfRoster = new Set();
  for (const co of manifest.cohorts) {
    const f = await fetchCohortFences(projectId, googleToken, co.cohortId, coachId, fetcher);
    const v = _verifyCohortAuthorizationExact(co, f, reg.activeSet, expectedRuntimeSha);
    for (const u of v.outOfRosterClients) allOutOfRoster.add(u);
    cohortStates.push({
      cohortId: co.cohortId,
      clientCount: co.clientCount,
      pidCount: co.pidCount,
      releaseFenceEnabled: v.releaseFenceEnabled,
      numericFenceEnabled: v.numericFenceEnabled,
      coachCohortEnabled: v.coachCohortEnabled,
      runtimeSha: v.runtimeSha,
      expiresAt: v.expiresAt,
      operationId: v.operationId,
      exactMatch: v.exactMatch,
      mismatches: v.mismatches,
    });
  }

  // Detect any stale/legacy cohorts still open outside the current commercial manifest
  const staleOpenCohorts = [];
  for (const cid of discovery.cohortIds) {
    if (expectedCohortSet.has(cid)) continue;
    const f = await fetchCohortFences(projectId, googleToken, cid, coachId, fetcher);
    const anyOpen = !!(
      (f.releaseFence && f.releaseFence.enabled === true) ||
      (f.numericFence && f.numericFence.enabled === true) ||
      (f.coachCanaryCohort && f.coachCanaryCohort.enabled === true)
    );
    if (anyOpen) {
      staleOpenCohorts.push(cid);
      if (f.releaseFence && Array.isArray(f.releaseFence.clientIds)) {
        for (const u of f.releaseFence.clientIds) if (!reg.activeSet.has(u)) allOutOfRoster.add(u);
      }
      if (f.numericFence && f.numericFence.windows && typeof f.numericFence.windows === 'object') {
        for (const u of Object.keys(f.numericFence.windows)) if (!reg.activeSet.has(u)) allOutOfRoster.add(u);
      }
      if (f.coachCanaryCohort && Array.isArray(f.coachCanaryCohort.clientIds)) {
        for (const u of f.coachCanaryCohort.clientIds) if (!reg.activeSet.has(u)) allOutOfRoster.add(u);
      }
    }
  }

  const allCohortsArmed = cohortStates.length > 0 && cohortStates.every(x => x.releaseFenceEnabled && x.numericFenceEnabled && x.coachCohortEnabled);
  const outOfRosterClients = [...allOutOfRoster].sort();
  const exactCoverageVerified = allCohortsArmed &&
    cohortStates.every(x => x.exactMatch === true) &&
    staleOpenCohorts.length === 0 &&
    outOfRosterClients.length === 0 &&
    discovery.complete === true;

  const report = {
    schema: 'vdsen-fleet-audit-v1',
    status: discovery.complete ? 'FLEET_AUDIT_SUCCESS' : 'FLEET_AUDIT_INCOMPLETE',
    totalClients: manifest.totalClients,
    eligibleCount: manifest.eligibleCount,
    eligibleWithUpdatedAt: manifest.eligibleWithUpdatedAt,
    eligibleMissingUpdatedAt: manifest.eligibleMissingUpdatedAt,
    excludedCount: manifest.excludedCount,
    excludedByReason: manifest.excludedByReason,
    totalEligiblePids: manifest.totalEligiblePids,
    cohortCount: manifest.cohortCount,
    allCohortsArmed,
    exactCoverageVerified,
    staleOpenCohorts,
    outOfRosterClients,
    discoveryErrors: discovery.discoveryErrors,
    cohorts: cohortStates,
    auditedAt: new Date().toISOString(),
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

async function stopCohorts(opts) {
  const { projectId, googleToken, coachId, targetCohortId, reason, outFile, fetcher = globalThis.fetch, commercialRosterPath } = opts;
  let targets;
  const discoveryErrors = [];
  const incompleteReasons = [];

  if (targetCohortId === 'ALL') {
    const discovery = await discoverOpenCohortIds(projectId, googleToken, coachId, fetcher);
    discoveryErrors.push(...discovery.discoveryErrors);
    const union = new Set(discovery.cohortIds);
    try {
      const manifest = await loadLiveRoster(projectId, googleToken, { fetcher, commercialRosterPath });
      for (const co of manifest.cohorts) union.add(co.cohortId);
    } catch (err) {
      // Emergency STOP continues even if manifest is missing/updated, but records incomplete discovery if Firestore discovery also failed
      if (!discovery.complete) {
        incompleteReasons.push('MANIFEST_FALLBACK_UNAVAILABLE: ' + (err && err.message ? err.message : String(err)));
      }
    }
    targets = [...union].sort();
  } else {
    targets = [targetCohortId];
  }

  const nowIso = new Date().toISOString();
  const writes = [];
  for (const cid of targets) {
    writes.push(
      {
        update: {
          name: docName(projectId, 'releaseControl/autonomousProgression_cohort_' + cid),
          fields: toFsFields({ enabled: false, stoppedAt: nowIso, stopReason: reason || 'COHORT_STOP' }),
        },
        updateMask: { fieldPaths: ['enabled', 'stoppedAt', 'stopReason'] },
      },
      {
        update: {
          name: docName(projectId, 'releaseControl/numericPilot_cohort_' + cid),
          fields: toFsFields({ enabled: false, stoppedAt: nowIso, stopReason: reason || 'COHORT_STOP' }),
        },
        updateMask: { fieldPaths: ['enabled', 'stoppedAt', 'stopReason'] },
      },
      {
        update: {
          name: docName(projectId, 'coaches/' + coachId),
          fields: toFsFields({ autoApplyCanary: { cohorts: { [cid]: { enabled: false, stoppedAt: nowIso } } } }),
        },
        updateMask: { fieldPaths: ['autoApplyCanary.cohorts.`' + cid + '`.enabled', 'autoApplyCanary.cohorts.`' + cid + '`.stoppedAt'] },
      }
    );
  }
  if (targetCohortId === 'ALL') {
    writes.push({
      update: {
        name: docName(projectId, 'coaches/' + coachId),
        fields: toFsFields({ autoApplyCanary: { enabled: false } }),
      },
      updateMask: { fieldPaths: ['autoApplyCanary.enabled'] },
    });
  }
  if (writes.length > 0) {
    await fsCommit(projectId, googleToken, writes, fetcher);
  }

  // Mandatory post-STOP readback verification of all targeted fences
  const pendingCohorts = [];
  let coachCanaryDisabledVerified = targetCohortId !== 'ALL';
  for (const cid of targets) {
    try {
      const vf = await fetchCohortFences(projectId, googleToken, cid, coachId, fetcher);
      const stillOpen = !!(
        (vf.releaseFence && vf.releaseFence.enabled === true) ||
        (vf.numericFence && vf.numericFence.enabled === true) ||
        (vf.coachCanaryCohort && vf.coachCanaryCohort.enabled === true)
      );
      if (stillOpen) pendingCohorts.push(cid);
    } catch (err) {
      pendingCohorts.push(cid);
      incompleteReasons.push('POST_VERIFY_READ_FAILED_' + cid + ': ' + (err && err.message ? err.message : String(err)));
    }
  }
  if (targetCohortId === 'ALL' && coachId) {
    try {
      const coachDoc = await fsGet(projectId, googleToken, 'coaches/' + coachId, fetcher);
      const globalEnabled = !!(coachDoc && coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.enabled === true);
      coachCanaryDisabledVerified = !globalEnabled;
      if (globalEnabled) incompleteReasons.push('COACH_CANARY_STILL_ENABLED');
    } catch (err) {
      coachCanaryDisabledVerified = false;
      incompleteReasons.push('POST_VERIFY_COACH_READ_FAILED: ' + (err && err.message ? err.message : String(err)));
    }
  }

  if (discoveryErrors.length > 0) {
    incompleteReasons.push(...discoveryErrors);
  }
  const verifiedComplete = pendingCohorts.length === 0 && incompleteReasons.length === 0 && coachCanaryDisabledVerified;
  const out = {
    schema: 'vdsen-cohort-stop-v1',
    status: verifiedComplete ? 'STOPPED_VERIFIED' : 'STOP_INCOMPLETE',
    stoppedCohorts: targets.filter(cid => !pendingCohorts.includes(cid)),
    pendingCohorts,
    discoveryErrors,
    incompleteReasons,
    stoppedAt: nowIso,
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  }
  return out;
}

async function main() {
  const cmd = process.argv[2];
  const env = process.env;
  const projectId = env.GCP_PROJECT_ID || 'vdsen-ecosistema';
  const googleToken = env.GOOGLE_ACCESS_TOKEN;
  const vercelToken = env.VERCEL_TOKEN;
  const reportDir = env.REPORT_DIR || 'release-output/numeric-pilot';
  const uidInput = String(env.INPUT_UID || '');
  const cohortId = uidInput.startsWith('COHORT:') ? uidInput.slice('COHORT:'.length) : null;

  if (cmd === 'audit-fleet') {
    const rep = await auditFleet({ projectId, googleToken, coachId: env.INPUT_COACH, outFile: path.join(reportDir, 'fleet-audit.json') });
    console.log(JSON.stringify(rep, null, 2));
    if (rep.status !== 'FLEET_AUDIT_SUCCESS') process.exitCode = 1;
    return;
  }
  if (cmd === 'prepare-fleet-runtime') {
    const rep = await prepareFleetRuntime({
      projectId, googleToken, vercelToken,
      runtimeSha: env.INPUT_RUNTIME, operationId: env.INPUT_OPERATION,
      startsAt: env.INPUT_STARTS, expiresAt: env.INPUT_EXPIRES,
      coachId: env.INPUT_COACH, outFile: path.join(reportDir, 'fleet-runtime-prep.json'),
    });
    console.log(JSON.stringify(rep, null, 2));
    return;
  }
  if (cmd === 'preflight-cohort') {
    assert.ok(cohortId, 'COHORT_ID_REQUIRED');
    const { result } = await preflightCohort({
      projectId, googleToken, vercelToken, cohortId,
      deploymentId: env.INPUT_DEPLOYMENT, runtimeSha: env.INPUT_RUNTIME,
      operationId: env.INPUT_OPERATION, startsAt: env.INPUT_STARTS,
      expiresAt: env.INPUT_EXPIRES, coachId: env.INPUT_COACH,
      outFile: path.join(reportDir, 'cohort-preflight-' + cohortId + '.json'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.decision !== 'GO') process.exitCode = 1;
    return;
  }
  if (cmd === 'arm-cohort') {
    assert.ok(cohortId, 'COHORT_ID_REQUIRED');
    const rep = await armCohort({
      projectId, googleToken, vercelToken, cohortId,
      deploymentId: env.INPUT_DEPLOYMENT, runtimeSha: env.INPUT_RUNTIME,
      operationId: env.INPUT_OPERATION, startsAt: env.INPUT_STARTS,
      expiresAt: env.INPUT_EXPIRES, coachId: env.INPUT_COACH,
      runId: env.GITHUB_RUN_ID,
      outFile: path.join(reportDir, 'cohort-arm-' + cohortId + '.json'),
    });
    console.log(JSON.stringify(rep, null, 2));
    return;
  }
  if (cmd === 'stop-cohort') {
    const target = uidInput === 'FLEET:ALL' ? 'ALL' : cohortId;
    assert.ok(target, 'STOP_COHORT_TARGET_REQUIRED');
    const rep = await stopCohorts({
      projectId, googleToken, coachId: env.INPUT_COACH,
      targetCohortId: target, reason: env.INPUT_STOP_REASON || 'OPERATOR_COHORT_STOP',
      outFile: path.join(reportDir, 'cohort-stop.json'),
    });
    console.log(JSON.stringify(rep, null, 2));
    if (rep.status !== 'STOPPED_VERIFIED') process.exitCode = 1;
    return;
  }
  if (cmd === 'detect-plan-drift') {
    const rep = await detectPlanChangeDrift({
      projectId, googleToken, coachId: env.INPUT_COACH,
      outFile: path.join(reportDir, 'plan-change-drift.json'),
    });
    console.log(JSON.stringify(rep, null, 2));
    if (rep.status === 'BLOCKED_NEW_PLAN_INVALID') process.exitCode = 1;
    return;
  }
  if (cmd === 'renew-cohort') {
    assert.ok(cohortId, 'COHORT_ID_REQUIRED');
    const rep = await renewDriftedCohort({
      projectId, googleToken, vercelToken, cohortId,
      deploymentId: env.INPUT_DEPLOYMENT, runtimeSha: env.INPUT_RUNTIME,
      operationId: env.INPUT_OPERATION, startsAt: env.INPUT_STARTS,
      expiresAt: env.INPUT_EXPIRES, coachId: env.INPUT_COACH,
      runId: env.GITHUB_RUN_ID,
      outFile: path.join(reportDir, 'cohort-renew-' + cohortId + '.json'),
    });
    console.log(JSON.stringify(rep, null, 2));
    if (rep.status !== 'COHORT_RENEWED_VERIFIED') process.exitCode = 1;
    return;
  }
  if (cmd === 'renew-cohort-op') {
    const rep = await executeRenewCohortOperation({
      projectId,
      googleToken,
      vercelToken,
      operationId: env.INPUT_OPERATION,
      cohortId,
      runtimeSha: env.INPUT_RUNTIME,
      coachId: env.INPUT_COACH,
      clientId: env.INPUT_PID || '',
      planId: env.INPUT_PLAN || '',
      startsAt: env.INPUT_STARTS || '',
      expiresAt: env.INPUT_EXPIRES || '',
      renewalMode: env.INPUT_STOP_REASON || '',
      runId: env.GITHUB_RUN_ID || '',
      outFile: path.join(reportDir, 'cohort-renew-op-' + (env.INPUT_OPERATION || 'op') + '.json'),
    });
    console.log(JSON.stringify(rep, null, 2));
    if (rep.status !== 'RENEWED_VERIFIED') process.exitCode = 1;
    return;
  }
  throw new Error('UNKNOWN_COHORT_CMD: ' + cmd);
}

// T878 — Detect planId / PID / pidsHash drift for confirmed active clients when the Coach
// activates a new routine, and plan targeted renewal ONLY for affected cohorts without
// interrupting unaffected cohorts or expanding the commercial roster.
async function detectPlanChangeDrift(opts) {
  const { projectId, googleToken, coachId, outFile, expectedRuntimeSha, fetcher = globalThis.fetch, commercialRosterPath } = opts;
  const reg = loadCommercialRoster(commercialRosterPath);
  const manifest = await loadLiveRoster(projectId, googleToken, { fetcher, commercialRegistry: reg });

  const driftedClients = [];
  const blockedNewPlans = [];
  const affectedCohortSet = new Set();
  const unaffectedCohortIds = [];

  for (const ex of manifest.excluded || []) {
    if (reg.activeSet.has(ex.uid)) {
      blockedNewPlans.push({
        uid: ex.uid,
        planId: ex.planId || null,
        reason: ex.reason || 'NEW_PLAN_INVALID',
      });
    }
  }

  for (const co of manifest.cohorts) {
    const f = await fetchCohortFences(projectId, googleToken, co.cohortId, coachId, fetcher);
    const v = _verifyCohortAuthorizationExact(co, f, reg.activeSet, expectedRuntimeSha);
    const winMap = (f.numericFence && f.numericFence.windows && typeof f.numericFence.windows === 'object')
      ? f.numericFence.windows
      : {};
    let cohortHasDrift = false;

    for (const client of co.clients) {
      const w = winMap[client.uid] || null;
      const reasons = [];
      if (!w || w.enabled !== true) {
        reasons.push('WINDOW_MISSING_OR_DISABLED');
      } else {
        if (w.planId !== client.planId) reasons.push('PLAN_ID_CHANGED');
        if (w.pidsHash !== client.pidsHash) reasons.push('PIDS_HASH_CHANGED');
        if (w.pidCount !== client.pidCount) reasons.push('PID_COUNT_CHANGED');
        if (!_sameSortedArray(w.pids, client.pids)) reasons.push('PIDS_LIST_CHANGED');
      }
      const hasValidUpdatedAt = typeof client.updatedAt === 'string' && Number.isFinite(Date.parse(client.updatedAt));
      if (!hasValidUpdatedAt) {
        reasons.push('NEW_PLAN_MISSING_UPDATED_AT');
        blockedNewPlans.push({ uid: client.uid, cohortId: co.cohortId, planId: client.planId, reason: 'NEW_PLAN_MISSING_UPDATED_AT' });
      }
      if (reasons.length > 0) {
        cohortHasDrift = true;
        affectedCohortSet.add(co.cohortId);
        driftedClients.push({
          uid: client.uid,
          cohortId: co.cohortId,
          armedPlanId: w ? (w.planId || null) : null,
          livePlanId: client.planId,
          armedPidsHash: w ? (w.pidsHash || null) : null,
          livePidsHash: client.pidsHash,
          armedPidCount: w && Number.isFinite(w.pidCount) ? w.pidCount : 0,
          livePidCount: client.pidCount,
          reasons,
          readyForRenewal: hasValidUpdatedAt && client.pidCount >= 1,
        });
      }
    }
    if (!cohortHasDrift && v.exactMatch) {
      unaffectedCohortIds.push(co.cohortId);
    } else if (!cohortHasDrift && !v.exactMatch) {
      affectedCohortSet.add(co.cohortId);
    }
  }

  const affectedCohortIds = [...affectedCohortSet].sort();
  unaffectedCohortIds.sort();
  const status = blockedNewPlans.length > 0
    ? 'BLOCKED_NEW_PLAN_INVALID'
    : (driftedClients.length > 0 || affectedCohortIds.length > 0 ? 'DRIFT_DETECTED' : 'NO_DRIFT');

  const report = {
    schema: 'vdsen-plan-drift-v1',
    status,
    commercialActiveCount: reg.activeSet.size,
    driftedClients,
    blockedNewPlans,
    affectedCohortIds,
    unaffectedCohortIds,
    numericApplyBlockedUntilVerified: driftedClients.length > 0 || blockedNewPlans.length > 0,
    checkedAt: new Date().toISOString(),
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

async function renewDriftedCohort(opts) {
  const {
    projectId, googleToken, vercelToken, cohortId, deploymentId, runtimeSha,
    operationId, startsAt, expiresAt, coachId, runId, outFile,
    fetcher = globalThis.fetch, commercialRosterPath, force = false,
  } = opts;
  assert.ok(cohortId, 'COHORT_ID_REQUIRED');

  const drift = await detectPlanChangeDrift({
    projectId, googleToken, coachId, expectedRuntimeSha: runtimeSha, fetcher, commercialRosterPath,
  });
  const cohortBlocked = drift.blockedNewPlans.filter(b => !b.cohortId || b.cohortId === cohortId);
  assert.equal(cohortBlocked.length, 0, 'COHORT_RENEWAL_BLOCKED_INVALID_PLAN: ' + cohortBlocked.map(b => b.uid + ':' + b.reason).join(','));
  if (!force) {
    assert.ok(drift.affectedCohortIds.includes(cohortId), 'COHORT_NOT_AFFECTED_BY_DRIFT: ' + cohortId);
  }

  // Step 1: Invalidate incompatible prior authorization ONLY for the affected cohort
  // (blocks numeric apply for this cohort while leaving unaffected cohorts 100% uninterrupted).
  const stopped = await stopCohorts({
    projectId, googleToken, coachId,
    targetCohortId: cohortId,
    reason: 'PLAN_CHANGE_RENEWAL:' + (operationId || cohortId),
    fetcher, commercialRosterPath,
  });
  assert.equal(stopped.status, 'STOPPED_VERIFIED', 'COHORT_RENEWAL_STOP_INCOMPLETE: ' + JSON.stringify(stopped.incompleteReasons || []));

  // Step 2: Re-authorize ONLY the affected cohort via official preflightCohort -> armCohort.
  // Unaffected cohorts are never written and the 25-client commercial roster is never expanded.
  const armed = await armCohort({
    projectId, googleToken, vercelToken, cohortId, deploymentId, runtimeSha,
    operationId, startsAt, expiresAt, coachId, runId, fetcher, commercialRosterPath,
  });

  // Post-renewal exact verification for this cohort
  const reg = loadCommercialRoster(commercialRosterPath);
  const manifest = await loadLiveRoster(projectId, googleToken, { fetcher, commercialRegistry: reg });
  const co = manifest.cohorts.find(c => c.cohortId === cohortId);
  assert.ok(co, 'RENEWED_COHORT_NOT_FOUND_IN_MANIFEST: ' + cohortId);
  const f = await fetchCohortFences(projectId, googleToken, cohortId, coachId, fetcher);
  const v = _verifyCohortAuthorizationExact(co, f, reg.activeSet, runtimeSha);
  assert.equal(v.exactMatch, true, 'COHORT_RENEWAL_POST_VERIFY_FAILED: ' + v.mismatches.join(','));

  const report = {
    schema: 'vdsen-cohort-renewal-v1',
    status: 'COHORT_RENEWED_VERIFIED',
    cohortId,
    operationId,
    runtimeSha,
    deploymentId,
    renewedClients: drift.driftedClients.filter(d => d.cohortId === cohortId).map(d => ({
      uid: d.uid,
      previousPlanId: d.armedPlanId,
      newPlanId: d.livePlanId,
      previousPidsHash: d.armedPidsHash,
      newPidsHash: d.livePidsHash,
    })),
    unaffectedCohortIds: drift.unaffectedCohortIds,
    exactMatch: v.exactMatch,
    armed,
    verifiedAt: new Date().toISOString(),
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

// T882 — Autonomous GitHub Actions cohort renewal orchestrator (`renew-cohort`).
// Executes the full 19-step state machine with:
//   - Persistent ledger updates (`VALIDATING` -> `PREPARING_RUNTIME` -> `DEPLOYING` ->
//     `VERIFYING_RUNTIME` -> `PROMOTING` -> `REARMING` -> `RENEWED_VERIFIED`)
//   - Effective STOP checks (`releaseControl/autoCohortRenewalControl`) at start, pre-build, pre-promote, and pre-rearm
//   - Preservation of ALL 5 cohort shard slots and unaffected cohorts (zero permanent project-level shards)
//   - Optimistic concurrency checks (live alias + live client activePlanId re-read before promotion)
//   - Granular phase-aware rollback (never reverts a newer legitimate promotion, never deletes logbooks)
async function executeRenewCohortOperation(opts) {
  const {
    projectId = 'vdsen-ecosistema',
    googleToken,
    vercelToken,
    operationId,
    cohortId: inputCohortId,
    runtimeSha: inputRuntimeSha,
    coachId: inputCoachId,
    clientId: inputClientId = '',
    planId: inputPlanId = '',
    startsAt: inputStartsAt = '',
    expiresAt: inputExpiresAt = '',
    renewalMode: inputRenewalMode = '',
    runId = '',
    outFile,
    io = {},
  } = opts || {};

  assert.ok(operationId && /^[a-zA-Z0-9_-]{8,80}$/.test(operationId), 'RENEW_OP_ID_INVALID');

  const now = () => (typeof io.now === 'function' ? io.now() : new Date().toISOString());
  const readDoc = io.readDoc || ((docPath) => fsGet(projectId, googleToken, docPath));
  const writeDoc = io.writeDoc || (async (docPath, data) => {
    const url = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents/' + docPath;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + googleToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFsFields(data) }),
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(r.ok, 'FS_WRITE_FAILED_' + r.status + ':' + docPath);
    return r.json();
  });
  const loadRoster = io.loadLiveRoster || ((p) => loadLiveRoster(projectId, googleToken, p));
  const getCurrentAlias = io.currentApp || (async () => {
    const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
    return A.currentApp(s);
  });
  const checkNumericGuardOff = io.checkNumericGuardOff || (async () => {
    const envData = await vget(vercelToken, '/v9/projects/' + DEFAULT_PROJECT_ID + '/env?decrypt=false');
    const res = G.evaluateProductionEnv(envData.envs, { project: DEFAULT_PROJECT_ID, team: DEFAULT_TEAM_ID });
    assert.equal(res.status, 'DISARMED', 'PROJECT_NUMERIC_GUARD_NOT_DISARMED');
    return res;
  });
  const buildDeployment = io.buildDeployment || (async ({ runtimeSha, operationId: opId, baselineDeployment, cohorts }) => {
    const tmpRoot = path.resolve(process.env.RUNNER_TEMP || require('node:os').tmpdir());
    const dest = path.resolve(tmpRoot, 'vdsen-renew-' + (runId || Date.now()));
    A.exportCandidateTree(runtimeSha, dest);
    A.verifyExportedTree(runtimeSha, dest, A.servedSurface());
    const args = [
      'deploy', '--prod', '--skip-domain', '--yes',
      '-e', 'AUTONOMOUS_PROGRESSION_ENABLED=true',
      '-e', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=true',
      '-e', 'VDSEN_NUMERIC_PILOT_ENABLED=true',
      '-e', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA=' + runtimeSha,
      '-m', 'githubCommitSha=' + runtimeSha,
      '-m', 'vdsenPilotOperation=' + opId,
      '-m', 'vdsenFleetCohorts=' + String(cohorts.length),
      '-m', 'vdsenBaselineDeployment=' + baselineDeployment,
    ];
    for (const co of cohorts) {
      for (const sh of co.envShards) {
        args.push('-e', sh.name + '=' + JSON.stringify(sh.windows));
      }
    }
    const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
    const r = await A.runVercelCli(args, dest, { VERCEL_ORG_ID: DEFAULT_TEAM_ID, VERCEL_PROJECT_ID: DEFAULT_PROJECT_ID });
    assert.equal(r.code, 0, 'RENEW_DEPLOY_FAILED: ' + String(r.err || r.out).slice(0, 300));
    const match = (String(r.out) + '\n' + String(r.err)).match(/https:\/\/([A-Za-z0-9.-]+\.vercel\.app)/);
    assert.ok(match, 'RENEW_DEPLOY_URL_MISSING');
    const staged = await A.deployment(s, match[1]);
    return { deploymentId: staged.id || staged.uid, url: staged.url, readyState: staged.readyState || staged.ready };
  });
  const verifyCandidate = io.verifyCandidate || (async ({ deploymentId, runtimeSha, shardNames }) => {
    const d = await vget(vercelToken, '/v13/deployments/' + encodeURIComponent(deploymentId));
    assert.equal(d.projectId, DEFAULT_PROJECT_ID, 'PROJECT_ID_MISMATCH');
    assert.equal(d.teamId || d.ownerId, DEFAULT_TEAM_ID, 'TEAM_ID_MISMATCH');
    assert.equal(d.readyState, 'READY', 'DEPLOYMENT_NOT_READY');
    assert.equal(d.target, 'production', 'DEPLOYMENT_NOT_PRODUCTION');
    assert.equal(d.meta && d.meta.githubCommitSha, runtimeSha, 'DEPLOYMENT_SHA_MISMATCH');
    const envNames = (Array.isArray(d.env) ? d.env : []).map(e => typeof e === 'string' ? e : (e && e.key)).filter(Boolean);
    assert.ok(!envNames.includes('CRON_SECRET'), 'CRON_SECRET_FORBIDDEN');
    for (const req of ['AUTONOMOUS_PROGRESSION_ENABLED', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED', 'VDSEN_NUMERIC_PILOT_ENABLED', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA']) {
      assert.ok(envNames.includes(req), 'MISSING_REQUIRED_ENV_' + req);
    }
    for (const sh of shardNames) {
      assert.ok(envNames.includes(sh), 'MISSING_COHORT_SHARD_' + sh);
    }
    return { verified: true, deploymentId, runtimeSha, envNames };
  });
  const promoteDeployment = io.promoteDeployment || (async ({ deploymentId, runtimeSha }) => {
    const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
    await A.promote(s, deploymentId);
    const verifiedPaths = await A.verifyPublicBytes(s, runtimeSha, A.servedSurface());
    return { promoted: true, deploymentId, verifiedPublicPaths: verifiedPaths.length };
  });
  const revertDeployment = io.revertDeployment || (async (targetDeploymentId) => {
    const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
    await A.revertApp(s, targetDeploymentId);
    assert.equal(await A.currentApp(s), targetDeploymentId, 'ROLLBACK_ALIAS_MISMATCH');
    return { restored: true, deploymentId: targetDeploymentId };
  });
  const rearmCohortFences = io.rearmCohortFences || (async ({ cohort, coachId, runtimeSha, operationId: opId, startsAt, expiresAt }) => {
    const relPath = 'releaseControl/autonomousProgression_cohort_' + cohort.cohortId;
    const numPath = 'releaseControl/numericPilot_cohort_' + cohort.cohortId;
    const coachPath = 'coaches/' + coachId;
    const windowsMap = {};
    for (const cl of cohort.clients) {
      windowsMap[cl.uid] = {
        schema: C.COHORT_SCHEMA,
        mode: 'NUMERIC_APPLY',
        cohortId: cohort.cohortId,
        enabled: true,
        uid: cl.uid,
        planId: cl.planId,
        pids: cl.pids,
        pidCount: cl.pidCount,
        pidsHash: cl.pidsHash,
        runtimeSha,
        operationId: opId,
        startsAt,
        expiresAt,
      };
    }
    const coachDoc = (await readDoc(coachPath)) || {};
    const existingCohorts = (coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.cohorts) || {};
    const nextCohorts = Object.assign({}, existingCohorts, {
      [cohort.cohortId]: {
        enabled: true,
        cohortId: cohort.cohortId,
        operationId: opId,
        startsAt,
        expiresAt,
        clientIds: cohort.clientIds,
        prescriptionExerciseIds: cohort.allPids,
      },
    });
    await writeDoc(relPath, {
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      cohortId: cohort.cohortId,
      operationId: opId,
      startsAt,
      expiresAt,
      clientIds: cohort.clientIds,
    });
    await writeDoc(numPath, {
      schema: C.COHORT_SCHEMA,
      mode: 'NUMERIC_APPLY',
      enabled: true,
      cohortId: cohort.cohortId,
      operationId: opId,
      runtimeSha,
      startsAt,
      expiresAt,
      windows: windowsMap,
    });
    await writeDoc(coachPath, Object.assign({}, coachDoc, {
      autoApplyCanary: Object.assign({}, coachDoc.autoApplyCanary || {}, {
        enabled: true,
        cohorts: nextCohorts,
      }),
    }));
    return { rearmed: true, cohortId: cohort.cohortId };
  });
  const dispatchNextQueued = io.dispatchNextQueued || null;

  const opPath = 'releaseControl/numericPilot/operations/' + operationId;
  const lockPath = 'releaseControl/numericPilotGlobalLock';
  const stopPath = 'releaseControl/autoCohortRenewalControl';

  const checkStopFence = async () => {
    const sc = await readDoc(stopPath);
    if (sc && (sc.stopped === true || sc.enabled === false)) {
      const err = new Error('STOP_ACTIVE_DURING_RENEWAL:' + (sc.reason || 'AUTO_RENEWAL_STOPPED'));
      err.code = 'STOP_ACTIVE_DURING_RENEWAL';
      throw err;
    }
  };

  let opDoc = await readDoc(opPath);
  // T883: When Vercel runs with strictly read-only Firestore IAM (roles/datastore.viewer),
  // GitHub Actions (vdsen-release-bot WIF) bootstraps the persisted ledger, global lock,
  // and single-use pilotAuthorization atomically after independently validating inputs.
  if (!opDoc && inputClientId && inputPlanId && inputCohortId && inputCoachId && inputRuntimeSha && inputExpiresAt) {
    await checkStopFence();
    const curLock = (await readDoc(lockPath)) || { version: 0, activeOperationId: null, pendingQueue: [] };
    const activeOpId = curLock.activeOperationId || null;
    const activeLeaseMs = Date.parse(curLock.leaseExpiresAt || '');
    const nowIsoBoot = now();
    const nowMsBoot = Date.parse(nowIsoBoot);
    if (activeOpId && activeOpId !== operationId && Number.isFinite(activeLeaseMs) && activeLeaseMs > nowMsBoot) {
      throw new Error('GLOBAL_LOCK_HELD_BY_OTHER:' + activeOpId);
    }
    const resolvedMode = (inputRenewalMode === 'PILOT_RESTRICTED' || inputRenewalMode === 'GENERAL_AUTHORIZED')
      ? inputRenewalMode
      : 'GENERAL_AUTHORIZED';
    if (resolvedMode === 'PILOT_RESTRICTED') {
      const pAuthPath = 'releaseControl/numericPilot/pilotAuthorizations/' + operationId;
      const existingAuth = await readDoc(pAuthPath);
      if (existingAuth && existingAuth.consumed === true) {
        throw new Error('PILOT_AUTHORIZATION_ALREADY_CONSUMED:' + operationId);
      }
      await writeDoc(pAuthPath, {
        schema: 'vdsen-auto-renewal-pilot-scope-v1',
        operationId,
        uid: inputClientId,
        planId: inputPlanId,
        cohortId: inputCohortId,
        consumed: true,
        consumedAt: nowIsoBoot,
        bootstrappedByWorkflow: true,
      });
    }
    const nextLockVersion = (Number(curLock.version) || 0) + 1;
    const leaseExpiresAt = new Date(nowMsBoot + 15 * 60 * 1000).toISOString();
    opDoc = {
      schema: 'vdsen-plan-activation-sync-ledger-v1',
      operationId,
      renewalMode: resolvedMode,
      cohortId: inputCohortId,
      clientId: inputClientId,
      coachUid: inputCoachId,
      planId: inputPlanId,
      runtimeSha: inputRuntimeSha,
      startsAt: inputStartsAt || nowIsoBoot,
      expiresAt: inputExpiresAt,
      status: 'REQUESTED',
      lockVersion: nextLockVersion,
      workflowRunId: runId || null,
      bootstrappedByWorkflow: true,
      requestedAt: nowIsoBoot,
      updatedAt: nowIsoBoot,
      leaseExpiresAt,
      history: [{ state: 'REQUESTED', at: nowIsoBoot, lockVersion: nextLockVersion, bootstrappedByWorkflow: true }],
    };
    await writeDoc(opPath, opDoc);
    await writeDoc(lockPath, {
      schema: 'vdsen-numeric-global-lock-v1',
      activeOperationId: operationId,
      cohortId: inputCohortId,
      clientId: inputClientId,
      planId: inputPlanId,
      status: 'REQUESTED',
      acquiredAt: nowIsoBoot,
      updatedAt: nowIsoBoot,
      leaseExpiresAt,
      pendingQueue: Array.isArray(curLock.pendingQueue) ? curLock.pendingQueue.filter(q => q && q.operationId !== operationId) : [],
      version: nextLockVersion,
    });
  }
  assert.ok(opDoc, 'PERSISTED_OPERATION_NOT_FOUND:' + operationId);
  assert.ok(['REQUESTED', 'QUEUED', 'VALIDATING'].includes(opDoc.status), 'OPERATION_STATE_NOT_ELIGIBLE:' + opDoc.status);
  const cohortId = inputCohortId || opDoc.cohortId;
  const clientId = opDoc.clientId;
  const expectedPlanId = opDoc.planId;
  const coachId = inputCoachId || opDoc.coachUid;
  const runtimeSha = inputRuntimeSha || opDoc.runtimeSha;
  assert.ok(cohortId && clientId && expectedPlanId && coachId && runtimeSha, 'OPERATION_METADATA_INCOMPLETE');
  // T883-B1: Never trust workflow_dispatch inputs blindly; verify against persisted ledger doc
  if (inputCohortId) assert.equal(opDoc.cohortId, inputCohortId, 'OPERATION_COHORT_MISMATCH');
  if (inputCoachId && opDoc.coachUid) assert.equal(opDoc.coachUid, inputCoachId, 'OPERATION_REQUESTER_MISMATCH');
  if (inputRuntimeSha && opDoc.runtimeSha) assert.equal(opDoc.runtimeSha, inputRuntimeSha, 'OPERATION_RUNTIME_SHA_MISMATCH');

  // T883-B3: Capture monotonic fencing token (`lockVersion`) and verify active lock ownership + unexpired lease
  let expectedLockVersion = null;
  const verifyFencingLock = async (stage) => {
    const curLock = await readDoc(lockPath);
    if (!curLock) return; // legacy tests without lock doc
    assert.equal(curLock.activeOperationId, operationId, 'STALE_LOCK_FENCING_ABORT:ACTIVE_OP_CHANGED_AT_' + stage);
    if (expectedLockVersion !== null && curLock.version !== undefined) {
      assert.equal(Number(curLock.version), expectedLockVersion, 'STALE_LOCK_FENCING_ABORT:VERSION_MISMATCH_AT_' + stage);
    }
    if (curLock.leaseExpiresAt) {
      const leaseMs = Date.parse(curLock.leaseExpiresAt);
      const nowMs = Date.parse(now());
      assert.ok(Number.isFinite(leaseMs) && leaseMs > nowMs, 'STALE_LOCK_FENCING_ABORT:LEASE_EXPIRED_AT_' + stage);
    }
  };
  const initialLock = await readDoc(lockPath);
  if (initialLock) {
    expectedLockVersion = Number(opDoc.lockVersion !== undefined ? opDoc.lockVersion : initialLock.version);
    await verifyFencingLock('VALIDATING');
  }

  const history = Array.isArray(opDoc.history) ? opDoc.history.slice(-20) : [];
  const transition = async (state, extra = {}) => {
    const at = now();
    history.push(Object.assign({ state, at }, extra.errorCode ? { errorCode: extra.errorCode } : {}));
    opDoc = Object.assign({}, opDoc, {
      status: state,
      workflowRunId: runId || opDoc.workflowRunId || null,
      updatedAt: at,
      history,
    }, extra);
    await writeDoc(opPath, opDoc);
  };

  const releaseGlobalLock = async (finalState) => {
    const curLock = (await readDoc(lockPath)) || {};
    const queue = Array.isArray(curLock.pendingQueue) ? curLock.pendingQueue.slice() : [];
    const nextQueued = queue.length > 0 ? queue[0] : null;
    if (curLock.activeOperationId === operationId) {
      await writeDoc(lockPath, Object.assign({}, curLock, {
        activeOperationId: null,
        status: 'IDLE',
        lastCompletedOperationId: operationId,
        lastFinalState: finalState,
        leaseExpiresAt: null,
        updatedAt: now(),
        version: (Number(curLock.version) || 0) + 1,
      }));
    }
    if (nextQueued && typeof dispatchNextQueued === 'function') {
      await dispatchNextQueued(nextQueued).catch(() => {});
    }
    return nextQueued;
  };

  let phase = 'VALIDATING';
  let previousDeploymentId = null;
  let candidateDeploymentId = null;
  let promoted = false;
  let fencesMutated = false;
  let prevFenceSnapshot = null;

  try {
    // 1–7. VALIDATING
    await transition('VALIDATING');
    await checkStopFence();
    const guardBefore = await checkNumericGuardOff();
    previousDeploymentId = await getCurrentAlias();
    assert.ok(previousDeploymentId, 'LIVE_ALIAS_UNAVAILABLE');

    const startsAt = opDoc.startsAt || now().replace(/\.\d{3}Z$/, 'Z');
    const expiresAt = opDoc.expiresAt;
    assert.ok(expiresAt && Date.parse(expiresAt) > Date.now(), 'RENEWAL_WINDOW_EXPIRED');

    const manifest = await loadRoster({ runtimeSha, operationId, startsAt, expiresAt });
    const targetCohort = manifest.cohorts.find(c => c.cohortId === cohortId);
    assert.ok(targetCohort, 'TARGET_COHORT_NOT_FOUND:' + cohortId);
    const targetClient = targetCohort.clients.find(c => c.uid === clientId);
    assert.ok(targetClient, 'TARGET_CLIENT_NOT_ELIGIBLE:' + clientId);
    assert.equal(targetClient.planId, expectedPlanId, 'PLAN_CHANGED_BEFORE_DEPLOY');
    if (targetClient.coachId) assert.equal(targetClient.coachId, coachId, 'CLIENT_COACH_OWNERSHIP_MISMATCH');
    if (opDoc.renewalMode === 'PILOT_RESTRICTED') {
      const pAuth = await readDoc('releaseControl/numericPilot/pilotAuthorizations/' + operationId);
      assert.ok(pAuth && pAuth.uid === clientId && pAuth.planId === expectedPlanId && pAuth.cohortId === cohortId, 'PILOT_AUTHORIZATION_VERIFICATION_FAILED');
    }

    const allShardNames = manifest.cohorts.flatMap(co => co.envVarNames);
    assert.equal(allShardNames.length, 5, 'EXPECTED_FIVE_SHARD_SLOTS_MISMATCH:' + allShardNames.length);
    const unaffectedCohortIds = manifest.cohorts.filter(c => c.cohortId !== cohortId).map(c => c.cohortId);

    // Capture affected cohort fences BEFORE any mutation for granular rollback
    prevFenceSnapshot = {
      rel: await readDoc('releaseControl/autonomousProgression_cohort_' + cohortId),
      num: await readDoc('releaseControl/numericPilot_cohort_' + cohortId),
      coach: await readDoc('coaches/' + coachId),
    };

    // 8–12. PREPARING_RUNTIME & DEPLOYING
    phase = 'PREPARING_RUNTIME';
    await transition('PREPARING_RUNTIME', { previousDeploymentId, shardNames: allShardNames });
    await checkStopFence();

    phase = 'DEPLOYING';
    await transition('DEPLOYING');
    const baselineState = io.baselineState || JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
    const buildRes = await buildDeployment({
      runtimeSha,
      operationId,
      baselineDeployment: baselineState.production_deployment,
      cohorts: manifest.cohorts,
    });
    candidateDeploymentId = buildRes && buildRes.deploymentId;
    assert.ok(candidateDeploymentId, 'CANDIDATE_DEPLOYMENT_ID_MISSING');

    // 13. VERIFYING_RUNTIME
    phase = 'VERIFYING_RUNTIME';
    await transition('VERIFYING_RUNTIME', { candidateDeploymentId });
    await verifyCandidate({ deploymentId: candidateDeploymentId, runtimeSha, shardNames: allShardNames });
    const guardAfter = await checkNumericGuardOff();
    G.assertPromotionAllowed({ preflight: guardBefore, fresh: guardAfter });

    // Optimistic concurrency re-read BEFORE promotion (STOP + fencing lock + alias + client activePlanId)
    await checkStopFence();
    await verifyFencingLock('PRE_PROMOTE');
    const liveAliasPrePromote = await getCurrentAlias();
    assert.equal(liveAliasPrePromote, previousDeploymentId, 'OPTIMISTIC_CONCURRENCY_ALIAS_CHANGED');
    const freshClientDoc = await readDoc('clients/' + clientId);
    if (freshClientDoc && freshClientDoc.activePlanId && freshClientDoc.activePlanId !== expectedPlanId) {
      const err = new Error('PLAN_CHANGED_DURING_DEPLOYMENT:' + freshClientDoc.activePlanId);
      err.code = 'PLAN_CHANGED_DURING_DEPLOYMENT';
      throw err;
    }

    // 14–15. PROMOTING
    phase = 'PROMOTING';
    await transition('PROMOTING');
    await promoteDeployment({ deploymentId: candidateDeploymentId, runtimeSha });
    promoted = true;
    const liveAliasPostPromote = await getCurrentAlias();
    assert.equal(liveAliasPostPromote, candidateDeploymentId, 'POST_PROMOTE_ALIAS_MISMATCH');

    // 16–17. REARMING (ONLY affected cohort; unaffected cohorts untouched)
    phase = 'REARMING';
    await transition('REARMING', { deploymentId: candidateDeploymentId });
    await checkStopFence();
    await verifyFencingLock('PRE_REARM');
    fencesMutated = true;
    await rearmCohortFences({
      cohort: targetCohort,
      coachId,
      runtimeSha,
      operationId,
      startsAt,
      expiresAt,
    });

    // 18–19. RENEWED_VERIFIED
    phase = 'RENEWED_VERIFIED';
    await transition('RENEWED_VERIFIED', {
      deploymentId: candidateDeploymentId,
      previousDeploymentId,
      pidsHash: targetClient.pidsHash,
      pidCount: targetClient.pidCount,
      unaffectedCohortIds,
      verifiedAt: now(),
    });
    const nextQueued = await releaseGlobalLock('RENEWED_VERIFIED');
    const report = {
      schema: 'vdsen-renew-cohort-op-v1',
      status: 'RENEWED_VERIFIED',
      operationId,
      cohortId,
      clientId,
      planId: expectedPlanId,
      pidsHash: targetClient.pidsHash,
      pidCount: targetClient.pidCount,
      runtimeSha,
      previousDeploymentId,
      deploymentId: candidateDeploymentId,
      shardNames: allShardNames,
      unaffectedCohortIds,
      nextQueuedOperationId: nextQueued ? nextQueued.operationId : null,
      verifiedAt: now(),
    };
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    }
    return report;
  } catch (err) {
    const errorCode = (err && err.code && err.code !== 'ERR_ASSERTION')
      ? err.code
      : String(err && err.message || 'RENEW_FAILED').split(':')[0].split('\n')[0].trim().slice(0, 64);
    if (!promoted && !fencesMutated) {
      // Pre-promotion failure: zero production traffic or fence impact
      await transition('FAILED', { failedPhase: phase, errorCode, failedAt: now() });
      await releaseGlobalLock('FAILED');
      const report = {
        schema: 'vdsen-renew-cohort-op-v1',
        status: 'FAILED',
        failedPhase: phase,
        errorCode,
        operationId,
        cohortId,
        clientId,
        planId: expectedPlanId,
        rollbackPerformed: false,
        previousDeploymentId,
        candidateDeploymentId,
        failedAt: now(),
      };
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
      }
      return report;
    }

    // Post-promotion or re-arm failure: granular rollback without overwriting newer promotions
    await transition('ROLLBACK_REQUIRED', { failedPhase: phase, errorCode });
    let aliasRestored = false;
    let fencesRestored = false;
    let rollbackSkippedNewerPromotion = false;
    let rollbackError = null;
    try {
      const currentLive = await getCurrentAlias();
      if (promoted && previousDeploymentId) {
        if (currentLive === candidateDeploymentId) {
          await revertDeployment(previousDeploymentId);
          aliasRestored = true;
        } else if (currentLive === previousDeploymentId) {
          aliasRestored = true;
        } else {
          // A newer legitimate promotion happened; do NOT revert it blindly
          rollbackSkippedNewerPromotion = true;
        }
      }
      if (fencesMutated && prevFenceSnapshot) {
        if (prevFenceSnapshot.rel) await writeDoc('releaseControl/autonomousProgression_cohort_' + cohortId, prevFenceSnapshot.rel);
        if (prevFenceSnapshot.num) await writeDoc('releaseControl/numericPilot_cohort_' + cohortId, prevFenceSnapshot.num);
        if (prevFenceSnapshot.coach) await writeDoc('coaches/' + coachId, prevFenceSnapshot.coach);
        fencesRestored = true;
      }
    } catch (rbErr) {
      rollbackError = rbErr && rbErr.message ? rbErr.message : String(rbErr);
    }

    const rollbackVerified = !rollbackError && !rollbackSkippedNewerPromotion && (!promoted || aliasRestored) && (!fencesMutated || fencesRestored);
    const finalStatus = rollbackVerified ? 'ROLLED_BACK_VERIFIED' : 'ROLLBACK_REQUIRED';
    await transition(finalStatus, {
      failedPhase: phase,
      errorCode,
      aliasRestored,
      fencesRestored,
      rollbackSkippedNewerPromotion,
      rollbackError,
      rolledBackAt: now(),
    });
    await releaseGlobalLock(finalStatus);
    const report = {
      schema: 'vdsen-renew-cohort-op-v1',
      status: finalStatus,
      failedPhase: phase,
      errorCode,
      operationId,
      cohortId,
      clientId,
      planId: expectedPlanId,
      rollbackPerformed: true,
      aliasRestored,
      fencesRestored,
      rollbackSkippedNewerPromotion,
      rollbackError,
      previousDeploymentId,
      candidateDeploymentId,
      rolledBackAt: now(),
    };
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    }
    return report;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('COHORT_OPS_ERROR:', err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  buildCohortsFromRoster,
  loadCommercialRoster,
  loadLiveRoster,
  discoverOpenCohortIds,
  prepareFleetRuntime,
  preflightCohort,
  armCohort,
  auditFleet,
  stopCohorts,
  detectPlanChangeDrift,
  renewDriftedCohort,
  executeRenewCohortOperation,
  extractPlanPids,
  toFsFields,
  MAX_COHORT_CLIENTS,
};
