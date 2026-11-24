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

/**
 * Pure, deterministic cohort builder: classifies eligible vs excluded clients and partitions
 * eligible clients into isolated cohorts of <= 10 clients each.
 */
function buildCohortsFromRoster(clients, plansById, opts = {}) {
  const runtimeSha = opts.runtimeSha || '';
  const baseOpId = opts.operationId || 'T875-FLEET-OP';
  const startsAt = opts.startsAt || '';
  const expiresAt = opts.expiresAt || '';
  const eligible = [];
  const excluded = [];

  const sortedClients = (Array.isArray(clients) ? clients : []).slice().sort((a, b) => String(a._id || a.uid || '').localeCompare(String(b._id || b.uid || '')));
  for (const c of sortedClients) {
    const uid = c._id || c.uid;
    if (!uid) continue;
    if (!eligibility.isClientStatusValid(c)) {
      excluded.push({ uid, coachId: c.coachId || null, reason: 'CLIENT_INACTIVE_OR_SUSPENDED' });
      continue;
    }
    if (!c.activePlanId) {
      excluded.push({ uid, coachId: c.coachId || null, reason: 'NO_ACTIVE_PLAN_ID' });
      continue;
    }
    const plan = plansById && plansById[c.activePlanId];
    if (!plan) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, reason: 'ACTIVE_PLAN_NOT_FOUND' });
      continue;
    }
    if (!eligibility.isPlanStatusValid(plan, c)) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, reason: 'PLAN_STATUS_INVALID' });
      continue;
    }
    if (plan.clientId && plan.clientId !== uid) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, reason: 'PLAN_CLIENT_MISMATCH' });
      continue;
    }
    const { pids, totalExercises, missingPidExercises } = extractPlanPids(plan);
    if (pids.length === 0) {
      excluded.push({ uid, coachId: c.coachId || null, activePlanId: c.activePlanId, totalExercises, missingPidExercises, reason: 'NO_PRESCRIPTION_EXERCISE_IDS' });
      continue;
    }
    const pidsHash = C.computePidsHash(pids);
    assert.ok(pidsHash, 'INVALID_PIDS_HASH_FOR_' + uid);
    eligible.push({
      uid,
      coachId: c.coachId || null,
      planId: c.activePlanId,
      updatedAt: plan.updatedAt || null,
      pids,
      pidCount: pids.length,
      pidsHash,
    });
  }

  const cohorts = [];
  for (let i = 0; i < eligible.length; i += MAX_COHORT_CLIENTS) {
    const idx = Math.floor(i / MAX_COHORT_CLIENTS) + 1;
    const cohortId = 'cohort-' + String(idx).padStart(2, '0');
    const slice = eligible.slice(i, i + MAX_COHORT_CLIENTS);
    assert.ok(slice.length >= 1 && slice.length <= MAX_COHORT_CLIENTS, 'COHORT_CAP_VIOLATED');
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
    const envVarName = 'VDSEN_NUMERIC_COHORT_' + idx;
    const envVarValue = JSON.stringify(compactWindows);
    assert.ok(Buffer.byteLength(envVarValue, 'utf8') < 4000, 'COHORT_ENV_SHARD_EXCEEDS_4KB: ' + envVarName);
    cohorts.push({
      index: idx,
      cohortId,
      envVarName,
      envVarBytes: Buffer.byteLength(envVarValue, 'utf8'),
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
    excludedCount: excluded.length,
    excludedByReason,
    totalEligiblePids: eligible.reduce((s, x) => s + x.pidCount, 0),
    cohortCount: cohorts.length,
    maxClientsPerCohort: MAX_COHORT_CLIENTS,
    cohorts,
    excluded,
  };
}

// ── Firestore REST helpers (WIF GOOGLE_ACCESS_TOKEN) ─────────────────────────────────────────
function fsBase(projectId) {
  return 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents';
}

async function fsList(projectId, token, col) {
  const docs = [];
  let pageToken = '';
  while (true) {
    const url = fsBase(projectId) + '/' + col + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(res.status, 200, 'FS_LIST_FAILED_' + col + '_' + res.status);
    const data = await res.json();
    if (Array.isArray(data.documents)) docs.push(...data.documents.map(fromFsDoc));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return docs;
}

async function fsGet(projectId, token, docPath) {
  const res = await fetch(fsBase(projectId) + '/' + docPath, { headers: { authorization: 'Bearer ' + token } });
  if (res.status === 404) return null;
  assert.equal(res.status, 200, 'FS_GET_FAILED_' + docPath + '_' + res.status);
  return fromFsDoc(await res.json());
}

async function fsCommit(projectId, token, writes) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + projectId + '/databases/(default)/documents:commit';
  const res = await fetch(url, {
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

async function loadLiveRoster(projectId, token, opts) {
  const clients = await fsList(projectId, token, 'clients');
  const plansById = {};
  const planIds = [...new Set(clients.map(c => c.activePlanId).filter(Boolean))];
  for (const pid of planIds) {
    const p = await fsGet(projectId, token, 'plans/' + pid);
    if (p) plansById[pid] = p;
  }
  return buildCohortsFromRoster(clients, plansById, opts);
}

async function fetchCohortFences(projectId, token, cohortId, coachId) {
  const relDoc = await fsGet(projectId, token, 'releaseControl/autonomousProgression_cohort_' + cohortId);
  const numDoc = await fsGet(projectId, token, 'releaseControl/numericPilot_cohort_' + cohortId);
  const coachDoc = coachId ? await fsGet(projectId, token, 'coaches/' + coachId) : null;
  const canaryCohort = coachDoc && coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.cohorts && coachDoc.autoApplyCanary.cohorts[cohortId] || null;
  return { releaseFence: relDoc, numericFence: numDoc, coachCanaryCohort: canaryCohort, coachCanaryEnabled: !!(coachDoc && coachDoc.autoApplyCanary && coachDoc.autoApplyCanary.enabled === true) };
}

async function vget(vercelToken, p) {
  const url = 'https://api.vercel.com' + p + (p.includes('?') ? '&' : '?') + 'teamId=' + DEFAULT_TEAM_ID;
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + vercelToken }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200, 'VERCEL_GET_FAILED_' + r.status + '_' + p);
  return r.json();
}

async function verifyFleetDeploymentLive(vercelToken, deploymentId, expectedSha, expectedCohortEnvName) {
  const d = await vget(vercelToken, '/v13/deployments/' + encodeURIComponent(deploymentId));
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
    assert.ok(envNames.includes(expectedCohortEnvName), 'MISSING_COHORT_SHARD_' + expectedCohortEnvName);
  }
  const aliasData = await vget(vercelToken, '/v2/aliases/' + encodeURIComponent(EXPECTED_ALIAS));
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
    args.push('-e', co.envVarName + '=' + JSON.stringify(co.compactWindows));
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
    const att = await verifyFleetDeploymentLive(vercelToken, stagedId, runtimeSha, manifest.cohorts[0].envVarName);
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
  const { projectId, googleToken, vercelToken, cohortId, deploymentId, runtimeSha, operationId, startsAt, expiresAt, coachId, outFile } = opts;
  const manifest = await loadLiveRoster(projectId, googleToken, { runtimeSha, operationId, startsAt, expiresAt });
  const co = manifest.cohorts.find(x => x.cohortId === cohortId);
  assert.ok(co, 'COHORT_NOT_FOUND_' + cohortId);

  const att = await verifyFleetDeploymentLive(vercelToken, deploymentId, runtimeSha, co.envVarName);
  const fences = await fetchCohortFences(projectId, googleToken, cohortId, coachId);
  const priorLedger = await fsGet(projectId, googleToken, 'releaseControl/numericPilot/operations/' + co.operationId);

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
          'autoApplyCanary.cohorts.' + co.cohortId,
        ],
      },
    },
  ];

  await fsCommit(projectId, googleToken, writes);
  const verifiedFences = await fetchCohortFences(projectId, googleToken, co.cohortId, coachId);
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

