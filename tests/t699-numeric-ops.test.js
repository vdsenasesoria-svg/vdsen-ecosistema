'use strict';
// Unit and operational tests for VDSEN T699 independent numeric operations.
// All tests use strict mocks and isolated environments; no live secrets, network or prod mutations.
// Verifies all operational failure modes, missing evidence paths, STOP semantics, and attestation gates.

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

function createValidFences(overrides = {}) {
  return {
    releaseControl: {
      enabled: false,
      clientIds: [C.UID],
      expiresAt: '2026-11-06T22:00:00Z'
    },
    numericPilot: {
      enabled: false,
      uid: C.UID,
      planId: C.PLAN,
      pid: C.PID,
      runtimeSha: VALID_SHA,
      operationId: VALID_OP_ID,
      expiresAt: '2026-11-06T22:00:00Z'
    },
    coach: {
      autoApplyCanary: {
        enabled: false,
        clientIds: [C.UID],
        prescriptionExerciseIds: [C.PID]
      }
    },
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
  const base = {
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
    ]
  };
  return Object.assign({}, base, overrides);
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

// 4. Deployment sin target
test('T699-OPS.4 Deployment sin target: attestRuntime rechaza target ausente sin asumir producción', async () => {
  const d = createValidDeployment();
  delete d.target;
  const fetcher = createMockFetcher(d);
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'TARGET_MISSING');
});

// 5. Deployment con target no-production
test('T699-OPS.5 Target modificado: attestRuntime rechaza target preview', async () => {
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

// 6. Deployment sin ID verificable
test('T699-OPS.6 Deployment sin ID verificable: attestRuntime rechaza respuesta del proveedor sin id', async () => {
  const d = createValidDeployment();
  delete d.id;
  const fetcher = createMockFetcher(d);
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'DEPLOYMENT_ID_MISSING');
});

// 7. Deployment sin teamId
test('T699-OPS.7 Deployment sin teamId: attestRuntime rechaza respuesta sin teamId', async () => {
  const d = createValidDeployment();
  delete d.teamId;
  const fetcher = createMockFetcher(d);
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'TEAM_ID_MISSING');
});

// 8. Deployment sin metadata de operación
test('T699-OPS.8 Deployment sin metadata de operación: rechaza ausencia de vdsenPilotOperation', async () => {
  const d = createValidDeployment({
    meta: { githubCommitSha: VALID_SHA } // omits vdsenPilotOperation
  });
  const fetcher = createMockFetcher(d);
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'REJECTED');
  assert.equal(res.reason, 'OPERATION_METADATA_MISSING');
});

// 9. Respuesta del proveedor sin información de variables
test('T699-OPS.9 Respuesta sin información de variables: reporta BLOCKED ante falta de envNames/env', async () => {
  const d = createValidDeployment();
  delete d.envNames;
  delete d.env;
  const fetcher = createMockFetcher(d);
  const res = await attestRuntime({
    deploymentId: VALID_DEPLOYMENT,
    expectedSha: VALID_SHA,
    expectedOperationId: VALID_OP_ID,
    vercelToken: 'mock-token',
    fetcher
  });

  assert.equal(res.attested, false);
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.reason, 'ENV_EVIDENCE_MISSING');
});

// 10. Ventana vencida o mayor a 24 horas
test('T699-OPS.10 Ventana vencida o excesiva: validateNumericWindow rechaza expiración <= now o duración > 24h', () => {
  const expired = createValidWindow({
    startsAt: '2026-11-05T10:00:00Z',
    expiresAt: '2026-11-05T20:00:00Z'
  });
  const resExpired = validateNumericWindow(expired, NOW);
  assert.equal(resExpired.valid, false);
  assert.ok(resExpired.errors.some(e => e.includes('Window has expired')));

  const excessive = createValidWindow({
    startsAt: '2026-11-06T10:00:00Z',
    expiresAt: '2026-11-07T11:00:00Z'
  });
  const resExcessive = validateNumericWindow(excessive, NOW);
  assert.equal(resExcessive.valid, false);
  assert.ok(resExcessive.errors.some(e => e.includes('exceeds the 24-hour limit')));
});

// 11. UID ajeno
test('T699-OPS.11 UID ajeno: rechaza cualquier UID diferente a Ayrton', async () => {
  const foreignUidWindow = createValidWindow({ uid: 'foreign-athlete-uid-12345' });
  const val = validateNumericWindow(foreignUidWindow, NOW);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some(e => e.includes('Invalid UID')));

  const pre = await runPreflight({
    window: foreignUidWindow,
    deploymentId: VALID_DEPLOYMENT,
    fences: createValidFences(),
    activeRuns: [],
    priorOperations: [],
    now: NOW
  });
  assert.equal(pre.decision, 'NO-GO');
  assert.ok(pre.blockers.some(b => b.includes('Invalid UID')));
});

