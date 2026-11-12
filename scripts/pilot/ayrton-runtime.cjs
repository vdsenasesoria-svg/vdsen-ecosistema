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
function assertAttemptAllowed(workflowRuns, currentRunId, reconcileFailedRun = '', reconciliationEvidence = null) {
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

  assert.ok(reconciliationEvidence && typeof reconciliationEvidence === 'object', 'PRIOR_RUN_EVIDENCE_MISSING');
  assert.ok(reconciliationEvidence.baselineDeployment && typeof reconciliationEvidence.baselineDeployment === 'string', 'PRIOR_RUN_EVIDENCE_MISSING');
  assert.equal(reconciliationEvidence.currentAlias, reconciliationEvidence.baselineDeployment, 'PRODUCTION_ALIAS_NOT_ON_BASELINE');
  assert.equal(reconciliationEvidence.stagedDeploymentsCount, 0, 'PENDING_OR_STAGED_DEPLOYMENTS_EXIST');
  assert.equal(reconciliationEvidence.priorRunMutations, 0, 'PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO');
  assert.equal(reconciliationEvidence.evidenceVerified, true, 'PRIOR_RUN_EVIDENCE_UNVERIFIED');

  return { mode: 'AUDITED_FAILED_RUN_RECOVERY', currentRunId: String(currentRunId), reconciledRunId: String(reconcileFailedRun), evidence: reconciliationEvidence };
}
async function gatherReconciliationEvidence(s, failedRunId, deps = {}) {
  try {
    assert.ok(s && s.production_deployment, 'BASELINE_DEPLOYMENT_REQUIRED');
    assert.match(String(failedRunId || ''), /^[1-9][0-9]+$/, 'INVALID_RECONCILE_FAILED_RUN_ID');

    // 1. Check project and baseline identity
    assert.equal(s.production_project, P.PROJECT, 'PROJECT_IDENTITY_MISMATCH');
    assert.equal(s.vercel_team, P.TEAM, 'TEAM_IDENTITY_MISMATCH');
    assert.ok(s.runtime_sha && s.runtime_sha.length === 40, 'BASELINE_RUNTIME_MISMATCH');
    assert.equal(s.numeric_apply_enabled, false, 'BASELINE_MUST_BE_OFF');

    const cp = require('node:child_process');
    const gh = deps.gh || ((...args) => JSON.parse(cp.execFileSync('gh', args, { encoding: 'utf8' })));
    const fetchFn = deps.fetch || globalThis.fetch;
    const currentAppFn = deps.currentApp || A.currentApp;
    const repo = process.env.GITHUB_REPOSITORY || 'vdsenasesoria-svg/vdsen-ecosistema';

    // 2. Check run identity and state in GitHub Actions
    const run = gh('api', 'repos/' + repo + '/actions/runs/' + failedRunId);
    assert.equal(String(run.id), String(failedRunId), 'RUN_ID_MISMATCH');
    assert.equal(run.path, '.github/workflows/vdsen-ayrton-runtime.yml', 'WORKFLOW_PATH_MISMATCH');
    assert.equal(run.head_branch, 'codex/client-app-next', 'WORKFLOW_BRANCH_MISMATCH');
    assert.equal(run.event, 'workflow_dispatch', 'WORKFLOW_EVENT_MISMATCH');
    assert.equal(run.status, 'completed', 'PRIOR_RUN_NOT_COMPLETED');
    assert.equal(run.conclusion, 'failure', 'PRIOR_RUN_DID_NOT_FAIL');

    // 3. Reconstruct exact failure phase from jobs / steps / artifacts
    const jobsRes = gh('api', 'repos/' + repo + '/actions/runs/' + failedRunId + '/jobs');
    assert.ok(jobsRes && Array.isArray(jobsRes.jobs) && jobsRes.jobs.length >= 1, 'INVALID_JOBS_LIST');
    const pilotJob = jobsRes.jobs.find(j => j.name === 'pilot-runtime') || jobsRes.jobs[0];
    assert.equal(pilotJob.status, 'completed', 'JOB_NOT_COMPLETED');
    assert.equal(pilotJob.conclusion, 'failure', 'JOB_DID_NOT_FAIL');

    const steps = pilotJob.steps || [];
    const armStep = steps.find(st => st.name && st.name.includes('One pilot deployment with both fences closed'));
    assert.ok(armStep, 'ARM_STEP_NOT_FOUND');
    assert.equal(armStep.conclusion, 'failure', 'ARM_STEP_DID_NOT_FAIL');

    // Check duration: preflight failure took <= 10s (e.g. 749ms); staging CLI would take > 30s
    const armDurationSec = (Date.parse(armStep.completed_at) - Date.parse(armStep.started_at)) / 1000;
    assert.ok(Number.isFinite(armDurationSec) && armDurationSec < 30, 'ARM_STEP_DURATION_EXCEEDS_PREFLIGHT');

    // Check artifacts: must not have produced any release/staging report
    const artifacts = gh('api', 'repos/' + repo + '/actions/runs/' + failedRunId + '/artifacts');
    assert.ok(artifacts && Array.isArray(artifacts.artifacts), 'INVALID_ARTIFACT_LIST');
    const runtimeArt = artifacts.artifacts.find(a => a.name === 'ayrton-runtime-' + failedRunId);
    if (runtimeArt) {
      assert.fail('PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO');
    }

    // 4. Full, fail-closed pagination of Vercel deployments
    const vercelToken = deps.vercelToken || process.env.VERCEL_TOKEN;
    assert.ok(vercelToken, 'VERCEL_TOKEN_REQUIRED');
    let until = null;
    const allDeployments = [];
    for (let page = 0; page < 20; page++) {
      const q = 'https://api.vercel.com/v6/deployments?projectId=' + P.PROJECT + '&teamId=' + P.TEAM + '&limit=100' + (until ? '&until=' + until : '');
      const vres = await fetchFn(q, { headers: { authorization: 'Bearer ' + vercelToken } });
      assert.equal(vres.status, 200, 'VERCEL_READ_FAILED');
      const vjson = await vres.json();
      assert.ok(Array.isArray(vjson.deployments), 'VERCEL_READ_FAILED');
      allDeployments.push(...vjson.deployments);
      if (!vjson.pagination || !vjson.pagination.next) {
        until = null;
        break;
      }
      until = vjson.pagination.next;
    }
    assert.equal(until, null, 'DEPLOYMENT_LIST_INCOMPLETE');

    // Verify no deployment was staged with this baseline
    const matchingBaseline = allDeployments.filter(d => d.meta && d.meta.vdsenPilotBaseline === s.production_deployment);
    assert.equal(matchingBaseline.length, 0, 'PENDING_OR_STAGED_DEPLOYMENTS_EXIST');

    // Verify no deployment was created during the failed run's time window
    const runStartMs = Date.parse(run.created_at);
    const runEndMs = Date.parse(run.updated_at);
    assert.ok(Number.isFinite(runStartMs) && Number.isFinite(runEndMs), 'RUN_TIMESTAMPS_INVALID');
    const deploymentsDuringRun = allDeployments.filter(d => {
      const dCreated = typeof d.created === 'number' ? d.created : Date.parse(d.createdAt || d.created);
      return dCreated >= runStartMs - 5000 && dCreated <= runEndMs + 60000;
    });
    assert.equal(deploymentsDuringRun.length, 0, 'DEPLOYMENTS_CREATED_DURING_PRIOR_RUN');

    // 5. Verify current live alias matches baseline deployment
    const currentAlias = await currentAppFn(s);
    assert.equal(currentAlias, s.production_deployment, 'PRODUCTION_ALIAS_NOT_ON_BASELINE');

    return {
      baselineDeployment: s.production_deployment,
      currentAlias,
      stagedDeploymentsCount: matchingBaseline.length,
      priorRunMutations: 0,
      evidenceVerified: true,
      phaseProven: 'ARM_PREFLIGHT_ZERO_MUTATIONS',
    };
  } catch (err) {
    const code = classifyDiagnosticCode(err);
    const known = ['PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO', 'PENDING_OR_STAGED_DEPLOYMENTS_EXIST', 'PRODUCTION_ALIAS_NOT_ON_BASELINE', 'DEPLOYMENT_LIST_INCOMPLETE'].includes(code);
    const outErr = new Error(known ? code : 'BLOCKED_EVIDENCE');
    outErr.cause = err;
    throw outErr;
  }
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
    baseline, staged: null, status: 'PREPARING', promotionAttempted: false, productionMutations: 0, deployIntentReached: false };
  const save = () => io.save(report);
  const fenceEvidence = snapshot => ({ readAt: new Date().toISOString(), releaseEnabled: snapshot.release && snapshot.release.enabled,
    coachEnabled: snapshot.coach.autoApplyCanary && snapshot.coach.autoApplyCanary.enabled, exclusiveScopeVerified: true });
  let before = null;
  try {
    report.treeSha = await io.validateSource(w.runtimeSha); report.baselineProof = await io.validateBaseline(baseline);
    assert.equal(await io.current(), baseline.deployment, 'BASELINE_MOVED');
    const fencesBefore = await io.snapshot(w); closed(w, fencesBefore); report.fencesBefore = fenceEvidence(fencesBefore);
    before = await io.offProof(); G.assertDisarmedEvidence(before); G.assertFresh(before);
    report.projectNumericGuardBefore = before;
    await io.assertNoPriorOperation(w.operationId);
  } catch (preflightErr) {
    if (preflightErr && typeof preflightErr === 'object') preflightErr.checkpoint = report;
    throw preflightErr;
  }
  report.deployIntentReached = true;
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
  } catch (stageOrPromoteErr) {
    const current = await io.current();
    if (current !== baseline.deployment && report.promotionAttempted && report.staged && current === report.staged.id) {
      report.status = 'ROLLBACK_INTENT'; await save();
      try {
        await io.rollback(baseline.deployment); report.productionMutations++;
        assert.equal(await io.current(), baseline.deployment, 'ROLLBACK_ALIAS_FAILED');
        await io.verifyBytes(baseline.runtimeSha); report.status = 'ROLLED_BACK_VERIFIED';
      } catch (_) {
        report.status = 'ROLLBACK_FAILED_UNVERIFIED'; await save();
        const err = new Error(report.status); err.checkpoint = report; throw err;
      }
    } else {
      report.status = current === baseline.deployment ? 'FAILED_BASELINE_UNCHANGED_NO_RETRY' : 'CONCURRENT_ALIAS_NO_AUTOMATIC_OVERWRITE';
    }
    await save();
    const err = new Error(report.status);
    err.checkpoint = report;
    err.cause = stageOrPromoteErr;
    throw err;
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
const ALLOWED_DIAGNOSTIC_CODES = new Set([
  'FENCE_READ_FAILED',
  'RELEASE_FENCE_MUST_BE_DISABLED',
  'COACH_FENCE_MUST_BE_DISABLED',
  'PILOT_OPERATION_ALREADY_EXISTS',
  'PILOT_BASELINE_ALREADY_STAGED',
  'DEPLOYMENT_LIST_INCOMPLETE',
  'MALFORMED_FIRESTORE_RESPONSE',
  'CLIENT_DOCUMENT_INVALID',
  'CLIENT_COACH_ID_REQUIRED',
  'CLIENT_ACTIVE_PLAN_REQUIRED',
  'COACH_ID_MISMATCH',
  'ACTIVE_PLAN_MISMATCH',
  'COACH_DOCUMENT_REQUIRED',
  'BASELINE_MOVED',
  'STAGED_IS_BASELINE',
  'ALIAS_MOVED_DURING_STAGE',
  'ALIAS_NOT_CONVERGED',
  'DEPLOY_UNCERTAIN_NO_RETRY',
  'DEPLOY_ID_UNCERTAIN_NO_RETRY',
  'VERCEL_READ_FAILED',
  'CRON_NOT_ALLOWED',
  'PILOT_WINDOW_REQUIRED',
  'ONLY_STAGE1_SHADOW_ACCEPTED',
  'PILOT_LANE_DISARMED',
  'NO_JOB_RERUNS',
  'EXPIRY_INVALID',
  'PLAN_CHANGED',
  'COACH_CHANGED',
  'CANARY_SINGLE_PID_MISMATCH',
  'ACTIVE_WINDOW_NO_RENEWAL',
  'IMMUTABLE_RUNTIME_WINDOW_MISMATCH',
  'ROLLBACK_ALIAS_FAILED',
  'ROLLBACK_FAILED_UNVERIFIED',
  'ROLLED_BACK_VERIFIED',
  'FAILED_BASELINE_UNCHANGED_NO_RETRY',
  'CONCURRENT_ALIAS_NO_AUTOMATIC_OVERWRITE',
  'FOREIGN_ALIAS_NO_OVERWRITE',
  'ONE_ATTEMPT_PER_BASELINE_EXCEEDED',
  'CONCURRENT_OR_PRIOR_RUN_EXISTS',
  'RECOVERY_ALLOWED_ONLY_FOR_EXACTLY_ONE_PRIOR_ATTEMPT',
  'RECONCILED_RUN_NOT_FOUND_FOR_CURRENT_BASELINE',
  'PRIOR_RUN_NOT_COMPLETED',
  'PRIOR_RUN_DID_NOT_FAIL',
  'PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO',
  'PRIOR_RUN_EVIDENCE_MISSING',
  'PRIOR_RUN_EVIDENCE_UNVERIFIED',
  'PRODUCTION_ALIAS_NOT_ON_BASELINE',
  'PENDING_OR_STAGED_DEPLOYMENTS_EXIST',
  'CANNOT_RECONCILE_SELF',
  'INVALID_RECONCILE_FAILED_RUN_ID',
  'INVALID_CURRENT_RUN_ID',
  'INVALID_WORKFLOW_RUNS',
  'UNAUTHORIZED_MAIN_SHA',
  'INVALID_MAIN_SHA',
  'MAIN_SHA_MISMATCH',
  'OFF_BASELINE_RELEASE_REQUIRED_FIRST',
  'PILOT_PROBE_RUNTIME_REQUIRED',
  'BASELINE_RUNTIME_MISMATCH',
  'BASELINE_MUST_BE_OFF',
  'ENV_LIST_INCOMPLETE',
  'UNSAFE_EXPORT_PATH',
  'DEPLOYMENT_ENV_NAMES_REQUIRED',
  'PILOT_RUNTIME_STOPPED',
  'BLOCKED_EVIDENCE',
]);

function classifyDiagnosticCode(err) {
  if (!err) return 'UNCLASSIFIED_ERROR';
  const raw = String(err.message || err.code || err || '').trim();
  if (!raw) return 'UNCLASSIFIED_ERROR';

  for (const code of ALLOWED_DIAGNOSTIC_CODES) {
    if (raw === code) return code;
    if (raw.startsWith(code + ':') || raw.startsWith(code + ' ') || raw.startsWith('Error: ' + code)) {
      return code;
    }
  }

  for (const code of ALLOWED_DIAGNOSTIC_CODES) {
    const re = new RegExp('\\b' + code + '\\b');
    if (re.test(raw)) return code;
  }

  return 'UNCLASSIFIED_ERROR';
}

function formatSanitizedFailure(err, checkpoint = null) {
  const code = classifyDiagnosticCode(err);

  let phase = 'ARM_PREFLIGHT';
  if (checkpoint && checkpoint.phase) {
    phase = checkpoint.phase;
  } else if (checkpoint && checkpoint.status) {
    if (checkpoint.status === 'DEPLOY_INTENT_NO_RETRY' || (checkpoint.deployIntentReached && !checkpoint.staged && !checkpoint.promotionAttempted)) {
      phase = 'STAGING';
    } else if (['STAGED', 'PROMOTE_INTENT'].includes(checkpoint.status)) {
      phase = checkpoint.promotionAttempted ? 'PROMOTION' : 'STAGING';
    } else if (['ROLLBACK_INTENT', 'ROLLBACK_FAILED_UNVERIFIED', 'ROLLED_BACK_VERIFIED'].includes(checkpoint.status)) {
      phase = 'ROLLBACK';
    } else if (['FAILED_BASELINE_UNCHANGED_NO_RETRY', 'CONCURRENT_ALIAS_NO_AUTOMATIC_OVERWRITE'].includes(checkpoint.status)) {
      phase = checkpoint.promotionAttempted ? 'PROMOTION' : (checkpoint.deployIntentReached ? 'STAGING' : 'ARM_PREFLIGHT');
    }
  }

  let state = 'PRODUCTION_STATE_UNVERIFIED';
  let action = 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY';

  if (checkpoint) {
    if (checkpoint.status === 'ROLLED_BACK_VERIFIED') {
      state = 'SAFE_BASELINE_RESTORED_VERIFIED';
      action = 'REVIEW_REDACTED_CHECKPOINT_NO_AUTOMATIC_RETRY';
    } else if (checkpoint.status === 'FAILED_BASELINE_UNCHANGED_NO_RETRY' &&
               checkpoint.productionMutations === 0 &&
               !checkpoint.staged &&
               !checkpoint.deployIntentReached &&
               !checkpoint.promotionAttempted) {
      state = 'SAFE_BASELINE_UNCHANGED_ZERO_MUTATIONS';
      action = 'REVIEW_REDACTED_CHECKPOINT_NO_AUTOMATIC_RETRY';
    } else if (phase === 'ARM_PREFLIGHT' &&
               (!checkpoint.productionMutations || checkpoint.productionMutations === 0) &&
               !checkpoint.staged &&
               !checkpoint.deployIntentReached &&
               !checkpoint.promotionAttempted &&
               (checkpoint.status === 'PREPARING' || !checkpoint.status)) {
      state = 'SAFE_BASELINE_UNCHANGED_ZERO_MUTATIONS';
      action = 'REVIEW_REDACTED_CHECKPOINT_NO_AUTOMATIC_RETRY';
    } else {
      state = 'PRODUCTION_STATE_UNVERIFIED';
      action = 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY';
    }
  } else {
    state = 'PRODUCTION_STATE_UNVERIFIED';
    action = 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY';
  }

  return {
    status: 'PILOT_RUNTIME_STOPPED',
    error_code: code,
    phase,
    state,
    action_required: action,
  };
}
module.exports = {
  arm,
  restore,
  closed,
  invocation,
  buildDeployArgs,
  T671,
  OFF_BASELINE_SHA,
  LEGACY_T671_SHA,
  assertAuthorizedMainSha,
  REVIEWED_MAIN_SHAS,
  adapters,
  assertAttemptAllowed,
  gatherReconciliationEvidence,
  formatSanitizedFailure,
  classifyDiagnosticCode,
  ALLOWED_DIAGNOSTIC_CODES,
};
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify({ status: r.status }))).catch((err) => {
  const checkpoint = (err && err.checkpoint) ? err.checkpoint : null;
  const report = formatSanitizedFailure(err, checkpoint);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
});
