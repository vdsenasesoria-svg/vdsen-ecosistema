'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  arm,
  assertAttemptAllowed,
  BOUNDED_THREE_RUN_RECOVERY_T839,
} = require('../scripts/pilot/ayrton-runtime.cjs');

test('T839-A1: vdsen-ayrton-runtime.yml downloads off-baseline after baseline gates and before arm, preserving restore_run', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'vdsen-ayrton-runtime.yml'), 'utf8');
  const idxGates = yml.indexOf('Full baseline gates before a new runtime');
  const idxOff = yml.indexOf('Prove the captured OFF baseline from its official app release artifacts');
  const idxArm = yml.indexOf('One pilot deployment with both fences closed, then promote the same ID');
  const idxRestore = yml.indexOf('Restore only the captured OFF baseline, with alias and byte readback');
  assert.ok(idxGates > 0 && idxOff > idxGates && idxArm > idxOff && idxRestore > idxArm);
  const offBlock = yml.slice(idxOff, yml.indexOf('- id: google'));
  assert.ok(!offBlock.includes("inputs.restore_run == ''"), 'off-baseline must run for both arm and restore_run');
});

test('T839-A2: T821.1 preserves pre-existing release-output/off-baseline directory', () => {
  const dir = 'release-output/off-baseline';
  const marker = path.join(dir, 't839-marker.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ ok: true }));
  try {
    execFileSync(process.execPath, ['--test', 'tests/t821-app-only-provenance.test.js'], { stdio: 'pipe' });
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('T839-A3: missing or invalid off-baseline fails validateBaseline before stage()', async () => {
  let staged = false;
  await assert.rejects(
    () => arm({
      schema: 'vdsen-ayrton-window-v1',
      mode: 'STAGE1_SHADOW',
      pid: 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83',
      uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
      coachId: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
      planId: 'D5fVjlS3NysTD6Yg2ZpW',
      runtimeSha: '38ee4cb26691ff54e1e331a2c60f2f453b1c2469',
      deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
      expiresAt: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      operationId: 'op-ayrton-shadow-20261118120000-11223344',
    }, {
      runtimeSha: '38ee4cb26691ff54e1e331a2c60f2f453b1c2469',
      deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
      officialReleaseRun: '44179647316',
    }, {
      validateSource: async () => 'a'.repeat(40),
      validateBaseline: async () => { throw new Error('OFF_BASELINE_EVIDENCE_INVALID'); },
      current: async () => 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
      snapshot: async () => { throw new Error('SHOULD_NOT_REACH'); },
      offProof: async () => { throw new Error('SHOULD_NOT_REACH'); },
      assertNoPriorOperation: async () => true,
      save: async () => {},
      stage: async () => { staged = true; },
      promote: async () => {},
      rollback: async () => {},
    }),
    /OFF_BASELINE_EVIDENCE_INVALID/
  );
  assert.equal(staged, false);
});

test('T839-C: bounded three-run recovery validates exact set, zero mutations, baseline/runtime, alias, and fresh operationId', () => {
  const ctx = {
    baselineDeployment: BOUNDED_THREE_RUN_RECOVERY_T839.baselineDeployment,
    runtimeSha: BOUNDED_THREE_RUN_RECOVERY_T839.runtimeSha,
    operationId: 'op-ayrton-shadow-20261118120000-aabbccdd',
  };
  const runs4 = [
    { id: 44228373358, status: 'completed', conclusion: 'failure' },
    { id: 44229712230, status: 'completed', conclusion: 'failure' },
    { id: 44290105865, status: 'completed', conclusion: 'failure' },
    { id: 44295000000, status: 'in_progress', conclusion: null },
  ];
  const makeEv = (runId, phaseProven) => ({
    runId,
    baselineDeployment: ctx.baselineDeployment,
    currentAlias: ctx.baselineDeployment,
    stagedDeploymentsCount: 0,
    priorRunMutations: 0,
    evidenceVerified: true,
    phaseProven,
  });
  const evs = [
    makeEv('44228373358', 'ATTEMPT_GATE_PREFLIGHT_ZERO_MUTATIONS'),
    makeEv('44229712230', 'ARM_PREFLIGHT_ZERO_MUTATIONS'),
    makeEv('44290105865', 'ARM_PREFLIGHT_ZERO_MUTATIONS'),
  ];

  const ok = assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', evs, ctx);
  assert.equal(ok.mode, 'T839_BOUNDED_THREE_RUN_RECOVERY');
  assert.deepEqual(ok.reconciledRunIds, ['44228373358', '44229712230', '44290105865']);

  // Additional unauthorized run / 5th attempt rejected
  assert.throws(
    () => assertAttemptAllowed([...runs4, { id: 44295000001, status: 'in_progress', conclusion: null }], '44295000001', '44228373358,44229712230,44290105865', evs, ctx),
    /ONE_ATTEMPT_PER_BASELINE_EXCEEDED/
  );
  // Missing evidence
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', evs.slice(0, 2), ctx),
    /PRIOR_RUN_EVIDENCE_MISSING/
  );
  // Non-zero priorRunMutations
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', [evs[0], evs[1], { ...evs[2], priorRunMutations: 1 }], ctx),
    /PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO/
  );
  // Different baseline / runtime / alias
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', evs, { ...ctx, baselineDeployment: 'dpl_other' }),
    /RECONCILIATION_SET_NOT_AUTHORIZED/
  );
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', evs, { ...ctx, runtimeSha: '0'.repeat(40) }),
    /RECONCILIATION_SET_NOT_AUTHORIZED/
  );
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', [evs[0], evs[1], { ...evs[2], currentAlias: 'dpl_other' }], ctx),
    /PRODUCTION_ALIAS_NOT_ON_BASELINE/
  );
  // Reused prior operationId rejected
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44290105865', evs, { ...ctx, operationId: 'op-ayrton-shadow-20261118105624-d9b2c441' }),
    /PILOT_OPERATION_ALREADY_EXISTS/
  );
  // Different 3-run set rejected
  assert.throws(
    () => assertAttemptAllowed(runs4, '44295000000', '44228373358,44229712230,44999999999', evs, ctx),
    /EXTRAORDINARY_RECOVERY_NOT_AUTHORIZED/
  );
});
