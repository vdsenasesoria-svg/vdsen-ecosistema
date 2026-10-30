'use strict';
// Dedicated, explicitly authorized PILOT runtime lane. Does not write Firestore or project variables.
// The app-only Numeric Guard is unchanged: it cannot release an armed runtime.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const A = require('../release/app-live.cjs'), G = require('../release/numeric-guard.cjs');
const C = require('./ayrton-canary.cjs'), P = require('./window-protocol.cjs');
const T671 = 'a8cf462c78c4bd795cc9f485a82f64429c179f00';
const FILE = 'release-output/ayrton-runtime.json';
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
}
// Dependency boundary is used for isolated simulations. Production CLI always constructs its own adapters.
async function arm(w, baseline, io) {
  P.windowSpec(w);
  assert.equal(baseline.runtimeSha, T671, 'OFF_T671_RELEASE_REQUIRED_FIRST');
  assert.notEqual(w.runtimeSha, T671, 'PILOT_PROBE_RUNTIME_REQUIRED');
  const report = { schema: 'vdsen-ayrton-runtime-release-v1', operationId: w.operationId, runtimeSha: w.runtimeSha,
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
  assert.equal(report.baseline.runtimeSha, T671); assert.ok(report.staged && report.staged.id);
  await io.validateBaseline(report.baseline);
  const current = await io.current();
  assert.ok([report.baseline.deployment, report.staged.id].includes(current), 'FOREIGN_ALIAS_NO_OVERWRITE');
  if (current !== report.baseline.deployment) await io.rollback(report.baseline.deployment);
  assert.equal(await io.current(), report.baseline.deployment); await io.verifyBytes(report.baseline.runtimeSha);
  return { status: 'ROLLBACK_VERIFIED', wrote: current === report.baseline.deployment ? 0 : 1 };
}
function adapters(s) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const read = async p => { const r = await C.http('GET', p, process.env.GOOGLE_ACCESS_TOKEN); assert.equal(r.status, 200, 'FENCE_READ_FAILED'); return C.decDoc(r.body); };
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
      assert.equal(main, 'f6596ba5207dc158b8a9b01483cd0fe0ebeb274c');
      await require('./ayrton-window.cjs').assertLegacyRetired(s);
      return git('rev-parse', sha + '^{tree}');
    },
    validateBaseline: async b => {
      assert.equal(s.runtime_sha, T671); assert.equal(s.production_deployment, b.deployment);
      assert.equal(s.app_release.deployment, b.deployment); assert.match(String(s.app_release.source_release_run), /^[1-9][0-9]+$/);
      const d = await A.deployment(s, b.deployment); assert.equal(d.readyState, 'READY');
      assert.equal(d.id || d.uid, b.deployment);
      assert.equal(d.projectId, P.PROJECT); assert.equal(d.teamId || d.ownerId, P.TEAM);
      assert.equal(d.meta && d.meta.githubCommitSha, b.runtimeSha);
      return require('./off-baseline.cjs').load(s, b, d);
    },
    snapshot: async w => {
      const client = await read('clients/' + w.uid + '?mask.fieldPaths=coachId&mask.fieldPaths=activePlanId');
      const release = await read(C.RELEASE_PATH);
      const coach = await read('coaches/' + w.coachId + '?mask.fieldPaths=autoApplyCanary');
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
      for (const filter of ['meta-vdsenPilotOperation=' + encodeURIComponent(id), 'meta-vdsenPilotBaseline=' + encodeURIComponent(s.production_deployment)]) {
        const r = await vget('/v6/deployments?projectId=' + P.PROJECT + '&' + filter);
        assert.ok(Array.isArray(r.deployments) && !r.pagination?.next && r.deployments.length === 0, 'OPERATION_EXISTS_OR_LIST_INCOMPLETE');
      }
    },
    stage: async w => {
      const root = path.resolve(process.env.RUNNER_TEMP), dest = path.resolve(root, 'vdsen-ayrton-' + process.env.GITHUB_RUN_ID);
      assert.ok(dest.startsWith(root + path.sep) && dest !== root, 'UNSAFE_EXPORT_PATH');
      A.exportCandidateTree(w.runtimeSha, dest); A.verifyExportedTree(w.runtimeSha, dest, A.servedSurface());
      const args = ['deploy', dest, '--prod', '--skip-domain', '--yes', '--json', '-m', 'githubCommitSha=' + w.runtimeSha,
        '-m', 'vdsenPilotOperation=' + w.operationId, '-m', 'vdsenPilotBaseline=' + s.production_deployment,
        ...G.KNOWN_FLAGS.flatMap(key => ['--env', key + '=true']),
        '--env', 'VDSEN_PILOT_WINDOW=' + JSON.stringify({ uidHash: require('node:crypto').createHash('sha256').update(w.uid).digest('hex'),
          planHash: require('node:crypto').createHash('sha256').update(w.planId).digest('hex'), expiresAt: w.expiresAt, operationId: w.operationId })];
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
  return arm(w, { runtimeSha: s.runtime_sha, deployment: s.production_deployment, officialReleaseRun: String(s.app_release.source_release_run) }, io);
}
module.exports = { arm, restore, closed, invocation, T671 };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify({ status: r.status }))).catch(() => {
  console.error('PILOT_RUNTIME_STOPPED: review the redacted checkpoint; do not repeat deployment.'); process.exitCode = 1;
});
