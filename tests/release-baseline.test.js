'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { json, git, hash } = require('../scripts/release/lib.cjs');
const { compare, validateBaseline, parseEvents, critical } = require('../scripts/release/baseline.cjs');
const { environmentContract, workflowGuard, prepare, apply, rollback, rollbackRulesProvenance } = require('../scripts/release/live.cjs');
const { workflowContract } = require('../scripts/release/check.cjs');
const baseline = json('.release/known-baseline-failures.json');
const state = json('.release/vdsen-client.json');
const clone = x => JSON.parse(JSON.stringify(x));
const records = category => baseline.failures.filter(x => x.category === category).map(x => ({ file: x.suite, name: x.test_name, status: x.status }));
const options = { verifySource: false };
test('pinned manifest has exact source-backed identities and independently protected critical tests', () => {
  validateBaseline(baseline);
  assert.equal(baseline.failures.filter(x => x.category === 'unit').length, 13);
  assert.equal(baseline.failures.filter(x => x.category === 'emulator').length, 37);
  assert.equal(baseline.failures.filter(x => x.critical).length, 38);
  assert.equal(critical('unit', 'tests/release-baseline.test.js', 'arbitrary test'), true);
});
test('known noncritical failures match, but known security failures still block', () => {
  const unit = compare(baseline, 'unit', records('unit'), options);
  assert.equal(unit.TEST_BASELINE_MATCH, 'YES'); assert.equal(unit.NEW_REGRESSIONS, 0);
  assert.equal(unit.KNOWN_FAILURES_REMAINING, 13); assert.equal(unit.gate, 'FAIL');
  assert.equal(unit.critical_failure_ids.length, 1);
  const emulator = compare(baseline, 'emulator', records('emulator'), options);
  assert.equal(emulator.TEST_BASELINE_MATCH, 'YES'); assert.equal(emulator.NEW_REGRESSIONS, 0);
  assert.equal(emulator.critical_failure_ids.length, 37); assert.equal(emulator.gate, 'FAIL');
  const onlyCriticalFixed = records('unit').map(r => ({ ...r, status: critical('unit', r.file, r.name) ? 'PASS' : r.status }));
  assert.equal(compare(baseline, 'unit', onlyCriticalFixed, options).gate, 'PASS');
});
test('same failure count with a replacement identity is a regression, never a count waiver', () => {
  const current = records('unit'); current[0] = { ...current[0], name: 'Previously passing test now fails' };
  const r = compare(baseline, 'unit', current, options);
  assert.equal(r.gate, 'FAIL'); assert.equal(r.TEST_BASELINE_MATCH, 'NO');
  assert.ok(r.new_regression_ids.some(x => x.includes('Previously passing')));
  assert.ok(r.new_regression_ids.some(x => x.endsWith(':MISSING_TEST')));
});
test('observed known PASS is FIXED_BASELINE_FAILURE; absence, skip and cancellation changes block', () => {
  const current = records('unit').map(x => ({ ...x, status: 'PASS' }));
  const fixed = compare(baseline, 'unit', current, options);
  assert.equal(fixed.gate, 'PASS'); assert.equal(fixed.FIXED_BASELINE_FAILURES, 13);
  assert.match(fixed.recommendation, /reviewed baseline commit/);
  current[0].status = 'SKIP'; assert.equal(compare(baseline, 'unit', current, options).gate, 'FAIL');
  current[0].status = 'CANCELLED'; assert.ok(compare(baseline, 'unit', current, options).NEW_REGRESSIONS > 0);
  assert.throws(() => compare(baseline, 'unit', [], options), /Empty/);
  assert.equal(compare(baseline, 'unit', current.slice(1), options).FIXED_BASELINE_FAILURES, 12);
});
test('missing required suite, duplicate records and malformed event output fail closed', () => {
  assert.equal(compare(baseline, 'unit', records('unit'), { ...options, expectedFiles: ['tests/missing.test.js'] }).gate, 'FAIL');
  assert.throws(() => compare(baseline, 'unit', [...records('unit'), records('unit')[0]], options), /Duplicate/);
  assert.throws(() => parseEvents('# pass 1060\n# fail 13\n'), /missing/);
  assert.throws(() => parseEvents('VDSEN_TEST_EVENT invalid-json'));
});
test('manifest cannot conceal security failures, use wildcards or drift from pinned source', () => {
  for (const mutate of [x => { x.failures[0].test_name = '*'; }, x => { x.failures[0].source_sha = '0'.repeat(40); }, x => { x.failures.push(x.failures[0]); }, x => { delete x.failures[0].reason; }, x => { x.failures.find(f => f.critical).critical = false; }, x => { x.failures[0].test_source_sha256 = '0'.repeat(64); }]) {
    const invalid = clone(baseline); mutate(invalid); assert.throws(() => validateBaseline(invalid));
  }
});
test('canonical workflow contract is repo-only and checks can run with production disabled', () => {
  const previous = process.env.PRODUCTION_RELEASE_ENABLED;
  try { process.env.PRODUCTION_RELEASE_ENABLED = 'false'; workflowContract(); }
  finally { if (previous === undefined) delete process.env.PRODUCTION_RELEASE_ENABLED; else process.env.PRODUCTION_RELEASE_ENABLED = previous; }
  const source = fs.readFileSync('.github/workflows/vdsen-release-prod.yml', 'utf8');
  assert.ok(source.indexOf('test "$PRODUCTION_RELEASE_ENABLED" = true') < source.indexOf('- id: google'));
});
test('false, missing and malformed kill switch blocks all live entrypoints before network activity', async () => {
  const before = { ...process.env }, fetch = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; throw new Error('Network must not run'); };
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/codex/client-app-next' });
    for (const value of ['false', '', 'TRUE', '1']) {
      process.env.PRODUCTION_RELEASE_ENABLED = value;
      assert.throws(workflowGuard);
      for (const run of [prepare, apply, rollback]) await assert.rejects(run(), /Emergency stop/);
    }
    delete process.env.PRODUCTION_RELEASE_ENABLED;
    await assert.rejects(prepare(), /Emergency stop/);
    assert.equal(calls, 0);
  } finally { global.fetch = fetch; for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
});
test('environment identifiers must match pinned projects, identity provider and service account', () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, { GCP_PROJECT_ID: state.firebase_project, VERCEL_PROJECT_ID: state.production_project, VERCEL_ORG_ID: state.vercel_team, GCP_RELEASE_SERVICE_ACCOUNT: 'vdsen-release-bot@vdsen-ecosistema.iam.gserviceaccount.com', GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/github/providers/release' });
    environmentContract(state);
    for (const key of ['GCP_PROJECT_ID', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'GCP_RELEASE_SERVICE_ACCOUNT', 'GCP_WORKLOAD_IDENTITY_PROVIDER']) {
      const value = process.env[key]; process.env[key] = 'wrong'; assert.throws(() => environmentContract(state)); process.env[key] = value;
    }
  } finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
});
test('current production is distinct from rollback and advance never promotes a preview', () => {
  assert.equal(state.production_deployment, 'dpl_4xAS5kXuny7APpaRjozGeNdPETMj');
  assert.notEqual(state.production_deployment, state.rollback_deployment);
  // After the first app release the state describes an APP release, so the mode is app_only. This
  // does NOT relax the rules lane: the assertions below still prove live.cjs cannot deploy,
  // promote or switch the app, and that rules provenance still fails closed.
  assert.equal(state.release_mode, 'app_only');
  const source = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  const body = source.slice(source.indexOf('async function apply()'), source.indexOf('async function rollback()'));
  assert.ok(!body.includes('switchApp('));
  const content = fs.readFileSync(state.rules_transition.rollback_source_path, 'utf8');
  rollbackRulesProvenance({ package_sha: git('rev-parse', 'HEAD').trim(), state, old_rules: { sha256: hash(content), source: { files: [{ content }] } } });
  assert.throws(() => rollbackRulesProvenance({ package_sha: git('rev-parse', 'HEAD').trim(), state, old_rules: { sha256: hash('wrong'), source: { files: [{ content: 'wrong' }] } } }), /do not match/);
});

