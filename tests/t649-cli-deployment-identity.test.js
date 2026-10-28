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
  // Same SHA AND same deployment id in both roles: a one-element id set must not be mistaken for an unambiguous identity.
  const sameBoth = clone(state); sameBoth.rollback_runtime_sha = sameBoth.runtime_sha; sameBoth.rollback_deployment = sameBoth.production_deployment;
  assert.throws(() => verifyDeployment(prod(), sameBoth, sameBoth.runtime_sha), /no unambiguous reviewed id/);
  assert.throws(() => verifyDeployment(prod(), sameBoth, sameBoth.runtime_sha, 'codex/client-app-next'), /no unambiguous reviewed id/);
  // Different SHAs but one deployment id pinned to both roles is not a reviewable baseline either.
  const sameId = clone(state); sameId.rollback_deployment = sameId.production_deployment;
  assert.throws(() => verifyDeployment(prod(), sameId, sameId.runtime_sha), /no unambiguous reviewed id/);
  assert.throws(() => verifyDeployment(cli(sameId.rollback_deployment, sameId.rollback_runtime_sha), sameId, sameId.rollback_runtime_sha), /no unambiguous reviewed id/);
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
  // Partial Git metadata stays under the Git contract whether or not the caller passes `ref` (rollback calls omit it). org+repo without a ref is the one shape the
  // ORIGINAL contract also accepts when no ref argument is given (the ref is simply not checked); the differential test below proves nothing else changed.
  const all = { githubCommitRef: 'codex/client-app-next', githubCommitOrg: 'vdsenasesoria-svg', githubCommitRepo: 'vdsen-ecosistema' };
  for (const keep of [['githubCommitRef'], ['githubCommitOrg'], ['githubCommitRepo'], ['githubCommitOrg', 'githubCommitRef'], ['githubCommitRepo', 'githubCommitRef']]) {
    const partial = prod(); for (const k of keep) partial.meta[k] = all[k];
    assert.throws(() => verifyDeployment(partial, state, state.runtime_sha), undefined, 'partial ' + keep + ' without ref argument');
    assert.throws(() => verifyDeployment(partial, state, state.runtime_sha, 'codex/client-app-next'), undefined, 'partial ' + keep + ' with ref argument');
  }
  const orgRepo = prod(); orgRepo.meta.githubCommitOrg = all.githubCommitOrg; orgRepo.meta.githubCommitRepo = all.githubCommitRepo;
  assert.doesNotThrow(() => verifyDeployment(orgRepo, state, state.runtime_sha), 'org+repo, no ref argument: identical to the original contract');
  assert.throws(() => verifyDeployment(orgRepo, state, state.runtime_sha, 'codex/client-app-next'), undefined, 'org+repo but no ref while a ref is required');
  const withIdAndWrongOrg = prod(); withIdAndWrongOrg.meta.githubCommitOrg = 'someone-else';
  assert.throws(() => verifyDeployment(withIdAndWrongOrg, state, state.runtime_sha), undefined, 'Git metadata present forces Git validation');
});

test('T649 the fix is confined to lib.cjs: the live lane call sites still pass no extra identity and the mutation path is untouched', () => {
  const fs = require('node:fs');
  const live = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  assert.equal((live.match(/verifyDeployment\(/g) || []).length, 5, 'five call sites, unchanged');
  assert.match(live, /verifyDeployment\(await deployment\(s, s\.production_deployment\), s, s\.runtime_sha, 'codex\/client-app-next'\)/);
});

// Reference oracle: the ORIGINAL verifyDeployment (43a92eed). For every deployment that carries any Git metadata the new function must decide exactly as before.
function originalVerify(d, st, sha, ref) {
  assert.equal(d.projectId, st.production_project); assert.equal(d.readyState, 'READY'); assert.equal(d.meta?.githubCommitSha, sha);
  assert.equal(d.meta?.githubCommitOrg, 'vdsenasesoria-svg'); assert.equal(d.meta?.githubCommitRepo, 'vdsen-ecosistema');
  if (ref) assert.equal(d.meta?.githubCommitRef, ref);
  return d;
}
test('T649 differential: every deployment carrying any Git metadata gets the same verdict as the original contract', () => {
  const orgs = [undefined, 'vdsenasesoria-svg', 'other'], repos = [undefined, 'vdsen-ecosistema', 'fork'], refs = [undefined, 'codex/client-app-next', 'feature'];
  const ok = (fn) => { try { fn(); return true; } catch { return false; } };
  let compared = 0;
  for (const o of orgs) for (const r of repos) for (const f of refs) {
    if (o === undefined && r === undefined && f === undefined) continue;                         // the CLI shape: the only intentional change
    for (const id of [undefined, state.production_deployment, 'dpl_x']) for (const ready of ['READY', 'ERROR']) for (const argRef of [undefined, 'codex/client-app-next']) {
      const d = prod(); d.readyState = ready; if (id === undefined) delete d.id; else d.id = id;
      if (o !== undefined) d.meta.githubCommitOrg = o; if (r !== undefined) d.meta.githubCommitRepo = r; if (f !== undefined) d.meta.githubCommitRef = f;
      assert.equal(ok(() => verifyDeployment(d, state, state.runtime_sha, argRef)), ok(() => originalVerify(d, state, state.runtime_sha, argRef)), JSON.stringify({ o, r, f, id, ready, argRef }));
      compared++;
    }
  }
  assert.ok(compared > 300, 'matrix size ' + compared);
});
