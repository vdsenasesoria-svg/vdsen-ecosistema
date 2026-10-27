'use strict';
// T649 — a production deployment created by the Vercel CLI carries only githubCommitSha (no org/repo/ref). The Rules lane must accept it by EXACT identity
// (the reviewed deployment id, project, READY, SHA) and must keep the full Git validation for any deployment that carries Git metadata.
const test = require('node:test');
const assert = require('node:assert/strict');
const { json, verifyDeployment } = require('../scripts/release/lib.cjs');

const state = json('.release/vdsen-client.json');
const clone = (x) => JSON.parse(JSON.stringify(x));
const cli = (id, sha) => ({ id, projectId: state.production_project, readyState: 'READY', source: 'cli', meta: { githubCommitSha: sha, lambdaRuntimeStats: '{}' } });
const prod = () => cli(state.production_deployment, state.runtime_sha);
const rollback = () => cli(state.rollback_deployment, state.rollback_runtime_sha);
const git = (sha) => ({ projectId: state.production_project, readyState: 'READY', meta: { githubCommitSha: sha, githubCommitRef: 'codex/client-app-next', githubCommitOrg: 'vdsenasesoria-svg', githubCommitRepo: 'vdsen-ecosistema' } });

test('T649 the reviewed CLI production and rollback deployments are accepted exactly as the live lane calls verifyDeployment', () => {
  assert.equal(verifyDeployment(prod(), state, state.runtime_sha, 'codex/client-app-next').id, state.production_deployment);   // live.cjs prepare/apply (production)
  assert.equal(verifyDeployment(rollback(), state, state.rollback_runtime_sha).id, state.rollback_deployment);                  // live.cjs prepare/recover/rollback (rollback target)
});

test('T649 a CLI deployment is rejected for another id, another project, a non-READY state or another SHA', () => {
  const cases = [
    ['other deployment id (same SHA)', (d) => { d.id = 'dpl_SomeOtherDeployment000000000000'; }],
    ['missing id', (d) => { delete d.id; }],
    ['id of the rollback deployment presented as production', (d) => { d.id = state.rollback_deployment; }],
    ['other project', (d) => { d.projectId = 'prj_other'; }],
    ['not READY', (d) => { d.readyState = 'BUILDING'; }],
    ['ERROR state', (d) => { d.readyState = 'ERROR'; }],
    ['different SHA', (d) => { d.meta.githubCommitSha = '0'.repeat(40); }],
    ['no SHA', (d) => { delete d.meta.githubCommitSha; }],
    ['no meta', (d) => { delete d.meta; }]];
  for (const [label, mutate] of cases) {
    const bad = prod(); mutate(bad);
    assert.throws(() => verifyDeployment(bad, state, state.runtime_sha, 'codex/client-app-next'), undefined, label);
  }
  const badRollback = rollback(); badRollback.id = state.production_deployment;
  assert.throws(() => verifyDeployment(badRollback, state, state.rollback_runtime_sha), undefined, 'production id presented as rollback');
});

test('T649 a SHA the reviewed state does not pin, or pins ambiguously, never reaches the CLI path', () => {
  const unknown = cli('dpl_Unpinned000000000000000000000', 'a'.repeat(40));
  assert.throws(() => verifyDeployment(unknown, state, 'a'.repeat(40)), /no unambiguous reviewed id/);
  const ambiguous = clone(state); ambiguous.rollback_runtime_sha = ambiguous.runtime_sha;
  assert.throws(() => verifyDeployment(prod(), ambiguous, ambiguous.runtime_sha), /no unambiguous reviewed id/);
  const unpinned = clone(state); delete unpinned.production_deployment;
  assert.throws(() => verifyDeployment(prod(), unpinned, unpinned.runtime_sha), /no unambiguous reviewed id/);
});

test('T649 Git validation is unchanged: full metadata passes, and any wrong or partial Git metadata is rejected even when the id and SHA are right', () => {
  assert.doesNotThrow(() => verifyDeployment(git(state.runtime_sha), state, state.runtime_sha, 'codex/client-app-next'));
  const cases = [
    ['wrong org', (d) => { d.meta.githubCommitOrg = 'someone-else'; }], ['wrong repo', (d) => { d.meta.githubCommitRepo = 'fork'; }],
    ['wrong ref', (d) => { d.meta.githubCommitRef = 'feature'; }],
    ['org only', (d) => { delete d.meta.githubCommitRepo; delete d.meta.githubCommitRef; }], ['repo only', (d) => { delete d.meta.githubCommitOrg; delete d.meta.githubCommitRef; }],
    ['ref only', (d) => { delete d.meta.githubCommitOrg; delete d.meta.githubCommitRepo; }], ['org+repo without ref', (d) => { delete d.meta.githubCommitRef; }]];
  for (const [label, mutate] of cases) {
    const bad = git(state.runtime_sha); bad.id = state.production_deployment; mutate(bad);
    assert.throws(() => verifyDeployment(bad, state, state.runtime_sha, 'codex/client-app-next'), undefined, label);
  }
  const withIdAndWrongOrg = prod(); withIdAndWrongOrg.meta.githubCommitOrg = 'someone-else';
  assert.throws(() => verifyDeployment(withIdAndWrongOrg, state, state.runtime_sha), undefined, 'Git metadata present forces Git validation');
});

test('T649 the fix is confined to lib.cjs: the live lane call sites still pass no extra identity and the mutation path is untouched', () => {
  const fs = require('node:fs');
  const live = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  assert.equal((live.match(/verifyDeployment\(/g) || []).length, 5, 'five call sites, unchanged');
  assert.match(live, /verifyDeployment\(await deployment\(s, s\.production_deployment\), s, s\.runtime_sha, 'codex\/client-app-next'\)/);
});
