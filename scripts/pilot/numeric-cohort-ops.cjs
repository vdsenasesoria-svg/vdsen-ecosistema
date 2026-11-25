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
  throw new Error('UNKNOWN_COHORT_CMD: ' + cmd);
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
  extractPlanPids,
  toFsFields,
  MAX_COHORT_CLIENTS,
};
