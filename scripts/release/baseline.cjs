'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { json, validate, git, hash } = require('./lib.cjs');
const id = (category, file, name) => category + ':' + file + '::' + name;
// Independent of the manifest: a reviewer cannot waive security by changing a flag.
const critical = (category, file, name) => category === 'emulator' || /release|security|secret|provenance|kill.switch|numeric.apply.enabled/i.test(file + ' ' + name) || /\/t53[6-9][-_]/.test(file);
function validateBaseline(manifest, verifySource = true) {
  validate(manifest, json('.release/schema/known-baseline-failures.schema.json'));
  const seen = new Set();
  if (verifySource) git('cat-file', '-e', manifest.source_sha + '^{commit}');
  for (const failure of manifest.failures) {
    assert.equal(failure.source_sha, manifest.source_sha);
    assert.equal(failure.id, id(failure.category, failure.suite, failure.test_name));
    assert.ok(!seen.has(failure.id), 'Duplicate baseline identity'); seen.add(failure.id);
    assert.ok(failure.test_name.trim() && !/[?*]/.test(failure.test_name), 'Wildcard baseline forbidden');
    assert.ok(failure.reason.trim());
    assert.equal(failure.critical, critical(failure.category, failure.suite, failure.test_name));
    if (verifySource) assert.equal(hash(git('show', manifest.source_sha + ':' + failure.suite)), failure.test_source_sha256);
  }
  return manifest;
}
function compare(manifest, category, records, options = {}) {
  validateBaseline(manifest, options.verifySource !== false);
  assert.ok(['unit', 'emulator'].includes(category));
  const observed = new Map();
  for (const record of records) {
    assert.ok(/^tests\/[A-Za-z0-9_.-]+\.(?:js|cjs)$/.test(record.file), 'Invalid observed suite');
    assert.ok(typeof record.name === 'string' && record.name.trim(), 'Missing observed test name');
    assert.ok(['PASS', 'FAIL', 'CANCELLED', 'SKIP'].includes(record.status), 'Invalid observed status');
    const key = id(category, record.file, record.name);
    assert.ok(!observed.has(key), 'Duplicate observed identity: ' + key);
    observed.set(key, record);
  }
  assert.ok(observed.size > 0, 'Empty test result cannot pass');
  const baseline = new Map(manifest.failures.filter(x => x.category === category).map(x => [x.id, x]));
  const remaining = [], fixed = [], regressions = [], security = [];
  for (const [key, record] of observed) {
    const pinned = baseline.get(key);
    if (record.status === 'PASS') { if (pinned) fixed.push(key); continue; }
    if (record.status === 'SKIP') { regressions.push(key + ':SKIPPED'); continue; }
    if (critical(category, record.file, record.name)) security.push(key);
    if (!pinned || pinned.status !== record.status) regressions.push(key);
    else {
      remaining.push(key);
      if (options.verifySource !== false && hash(git('show', 'HEAD:' + pinned.suite)) !== pinned.test_source_sha256) regressions.push(key + ':TEST_SOURCE_CHANGED');
    }
  }
  // Absence is not evidence of a fix; only an observed PASS is FIXED_BASELINE_FAILURE.
  for (const [key] of baseline) if (!observed.has(key)) regressions.push(key + ':MISSING_TEST');
  for (const file of options.expectedFiles || []) if (![...observed.values()].some(x => x.file === file)) regressions.push(category + ':' + file + ':MISSING_SUITE');
  return {
    category, gate: regressions.length || security.length ? 'FAIL' : 'PASS',
    TEST_BASELINE_MATCH: regressions.length ? 'NO' : 'YES', NEW_REGRESSIONS: regressions.length,
    KNOWN_FAILURES_REMAINING: remaining.length, FIXED_BASELINE_FAILURES: fixed.length,
    known_failure_ids: remaining, fixed_baseline_failure_ids: fixed, new_regression_ids: regressions,
    critical_failure_ids: security, recommendation: fixed.length ? 'Remove fixed exact identities through a reviewed baseline commit' : null,
    raw_results: Object.fromEntries(['PASS', 'FAIL', 'CANCELLED', 'SKIP'].map(status => [status, records.filter(x => x.status === status).length]))
  };
}
function parseEvents(output) {
  const lines = output.split(/\r?\n/).filter(x => x.startsWith('VDSEN_TEST_EVENT '));
  assert.ok(lines.length, 'Structured test events missing; fail closed');
  return lines.map(x => JSON.parse(x.slice('VDSEN_TEST_EVENT '.length)));
}
// Import already captured Node spec logs, using failure sections with exact file+name.
// This is for reconciliation only; CI always consumes structured reporter events.
function importCaptured(output, category) {
  const failures = [];
  const expression = /^test at (tests[\\/][^\r\n]+?):\d+:\d+\r?\n[✖×] (.+?) \([\d.]+ms\)\r?\n([\s\S]*?)(?=^test at |^\[suite\]|$(?![\s\S]))/gm;
  for (const match of output.matchAll(expression)) {
    const file = match[1].replace(/\\/g, '/'), name = match[2];
    const detail = match[3];
    const status = /test timed out|cancelledByParent|testTimeoutFailure/.test(detail) ? 'CANCELLED' : 'FAIL';
    failures.push({ file, name, status, reason: detail.includes('UNKNOWN') ? 'Emulator returned UNKNOWN after preceding tenant timeout' : status === 'CANCELLED' ? 'Test timed out after 60000ms' : detail.includes('TypeError') ? 'TypeError reading missing regex match' : 'Existing assertion or generated document/template mismatch' });
  }
  assert.ok(failures.length, 'No exact identities in captured ' + category + ' log');
  return failures;
}
function runCategory(category) {
  const manifest = validateBaseline(json('.release/known-baseline-failures.json'));
  const unitFiles = fs.readdirSync('tests').filter(x => x.endsWith('.test.js')).sort().map(x => 'tests/' + x);
  const reporter = pathToFileURL(path.resolve(__dirname, 'test-reporter.cjs')).href;
  const args = category === 'unit' ? ['--test', '--test-reporter=' + reporter, ...unitFiles] : ['scripts/test-auto-apply-emulator.cjs'];
  const env = { ...process.env };
  if (category === 'emulator') env.NODE_OPTIONS = '--test-reporter=' + JSON.stringify(reporter);
  const run = spawnSync(process.execPath, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = (run.stdout || '') + (run.stderr || '');
  fs.mkdirSync('release-output', { recursive: true });
  fs.writeFileSync('release-output/' + category + '-tests.log', output);
  let report;
  try {
    assert.ok(!run.error && run.status !== null, 'Test runner failed or was interrupted');
    const records = parseEvents(output);
    if (run.status !== 0) assert.ok(records.some(x => x.status === 'FAIL' || x.status === 'CANCELLED'), 'Runner failed without identified failing test');
    // Required emulator suite inventory comes from the existing canonical runner, not a parallel suite list.
    const expected = category === 'unit' ? unitFiles : [...fs.readFileSync('scripts/test-auto-apply-emulator.cjs', 'utf8').matchAll(/path\.join\('tests', '([^']+)'\)/g)].map(x => 'tests/' + x[1]);
    assert.ok(expected.length);
    report = compare(manifest, category, records, { expectedFiles: expected });
  } catch (e) { report = { category, gate: 'FAIL', TEST_BASELINE_MATCH: 'NO', NEW_REGRESSIONS: 1, error: e.message }; }
  report.package_sha = git('rev-parse', 'HEAD').trim();
  report.github_run_id = process.env.GITHUB_RUN_ID || null;
  fs.writeFileSync('release-output/' + category + '-baseline-result.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  return report.gate === 'PASS' ? 0 : 1;
}
if (require.main === module) {
  try {
    const category = process.argv[2]; assert.ok(['unit', 'emulator'].includes(category));
    process.exitCode = runCategory(category);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { id, critical, validateBaseline, compare, parseEvents, importCaptured, runCategory };
