'use strict';
// T577: the baseline-aware CI unit gate (scripts/release/baseline.cjs) runs ONLY tests/*.test.js and rejects observed tests whose file is
// outside tests/. The server-side suites under api/ (including the T576 function-bundle guard) were therefore part of no CI gate.
// Each node:test-based api/*.test.js is run here as one test (child process), so a failure in any of them fails the unit gate.
// Legacy api/*.test.js that are standalone scripts (no node:test) are not run here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = path.join(__dirname, '..', 'api');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && /node:test/.test(fs.readFileSync(path.join(dir, f), 'utf8'))).sort();

test('T577 api suites are discovered, including the T576 bundle guard', () => {
  assert.ok(files.includes('_functionBundleTrace.test.js'));
  assert.ok(files.includes('_autonomousProgression.test.js'));
});
for (const f of files) {
  test('T577 api/' + f + ' passes', () => {
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.FIRESTORE_EMULATOR_HOST;
    const r = spawnSync(process.execPath, ['--test', path.join('api', f)], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    assert.equal(r.status, 0, ((r.stdout || '') + (r.stderr || '')).slice(-1500));
  });
}
