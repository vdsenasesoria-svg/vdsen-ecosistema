'use strict';
// Unit and operational tests for VDSEN T699 independent numeric operations.
// All tests use strict mocks and isolated environments; no live secrets, network or prod mutations.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../api/_numericPilotContract');
const { attestRuntime, DEFAULT_PROJECT_ID, DEFAULT_TEAM_ID } = require('../scripts/pilot/numeric-attestation.cjs');
const { runPreflight, validateNumericWindow, validateFences, MAX_WINDOW_HOURS } = require('../scripts/pilot/numeric-preflight.cjs');
const { executeStop, auditMesoConsistency, assertFreshAuthorizationRequired } = require('../scripts/pilot/numeric-stop-recovery.cjs');
const { invocation } = require('../scripts/pilot/numeric-pilot-ops.cjs');

const VALID_SHA = 'a'.repeat(40);
const VALID_OP_ID = 'test-numeric-op-001';
const VALID_DEPLOYMENT = 'dpl_testNumeric123456';
const NOW = Date.parse('2026-11-06T12:00:00Z');

function createValidWindow(overrides = {}) {
  return {
    schema: 'vdsen-numeric-pilot-v1',
    mode: 'NUMERIC_APPLY',
    uid: C.UID,
    planId: C.PLAN,
    pid: C.PID,
    runtimeSha: VALID_SHA,
    operationId: VALID_OP_ID,
    startsAt: '2026-11-06T10:00:00Z',
    expiresAt: '2026-11-06T22:00:00Z', // 12 hours <= 24h
    ...overrides
  };
}

function createMockFetcher(deploymentResponse, httpStatus = 200) {
  return async (url, init) => {
    return {
      status: httpStatus,
      json: async () => deploymentResponse
    };
  };
}

function createValidDeployment(overrides = {}) {
  return {
    id: VALID_DEPLOYMENT,
    projectId: DEFAULT_PROJECT_ID,
    teamId: DEFAULT_TEAM_ID,
    target: 'production',
    readyState: 'READY',
    meta: {
      githubCommitSha: VALID_SHA,
      vdsenPilotOperation: VALID_OP_ID
    },
    envNames: [
      'AUTONOMOUS_PROGRESSION_ENABLED',
      'AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED',
      'VDSEN_NUMERIC_PILOT_ENABLED'
    ],
    ...overrides
  };
}

// 1. Runtime válido
test('T699-OPS.1 Runtime válido: attestRuntime aprueba deployment con todas las propiedades correctas', async () => {
  const fetcher = createMockFetcher(createValidDeployment());
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    expectedUid: C.UID,
    expectedPlanId: C.PLAN,
    expectedPid: C.PID,
    vercelToken: 'mock-token',
    now: NOW,
    fetcher
  });

  assert.equal(res.attested, true);
  assert.equal(res.status, 'ATTESTED');
  assert.equal(res.runtimeSha, VALID_SHA);
  assert.equal(res.deploymentId, VALID_DEPLOYMENT);
  assert.equal(res.pilotUid, C.UID);
  assert.equal(res.pid, C.PID);
  assert.equal(res.cronConfigured, false);
});

// 2. Runtime incorrecto
test('T699-OPS.2 Runtime incorrecto: attestRuntime rechaza discrepancia en commit SHA', async () => {
  const fetcher = createMockFetcher(createValidDeployment({
    meta: { githubCommitSha: 'b'.repeat(40), vdsenPilotOperation: VALID_OP_ID }
  }));
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'RUNTIME_SHA_MISMATCH');
});

// 3. Deployment diferente
test('T699-OPS.3 Deployment diferente: attestRuntime rechaza ID de deployment no coincidente o 404', async () => {
  const fetcher = createMockFetcher({ error: { code: 'not_found' } }, 404);
  const res = await attestRuntime({
    deploymentId: 'dpl_nonExistentDeployment',
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'DEPLOYMENT_NOT_FOUND');
});

// 4. Target environment modificado (no producción)
test('T699-OPS.4 Target modificado: attestRuntime rechaza deployment cuyo target no sea production', async () => {
  const fetcher = createMockFetcher(createValidDeployment({ target: 'preview' }));
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'TARGET_NOT_PRODUCTION');
});

