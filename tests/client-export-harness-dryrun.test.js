'use strict';
// Runs the real-emulator integration suite's code (tests/client-export-emulator.cjs) against the rules-emulating in-memory fake, so the harness and
// the production Firestore adapter stay executable in environments without the emulator JAR. Not a substitute for the real emulator run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('CE-DRY the emulator integration suite executes green against the rules-emulating fake (harness self-check)', () => {
  const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'helpers', 'emulator-dryrun-preload.cjs'), '--test', path.join(__dirname, 'client-export-emulator.cjs')],
    { encoding: 'utf8', timeout: 120000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
  const out = r.stdout || '';
  const num = re => { const m = out.match(re); return m ? Number(m[1]) : -1; };
  assert.equal(num(/^# fail (\d+)/m), 0, out.slice(-3000));
  assert.equal(num(/^# skipped (\d+)/m), 0);
  assert.equal(num(/^# pass (\d+)/m), 11);
  assert.equal(r.status, 0);
});
