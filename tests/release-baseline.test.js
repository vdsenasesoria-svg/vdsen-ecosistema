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
  assert.equal(state.production_deployment, 'dpl_FngrtpodSKHZ9aPk75aA5SS7JGnB');
  assert.notEqual(state.production_deployment, state.rollback_deployment);
  assert.equal(state.release_mode, 'rules_only');
  const source = fs.readFileSync('scripts/release/live.cjs', 'utf8');
  const body = source.slice(source.indexOf('async function apply()'), source.indexOf('async function rollback()'));
  assert.ok(!body.includes('switchApp('));
  const content = git('show', state.rollback_runtime_sha + ':firestore.rules');
  rollbackRulesProvenance({ state, old_rules: { sha256: hash(content), source: { files: [{ content }] } } });
  assert.throws(() => rollbackRulesProvenance({ state, old_rules: { sha256: hash('wrong'), source: { files: [{ content: 'wrong' }] } } }), /incompatible/);
});