// 5. Ventana vencida o mayor a 24 horas
test('T699-OPS.5 Ventana vencida o excesiva: validateNumericWindow rechaza expiración <= now o duración > 24h', () => {
  // Expirada
  const expired = createValidWindow({
    startsAt: '2026-11-05T10:00:00Z',
    expiresAt: '2026-11-05T20:00:00Z'
  });
  const resExpired = validateNumericWindow(expired, NOW);
  assert.equal(resExpired.valid, false);
  assert.ok(resExpired.errors.some(e => e.includes('Window has expired')));

  // Duración > 24h (25h)
  const excessive = createValidWindow({
    startsAt: '2026-11-06T10:00:00Z',
    expiresAt: '2026-11-07T11:00:00Z'
  });
  const resExcessive = validateNumericWindow(excessive, NOW);
  assert.equal(resExcessive.valid, false);
  assert.ok(resExcessive.errors.some(e => e.includes('exceeds the 24-hour limit')));
});

// 6. UID ajeno
test('T699-OPS.6 UID ajeno: rechaza cualquier UID diferente a Ayrton en preflight y attestation', async () => {
  const foreignUidWindow = createValidWindow({ uid: 'foreign-athlete-uid-12345' });
  const val = validateNumericWindow(foreignUidWindow, NOW);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some(e => e.includes('Invalid UID')));

  const pre = await runPreflight({ window: foreignUidWindow, now: NOW });
  assert.equal(pre.decision, 'NO-GO');
  assert.ok(pre.blockers.some(b => b.includes('Invalid UID')));
});

// 7. PID ajeno
test('T699-OPS.7 PID ajeno: rechaza cualquier PID diferente a Press Convergente Inclinado', async () => {
  const foreignPidWindow = createValidWindow({ pid: 'foreign-exercise-pid-99999' });
  const val = validateNumericWindow(foreignPidWindow, NOW);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some(e => e.includes('Invalid PID')));

  const pre = await runPreflight({ window: foreignPidWindow, now: NOW });
  assert.equal(pre.decision, 'NO-GO');
  assert.ok(pre.blockers.some(b => b.includes('Invalid PID')));
});

// 8. Allowlist múltiple
test('T699-OPS.8 Allowlist múltiple: validateFences rechaza arrays con múltiples UIDs o PIDs', () => {
  const window = createValidWindow();
  const multiUidFences = {
    releaseControl: { clientIds: [C.UID, 'extra-athlete-uid'] },
    numericPilot: { uid: C.UID, planId: C.PLAN, pid: C.PID },
    coach: { autoApplyCanary: { clientIds: [C.UID, 'extra'], prescriptionExerciseIds: [C.PID] } }
  };
  const res = validateFences(multiUidFences, window);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes('strictly contain exactly Ayrton UID')));

  const multiPidFences = {
    releaseControl: { clientIds: [C.UID] },
    numericPilot: { uid: C.UID, planId: C.PLAN, pid: C.PID },
    coach: { autoApplyCanary: { clientIds: [C.UID], prescriptionExerciseIds: [C.PID, 'extra-pid'] } }
  };
  const resPid = validateFences(multiPidFences, window);
  assert.equal(resPid.valid, false);
  assert.ok(resPid.errors.some(e => e.includes('strictly contain exactly Ayrton PID')));
});

// 9. STOP activado
test('T699-OPS.9 STOP activado: executeStop desarma las 3 barreras de forma verificable', async () => {
  const store = new Map();
  const io = {
    writeFence: async (path, fields) => {
      store.set(path, { ...(store.get(path) || {}), ...fields });
      return true;
    },
    readFence: async (path) => store.get(path)
  };

  const report = await executeStop({
    reason: 'SAFETY_HOLD_TEST',
    coachId: 'coach-123',
    operationId: VALID_OP_ID,
    now: NOW
  }, io);

  assert.equal(report.schema, 'vdsen-numeric-stop-v1');
  assert.equal(report.allDisarmed, true);
  assert.equal(report.readback.numericPilotDisarmed, true);
  assert.equal(report.readback.releaseControlDisarmed, true);
  assert.equal(report.readback.coachCanaryDisarmed, true);
  assert.ok(report.digest);

  // Verificar estado en el almacén simulado
  assert.equal(store.get('releaseControl/numericPilot').enabled, false);
  assert.equal(store.get('releaseControl/autonomousProgression').enabled, false);
  assert.equal(store.get('coaches/coach-123').autoApplyCanary.enabled, false);
});

// 10. Ejecuciones concurrentes
test('T699-OPS.10 Ejecuciones concurrentes: runPreflight detecta y bloquea carreras de ejecución simultáneas', async () => {
  const window = createValidWindow();
  const pre = await runPreflight({
    window,
    now: NOW,
    activeRuns: [
      { id: '111111', status: 'completed' },
      { id: '222222', status: 'in_progress' }
    ]
  });

  assert.equal(pre.decision, 'NO-GO');
  assert.ok(pre.blockers.some(b => b.includes('Concurrent operational workflow run in progress')));
});

