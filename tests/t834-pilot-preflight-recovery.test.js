'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  arm,
  diagnosePreflight,
  listAllPilotWorkflowRuns,
  assertAttemptAllowed,
  formatSanitizedFailure,
  classifyDiagnosticCode,
  BOUNDED_TWO_RUN_RECOVERY_T834,
} = require('../scripts/pilot/ayrton-runtime.cjs');

function sampleWindow(overrides = {}) {
  return {
    schema: 'vdsen-ayrton-window-v1',
    mode: 'STAGE1_SHADOW',
    pid: 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83',
    uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    coachId: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    planId: 'D5fVjlS3NysTD6Yg2ZpW',
    runtimeSha: '38ee4cb26691ff54e1e331a2c60f2f453b1c2469',
    deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
    expiresAt: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    operationId: 'op-ayrton-shadow-20261118040000-11223344',
    ...overrides,
  };
}

function sampleBaseline(overrides = {}) {
  return {
    runtimeSha: '38ee4cb26691ff54e1e331a2c60f2f453b1c2469',
    deployment: 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
    officialReleaseRun: '44179647316',
    ...overrides,
  };
}

function validDisarmed() {
  return {
    schema: 'vdsen-numeric-guard-v1',
    status: 'DISARMED',
    flags: {
      AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE',
      AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_FALSE',
    },
    env_fingerprint: 'a'.repeat(64),
    captured_at: new Date().toISOString(),
  };
}

function closedSnapshot() {
  return {
    uid: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    coachId: 'z82EDPvsCaabfMN3eGAP3rpxeMt1',
    client: { coachId: 'z82EDPvsCaabfMN3eGAP3rpxeMt1', activePlanId: 'D5fVjlS3NysTD6Yg2ZpW' },
    release: { enabled: false, clientIds: ['z82EDPvsCaabfMN3eGAP3rpxeMt1'] },
    coach: { autoApplyCanary: { enabled: false, clientIds: ['z82EDPvsCaabfMN3eGAP3rpxeMt1'] } },
  };
}

function readOnlyIo(overrides = {}) {
  return {
    validateSource: async () => 'a'.repeat(40),
    validateBaseline: async () => ({ status: 'OFF_AT_IMMUTABLE_BUILD' }),
    current: async () => 'dpl_7ByavXXqB8m8SzKtz3W5erWJherU',
    snapshot: async () => closedSnapshot(),
    offProof: async () => validDisarmed(),
    assertNoPriorOperation: async () => true,
    ...overrides,
  };
}