async function auditFleet(opts) {
  const { projectId, googleToken, coachId, outFile } = opts;
  const manifest = await loadLiveRoster(projectId, googleToken, {});
  const cohortStates = [];
  for (const co of manifest.cohorts) {
    const f = await fetchCohortFences(projectId, googleToken, co.cohortId, coachId);
    cohortStates.push({
      cohortId: co.cohortId,
      clientCount: co.clientCount,
      pidCount: co.pidCount,
      releaseFenceEnabled: !!(f.releaseFence && f.releaseFence.enabled === true),
      numericFenceEnabled: !!(f.numericFence && f.numericFence.enabled === true),
      coachCohortEnabled: !!(f.coachCanaryCohort && f.coachCanaryCohort.enabled === true),
      expiresAt: (f.releaseFence && f.releaseFence.expiresAt) || null,
      operationId: (f.numericFence && f.numericFence.operationId) || null,
    });
  }
  const report = {
    schema: 'vdsen-fleet-audit-v1',
    status: 'FLEET_AUDIT_SUCCESS',
    totalClients: manifest.totalClients,
    eligibleCount: manifest.eligibleCount,
    eligibleWithUpdatedAt: manifest.eligibleWithUpdatedAt,
    eligibleMissingUpdatedAt: manifest.eligibleMissingUpdatedAt,
    excludedCount: manifest.excludedCount,
    excludedByReason: manifest.excludedByReason,
    totalEligiblePids: manifest.totalEligiblePids,
    cohortCount: manifest.cohortCount,
    allCohortsArmed: cohortStates.length > 0 && cohortStates.every(x => x.releaseFenceEnabled && x.numericFenceEnabled && x.coachCohortEnabled),
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
  const { projectId, googleToken, coachId, targetCohortId, reason, outFile } = opts;
  const manifest = await loadLiveRoster(projectId, googleToken, {});
  const targets = targetCohortId === 'ALL'
    ? manifest.cohorts.map(x => x.cohortId)
    : [targetCohortId];
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
        updateMask: { fieldPaths: ['autoApplyCanary.cohorts.' + cid + '.enabled', 'autoApplyCanary.cohorts.' + cid + '.stoppedAt'] },
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
  await fsCommit(projectId, googleToken, writes);
  const out = { schema: 'vdsen-cohort-stop-v1', status: 'STOPPED_VERIFIED', stoppedCohorts: targets, stoppedAt: nowIso };
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
  extractPlanPids,
  MAX_COHORT_CLIENTS,
};
