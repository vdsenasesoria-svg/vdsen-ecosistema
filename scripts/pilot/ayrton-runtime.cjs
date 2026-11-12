'use strict';
// Dedicated, explicitly authorized PILOT runtime lane. Does not write Firestore or project variables.
// The app-only Numeric Guard is unchanged: it cannot release an armed runtime.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const A = require('../release/app-live.cjs'), G = require('../release/numeric-guard.cjs');
const C = require('./ayrton-canary.cjs'), P = require('./window-protocol.cjs');
const OFF_BASELINE_SHA = A.SAFE_OFF_BASELINE.runtimeSha;
const LEGACY_T671_SHA = 'a8cf462c78c4bd795cc9f485a82f64429c179f00';
const T671 = OFF_BASELINE_SHA;
const FILE = 'release-output/ayrton-runtime.json';
const REVIEWED_MAIN_SHAS = [
  'eee34ea6442381ef7af086d08f149445f347efb6', // Post-PR171 merge: Ayrton pilot runtime workflow registration (T776)
  'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c', // Pinned initial main baseline
];
function assertAuthorizedMainSha(mainSha, expectedEnv = process.env.APP_EXPECTED_MAIN_SHA, extraReviewed = []) {
  assert.match(String(mainSha || ''), /^[a-f0-9]{40}$/, 'INVALID_MAIN_SHA');
  if (expectedEnv) {
    assert.match(String(expectedEnv), /^[a-f0-9]{40}$/, 'INVALID_EXPECTED_MAIN_SHA');
    assert.equal(mainSha, expectedEnv, 'MAIN_SHA_MISMATCH');
  }
  const allowed = new Set([...REVIEWED_MAIN_SHAS, ...extraReviewed]);
  assert.ok(allowed.has(mainSha), 'UNAUTHORIZED_MAIN_SHA: ' + mainSha);
  return mainSha;
}
function assertAttemptAllowed(workflowRuns, currentRunId, reconcileFailedRun = '') {
  assert.ok(Array.isArray(workflowRuns), 'INVALID_WORKFLOW_RUNS');
  assert.match(String(currentRunId || ''), /^[1-9][0-9]+$/, 'INVALID_CURRENT_RUN_ID');
  const current = workflowRuns.find(w => String(w.id) === String(currentRunId));
  assert.ok(current, 'CURRENT_RUN_NOT_FOUND_IN_DISPATCH_LIST');

  if (!reconcileFailedRun) {
    assert.equal(workflowRuns.length, 1, 'ONE_ATTEMPT_PER_BASELINE_EXCEEDED');
    assert.equal(String(workflowRuns[0].id), String(currentRunId), 'CONCURRENT_OR_PRIOR_RUN_EXISTS');
    return { mode: 'STANDARD_SINGLE_ATTEMPT', runId: String(currentRunId) };
  }

  assert.match(String(reconcileFailedRun), /^[1-9][0-9]+$/, 'INVALID_RECONCILE_FAILED_RUN_ID');
  assert.notEqual(String(reconcileFailedRun), String(currentRunId), 'CANNOT_RECONCILE_SELF');
  assert.equal(workflowRuns.length, 2, 'RECOVERY_ALLOWED_ONLY_FOR_EXACTLY_ONE_PRIOR_ATTEMPT');

  const prior = workflowRuns.find(w => String(w.id) === String(reconcileFailedRun));
  assert.ok(prior, 'RECONCILED_RUN_NOT_FOUND_FOR_CURRENT_BASELINE');
  assert.equal(prior.status, 'completed', 'PRIOR_RUN_NOT_COMPLETED');
  assert.equal(prior.conclusion, 'failure', 'PRIOR_RUN_DID_NOT_FAIL');

  return { mode: 'AUDITED_FAILED_RUN_RECOVERY', currentRunId: String(currentRunId), reconciledRunId: String(reconcileFailedRun) };
}
function closed(w, snapshot) {
  P.stateGate(w, snapshot, 'enable');
  assert.ok(!snapshot.release || snapshot.release.enabled === false, 'RELEASE_FENCE_MUST_BE_DISABLED');
  assert.ok(!snapshot.coach.autoApplyCanary || snapshot.coach.autoApplyCanary.enabled === false, 'COACH_FENCE_MUST_BE_DISABLED');
}
function invocation(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'vdsenasesoria-svg/vdsen-ecosistema');
  assert.equal(env.GITHUB_REF, 'refs/heads/codex/client-app-next');
  assert.equal(env.GITHUB_WORKFLOW_REF, 'vdsenasesoria-svg/vdsen-ecosistema/.github/workflows/vdsen-ayrton-runtime.yml@refs/heads/codex/client-app-next');
  assert.equal(env.AYRTON_RUNTIME_RELEASE_ENABLED, 'true', 'PILOT_LANE_DISARMED');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'NO_JOB_RERUNS');
  assert.equal(env.INPUT_MODE || 'STAGE1_SHADOW', 'STAGE1_SHADOW', 'ONLY_STAGE1_SHADOW_ACCEPTED');
  if (env.INPUT_MODE !== undefined && env.INPUT_MODE !== '') {
    assert.equal(env.INPUT_MODE, 'STAGE1_SHADOW', 'ONLY_STAGE1_SHADOW_ACCEPTED');
  }
}
function buildDeployArgs(w, productionDeployment, dest) {
  assert.ok(w, 'PILOT_WINDOW_REQUIRED');
  assert.equal(w.mode, 'STAGE1_SHADOW', 'ONLY_STAGE1_SHADOW_ACCEPTED');
  return [
    'deploy', dest, '--prod', '--skip-domain', '--yes', '--json',
    '-m', 'githubCommitSha=' + w.runtimeSha,
    '-m', 'vdsenPilotOperation=' + w.operationId,
    '-m', 'vdsenPilotBaseline=' + productionDeployment,
    '--env', 'AUTONOMOUS_PROGRESSION_ENABLED=true',
    '--env', 'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=false',
    '--env', 'VDSEN_PILOT_WINDOW=' + JSON.stringify({
      uidHash: require('node:crypto').createHash('sha256').update(w.uid).digest('hex'),
      planHash: require('node:crypto').createHash('sha256').update(w.planId).digest('hex'),
      expiresAt: w.expiresAt,
      operationId: w.operationId,
    }),
  ];
}
// Dependency boundary is used for isolated simulations. Production CLI always constructs its own adapters.
async function arm(w, baseline, io) {
  assert.ok(w, 'PILOT_WINDOW_REQUIRED');
  assert.equal(w.mode, 'STAGE1_SHADOW', 'ONLY_STAGE1_SHADOW_ACCEPTED');
  P.windowSpec(w);
  assert.ok(baseline.runtimeSha === T671 || (baseline.runtimeSha && baseline.runtimeSha.length === 40), 'OFF_BASELINE_RELEASE_REQUIRED_FIRST');
  assert.notEqual(w.runtimeSha, LEGACY_T671_SHA, 'PILOT_PROBE_RUNTIME_REQUIRED');
  const report = { schema: 'vdsen-ayrton-runtime-release-v1', operationId: w.operationId, runtimeSha: w.runtimeSha,
    mode: 'STAGE1_SHADOW', pid: w.pid || w.prescriptionExerciseId || null,
    baseline, staged: null, status: 'PREPARING', promotionAttempted: false, productionMutations: 0 };
  const save = () => io.save(report);
  const fenceEvidence = snapshot => ({ readAt: new Date().toISOString(), releaseEnabled: snapshot.release && snapshot.release.enabled,
    coachEnabled: snapshot.coach.autoApplyCanary && snapshot.coach.autoApplyCanary.enabled, exclusiveScopeVerified: true });
  report.treeSha = await io.validateSource(w.runtimeSha); report.baselineProof = await io.validateBaseline(baseline);
  assert.equal(await io.current(), baseline.deployment, 'BASELINE_MOVED');
  const fencesBefore = await io.snapshot(w); closed(w, fencesBefore); report.fencesBefore = fenceEvidence(fencesBefore);
  const before = await io.offProof(); G.assertDisarmedEvidence(before); G.assertFresh(before);
  report.projectNumericGuardBefore = before;
  await io.assertNoPriorOperation(w.operationId);
  report.status = 'DEPLOY_INTENT_NO_RETRY'; await save();
  try {
    const d = await io.stage(w); // Exactly one call. Uncertain results must never be retried.
    report.productionMutations++; report.staged = { id: d.id, url: d.url };
    report.window = { ...w, deployment: d.id }; report.status = 'STAGED'; await save();
    assert.equal(d.projectId, P.PROJECT); assert.equal(d.teamId, P.TEAM);
    assert.match(d.id, /^dpl_[A-Za-z0-9]+$/); assert.notEqual(d.id, baseline.deployment, 'STAGED_IS_BASELINE');
    assert.equal(d.sha, w.runtimeSha); assert.equal(d.target, 'production'); assert.equal(d.state, 'READY');
    assert.ok(!d.envNames.includes('CRON_SECRET'), 'CRON_NOT_ALLOWED');
    assert.equal(await io.current(), baseline.deployment, 'ALIAS_MOVED_DURING_STAGE');
    const fencesStaged = await io.snapshot(w); closed(w, fencesStaged); report.fencesStaged = fenceEvidence(fencesStaged); P.windowSpec(w);
    const fresh = await io.offProof(); G.assertPromotionAllowed({ preflight: before, fresh });
    report.projectNumericGuardAfter = fresh;
    report.promotionAttempted = true; report.status = 'PROMOTE_INTENT'; await save();
    await io.promote(d.id); report.productionMutations++; report.verifiedPublicPaths = await io.verifyBytes(w.runtimeSha);
    assert.equal(await io.current(), d.id, 'ALIAS_NOT_CONVERGED');
    const fencesAfter = await io.snapshot(w); closed(w, fencesAfter); report.fencesAfter = fenceEvidence(fencesAfter);
    report.status = 'RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED'; await save(); return report;
  } catch (_) {
    const current = await io.current();
    if (current !== baseline.deployment && report.promotionAttempted && report.staged && current === report.staged.id) {
      report.status = 'ROLLBACK_INTENT'; await save();
      try {
        await io.rollback(baseline.deployment); report.productionMutations++;
        assert.equal(await io.current(), baseline.deployment, 'ROLLBACK_ALIAS_FAILED');
        await io.verifyBytes(baseline.runtimeSha); report.status = 'ROLLED_BACK_VERIFIED';
      } catch (_) { report.status = 'ROLLBACK_FAILED_UNVERIFIED'; await save(); throw new Error(report.status); }
    } else report.status = current === baseline.deployment ? 'FAILED_BASELINE_UNCHANGED_NO_RETRY' : 'CONCURRENT_ALIAS_NO_AUTOMATIC_OVERWRITE';
    await save(); throw new Error(report.status);
  }
}
async function restore(report, io) {
  assert.equal(report.schema, 'vdsen-ayrton-runtime-release-v1');
  assert.ok(report.baseline && report.baseline.runtimeSha); assert.ok(report.staged && report.staged.id);
  await io.validateBaseline(report.baseline);
  const current = await io.current();
  assert.ok([report.baseline.deployment, report.staged.id].includes(current), 'FOREIGN_ALIAS_NO_OVERWRITE');
  if (current !== report.baseline.deployment) await io.rollback(report.baseline.deployment);
  assert.equal(await io.current(), report.baseline.deployment); await io.verifyBytes(report.baseline.runtimeSha);
  return { status: 'ROLLBACK_VERIFIED', wrote: current === report.baseline.deployment ? 0 : 1 };
}
function adapters(s) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const read = async (p, allow404 = false) => {
    const r = await C.http('GET', p, process.env.GOOGLE_ACCESS_TOKEN);
    if (allow404 && r.status === 404 && p.split('?')[0] === C.RELEASE_PATH) return null;
    assert.equal(r.status, 200, 'FENCE_READ_FAILED: ' + p + ' status ' + r.status);
    assert.ok(r.body && typeof r.body === 'object', 'MALFORMED_FIRESTORE_RESPONSE: ' + p);
    return C.decDoc(r.body) || {};
  };
  const vget = async p => {
    const r = await fetch('https://api.vercel.com' + p + (p.includes('?') ? '&' : '?') + 'teamId=' + P.TEAM, {
      headers: { authorization: 'Bearer ' + process.env.VERCEL_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 200, 'VERCEL_READ_FAILED'); return r.json();
  };
  return {
    save: async r => { fs.mkdirSync('release-output', { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(r, null, 2) + '\n'); },
    current: () => A.currentApp(s),
    validateSource: async sha => {
      git('merge-base', '--is-ancestor', sha, 'HEAD');
      git('diff', '--exit-code', sha, 'HEAD', '--', 'api', ...require('../release/deployed-product.cjs').SERVED, 'package.json', 'package-lock.json');
      G.assertContractCoverage(G.discoverRuntimeEnvNames(sha, git));
      assert.ok(git('show', sha + ':api/autonomous-progression-trigger.js').includes('vdsen-progression-runtime-v1'), 'PROBE_NOT_IN_RUNTIME');
      const main = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
      assertAuthorizedMainSha(main);
      await require('./ayrton-window.cjs').assertLegacyRetired(s);
      return git('rev-parse', sha + '^{tree}');
    },
    validateBaseline: async b => {
      assert.equal(s.runtime_sha, b.runtimeSha, 'BASELINE_RUNTIME_MISMATCH'); assert.equal(s.production_deployment, b.deployment);
      assert.equal(s.app_release.deployment, b.deployment); assert.match(String(s.app_release.source_release_run), /^[1-9][0-9]+$/);
      assert.equal(s.numeric_apply_enabled, false, 'BASELINE_MUST_BE_OFF');
      const d = await A.deployment(s, b.deployment); assert.equal(d.readyState, 'READY');
      assert.equal(d.id || d.uid, b.deployment);
      assert.equal(d.projectId, P.PROJECT); assert.equal(d.teamId || d.ownerId, P.TEAM);
      assert.equal(d.meta && d.meta.githubCommitSha, b.runtimeSha);
      return require('./off-baseline.cjs').load(s, b, d);
    },
    snapshot: async w => {
      const client = await read('clients/' + w.uid + '?mask.fieldPaths=coachId&mask.fieldPaths=activePlanId');
      assert.ok(client && typeof client === 'object', 'CLIENT_DOCUMENT_INVALID');
      assert.ok(client.coachId && typeof client.coachId === 'string', 'CLIENT_COACH_ID_REQUIRED');
      assert.ok(client.activePlanId && typeof client.activePlanId === 'string', 'CLIENT_ACTIVE_PLAN_REQUIRED');
      assert.equal(client.coachId, w.coachId, 'COACH_ID_MISMATCH');
      assert.equal(client.activePlanId, w.planId, 'ACTIVE_PLAN_MISMATCH');
      const release = await read(C.RELEASE_PATH, true);
      const coach = await read('coaches/' + w.coachId + '?mask.fieldPaths=autoApplyCanary');
      assert.ok(coach && typeof coach === 'object', 'COACH_DOCUMENT_REQUIRED');
      return { uid: w.uid, client, coachId: client.coachId, release, coach };
    },
    offProof: async () => {
      const project = await vget('/v9/projects/' + P.PROJECT); assert.equal(project.id, P.PROJECT); assert.equal(project.accountId, P.TEAM);
      const r = await vget('/v9/projects/' + P.PROJECT + '/env?decrypt=false');
      assert.ok(Array.isArray(r.envs) && !r.pagination?.next, 'ENV_LIST_INCOMPLETE');
      assert.ok(!r.envs.some(e => e.key === 'CRON_SECRET' && e.target?.includes('production')), 'CRON_NOT_ALLOWED');
      return G.evaluateProductionEnv(r.envs, { project: P.PROJECT, team: P.TEAM });
    },
    assertNoPriorOperation: async id => {
      let until = null;
      const allDeployments = [];
      for (let page = 0; page < 10; page++) {
        const query = '/v6/deployments?projectId=' + P.PROJECT + '&limit=100' + (until ? '&until=' + until : '');
        const r = await vget(query);
        assert.ok(Array.isArray(r.deployments), 'MALFORMED_VERCEL_DEPLOYMENTS_RESPONSE');
        allDeployments.push(...r.deployments);
        if (!r.pagination || !r.pagination.next) {
          until = null;
          break;
        }
        until = r.pagination.next;
      }
      assert.equal(until, null, 'DEPLOYMENT_LIST_INCOMPLETE');
      const matchingOp = allDeployments.filter(d => d.meta && d.meta.vdsenPilotOperation === id);
      assert.equal(matchingOp.length, 0, 'PILOT_OPERATION_ALREADY_EXISTS: ' + id);
      const matchingBaseline = allDeployments.filter(d => d.meta && d.meta.vdsenPilotBaseline === s.production_deployment);
      assert.equal(matchingBaseline.length, 0, 'PILOT_BASELINE_ALREADY_STAGED: ' + s.production_deployment);
    },
    stage: async w => {
      const root = path.resolve(process.env.RUNNER_TEMP), dest = path.resolve(root, 'vdsen-ayrton-' + process.env.GITHUB_RUN_ID);
      assert.ok(dest.startsWith(root + path.sep) && dest !== root, 'UNSAFE_EXPORT_PATH');
      A.exportCandidateTree(w.runtimeSha, dest); A.verifyExportedTree(w.runtimeSha, dest, A.servedSurface());
      const args = buildDeployArgs(w, s.production_deployment, dest);
      const r = await A.runVercelCli(args, dest, { VERCEL_ORG_ID: P.TEAM, VERCEL_PROJECT_ID: P.PROJECT });
      assert.equal(r.code, 0, 'DEPLOY_UNCERTAIN_NO_RETRY');
      const url = (String(r.out) + '\n' + String(r.err)).match(/https:\/\/([A-Za-z0-9.-]+\.vercel\.app)/);
      assert.ok(url, 'DEPLOY_ID_UNCERTAIN_NO_RETRY');
      const d = await A.deployment(s, url[1]);
      assert.ok(Array.isArray(d.env), 'DEPLOYMENT_ENV_NAMES_REQUIRED');
      return { id: d.id || d.uid, url: d.url, projectId: d.projectId, teamId: d.teamId || d.ownerId,
        sha: d.meta && d.meta.githubCommitSha, state: d.readyState, target: d.target, envNames: d.env };
    },
    promote: id => A.promote(s, id), rollback: id => A.revertApp(s, id), verifyBytes: sha => A.verifyPublicBytes(s, sha, A.servedSurface()),
  };
}
async function main(argv) {
  invocation(process.env);
  const s = JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
  assert.equal(s.production_project, P.PROJECT); assert.equal(s.vercel_team, P.TEAM);
  const io = adapters(s);
  if (argv[0] === 'restore') return restore(JSON.parse(fs.readFileSync(FILE, 'utf8')), io);
  assert.equal(argv[0], 'arm');
  const w = JSON.parse(fs.readFileSync(process.env.PILOT_WINDOW_FILE, 'utf8'));
  assert.equal(w.mode, 'STAGE1_SHADOW', 'ONLY_STAGE1_SHADOW_ACCEPTED');
  return arm(w, { runtimeSha: s.runtime_sha, deployment: s.production_deployment, officialReleaseRun: String(s.app_release.source_release_run) }, io);
}
function formatSanitizedFailure(err) {
  const rawMsg = (err && (err.message || err.code)) ? String(err.message || err.code) : String(err || 'UNKNOWN_ERROR');
  const cleanCode = rawMsg.split('\n')[0].replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]').slice(0, 140);
  return {
    status: 'PILOT_RUNTIME_STOPPED',
    error_code: cleanCode,
    phase: 'ARM_PREFLIGHT',
    state: 'SAFE_BASELINE_UNCHANGED_ZERO_MUTATIONS',
    action_required: 'REVIEW_REDACTED_CHECKPOINT_NO_AUTOMATIC_RETRY',
  };
}
module.exports = { arm, restore, closed, invocation, buildDeployArgs, T671, OFF_BASELINE_SHA, LEGACY_T671_SHA, assertAuthorizedMainSha, REVIEWED_MAIN_SHAS, adapters, assertAttemptAllowed, formatSanitizedFailure };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify({ status: r.status }))).catch((err) => {
  const report = formatSanitizedFailure(err);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
});
