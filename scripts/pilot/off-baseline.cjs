'use strict';
// Authenticated official-release artifacts prove OFF at the immutable build. This is not a fresh project-env proof.
//
// Provenance model (T677):
//  - AUTHENTICITY comes from the GitHub Actions API, read through the authenticated `gh` session: the run (repository,
//    workflow path, branch, event, attempt, conclusion and head commit == the historical runtime) and exactly one artifact of
//    that run, whose provider-reported sha256 digest must match the downloaded archive and the digest pinned in the
//    reviewed baseline.
//  - `evidenceSha256` below is a hash computed locally over what was downloaded. It detects later modification of the saved
//    files; by itself it proves nothing about where they came from.
//  - This is HISTORICAL evidence about one immutable build. It says nothing about what production serves now: the live
//    alias is read separately by the lane before every mutation.
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
// Exactly one artifact with the expected name; a truncated listing or a duplicate name is never resolved by picking one.
function selectArtifact(list, id) {
  const name = 'app-release-result-' + id;
  assert.ok(list && Array.isArray(list.artifacts), 'OFF_BASELINE_ARTIFACT_LIST_INVALID');
  assert.equal(list.total_count, list.artifacts.length, 'OFF_BASELINE_ARTIFACT_LIST_TRUNCATED');
  const matches = list.artifacts.filter(a => a.name === name);
  assert.equal(matches.length, 1, 'OFF_BASELINE_ARTIFACT_MISSING_OR_AMBIGUOUS');
  return matches[0];
}
function assertArtifactRecord(a, run, id, baseline) {
  assert.equal(a.name, 'app-release-result-' + id, 'OFF_BASELINE_ARTIFACT_NAME');
  assert.equal(a.expired, false, 'OFF_BASELINE_ARTIFACT_EXPIRED');
  const wr = a.workflow_run || {};
  assert.equal(String(wr.id), id, 'OFF_BASELINE_ARTIFACT_RUN_MISMATCH');
  assert.equal(wr.head_sha, run.head_sha, 'OFF_BASELINE_ARTIFACT_COMMIT_MISMATCH');
  assert.equal(wr.head_branch, 'codex/client-app-next', 'OFF_BASELINE_ARTIFACT_BRANCH_MISMATCH');
  assert.match(String(a.digest || ''), /^sha256:[a-f0-9]{64}$/, 'OFF_BASELINE_ARTIFACT_DIGEST_MISSING');
  if (baseline && baseline.evidenceArtifactDigest) assert.equal(a.digest, baseline.evidenceArtifactDigest, 'OFF_BASELINE_ARTIFACT_DIGEST_MISMATCH');
  return a;
}
function verify(s, baseline, deployment, { run, preflight, staged, result, rollback, artifact }) {
  const sourceRun = officialRun(run, s);
  assert.equal(baseline.officialReleaseRun, sourceRun);
  // The official run must be the execution of the historical commit this baseline names, not merely a run of the workflow:
  // its head commit is that commit, or a descendant of it (the lane may run newer tooling than the candidate it releases).
  assert.match(String(run.head_sha || ''), /^[0-9a-f]{40}$/, 'OFF_BASELINE_RUN_COMMIT_REQUIRED');
  if (run.head_sha !== baseline.runtimeSha) {
    let descends = false;
    try { execFileSync('git', ['merge-base', '--is-ancestor', baseline.runtimeSha, run.head_sha], { stdio: 'ignore' }); descends = true; } catch (_) { descends = false; }
    assert.ok(descends, 'OFF_BASELINE_RUN_COMMIT_MISMATCH');
  }
  assertArtifactRecord(artifact || {}, run, sourceRun, baseline);
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
  // Links between the artifacts of the SAME execution: candidate, project, team, previous production and staged build.
  assert.equal(preflight.rollback_artifact, 'app-rollback-' + sourceRun + '.json', 'OFF_BASELINE_ROLLBACK_ARTIFACT_NAME');
  assert.equal(String(rollback.release_id), sourceRun, 'OFF_BASELINE_ROLLBACK_RUN_MISMATCH');
  assert.equal(rollback.candidate_sha, baseline.runtimeSha, 'OFF_BASELINE_ROLLBACK_COMMIT_MISMATCH');
  assert.equal(rollback.production_project, expect.project, 'OFF_BASELINE_ROLLBACK_PROJECT_MISMATCH');
  assert.equal(rollback.vercel_team, expect.team, 'OFF_BASELINE_ROLLBACK_TEAM_MISMATCH');
  assert.equal(preflight.candidate, rollback.candidate_deployment, 'OFF_BASELINE_CANDIDATE_MISMATCH');
  assert.equal(preflight.production_deployment, rollback.production_deployment, 'OFF_BASELINE_PREVIOUS_MISMATCH');
  assert.equal(result.previous_deployment, rollback.production_deployment, 'OFF_BASELINE_PREVIOUS_MISMATCH');
  assert.equal(staged.production_alias_before, rollback.production_deployment, 'OFF_BASELINE_STAGED_BASELINE_MISMATCH');
  assert.equal(staged.production_alias_after, staged.production_alias_before, 'OFF_BASELINE_ALIAS_MOVED_DURING_STAGING');
  assert.notEqual(staged.staged_deployment, rollback.production_deployment, 'OFF_BASELINE_STAGED_IS_PREVIOUS');
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
  return { status: 'OFF_AT_IMMUTABLE_BUILD', officialReleaseRun: sourceRun, deployment: baseline.deployment, artifactDigest: artifact.digest,
    evidenceSha256: crypto.createHash('sha256').update(JSON.stringify({ run, preflight, staged, result, rollback, artifactDigest: artifact.digest })).digest('hex') };
}
function load(s, baseline, deployment) {
  const read = name => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  const preflight = read('app-preflight.json');
  // The rollback artifact is addressed by the exact name the official preflight recorded for the official run; a name that
  // is not that exact file name is rejected before any path is built from it.
  const expectedName = 'app-rollback-' + String(s.app_release.source_release_run) + '.json';
  assert.equal(preflight.rollback_artifact, expectedName, 'OFF_BASELINE_ROLLBACK_ARTIFACT_NAME');
  return verify(s, baseline, deployment, { run: read('official-run.json'), preflight, staged: read('app-staged.json'), result: read('app-result.json'),
    rollback: read(expectedName), artifact: read('official-artifact.json') });
}
function download(s, baseline = {}) {
  const id = String(s.app_release.source_release_run); assert.match(id, /^[1-9][0-9]+$/);
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ghBytes = args => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const getRun = () => JSON.parse(gh(['api', 'repos/' + REPO + '/actions/runs/' + id]));
  const before = getRun(); officialRun(before, s);
  const record = assertArtifactRecord(selectArtifact(JSON.parse(gh(['api', 'repos/' + REPO + '/actions/runs/' + id + '/artifacts?per_page=100'])), id), before, id, baseline);
  // The archive itself must match the provider digest (and, through assertArtifactRecord, the reviewed pin) before extraction.
  const archive = ghBytes(['api', 'repos/' + REPO + '/actions/artifacts/' + record.id + '/zip']);
  assert.equal('sha256:' + crypto.createHash('sha256').update(archive).digest('hex'), record.digest, 'OFF_BASELINE_ARTIFACT_BYTES_MISMATCH');
  // A fresh directory: files left by an earlier download must never be picked up as this run's evidence.
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  gh(['run', 'download', id, '--repo', REPO, '--name', record.name, '--dir', DIR]);
  const after = getRun(); officialRun(after, s);
  assert.equal(after.updated_at, before.updated_at, 'OFF_BASELINE_RUN_CHANGED');
  assert.equal(after.head_sha, before.head_sha, 'OFF_BASELINE_RUN_CHANGED');
  fs.writeFileSync(path.join(DIR, 'official-run.json'), JSON.stringify(after));
  fs.writeFileSync(path.join(DIR, 'official-artifact.json'), JSON.stringify({ id: record.id, name: record.name, digest: record.digest, expired: record.expired, workflow_run: record.workflow_run }));
}
module.exports = { officialRun, selectArtifact, assertArtifactRecord, verify, load, download };
if (require.main === module) {
  try { download(JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'))); }
  catch (_) { console.error('OFF_BASELINE_ARTIFACT_UNAVAILABLE_OR_UNVERIFIED: no deployment or rollback authorized.'); process.exitCode = 1; }
}