// 12. PID ajeno
test('T699-OPS.12 PID ajeno: rechaza cualquier PID diferente a Press Convergente Inclinado', async () => {
  const foreignPidWindow = createValidWindow({ pid: 'foreign-exercise-pid-99999' });
  const val = validateNumericWindow(foreignPidWindow, NOW);
  assert.equal(val.valid, false);
  assert.ok(val.errors.some(e => e.includes('Invalid PID')));

  const pre = await runPreflight({
    window: foreignPidWindow,
    deploymentId: VALID_DEPLOYMENT,
    fences: createValidFences(),
    activeRuns: [],
    priorOperations: [],
    now: NOW
  });
  assert.equal(pre.decision, 'NO-GO');
  assert.ok(pre.blockers.some(b => b.includes('Invalid PID')));
});

// 13. Allowlist múltiple
test('T699-OPS.13 Allowlist múltiple: validateFences rechaza arrays con múltiples UIDs o PIDs', () => {
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

// 14. Ausencia de barreras de Firestore
test('T699-OPS.14 Ausencia de barreras de Firestore: runPreflight devuelve BLOCKED', async () => {
  const window = createValidWindow();
  const pre = await runPreflight({
    window,
    deploymentId: VALID_DEPLOYMENT,
    fences: null, // missing fences
    activeRuns: [],
    priorOperations: [],
    now: NOW
  });

  assert.equal(pre.decision, 'BLOCKED');
  assert.equal(pre.reason, 'FENCES_UNAVAILABLE');
});

// 15. Ausencia de historial de operaciones
test('T699-OPS.15 Ausencia de historial de operaciones: runPreflight devuelve BLOCKED', async () => {
  const window = createValidWindow();
  const pre = await runPreflight({
    window,
    deploymentId: VALID_DEPLOYMENT,
    fences: createValidFences(),
    activeRuns: [],
    priorOperations: null, // missing prior operations
    now: NOW
  });

  assert.equal(pre.decision, 'BLOCKED');
  assert.equal(pre.reason, 'PRIOR_OPERATIONS_EVIDENCE_MISSING');
});

// 16. Ausencia de información de concurrencia
test('T699-OPS.16 Ausencia de información de concurrencia: runPreflight devuelve BLOCKED', async () => {
  const window = createValidWindow();
  const pre = await runPreflight({
    window,
    deploymentId: VALID_DEPLOYMENT,
    fences: createValidFences(),
    activeRuns: null, // missing active runs
    priorOperations: [],
    now: NOW
  });

  assert.equal(pre.decision, 'BLOCKED');
  assert.equal(pre.reason, 'CONCURRENCY_EVIDENCE_MISSING');
});

// 17. Operación ya ejecutada
test('T699-OPS.17 Operación ya ejecutada: runPreflight devuelve NO-GO', async () => {
  const window = createValidWindow({ operationId: 'already-run-op-999' });
  const pre = await runPreflight({
    window,
    deploymentId: VALID_DEPLOYMENT,
    fences: createValidFences(),
    activeRuns: [],
    priorOperations: ['already-run-op-999', 'other-op'],
    now: NOW,
    io: { fetcher: createMockFetcher(createValidDeployment({ meta: { githubCommitSha: VALID_SHA, vdsenPilotOperation: 'already-run-op-999' } })) },
    vercelToken: 'mock-token'
  });

  assert.equal(pre.decision, 'NO-GO');
  assert.ok(pre.blockers.some(b => b.includes('already been executed')));
});

// 18. STOP con interruptor numérico OFF
test('T699-OPS.18 STOP con interruptor numérico OFF: invocation permite stop aun con kill switch inactivo', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'vdsenasesoria-svg/vdsen-ecosistema',
    GITHUB_REF: 'refs/heads/codex/client-app-next',
    GITHUB_RUN_ATTEMPT: '1',
    VDSEN_NUMERIC_PILOT_RELEASE_ENABLED: 'false'
  };

  // Acción stop permitida
  const resStop = invocation(env, 'stop');
  assert.equal(resStop.authorized, true);
  assert.equal(resStop.action, 'stop');

  // Acción arm-fences bloqueada
  assert.throws(() => {
    invocation(env, 'arm-fences');
  }, /NUMERIC_PILOT_DISARMED/);
});