test('arm classifies preflight subprocess/assertion failures with preflight_step and zero secret leaks', async () => {
  const cases = [
    {
      name: 'SOURCE_NOT_ANCESTOR',
      io: { validateSource: async () => { const e = new Error('SOURCE_NOT_ANCESTOR'); e.cause = new Error('git secret_path=/tmp/foo'); throw e; } },
      expectedStep: 'VALIDATE_SOURCE',
      expectedCode: 'SOURCE_NOT_ANCESTOR',
    },
    {
      name: 'BASELINE_NOT_READY',
      io: { validateBaseline: async () => { throw new Error('BASELINE_NOT_READY'); } },
      expectedStep: 'VALIDATE_BASELINE',
      expectedCode: 'BASELINE_NOT_READY',
    },
    {
      name: 'CURRENT_ALIAS_READ_FAILED',
      io: { current: async () => { throw new TypeError('fetch failed: Bearer secret_token_xyz'); } },
      expectedStep: 'CURRENT_ALIAS',
      expectedCode: 'CURRENT_ALIAS_READ_FAILED',
    },
    {
      name: 'FIRESTORE_NETWORK_ERROR',
      io: { snapshot: async () => { throw new TypeError('network timeout reading clients/z82EDPvsCaabfMN3eGAP3rpxeMt1'); } },
      expectedStep: 'SNAPSHOT_READ',
      expectedCode: 'FIRESTORE_NETWORK_ERROR',
    },
    {
      name: 'RELEASE_FENCE_MUST_BE_DISABLED',
      io: { snapshot: async () => ({ ...closedSnapshot(), release: { enabled: true, clientIds: ['z82EDPvsCaabfMN3eGAP3rpxeMt1'] } }) },
      expectedStep: 'FENCES_CLOSED',
      expectedCode: 'RELEASE_FENCE_MUST_BE_DISABLED',
    },
    {
      name: 'COACH_FENCE_MUST_BE_DISABLED',
      io: { snapshot: async () => ({ ...closedSnapshot(), coach: { autoApplyCanary: { enabled: true, clientIds: ['z82EDPvsCaabfMN3eGAP3rpxeMt1'], prescriptionExerciseIds: ['ab150537-0d02-423b-a7e0-2b2f1a8a9a83'] } } }) },
      expectedStep: 'FENCES_CLOSED',
      expectedCode: 'COACH_FENCE_MUST_BE_DISABLED',
    },
    {
      name: 'VERCEL_NETWORK_ERROR',
      io: { offProof: async () => { throw new Error('socket hang up secret_env=123'); } },
      expectedStep: 'OFF_PROOF',
      expectedCode: 'VERCEL_NETWORK_ERROR',
    },
    {
      name: 'NUMERIC_APPLY_ACTIVE',
      io: {
        offProof: async () => ({
          ...validDisarmed(),
          status: 'ARMED',
          flags: { AUTONOMOUS_PROGRESSION_ENABLED: 'PLAIN_FALSE', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'PLAIN_TRUE' },
        }),
      },
      expectedStep: 'OFF_PROOF_DISARMED',
      expectedCode: 'EVIDENCE_NOT_DISARMED',
    },
    {
      name: 'PILOT_BASELINE_ALREADY_STAGED',
      io: { assertNoPriorOperation: async () => { throw new Error('PILOT_BASELINE_ALREADY_STAGED: dpl_7ByavXXqB8m8SzKtz3W5erWJherU'); } },
      expectedStep: 'ASSERT_NO_PRIOR_OPERATION',
      expectedCode: 'PILOT_BASELINE_ALREADY_STAGED',
    },
  ];

  for (const c of cases) {
    let caught = null;
    try {
      await arm(sampleWindow(), sampleBaseline(), {
        ...readOnlyIo(c.io),
        save: async () => { throw new Error('MUST_NOT_SAVE_BEFORE_DEPLOY_INTENT'); },
        stage: async () => { throw new Error('MUST_NOT_STAGE'); },
        promote: async () => { throw new Error('MUST_NOT_PROMOTE'); },
        rollback: async () => { throw new Error('MUST_NOT_ROLLBACK'); },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, c.name + ' should fail');
    const sanitized = formatSanitizedFailure(caught, caught.checkpoint);
    assert.equal(sanitized.phase, 'ARM_PREFLIGHT', c.name);
    assert.equal(sanitized.preflight_step, c.expectedStep, c.name);
    assert.equal(sanitized.error_code, c.expectedCode, c.name);
    assert.equal(sanitized.state, 'SAFE_BASELINE_UNCHANGED_ZERO_MUTATIONS', c.name);
    assert.ok(!JSON.stringify(sanitized).includes('secret_'), c.name);
    assert.ok(!JSON.stringify(sanitized).includes('z82EDPvsCaabfMN3eGAP3rpxeMt1'), c.name);
  }
});

test('diagnosePreflight is strictly read-only and never invokes stage/promote/rollback/save', async () => {
  let mutatingCalls = 0;
  const ioWithSpies = {
    ...readOnlyIo(),
    save: async () => { mutatingCalls++; },
    stage: async () => { mutatingCalls++; },
    promote: async () => { mutatingCalls++; },
    rollback: async () => { mutatingCalls++; },
  };
  const passRes = await diagnosePreflight(sampleWindow(), sampleBaseline(), ioWithSpies);
  assert.equal(passRes.status, 'PREFLIGHT_PASS');
  assert.equal(passRes.mutationsAttempted, 0);
  assert.equal(mutatingCalls, 0);
  assert.equal(passRes.failingCheck, null);

  const failRes = await diagnosePreflight(sampleWindow(), sampleBaseline(), {
    ...ioWithSpies,
    snapshot: async () => { throw new Error('FENCE_READ_FAILED: status 403'); },
  });
  assert.equal(failRes.status, 'PREFLIGHT_FAIL');
  assert.equal(failRes.mutationsAttempted, 0);
  assert.equal(mutatingCalls, 0);
  assert.equal(failRes.failingCheck, 'SNAPSHOT_READ');
  assert.equal(failRes.failingCode, 'FENCE_READ_FAILED');
  assert.equal(failRes.checks.find(c => c.check === 'FENCES_CLOSED').status, 'SKIPPED');
});

test('assertAttemptAllowed accepts T834 bounded two-run recovery only with valid evidence and rejects invalid states', () => {
  const ctx = {
    baselineDeployment: BOUNDED_TWO_RUN_RECOVERY_T834.baselineDeployment,
    runtimeSha: BOUNDED_TWO_RUN_RECOVERY_T834.runtimeSha,
    operationId: 'op-ayrton-shadow-20261118040000-11223344',
  };
  const runs3 = [
    { id: 44228373358, status: 'completed', conclusion: 'failure' },
    { id: 44229712230, status: 'completed', conclusion: 'failure' },
    { id: 44230000000, status: 'in_progress', conclusion: null },
  ];
  const ev1 = {
    runId: '44228373358',
    baselineDeployment: ctx.baselineDeployment,
    currentAlias: ctx.baselineDeployment,
    stagedDeploymentsCount: 0,
    priorRunMutations: 0,
    evidenceVerified: true,
    phaseProven: 'ATTEMPT_GATE_PREFLIGHT_ZERO_MUTATIONS',
  };
  const ev2 = {
    runId: '44229712230',
    baselineDeployment: ctx.baselineDeployment,
    currentAlias: ctx.baselineDeployment,
    stagedDeploymentsCount: 0,
    priorRunMutations: 0,
    evidenceVerified: true,
    phaseProven: 'ARM_PREFLIGHT_ZERO_MUTATIONS',
  };

  const ok = assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, ev2], ctx);
  assert.equal(ok.mode, 'T834_BOUNDED_TWO_RUN_RECOVERY');
  assert.deepEqual(ok.reconciledRunIds, ['44228373358', '44229712230']);

  // Rejects missing evidence, missing explicit runId, duplicate evidence, or foreign runId
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1], ctx), /PRIOR_RUN_EVIDENCE_MISSING/);
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev2, runId: undefined }], ctx), /PRIOR_RUN_EVIDENCE_MISSING/);
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev1 }], ctx), /PRIOR_RUN_EVIDENCE_MISSING/);
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev2, runId: '44999999999' }], ctx), /PRIOR_RUN_EVIDENCE_MISSING/);
  // Rejects truncated workflow_runs count
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, ev2], { ...ctx, totalWorkflowRunsCount: 4 }), /WORKFLOW_RUNS_LIST_INCOMPLETE/);
  // Rejects unverified evidence
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev2, evidenceVerified: false }], ctx), /PRIOR_RUN_EVIDENCE_UNVERIFIED/);
  // Rejects mutations > 0
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev2, priorRunMutations: 1 }], ctx), /PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO/);
  // Rejects staged deployments > 0
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev2, stagedDeploymentsCount: 1 }], ctx), /PENDING_OR_STAGED_DEPLOYMENTS_EXIST/);
  // Rejects alias drift
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, { ...ev2, currentAlias: 'dpl_other' }], ctx), /PRODUCTION_ALIAS_NOT_ON_BASELINE/);
  // Rejects baseline or runtime drift
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, ev2], { ...ctx, baselineDeployment: 'dpl_other' }), /RECONCILIATION_SET_NOT_AUTHORIZED/);
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, ev2], { ...ctx, runtimeSha: '0'.repeat(40) }), /RECONCILIATION_SET_NOT_AUTHORIZED/);
  // Rejects wrong run IDs
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44999999999', [ev1, ev2], ctx), /RECONCILIATION_SET_NOT_AUTHORIZED/);
  // Rejects extra/concurrent run
  assert.throws(() => assertAttemptAllowed([...runs3, { id: 44230000001, status: 'in_progress', conclusion: null }], '44230000001', '44228373358,44229712230', [ev1, ev2], ctx), /ONE_ATTEMPT_PER_BASELINE_EXCEEDED/);
  // Rejects missing operationId
  assert.throws(() => assertAttemptAllowed(runs3, '44230000000', '44228373358,44229712230', [ev1, ev2], { ...ctx, operationId: '' }), /PILOT_OPERATION_ID_REQUIRED/);
  // Generic unknown code stays safe
  assert.equal(classifyDiagnosticCode(new Error('raw secret token')), 'UNCLASSIFIED_ERROR');
});

test('listAllPilotWorkflowRuns paginates completely and rejects truncated responses', () => {
  const pages = [
    { total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] },
    { total_count: 3, workflow_runs: [{ id: 3 }] },
  ];
  let idx = 0;
  const full = listAllPilotWorkflowRuns('2026-11-17T21:35:55Z', { ghApi: () => pages[idx++] });
  assert.equal(full.totalCount, 3);
  assert.equal(full.workflowRuns.length, 3);

  assert.throws(
    () => listAllPilotWorkflowRuns('2026-11-17T21:35:55Z', {
      ghApi: () => ({ total_count: 5, workflow_runs: [] }),
    }),
    /WORKFLOW_RUNS_LIST_INCOMPLETE/
  );
});
