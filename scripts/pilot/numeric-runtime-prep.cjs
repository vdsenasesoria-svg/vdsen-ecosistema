'use strict';
// Protected deployment-scoped numeric pilot runtime preparation and OFF-baseline restoration.
// Reuses official release/pilot primitives (app-live.cjs, numeric-guard.cjs, numeric-attestation.cjs).
// Never mutates Vercel project-level environment variables, never weakens the APP-ONLY Numeric Guard,
// and never opens Firestore fences (all 3 fences MUST remain closed during runtime preparation).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../api/_numericPilotContract');
const A = require('../release/app-live.cjs');
const G = require('../release/numeric-guard.cjs');
const { validateNumericWindow } = require('./numeric-preflight.cjs');
const { attestRuntime, DEFAULT_PROJECT_ID, DEFAULT_TEAM_ID } = require('./numeric-attestation.cjs');

const EXPECTED_ALIAS = 'vdsen-ecosistema.vercel.app';

const REQUIRED_NUMERIC_RUNTIME_ENVS = Object.freeze([
  'AUTONOMOUS_PROGRESSION_ENABLED',
  'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED',
  'VDSEN_NUMERIC_PILOT_ENABLED',
  'VDSEN_NUMERIC_PILOT_RUNTIME_SHA',
  'VDSEN_NUMERIC_PILOT_WINDOW',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function buildPilotWindowMeta(w) {
  return JSON.stringify({
    uidHash: sha256(w.uid),
    planHash: sha256(w.planId),
    pidHash: sha256(w.pid),
    startsAt: w.startsAt,
    expiresAt: w.expiresAt,
    operationId: w.operationId,
  });
}

/**
 * Builds Vercel CLI arguments for ONE immutable, deployment-scoped numeric pilot deployment.
 * Attaches metadata (-m) and per-deployment env (--env) without modifying project-level env.
 */
function buildNumericDeployArgs(w, baselineDeployment, dest, now) {
  const check = validateNumericWindow(w, now);
  assert.ok(check.valid, 'INVALID_NUMERIC_WINDOW: ' + check.errors.join('; '));
  assert.match(String(baselineDeployment || ''), /^dpl_[A-Za-z0-9]+$/, 'BASELINE_DEPLOYMENT_INVALID');
  assert.ok(typeof dest === 'string' && dest.length > 0, 'EXPORT_DEST_REQUIRED');

  const canonicalWindow = {
    schema: w.schema,
    mode: w.mode,
    uid: w.uid,
    planId: w.planId,
    pid: w.pid,
    runtimeSha: w.runtimeSha,
    operationId: w.operationId,
    startsAt: w.startsAt,
    expiresAt: w.expiresAt,
  };

  return [
    'deploy', dest, '--prod', '--skip-domain', '--yes', '--json',
    '-m', 'githubCommitSha=' + w.runtimeSha,
    '-m', 'vdsenPilotOperation=' + w.operationId,
    '-m', 'vdsenPilotBaseline=' + baselineDeployment,
    '-m', 'vdsenPilotWindow=' + buildPilotWindowMeta(canonicalWindow),
    '--env', 'AUTONOMOUS_PROGRESSION_ENABLED=true',
    '--env', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=true',
    '--env', 'VDSEN_NUMERIC_PILOT_ENABLED=true',
    '--env', 'VDSEN_NUMERIC_PILOT_RUNTIME_SHA=' + w.runtimeSha,
    '--env', 'VDSEN_NUMERIC_PILOT_WINDOW=' + JSON.stringify(canonicalWindow),
  ];
}

function assertAllFencesClosed(fences) {
  assert.ok(fences && typeof fences === 'object', 'FENCES_EVIDENCE_REQUIRED');
  const rel = fences.releaseControl;
  const num = fences.numericPilot;
  const coach = fences.coach;
  assert.ok(!rel || rel.enabled !== true, 'RELEASE_FENCE_MUST_BE_CLOSED');
  assert.ok(!num || num.enabled !== true, 'NUMERIC_PILOT_FENCE_MUST_BE_CLOSED');
  assert.ok(!coach || !coach.autoApplyCanary || coach.autoApplyCanary.enabled !== true, 'COACH_FENCE_MUST_BE_CLOSED');
}

/**
 * Prepares, stages, promotes, and attests ONE deployment-scoped numeric pilot runtime
 * while preserving the project-level OFF Numeric Guard and keeping all 3 Firestore fences closed.
 */
async function prepareNumericRuntime(w, baseline, io, opts = {}) {
  const check = validateNumericWindow(w, opts.now);
  assert.ok(check.valid, 'INVALID_NUMERIC_WINDOW: ' + check.errors.join('; '));
  assert.ok(baseline && typeof baseline === 'object', 'BASELINE_REQUIRED');
  assert.match(String(baseline.deployment || ''), /^dpl_[A-Za-z0-9]+$/, 'BASELINE_DEPLOYMENT_INVALID');
  assert.match(String(baseline.runtimeSha || ''), /^[a-f0-9]{40}$/, 'BASELINE_SHA_INVALID');
  assert.equal(baseline.numericApplyEnabled, false, 'BASELINE_MUST_BE_OFF');
  assert.ok(io && typeof io === 'object', 'IO_ADAPTER_REQUIRED');

  const expectedAlias = opts.expectedAlias || EXPECTED_ALIAS;
  const report = {
    schema: 'vdsen-numeric-runtime-prep-v1',
    operationId: w.operationId,
    runtimeSha: w.runtimeSha,
    mode: w.mode,
    expectedAlias,
    baseline: {
      deployment: baseline.deployment,
      runtimeSha: baseline.runtimeSha,
      numericApplyEnabled: false,
    },
    staged: null,
    window: w,
    attestation: null,
    status: 'PREPARING',
    promotionAttempted: false,
    productionMutations: 0,
  };
  const save = async () => { if (typeof io.save === 'function') await io.save(report); };

  // 1. Pre-mutation verifications (fail-closed, zero mutations)
  assert.equal(await io.current(), baseline.deployment, 'BASELINE_MOVED');

  const fencesBefore = await io.readFences();
  assertAllFencesClosed(fencesBefore);

  const offBefore = await io.offProof();
  G.assertDisarmedEvidence(offBefore);
  G.assertFresh(offBefore);
  report.projectNumericGuardBefore = offBefore;

  await io.assertNoPriorOperation(w.operationId);

  // 2. Stage ONE deployment-scoped numeric runtime (no retry on uncertainty)
  report.status = 'DEPLOY_INTENT_NO_RETRY';
  await save();

  try {
    const d = await io.stage(w);
    report.productionMutations++;
    report.staged = { id: d.id, url: d.url };
    report.status = 'STAGED';
    await save();

    assert.equal(d.projectId, DEFAULT_PROJECT_ID, 'PROJECT_ID_MISMATCH');
    assert.equal(d.teamId, DEFAULT_TEAM_ID, 'TEAM_ID_MISMATCH');
    assert.match(String(d.id || ''), /^dpl_[A-Za-z0-9]+$/, 'STAGED_ID_INVALID');
    assert.notEqual(d.id, baseline.deployment, 'STAGED_IS_BASELINE');
    assert.equal(d.sha, w.runtimeSha, 'STAGED_SHA_MISMATCH');
    assert.equal(d.operationId, w.operationId, 'STAGED_OPERATION_ID_MISMATCH');
    assert.equal(d.target, 'production', 'STAGED_TARGET_NOT_PRODUCTION');
    assert.equal(d.state, 'READY', 'STAGED_NOT_READY');
    assert.ok(Array.isArray(d.envNames), 'STAGED_ENV_NAMES_REQUIRED');
    assert.ok(!d.envNames.includes('CRON_SECRET'), 'CRON_NOT_ALLOWED');
    for (const reqEnv of REQUIRED_NUMERIC_RUNTIME_ENVS) {
      assert.ok(d.envNames.includes(reqEnv), 'STAGED_MISSING_REQUIRED_ENV: ' + reqEnv);
    }

    // Confirm traffic did not move during staging, fences stayed closed, and project env stayed OFF
    assert.equal(await io.current(), baseline.deployment, 'ALIAS_MOVED_DURING_STAGE');
    assertAllFencesClosed(await io.readFences());
    const offFresh = await io.offProof();
    G.assertPromotionAllowed({ preflight: offBefore, fresh: offFresh });
    report.projectNumericGuardAfter = offFresh;

    // 3. Promote exact staged deployment and verify bytes + live provider attestation
    report.promotionAttempted = true;
    report.status = 'PROMOTE_INTENT';
    await save();

    await io.promote(d.id);
    report.productionMutations++;
    report.verifiedPublicPaths = await io.verifyBytes(w.runtimeSha);
    assert.equal(await io.current(), d.id, 'ALIAS_NOT_CONVERGED');

    const att = await io.attest(d.id, w, expectedAlias);
    assert.ok(att && att.attested === true && att.status === 'ATTESTED',
      'LIVE_RUNTIME_ATTESTATION_FAILED: ' + (att && att.reason ? att.reason : 'UNKNOWN'));
    report.attestation = att;

    // Final fence check: runtime is live, fences MUST still be closed until explicit arm-fences
    assertAllFencesClosed(await io.readFences());
    report.status = 'NUMERIC_RUNTIME_READY_FENCES_CLOSED';
    await save();
    return report;
  } catch (err) {
    const current = await io.current().catch(() => null);
    if (current && current !== baseline.deployment && report.promotionAttempted && report.staged && current === report.staged.id) {
      report.status = 'ROLLBACK_INTENT';
      await save();
      try {
        await io.rollback(baseline.deployment);
        report.productionMutations++;
        assert.equal(await io.current(), baseline.deployment, 'ROLLBACK_ALIAS_FAILED');
        await io.verifyBytes(baseline.runtimeSha);
        report.status = 'ROLLED_BACK_VERIFIED';
      } catch (_) {
        report.status = 'ROLLBACK_FAILED_UNVERIFIED';
        await save();
        const rErr = new Error(report.status);
        rErr.cause = err;
        rErr.checkpoint = report;
        throw rErr;
      }
    } else {
      report.status = current === baseline.deployment
        ? 'FAILED_BASELINE_UNCHANGED_NO_RETRY'
        : 'CONCURRENT_ALIAS_NO_AUTOMATIC_OVERWRITE';
    }
    await save();
    const wrapped = new Error(report.status + ': ' + err.message);
    wrapped.cause = err;
    wrapped.checkpoint = report;
    throw wrapped;
  }
}

/**
 * Restores the production alias back to the captured OFF baseline deployment.
 * Refuses to overwrite a foreign deployment that is neither the baseline nor the expected pilot deployment.
 */
async function restoreOffRuntime(params, io) {
  assert.ok(params && params.baseline, 'BASELINE_REQUIRED');
  const { baseline, pilotDeploymentId } = params;
  assert.match(String(baseline.deployment || ''), /^dpl_[A-Za-z0-9]+$/, 'BASELINE_DEPLOYMENT_INVALID');
  assert.match(String(baseline.runtimeSha || ''), /^[a-f0-9]{40}$/, 'BASELINE_SHA_INVALID');

  const current = await io.current();
  const allowed = [baseline.deployment];
  if (pilotDeploymentId) allowed.push(pilotDeploymentId);
  assert.ok(allowed.includes(current), 'FOREIGN_ALIAS_NO_OVERWRITE: current=' + current);

  let wrote = 0;
  if (current !== baseline.deployment) {
    await io.rollback(baseline.deployment);
    wrote = 1;
  }
  assert.equal(await io.current(), baseline.deployment, 'RESTORE_ALIAS_NOT_CONVERGED');
  const verifiedPublicPaths = await io.verifyBytes(baseline.runtimeSha);

  let fencesClosed = null;
  let fencesStatus = 'UNVERIFIED_NO_ADAPTER';
  let fenceCheckError = null;
  if (typeof io.readFences === 'function') {
    let snapshot;
    try {
      snapshot = await io.readFences();
    } catch (readErr) {
      fencesClosed = null;
      fencesStatus = 'UNVERIFIED_READ_ERROR';
      fenceCheckError = readErr && readErr.message ? readErr.message : String(readErr);
    }
    if (fencesStatus !== 'UNVERIFIED_READ_ERROR') {
      try {
        assertAllFencesClosed(snapshot);
        fencesClosed = true;
        fencesStatus = 'VERIFIED_CLOSED';
      } catch (fenceErr) {
        fencesClosed = false;
        fencesStatus = 'ACTIVE_OR_OPEN';
        fenceCheckError = fenceErr && fenceErr.message ? fenceErr.message : String(fenceErr);
      }
    }
  }

  const completeRecovery = fencesStatus === 'VERIFIED_CLOSED';
  return {
    schema: 'vdsen-numeric-runtime-restore-v1',
    status: completeRecovery ? 'OFF_BASELINE_RESTORED_VERIFIED' : 'OFF_RUNTIME_RESTORED_FENCES_UNVERIFIED_OR_ACTIVE',
    runtimeRestored: true,
    completeRecovery,
    previousDeployment: current,
    restoredDeployment: baseline.deployment,
    baselineSha: baseline.runtimeSha,
    wrote,
    verifiedPublicPaths,
    fencesClosed,
    fencesStatus,
    fenceCheckError,
    restoredAt: new Date().toISOString(),
  };
}

/**
 * Constructs production adapters backed by official Vercel API, Git archive export,
 * Numeric Guard, Firestore REST fences, and live attestRuntime().
 */
function createProductionAdapters(stateManifest, opts = {}) {
  const s = stateManifest;
  assert.equal(s.production_project, DEFAULT_PROJECT_ID, 'PROJECT_IDENTITY_MISMATCH');
  assert.equal(s.vercel_team, DEFAULT_TEAM_ID, 'TEAM_IDENTITY_MISMATCH');
  const outFile = opts.outFile || 'release-output/numeric-pilot/runtime-prep-result.json';
  const coachId = opts.coachId;
  const googleToken = opts.googleToken || process.env.GOOGLE_ACCESS_TOKEN;
  const projectId = opts.projectId || process.env.GCP_PROJECT_ID || 'vdsen-ecosistema';
  const vercelToken = opts.vercelToken || process.env.VERCEL_TOKEN;

  const vget = async (p) => {
    const url = 'https://api.vercel.com' + p + (p.includes('?') ? '&' : '?') + 'teamId=' + DEFAULT_TEAM_ID;
    const r = await fetch(url, {
      headers: { authorization: 'Bearer ' + vercelToken },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 200, 'VERCEL_READ_FAILED_' + r.status);
    return r.json();
  };

  return {
    save: async (report) => {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
    },
    current: () => A.currentApp(s),
    readFences: async () => {
      const { fetchFencesFromRest } = require('./numeric-pilot-ops.cjs');
      assert.ok(googleToken, 'GOOGLE_ACCESS_TOKEN_REQUIRED');
      assert.ok(coachId, 'COACH_ID_REQUIRED');
      return fetchFencesFromRest(projectId, googleToken, coachId);
    },
    offProof: async () => {
      const project = await vget('/v9/projects/' + DEFAULT_PROJECT_ID);
      assert.equal(project.id, DEFAULT_PROJECT_ID, 'PROJECT_ID_MISMATCH');
      assert.equal(project.accountId, DEFAULT_TEAM_ID, 'TEAM_ID_MISMATCH');
      const r = await vget('/v9/projects/' + DEFAULT_PROJECT_ID + '/env?decrypt=false');
      assert.ok(Array.isArray(r.envs) && !(r.pagination && r.pagination.next), 'ENV_LIST_INCOMPLETE');
      assert.ok(!r.envs.some(e => e.key === 'CRON_SECRET' && Array.isArray(e.target) && e.target.includes('production')), 'CRON_NOT_ALLOWED');
      return G.evaluateProductionEnv(r.envs, { project: DEFAULT_PROJECT_ID, team: DEFAULT_TEAM_ID });
    },
    assertNoPriorOperation: async (operationId) => {
      let until = null;
      const all = [];
      for (let page = 0; page < 20; page++) {
        const q = '/v7/deployments?projectId=' + DEFAULT_PROJECT_ID + '&limit=100' + (until ? '&until=' + until : '');
        const r = await vget(q);
        assert.ok(Array.isArray(r.deployments), 'MALFORMED_VERCEL_DEPLOYMENTS_RESPONSE');
        all.push(...r.deployments);
        if (!r.pagination || !r.pagination.next) { until = null; break; }
        until = r.pagination.next;
      }
      assert.equal(until, null, 'DEPLOYMENT_LIST_INCOMPLETE');
      const dup = all.filter(d => d.meta && d.meta.vdsenPilotOperation === operationId);
      assert.equal(dup.length, 0, 'PILOT_OPERATION_ALREADY_EXISTS: ' + operationId);
    },
    stage: async (w) => {
      const root = path.resolve(process.env.RUNNER_TEMP || require('node:os').tmpdir());
      const dest = path.resolve(root, 'vdsen-numeric-pilot-' + (process.env.GITHUB_RUN_ID || Date.now()));
      assert.ok(dest.startsWith(root + path.sep) && dest !== root, 'UNSAFE_EXPORT_PATH');
      A.exportCandidateTree(w.runtimeSha, dest);
      A.verifyExportedTree(w.runtimeSha, dest, A.servedSurface());
      const args = buildNumericDeployArgs(w, s.production_deployment, dest);
      const r = await A.runVercelCli(args, dest, { VERCEL_ORG_ID: DEFAULT_TEAM_ID, VERCEL_PROJECT_ID: DEFAULT_PROJECT_ID });
      assert.equal(r.code, 0, 'DEPLOY_UNCERTAIN_NO_RETRY');
      const match = (String(r.out) + '\n' + String(r.err)).match(/https:\/\/([A-Za-z0-9.-]+\.vercel\.app)/);
      assert.ok(match, 'DEPLOY_ID_UNCERTAIN_NO_RETRY');
      const d = await A.deployment(s, match[1]);
      assert.ok(Array.isArray(d.env), 'DEPLOYMENT_ENV_NAMES_REQUIRED');
      const envNames = d.env.map(e => (typeof e === 'string' ? e : (e && e.key))).filter(Boolean);
      return {
        id: d.id || d.uid,
        url: d.url,
        projectId: d.projectId,
        teamId: d.teamId || d.ownerId,
        sha: d.meta && d.meta.githubCommitSha,
        operationId: d.meta && d.meta.vdsenPilotOperation,
        state: d.readyState,
        target: d.target,
        envNames,
      };
    },
    promote: (id) => A.promote(s, id),
    rollback: (id) => A.revertApp(s, id),
    verifyBytes: (sha) => A.verifyPublicBytes(s, sha, A.servedSurface()),
    attest: (deploymentId, w, expectedAlias) => attestRuntime({
      deploymentId,
      expectedSha: w.runtimeSha,
      expectedOperationId: w.operationId,
      expectedUid: w.uid,
      expectedPlanId: w.planId,
      expectedPid: w.pid,
      expectedStartsAt: w.startsAt,
      expectedExpiresAt: w.expiresAt,
      expectedAlias: expectedAlias || EXPECTED_ALIAS,
      vercelToken,
    }),
  };
}

module.exports = {
  EXPECTED_ALIAS,
  REQUIRED_NUMERIC_RUNTIME_ENVS,
  buildPilotWindowMeta,
  buildNumericDeployArgs,
  assertAllFencesClosed,
  prepareNumericRuntime,
  restoreOffRuntime,
  createProductionAdapters,
};