// 11. Error de lectura del proveedor
test('T699-OPS.11 Error de lectura del proveedor: attestRuntime reporta BLOCKED ante fallos de API/red', async () => {
  const fetcher = async () => {
    throw new Error('ETIMEDOUT: Connection to Vercel API timed out');
  };
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.reason, 'NETWORK_OR_PROVIDER_ERROR');
});

// 12. Evidencia incompleta
test('T699-OPS.12 Evidencia incompleta: ausencia de token de proveedor sin mock reporta BLOCKED', async () => {
  const savedToken = process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TOKEN;
  try {
    const res = await attestRuntime({
      deploymentId: VALID_DEPLOYMENT,
      expectedSha: VALID_SHA,
      expectedOperationId: VALID_OP_ID
    });
    assert.equal(res.attested, false);
    assert.equal(res.status, 'BLOCKED');
    assert.equal(res.reason, 'VERCEL_TOKEN_UNAVAILABLE');
  } finally {
    if (savedToken !== undefined) process.env.VERCEL_TOKEN = savedToken;
  }
});

// 13. Intento de recuperación sin autorización
test('T699-OPS.13 Intento de recuperación sin autorización: assertFreshAuthorizationRequired rechaza reuso de operationId', () => {
  const priorReport = {
    schema: 'vdsen-numeric-stop-v1',
    operationId: 'op-alpha-12345',
    stoppedAt: '2026-11-06T12:00:00Z'
  };

  // Reusar el mismo operationId
  assert.throws(() => {
    assertFreshAuthorizationRequired(priorReport, { operationId: 'op-alpha-12345', startsAt: '2026-11-06T13:00:00Z' });
  }, /REUSE_OF_OPERATION_ID_FORBIDDEN/);

  // Iniciar con fecha anterior al STOP
  assert.throws(() => {
    assertFreshAuthorizationRequired(priorReport, { operationId: 'op-bravo-67890', startsAt: '2026-11-06T11:00:00Z' });
  }, /STALE_WINDOW_STARTS_BEFORE_PRIOR_STOP/);

  // Autorización válida y fresca
  assert.equal(assertFreshAuthorizationRequired(priorReport, { operationId: 'op-charlie-99999', startsAt: '2026-11-06T13:00:00Z' }), true);
});

// 14. Detección de inconsistencias en auditoría de estado
test('T699-OPS.14 Auditoría de estado: auditMesoConsistency clasifica legítimos, en curso e inconsistencias', () => {
  const meso = {
    progressionApplications: {
      rec_1: { state: 'PENDING', prescriptionExerciseId: C.PID, calculatedAt: '2026-11-06T10:00:00Z' },
      rec_2: { state: 'APPLIED', prescriptionExerciseId: C.PID },
      rec_3: { state: 'APPLIED', prescriptionExerciseId: C.PID }, // Huérfano sin overlay
      rec_4: { state: 'PENDING', prescriptionExerciseId: 'foreign-pid-999' } // PID fuera de alcance
    },
    nextExposureOverlays: {
      ov_2: { sourceRecordKey: 'rec_2', status: 'APPLIED', key: 'ov_2', dimension: 'LOAD' },
      ov_orphan: { sourceRecordKey: 'non_existent_rec', status: 'APPLIED' }
    },
    consumptionReceipts: {}
  };

  const audit = auditMesoConsistency(meso);
  assert.equal(audit.isConsistent, false);
  assert.equal(audit.classified.pendingHalted.length, 1);
  assert.equal(audit.classified.legitimateApplied.length, 1);
  assert.equal(audit.classified.inconsistentApplications.length, 1);
  assert.equal(audit.classified.orphanedOverlays.length, 1);
  assert.equal(audit.classified.outOfScopePids.length, 1);
});

// 15. Invocación de workflow protegida (Kill Switch)
test('T699-OPS.15 Invocación de workflow: invocation rechaza si kill switch es false o no es Actions', () => {
  assert.throws(() => {
    invocation({ GITHUB_ACTIONS: 'false' });
  }, /Must be executed within GitHub Actions environment/);

  assert.throws(() => {
    invocation({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
      GITHUB_REF: 'refs/heads/codex/client-app-next',
      VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false',
      GITHUB_RUN_ATTEMPT: '1'
    });
  }, /NUMERIC_PILOT_DISARMED/);
});
