'use strict';
// PR #52 contract: the read-only diagnostics workflow takes an exact, validated runtime SHA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const wf = fs.readFileSync('.github/workflows/vdsen-app-diagnostics.yml', 'utf8').split('\r\n').join('\n');
const code = wf.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

test('runtime_sha input is required and feeds both candidate steps', () => {
  assert.match(code, /runtime_sha:\n(?:.*\n)*?\s+required: true/);
  assert.equal((code.match(/APP_RUNTIME_SHA: \$\{\{ inputs\.runtime_sha \}\}/g) || []).length, 2);
  assert.ok(!/APP_RUNTIME_SHA: [0-9a-f]{40}/.test(code), 'no hard-coded candidate SHA');
});
test('validation step runs before the first use of the input and passes it only via env', () => {
  const v = code.indexOf('Validate runtime_sha'), first = code.indexOf('app-diagnostics.cjs');
  assert.ok(v > 0 && v < first);
  assert.ok(!/run:[^\n]*\$\{\{ inputs\./.test(code), 'inputs must never be interpolated into a shell command');
});
test('the shell validator accepts only 40 lowercase hex characters (whole string, newline-safe)', () => {
  const ok = 'a'.repeat(40);
  const run = v => spawnSync('bash', ['-c', '[[ "$V" =~ ^[0-9a-f]{40}$ ]]'], { env: { ...process.env, V: v } }).status === 0;
  assert.equal(run(ok), true);
  for (const bad of ['HEAD', 'latest', 'main', 'codex/client-app-next', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), ok + '\n; id', '', ' ' + ok])
    assert.equal(run(bad), false, JSON.stringify(bad));
  assert.ok(code.includes('[[ ! "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]]'), 'workflow uses the same validator');
});
test('workflow stays read-only with minimal permissions', () => {
  assert.match(code, /permissions:\n\s+contents: read/);
  assert.ok(!/id-token|write|\/promote|\/rollback\/|firebaserules|firestore\.googleapis|CLIENT_APP_RELEASE_ENABLED|PRODUCTION_RELEASE_ENABLED/.test(code));
  assert.ok(!/echo[^\n]*(VERCEL_TOKEN|secrets\.)/.test(code));
});
