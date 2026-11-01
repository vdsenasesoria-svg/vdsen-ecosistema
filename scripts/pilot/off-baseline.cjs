'use strict';
// Authenticated official-release artifacts prove OFF at the immutable build. This is not a fresh project-env proof.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto'), G = require('../release/numeric-guard.cjs');
const DIR = 'release-output/off-baseline';
const REPO = 'vdsenasesoria-svg/vdsen-ecosistema';
function officialRun(run, s) {
  const id = String(s.app_release.source_release_run);
  assert.match(id, /^[1-9][0-9]+$/, 'OFF_BASELINE_SOURCE_RUN_REQUIRED');
  assert.equal(String(run.id), id); assert.equal(run.repository.full_name, REPO);
  assert.equal(run.path, '.github/workflows/vdsen-app-release-prod.yml');
  assert.equal(run.head_branch, 'codex/client-app-next'); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.run_attempt, 1);
  return id;
}
function verify(s, baseline, deployment, { run, preflight, staged, result }) {
  const sourceRun = officialRun(run, s);
  assert.equal(baseline.officialReleaseRun, sourceRun);
  assert.equal(s.runtime_sha, baseline.runtimeSha); assert.equal(s.production_deployment, baseline.deployment);
  assert.equal(s.app_release.runtime_sha, baseline.runtimeSha); assert.equal(s.app_release.deployment, baseline.deployment);
  const expect = { project: s.production_project, team: s.vercel_team, runtimeSha: baseline.runtimeSha };
  assert.equal(deployment.id || deployment.uid, baseline.deployment);
  assert.equal(deployment.projectId, expect.project); assert.equal(deployment.teamId || deployment.ownerId, expect.team);
  assert.equal(deployment.readyState, 'READY'); assert.equal(deployment.target, 'production');
  assert.equal(deployment.meta.githubCommitSha, baseline.runtimeSha);
  assert.equal(staged.staged_deployment, baseline.deployment); assert.equal(staged.candidate_sha, baseline.runtimeSha);
  assert.equal(staged.production_project, expect.project); assert.equal(staged.vercel_team, expect.team);
  assert.equal(staged.staged_target, 'production'); assert.equal(staged.staged_ready_state, 'READY');
  assert.equal(preflight.runtime_sha, baseline.runtimeSha);
  const before = G.assertDisarmedEvidence(preflight.numeric_guard, expect), after = G.assertDisarmedEvidence(staged.numeric_guard, expect);
  G.assertUnchanged(before, after); G.attachDeploymentEnv(after, deployment);
  // Check the recorded chronology without substituting a historical clock for any live guard.
  const a = Date.parse(before.captured_at), b = Date.parse(after.captured_at), t = Date.parse(staged.staged_at);
  assert.ok([a, b, t].every(Number.isFinite) && a <= b && b <= t && t - a <= G.MAX_EVIDENCE_AGE_MS, 'OFF_BUILD_CHRONOLOGY_INVALID');
  assert.equal(String(result.release_id), sourceRun); assert.equal(result.runtime_sha, baseline.runtimeSha);
  assert.equal(result.app_release_status, 'SUCCESS'); assert.equal(result.state, 'VERIFIED');
  assert.equal(result.promotion_model, 'staged_production'); assert.equal(result.promotion_target, baseline.deployment);
  assert.equal(result.production_deployment, baseline.deployment); assert.equal(result.rollback_required, false);
  assert.equal(result.rules_mutated, false); assert.equal(result.main_unchanged, true);
  return { status: 'OFF_AT_IMMUTABLE_BUILD', officialReleaseRun: sourceRun, deployment: baseline.deployment,
    evidenceSha256: crypto.createHash('sha256').update(JSON.stringify({ run, preflight, staged, result })).digest('hex') };
}
function load(s, baseline, deployment) {
  const read = name => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  return verify(s, baseline, deployment, { run: read('official-run.json'), preflight: read('app-preflight.json'), staged: read('app-staged.json'), result: read('app-result.json') });
}
function download(s) {
  const id = String(s.app_release.source_release_run); assert.match(id, /^[1-9][0-9]+$/);
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const getRun = () => JSON.parse(gh(['api', 'repos/' + REPO + '/actions/runs/' + id]));
  const before = getRun(); officialRun(before, s);
  fs.mkdirSync(DIR, { recursive: true });
  gh(['run', 'download', id, '--repo', REPO, '--name', 'app-release-result-' + id, '--dir', DIR]);
  const after = getRun(); officialRun(after, s);
  assert.equal(after.updated_at, before.updated_at, 'OFF_BASELINE_RUN_CHANGED');
  fs.writeFileSync(path.join(DIR, 'official-run.json'), JSON.stringify(after));
}
module.exports = { officialRun, verify, load, download };
if (require.main === module) {
  try { download(JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'))); }
  catch (_) { console.error('OFF_BASELINE_ARTIFACT_UNAVAILABLE_OR_UNVERIFIED: no deployment or rollback authorized.'); process.exitCode = 1; }
}