const PACKAGE_SHA = git('rev-parse', 'HEAD').trim();

test('rollback rules provenance is decoupled from the app rollback runtime and fails closed', () => {
  const rules = state.rules_transition;
  const content = git('show', PACKAGE_SHA + ':' + rules.rollback_source_path);
  const snap = (over = {}, pkg = PACKAGE_SHA) => ({ package_sha: pkg, state, old_rules: { sha256: hash(content), source: { files: [{ content }] } }, ...over });
  // 1. correct rollback reference at snapshot.package_sha -> PASS
  rollbackRulesProvenance(snap());
  // 2. the live rollback rules are NOT the app rollback runtime's committed rules (the original defect)
  assert.notEqual(rules.rollback_sha256, hash(git('show', state.rollback_runtime_sha + ':firestore.rules')));
  // 3. the app rollback pair stays pinned and independently verifiable. It is now the deployment
  // that was serving production before the first app release, which is what a recovery would
  // actually restore.
  assert.equal(state.rollback_deployment, 'dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB');
  assert.equal(state.rollback_runtime_sha, 'd7bb71521d750eafd46a15fdd3c6ee157d4bd4cf');
  // 4. tampered captured live source -> FAIL
  assert.throws(() => rollbackRulesProvenance({ package_sha: PACKAGE_SHA, state, old_rules: { sha256: hash(content), source: { files: [{ content: content + '\n// tampered' }] } } }), /own hash/);
  const other = git('show', state.runtime_sha + ':firestore.rules');
  assert.throws(() => rollbackRulesProvenance({ package_sha: PACKAGE_SHA, state, old_rules: { sha256: hash(other), source: { files: [{ content: other }] } } }), /reviewed rollback rules reference/);
  // 5. wrong rollback_sha256 -> FAIL
  const wrongHash = clone(state); wrongHash.rules_transition.rollback_sha256 = '0'.repeat(64);
  assert.throws(() => rollbackRulesProvenance({ package_sha: PACKAGE_SHA, state: wrongHash, old_rules: { sha256: hash(content), source: { files: [{ content }] } } }), /content-addressed|reviewed rollback rules reference/);
  // malformed rollback_sha256 -> FAIL
  const malformed = clone(state); malformed.rules_transition.rollback_sha256 = 'nothex';
  assert.throws(() => rollbackRulesProvenance({ package_sha: PACKAGE_SHA, state: malformed, old_rules: { sha256: hash(content), source: { files: [{ content }] } } }), /missing/);
  // 6. path whose embedded SHA does not equal rollback_sha256 -> FAIL
  const mismatchedPath = clone(state); mismatchedPath.rules_transition.rollback_source_path = '.release/rollback/firestore.rules.' + '1'.repeat(64) + '.rules';
  assert.throws(() => rollbackRulesProvenance({ package_sha: PACKAGE_SHA, state: mismatchedPath, old_rules: { sha256: hash(content), source: { files: [{ content }] } } }), /content-addressed/);
  // missing path -> FAIL
  const missingPath = clone(state); delete missingPath.rules_transition.rollback_source_path;
  assert.throws(() => rollbackRulesProvenance({ package_sha: PACKAGE_SHA, state: missingPath, old_rules: { sha256: hash(content), source: { files: [{ content }] } } }), /content-addressed/);
  // 7. missing file at snapshot.package_sha -> FAIL
  assert.throws(() => rollbackRulesProvenance(snap({}, state.rollback_runtime_sha)), /does not exist|exists on disk|unknown revision|invalid object|Path .* does not exist/i);
  // 8. malformed / missing snapshot.package_sha -> FAIL
  for (const bad of ['', 'notasha', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
    assert.throws(() => rollbackRulesProvenance(snap({}, bad)), /package SHA/, 'package_sha must be validated: ' + bad);
  }
  const noPkg = snap(); delete noPkg.package_sha;
  assert.throws(() => rollbackRulesProvenance(noPkg), /package SHA/);
  // 9. the committed reference file is a real, tracked, non-empty rules file with the pinned hash
  assert.match(content, /^rules_version\s*=/);
  const tracked = git('ls-files', '--cached', rules.rollback_source_path).trim() || git('ls-files', rules.rollback_source_path).trim();
  assert.ok(tracked.length > 0, 'rollback rules reference must be a tracked repository file (git add it)');
});

test('rollback rules reference is immutable to the release package SHA, not the current worktree', () => {
  const rules = state.rules_transition;
  const content = git('show', PACKAGE_SHA + ':' + rules.rollback_source_path);
  // 10. historical package SHA remains authoritative even if the WORKTREE reference differs
  const worktreeCopy = fs.readFileSync(rules.rollback_source_path, 'utf8');
  const hist = { package_sha: PACKAGE_SHA, state, old_rules: { sha256: hash(content), source: { files: [{ content }] } } };
  rollbackRulesProvenance(hist);
  // a bogus package SHA cannot substitute a different reference, even if the worktree has one
  assert.equal(hash(worktreeCopy), rules.rollback_sha256);
  assert.throws(() => rollbackRulesProvenance({ ...hist, package_sha: state.rollback_runtime_sha }), /does not exist|exists on disk|unknown revision|invalid object|Path .* does not exist/i);
  // 11. deleting the reference from a LATER branch state does not invalidate the historical package
  //     (the gate reads git history at package_sha, never the current worktree)
  const src = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  const fn = src.slice(src.indexOf('function rollbackRulesProvenance'), src.indexOf('async function smoke'));
  assert.ok(fn.includes("git('show', snapshot.package_sha + ':' + rules.rollback_source_path)"), 'reference must be resolved from the package commit');
  assert.ok(!/readFileSync\(rules\.rollback_source_path/.test(fn), 'reference must not be read from the current worktree');
});

test('rollback APP provenance stays independent: the app pair is still pinned and verified on its own', () => {
  const src = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  // the rules gate must no longer consult the app rollback runtime's rules
  assert.ok(!/rollback_runtime_sha\s*\+\s*':firestore\.rules'/.test(src), 'rules provenance must not be coupled to rollback_runtime_sha');
  // the app rollback deployment is still verified against rollback_runtime_sha inside recover()
  const rec = src.slice(src.indexOf('async function recover'), src.indexOf('async function apply()'));
  assert.ok(rec.includes("deployment(s, snapshot.state.rollback_deployment), s, snapshot.state.rollback_runtime_sha"), 'app rollback deployment must still be verified against rollback_runtime_sha');
  assert.ok(rec.includes('verifyDeployment('), 'app rollback verification must remain');
  // restoreRules still restores from the captured pre-mutation source
  assert.ok(rec.includes('restoreRules(s, snapshot)'));
  const restore = src.slice(src.indexOf('async function restoreRules'), src.indexOf('function rollbackRulesProvenance'));
  assert.ok(restore.includes('snapshot.old_rules.source'), 'restoration must use the captured pre-mutation source');
});
