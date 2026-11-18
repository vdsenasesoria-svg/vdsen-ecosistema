'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnosePreflight } = require('../scripts/pilot/ayrton-runtime.cjs');

test('vdsen-app-diagnostics.yml integrates read-only diagnose-preflight with WIF datastore scope and zero mutations', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'vdsen-app-diagnostics.yml'), 'utf8');
  assert.match(yml, /id-token:\s*write/);
  assert.match(yml, /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.match(yml, /access_token_scopes:\s*https:\/\/www\.googleapis\.com\/auth\/datastore/);
  assert.match(yml, /node scripts\/pilot\/ayrton-runtime\.cjs diagnose-preflight/);
  assert.match(yml, /release-output\/ayrton-runtime-preflight\.json/);
  assert.ok(!yml.includes('ayrton-runtime.cjs arm'));
  assert.ok(!yml.includes('ayrton-window-ops.cjs'));
  assert.ok(!yml.includes('AYRTON_RUNTIME_RELEASE_ENABLED'));
  assert.ok(!yml.includes('AYRTON_WINDOW_RELEASE_ENABLED'));
});

test('diagnosePreflight reports identity, plan, fence, or numeric guard failures without mutating', async () => {
  const w = {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid: 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83',
    uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    coachId: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    planId: 'D5fVjlS3NysTD6Yg2ZpW',
    runtimeSha: '38ee4cb26691ff54e1e331a2c60f2f453b1c2469',
    deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
    expiresAt: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    operationId: 'op-diag-readonly-check',
  };
  const baseline = {
    runtimeSha: w.runtimeSha,
    deployment: w.deployment,
    officialReleaseRun: '44179647316',
  };
  const baseIo = {
    validateSource: async () => 'a'.repeat(40),
    validateBaseline: async () => ({ status: 'OFF_AT_IMMUTABLE_BUILD' }),
    current: async () => w.deployment,
    snapshot: async () => ({
      uid: w.uid,
      coachId: w.coachId,
      client: { coachId: w.coachId, activePlanId: w.planId },
      release: { enabled: false, clientIds: [w.uid] },
      coach: { autoApplyCanary: { enabled: false, clientIds: [w.uid] } },
    }),
    offProof: async () => ({
      schema: 'vdsen-numeric-guard-v1',
      status: 'DISARMED',
      flags: { AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE' },
      env_fingerprint: 'a'.repeat(64),
      captured_at: new Date().toISOString(),
    }),
    assertNoPriorOperation: async () => true,
  };

  const planMismatch = await diagnosePreflight(w, baseline, {
    ...baseIo,
    snapshot: async () => { throw new Error('ACTIVE_PLAN_MISMATCH'); },
  });
  assert.equal(planMismatch.status, 'PREFLIGHT_FAIL');
  assert.equal(planMismatch.mutationsAttempted, 0);
  assert.equal(planMismatch.failingCheck, 'SNAPSHOT_READ');
  assert.equal(planMismatch.failingCode, 'ACTIVE_PLAN_MISMATCH');
});