// 19. STOP con fallo en la segunda escritura (partial failure)
test('T699-OPS.19 STOP con fallo en escritura: maneja error parcial y reporta STOP_INCOMPLETE', async () => {
  const store = new Map();
  // Pre-seed fences as enabled before STOP
  store.set('releaseControl/numericPilot', { enabled: true });
  store.set('releaseControl/autonomousProgression', { enabled: true });
  store.set('coaches/coach-123', { autoApplyCanary: { enabled: true } });

  const io = {
    writeFence: async (path, fields) => {
      if (path === 'releaseControl/autonomousProgression') {
        throw new Error('ETIMEDOUT: Firestore write timeout on secondary fence');
      }
      store.set(path, { ...(store.get(path) || {}), ...fields });
      return true;
    },
    readFence: async (path) => store.get(path)
  };

  const report = await executeStop({
    reason: 'SAFETY_HOLD_PARTIAL_TEST',
    coachId: 'coach-123',
    operationId: VALID_OP_ID,
    now: NOW
  }, io);

  assert.equal(report.schema, 'vdsen-numeric-stop-v1');
  assert.equal(report.status, 'STOP_INCOMPLETE');
  assert.equal(report.allDisarmed, false);
  assert.equal(report.primaryFenceDisarmed, true); // Primary numeric gate was successfully closed
  assert.ok(report.errors.some(e => e.includes('timeout on secondary fence')));
  assert.equal(report.sportsDataPreserved, true);
});

// 20. STOP exitoso completo: desarma las 3 barreras preservando campos del coach
test('T699-OPS.20 STOP completo: desarma las 3 barreras y preserva otros campos del Coach', async () => {
  const store = new Map();
  // Pre-cargar coach con datos no relacionados al piloto
  store.set('coaches/coach-123', {
    name: 'Coach Principal',
    activeClients: 10,
    equipmentIncrements: { barbell: 2.5 },
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });

  const io = {
    writeFence: async (path, fields, opts) => {
      const existing = store.get(path) || {};
      store.set(path, { ...existing, ...fields });
      return true;
    },
    readFence: async (path) => store.get(path)
  };

  const report = await executeStop({
    reason: 'NORMAL_SCHEDULED_STOP',
    coachId: 'coach-123',
    operationId: VALID_OP_ID,
    now: NOW
  }, io);

  assert.equal(report.status, 'STOP_CONFIRMED');
  assert.equal(report.allDisarmed, true);
  assert.equal(report.readback.numericPilotDisarmed, true);
  assert.equal(report.readback.releaseControlDisarmed, true);
  assert.equal(report.readback.coachCanaryDisarmed, true);

  // Verificar que campos del coach no fueron borrados
  const updatedCoach = store.get('coaches/coach-123');
  assert.equal(updatedCoach.name, 'Coach Principal');
  assert.equal(updatedCoach.activeClients, 10);
  assert.equal(updatedCoach.autoApplyCanary.enabled, false);
});

// 21. Reutilización de una ventana anterior
test('T699-OPS.21 Reutilización de ventana anterior: assertFreshAuthorizationRequired la rechaza', () => {
  const priorReport = {
    schema: 'vdsen-numeric-stop-v1',
    operationId: 'op-alpha-12345',
    stoppedAt: '2026-11-06T12:00:00Z'
  };

  // Reusar mismo operationId
  assert.throws(() => {
    assertFreshAuthorizationRequired(priorReport, { operationId: 'op-alpha-12345', startsAt: '2026-11-06T13:00:00Z' });
  }, /REUSE_OF_OPERATION_ID_FORBIDDEN/);

  // Ventana previa al stop
  assert.throws(() => {
    assertFreshAuthorizationRequired(priorReport, { operationId: 'op-fresh-777', startsAt: '2026-11-06T11:00:00Z' });
  }, /STALE_WINDOW_STARTS_BEFORE_PRIOR_STOP/);

  // Nueva ventana válida
  assert.equal(assertFreshAuthorizationRequired(priorReport, { operationId: 'op-fresh-777', startsAt: '2026-11-06T13:00:00Z' }), true);
});

// 22. Error de lectura del proveedor
test('T699-OPS.22 Error de lectura del proveedor: attestRuntime reporta BLOCKED ante fallos de API/red', async () => {
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

// 23. Evidencia incompleta
test('T699-OPS.23 Evidencia incompleta: ausencia de token de proveedor reporta BLOCKED', async () => {
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
