'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  closed,
  adapters,
  assertAttemptAllowed,
  formatSanitizedFailure,
  classifyDiagnosticCode,
  ALLOWED_DIAGNOSTIC_CODES,
  restore,
  arm,
  gatherReconciliationEvidence,
} = require('../scripts/pilot/ayrton-runtime.cjs');
const P = require('../scripts/pilot/window-protocol.cjs');

const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const COACH = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const PLAN = 'D5fVjlS3NysTD6Yg2ZpW';
const PID = 'ab150537-0d02-423b-a7e0-2b2f1a8a9a83';
const RUNTIME_SHA = '3fc264e23d67a8ecb1611a6c8af04ad739f422da';
const DEPLOYMENT = 'dpl_8A6T9EkMNThqwjYeLZGt2xcetoK8';
const EXPIRES_AT = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const OPERATION_ID = 'op-ayrton-shadow-t776-test0001';

const sampleWindow = () => ({
  schema: 'vdsen-ayrton-window-v1',
  mode: 'STAGE1_SHADOW',
  pid: PID,
  uid: UID,
  coachId: COACH,
  planId: PLAN,
  runtimeSha: RUNTIME_SHA,
  deployment: DEPLOYMENT,
  expiresAt: EXPIRES_AT,
  operationId: OPERATION_ID,
});

const sampleState = () => ({
  runtime_sha: RUNTIME_SHA,
  production_deployment: DEPLOYMENT,
  production_project: P.PROJECT,
  vercel_team: P.TEAM,
  numeric_apply_enabled: false,
  app_release: {
    deployment: DEPLOYMENT,
    source_release_run: '43132135716',
    completed_at: '2026-11-12T01:16:37Z',
  },
});

const validEvidence = () => ({
  baselineDeployment: DEPLOYMENT,
  currentAlias: DEPLOYMENT,
  stagedDeploymentsCount: 0,
  priorRunMutations: 0,
  evidenceVerified: true,
});

// SCENARIO 1: Reintento tras fallo verificado con reconciliación auditable
test('SCENARIO 1: Reintento tras fallo verificado con reconciliación auditable (reconcile_failed_run)', () => {
  const currentRunId = '43160000000';
  const failedRunId = '43156465756';
  const runs = [
    { id: 43156465756, status: 'completed', conclusion: 'failure', head_sha: '7bb7b701b391ab741c67b6f180a0271edde87827' },
    { id: 43160000000, status: 'in_progress', conclusion: null, head_sha: '87a3fa759a44e2172f0b1c26465de78408b4cb72' },
  ];

  const res = assertAttemptAllowed(runs, currentRunId, failedRunId, validEvidence());
  assert.equal(res.mode, 'AUDITED_FAILED_RUN_RECOVERY');
  assert.equal(res.currentRunId, currentRunId);
  assert.equal(res.reconciledRunId, failedRunId);
  assert.equal(res.evidence.evidenceVerified, true);
});

// SCENARIO 2: Reintento bloqueado si ya existe un deployment staged
test('SCENARIO 2: Reintento bloqueado si ya existe un deployment staged', async () => {
  const s = sampleState();
  const origFetch = globalThis.fetch;
  try {
    // Subcase 2A: matching production baseline
    globalThis.fetch = async () => ({
      status: 200,
      json: async () => ({
        deployments: [{ id: 'dpl_staged_earlier', meta: { vdsenPilotBaseline: DEPLOYMENT } }],
        pagination: { next: null },
      }),
    });
    const ioA = adapters(s);
    await assert.rejects(
      async () => ioA.assertNoPriorOperation('op-fresh-unique'),
      /PILOT_BASELINE_ALREADY_STAGED/
    );

    // Subcase 2B: matching operation ID
    globalThis.fetch = async () => ({
      status: 200,
      json: async () => ({
        deployments: [{ id: 'dpl_other', meta: { vdsenPilotOperation: 'op-already-used-1234' } }],
        pagination: { next: null },
      }),
    });
    const ioB = adapters(s);
    await assert.rejects(
      async () => ioB.assertNoPriorOperation('op-already-used-1234'),
      /PILOT_OPERATION_ALREADY_EXISTS/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

// SCENARIO 3: Reintento bloqueado con resultado incierto y sin evidencia suficiente
test('SCENARIO 3: Reintento bloqueado con resultado incierto o sin evidencia suficiente para reconciliación', () => {
  const currentRunId = '43160000000';
  const targetFailedRunId = '43156465756';

  // 3A: Prior run is still in_progress
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'in_progress', conclusion: null },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, validEvidence()), /PRIOR_RUN_NOT_COMPLETED/);

  // 3B: Prior run concluded with success
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'success' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, validEvidence()), /PRIOR_RUN_DID_NOT_FAIL/);

  // 3C: Prior run concluded with cancelled
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'cancelled' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, validEvidence()), /PRIOR_RUN_DID_NOT_FAIL/);

  // 3D: Exactly 1 recovery attempt allowed (3 runs exist = already attempted once)
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43159000000, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, validEvidence()), /RECOVERY_ALLOWED_ONLY_FOR_EXACTLY_ONE_PRIOR_ATTEMPT/);

  // 3E: Cannot reconcile self
  assert.throws(() => assertAttemptAllowed([
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, currentRunId, validEvidence()), /CANNOT_RECONCILE_SELF/);

  // 3F: Reconciled run ID not found in list
  assert.throws(() => assertAttemptAllowed([
    { id: 43158888888, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, '43159999999', validEvidence()), /RECONCILED_RUN_NOT_FOUND_FOR_CURRENT_BASELINE/);

  // 3G: Intento fallido sin evidencia suficiente (evidencia null/missing)
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, null), /PRIOR_RUN_EVIDENCE_MISSING/);

  // 3H: Intento fallido con mutaciones > 0 no probadas cero
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, { ...validEvidence(), priorRunMutations: 1 }), /PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO/);

  // 3I: Intento fallido donde el alias se movió del baseline
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, { ...validEvidence(), currentAlias: 'dpl_other_foreign' }), /PRODUCTION_ALIAS_NOT_ON_BASELINE/);

  // 3J: Intento fallido con despliegues staged pendientes
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, { ...validEvidence(), stagedDeploymentsCount: 1 }), /PENDING_OR_STAGED_DEPLOYMENTS_EXIST/);

  // 3K: Intento fallido con evidencia no verificada
  assert.throws(() => assertAttemptAllowed([
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43160000000, status: 'in_progress' },
  ], currentRunId, targetFailedRunId, { ...validEvidence(), evidenceVerified: false }), /PRIOR_RUN_EVIDENCE_UNVERIFIED/);
});

// SCENARIO 4: Cambio de commit sin reconciliación explícita rechazado fail-closed
test('SCENARIO 4: Cambio de commit sin reconciliación explícita rechazado fail-closed', () => {
  const currentRunId = '43160000000';
  const runsWithDifferentCommits = [
    { id: 43156465756, head_sha: '7bb7b701b391ab741c67b6f180a0271edde87827' },
    { id: 43160000000, head_sha: '87a3fa759a44e2172f0b1c26465de78408b4cb72' },
  ];

  // No reconciliation param provided: changing commits CANNOT bypass the 1-attempt rule
  assert.throws(
    () => assertAttemptAllowed(runsWithDifferentCommits, currentRunId, ''),
    /ONE_ATTEMPT_PER_BASELINE_EXCEEDED/
  );
});

// SCENARIO 5: Lectura Firestore: documento de release ausente (404) aceptado como barrera cerrada
test('SCENARIO 5: Lectura Firestore: documento de release ausente (404) aceptado como barrera cerrada', async () => {
  const s = sampleState();
  const w = sampleWindow();
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('clients/' + UID)) {
        return {
          status: 200,
          text: async () => JSON.stringify({
            fields: {
              coachId: { stringValue: COACH },
              activePlanId: { stringValue: PLAN },
            },
          }),
        };
      }
      if (u.includes('releaseControl/autonomousProgression')) {
        return { status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'Not Found' } }) };
      }
      if (u.includes('coaches/' + COACH)) {
        return {
          status: 200,
          text: async () => JSON.stringify({
            fields: {
              autoApplyCanary: {
                mapValue: {
                  fields: {
                    enabled: { booleanValue: false },
                    clientIds: { arrayValue: { values: [{ stringValue: UID }] } },
                  },
                },
              },
            },
          }),
        };
      }
      return { status: 404, text: async () => '{}' };
    };

    const io = adapters(s);
    const snap = await io.snapshot(w);
    assert.equal(snap.release, null);
    assert.equal(snap.coach.autoApplyCanary.enabled, false);
    assert.doesNotThrow(() => closed(w, snap));
  } finally {
    globalThis.fetch = origFetch;
  }
});

// SCENARIO 6: Lectura Firestore: documento de Coach ausente (404) rechazado fail-closed
test('SCENARIO 6: Lectura Firestore: documento de Coach ausente (404) rechazado fail-closed (nunca convertido en {})', async () => {
  const s = sampleState();
  const w = sampleWindow();
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('clients/' + UID)) {
        return {
          status: 200,
          text: async () => JSON.stringify({
            fields: {
              coachId: { stringValue: COACH },
              activePlanId: { stringValue: PLAN },
            },
          }),
        };
      }
      if (u.includes('releaseControl/autonomousProgression')) {
        return { status: 404, text: async () => '{}' };
      }
      if (u.includes('coaches/' + COACH)) {
        // Missing coach document in Firestore
        return { status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'Coach document not found' } }) };
      }
      return { status: 404, text: async () => '{}' };
    };

    const io = adapters(s);
    await assert.rejects(
      async () => io.snapshot(w),
      /FENCE_READ_FAILED: coaches\/.* status 404/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

// SCENARIO 7: Lectura Firestore: error 403 y malformado rechazado fail-closed
test('SCENARIO 7: Lectura Firestore: error 403 y malformado rechazado fail-closed', async () => {
  const s = sampleState();
  const w = sampleWindow();
  const origFetch = globalThis.fetch;
  try {
    // 7A: 403 on client doc
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('clients/' + UID)) return { status: 403, text: async () => 'Forbidden' };
      return { status: 200, text: async () => '{}' };
    };
    const ioA = adapters(s);
    await assert.rejects(async () => ioA.snapshot(w), /FENCE_READ_FAILED: clients\/.* status 403/);

    // 7B: 403 on release fence
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('clients/' + UID)) {
        return {
          status: 200,
          text: async () => JSON.stringify({ fields: { coachId: { stringValue: COACH }, activePlanId: { stringValue: PLAN } } }),
        };
      }
      if (u.includes('releaseControl/autonomousProgression')) return { status: 403, text: async () => 'Forbidden' };
      return { status: 200, text: async () => '{}' };
    };
    const ioB = adapters(s);
    await assert.rejects(async () => ioB.snapshot(w), /FENCE_READ_FAILED: releaseControl\/.* status 403/);

    // 7C: Malformed JSON body on coach doc
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('clients/' + UID)) {
        return {
          status: 200,
          text: async () => JSON.stringify({ fields: { coachId: { stringValue: COACH }, activePlanId: { stringValue: PLAN } } }),
        };
      }
      if (u.includes('releaseControl/autonomousProgression')) return { status: 404, text: async () => '{}' };
      if (u.includes('coaches/' + COACH)) return { status: 200, text: async () => 'NOT_VALID_JSON{<' };
      return { status: 200, text: async () => '{}' };
    };
    const ioC = adapters(s);
    await assert.rejects(async () => ioC.snapshot(w), /MALFORMED_FIRESTORE_RESPONSE/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// SCENARIO 8: Metadatos Vercel: paginación completa multipágina y rechazo si queda incompleta
test('SCENARIO 8: Metadatos Vercel: paginación completa multipágina y rechazo si queda incompleta', async () => {
  const s = sampleState();
  const origFetch = globalThis.fetch;
  try {
    // 8A: Clean 2-page pagination completes and checks all items
    let pageCount = 0;
    globalThis.fetch = async (url) => {
      pageCount++;
      const u = String(url);
      if (!u.includes('until=')) {
        return {
          status: 200,
          json: async () => ({
            deployments: [{ id: 'dpl_page1', meta: { vdsenPilotOperation: 'other_op1' } }],
            pagination: { next: 1700000000000 },
          }),
        };
      }
      return {
        status: 200,
        json: async () => ({
          deployments: [{ id: 'dpl_page2', meta: { vdsenPilotOperation: 'other_op2' } }],
          pagination: { next: null },
        }),
      };
    };
    const ioA = adapters(s);
    await assert.doesNotReject(async () => ioA.assertNoPriorOperation('op-fresh-unique'));
    assert.equal(pageCount, 2, 'Must have traversed both pages');

    // 8B: Incomplete pagination (infinite loop capped at 10 pages) -> fails closed
    globalThis.fetch = async () => ({
      status: 200,
      json: async () => ({
        deployments: [],
        pagination: { next: 1700000000001 },
      }),
    });
    const ioB = adapters(s);
    await assert.rejects(async () => ioB.assertNoPriorOperation('op-fresh-unique'), /DEPLOYMENT_LIST_INCOMPLETE/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// SCENARIO 9: Formato de logs y derivación estricta de estado de seguridad
test('SCENARIO 9: Formato de logs y derivación estricta de estado de seguridad', () => {
  // 9A: Fallo antes del staging (preflight con cero mutaciones)
  const preflightCheckpoint = {
    phase: 'ARM_PREFLIGHT',
    status: 'PREPARING',
    productionMutations: 0,
    staged: null,
    deployIntentReached: false,
    promotionAttempted: false,
  };
  const repPreflight = formatSanitizedFailure(new Error('FENCE_READ_FAILED: clients/123 status 403'), preflightCheckpoint);
  assert.equal(repPreflight.status, 'PILOT_RUNTIME_STOPPED');
  assert.equal(repPreflight.error_code, 'FENCE_READ_FAILED');
  assert.equal(repPreflight.phase, 'ARM_PREFLIGHT');
  assert.equal(repPreflight.state, 'SAFE_BASELINE_UNCHANGED_ZERO_MUTATIONS');
  assert.equal(repPreflight.action_required, 'REVIEW_REDACTED_CHECKPOINT_NO_AUTOMATIC_RETRY');
  assert.equal(repPreflight.stack, undefined);

  // 9B: Resultado incierto durante staging (deploy intent alcanzado)
  const stagingCheckpoint = {
    phase: 'STAGING',
    status: 'DEPLOY_INTENT_NO_RETRY',
    deployIntentReached: true,
    productionMutations: 0,
    staged: null,
    promotionAttempted: false,
  };
  const repStaging = formatSanitizedFailure(new Error('DEPLOY_UNCERTAIN_NO_RETRY: network timeout during vercel deploy'), stagingCheckpoint);
  assert.equal(repStaging.status, 'PILOT_RUNTIME_STOPPED');
  assert.equal(repStaging.error_code, 'DEPLOY_UNCERTAIN_NO_RETRY');
  assert.equal(repStaging.phase, 'STAGING');
  assert.equal(repStaging.state, 'PRODUCTION_STATE_UNVERIFIED');
  assert.equal(repStaging.action_required, 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY');

  // 9C: Fallo después de promoción (promotion attempted)
  const promoCheckpoint = {
    phase: 'PROMOTION',
    status: 'CONCURRENT_ALIAS_NO_AUTOMATIC_OVERWRITE',
    deployIntentReached: true,
    productionMutations: 2,
    staged: { id: 'dpl_stage123' },
    promotionAttempted: true,
  };
  const repPromo = formatSanitizedFailure(new Error('ALIAS_NOT_CONVERGED'), promoCheckpoint);
  assert.equal(repPromo.status, 'PILOT_RUNTIME_STOPPED');
  assert.equal(repPromo.error_code, 'ALIAS_NOT_CONVERGED');
  assert.equal(repPromo.state, 'PRODUCTION_STATE_UNVERIFIED');
  assert.equal(repPromo.action_required, 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY');

  // 9D: Rollback fallido
  const rollbackFailCheckpoint = {
    phase: 'ROLLBACK',
    status: 'ROLLBACK_FAILED_UNVERIFIED',
    deployIntentReached: true,
    productionMutations: 3,
    staged: { id: 'dpl_stage123' },
    promotionAttempted: true,
  };
  const repRbFail = formatSanitizedFailure(new Error('ROLLBACK_FAILED_UNVERIFIED'), rollbackFailCheckpoint);
  assert.equal(repRbFail.status, 'PILOT_RUNTIME_STOPPED');
  assert.equal(repRbFail.error_code, 'ROLLBACK_FAILED_UNVERIFIED');
  assert.equal(repRbFail.state, 'PRODUCTION_STATE_UNVERIFIED');
  assert.equal(repRbFail.action_required, 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY');

  // 9E: Error arbitrario con secreto fuera del patrón Bearer
  const arbitrarySecretError = new Error(
    'Postgres connection failed: postgresql://admin:super_secret_pg_pass_998877!@10.0.1.5:5432/vdsen_prod?sslmode=require\n' +
    'Internal trace: token=github_pat_11AAAAABBBBCCCCDDDD_EEEEFFFFGGGGHHHH\n' +
    '    at pgConnect (/node_modules/pg/client.js:10:5)'
  );
  const repArbitrary = formatSanitizedFailure(arbitrarySecretError, preflightCheckpoint);
  assert.equal(repArbitrary.error_code, 'UNCLASSIFIED_ERROR');
  assert.ok(!JSON.stringify(repArbitrary).includes('super_secret_pg_pass_998877'));
  assert.ok(!JSON.stringify(repArbitrary).includes('github_pat_11AAAAABBBBCCCCDDDD'));
  assert.ok(!JSON.stringify(repArbitrary).includes('pgConnect'));

  // 9F: Incertidumbre total sin checkpoint explícito -> PRODUCTION_STATE_UNVERIFIED
  const repNoCheckpoint = formatSanitizedFailure(new Error('SOME_UNKNOWN_FAILURE'));
  assert.equal(repNoCheckpoint.state, 'PRODUCTION_STATE_UNVERIFIED');
  assert.equal(repNoCheckpoint.action_required, 'STOP_REVIEW_REQUIRED_NO_AUTOMATIC_RETRY');
});

// SCENARIO 10: Preservación del STOP y rollback
test('SCENARIO 10: Preservación del STOP y rollback', async () => {
  const s = sampleState();
  const w = sampleWindow();

  // 10A: restore() safely reverts alias to baseline deployment
  let rollbackInvokedWith = null;
  let bytesVerifiedFor = null;
  let currentAliasRestore = 'dpl_staged_xyz';
  const mockIoRestore = {
    validateBaseline: async () => true,
    current: async () => currentAliasRestore,
    rollback: async (dep) => { rollbackInvokedWith = dep; currentAliasRestore = dep; },
    verifyBytes: async (sha) => { bytesVerifiedFor = sha; },
  };

  const report = {
    schema: 'vdsen-ayrton-runtime-release-v1',
    baseline: { runtimeSha: RUNTIME_SHA, deployment: DEPLOYMENT },
    staged: { id: 'dpl_staged_xyz' },
  };
  const resRestore = await restore(report, mockIoRestore);
  assert.equal(resRestore.status, 'ROLLBACK_VERIFIED');
  assert.equal(resRestore.wrote, 1);
  assert.equal(rollbackInvokedWith, DEPLOYMENT);
  assert.equal(bytesVerifiedFor, RUNTIME_SHA);

  // 10B: arm() rolls back to baseline if promotion fails
  let armRollbackInvoked = false;
  let savedStatus = null;
  let currentAlias = DEPLOYMENT;
  const mockIoArm = {
    save: async (r) => { savedStatus = r.status; },
    validateSource: async () => 'tree123',
    validateBaseline: async () => ({ ok: true }),
    current: async () => currentAlias,
    snapshot: async () => ({
      uid: UID,
      coachId: COACH,
      client: { coachId: COACH, activePlanId: PLAN },
      release: null,
      coach: { autoApplyCanary: { enabled: false, clientIds: [UID] } },
    }),
    offProof: async () => require('../scripts/release/numeric-guard.cjs').evaluateProductionEnv([], { project: P.PROJECT, team: P.TEAM }),
    assertNoPriorOperation: async () => {},
    stage: async () => {
      return {
        id: 'dpl_stageNew123',
        url: 'https://vdsen-stage.vercel.app',
        projectId: P.PROJECT,
        teamId: P.TEAM,
        sha: RUNTIME_SHA,
        target: 'production',
        state: 'READY',
        envNames: ['AUTONOMOUS_PROGRESSION_ENABLED'],
      };
    },
    promote: async () => {
      currentAlias = 'dpl_stageNew123';
      throw new Error('NETWORK_TIMEOUT_DURING_PROMOTION');
    },
    rollback: async (dep) => {
      armRollbackInvoked = true;
      currentAlias = dep;
    },
    verifyBytes: async () => ({ ok: true }),
  };

  await assert.rejects(
    async () => arm(w, { runtimeSha: RUNTIME_SHA, deployment: DEPLOYMENT }, mockIoArm),
    /ROLLED_BACK_VERIFIED/
  );
  assert.equal(armRollbackInvoked, true, 'Rollback must be invoked on promotion failure');
  assert.equal(currentAlias, DEPLOYMENT, 'Alias must converge back to baseline');
});

// SCENARIO 11: gatherReconciliationEvidence auditoría autoritativa de corrida previa fallida
test('SCENARIO 11: gatherReconciliationEvidence auditoría autoritativa de corrida previa fallida', async () => {
  const s = sampleState();
  const failedRunId = '43156465756';

  const mockRun = {
    id: 43156465756,
    path: '.github/workflows/vdsen-ayrton-runtime.yml',
    head_branch: 'codex/client-app-next',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    created_at: '2026-11-12T04:41:43Z',
    updated_at: '2026-11-12T04:51:03Z',
  };

  const mockJobs = {
    jobs: [
      {
        id: 130977457299,
        name: 'pilot-runtime',
        status: 'completed',
        conclusion: 'failure',
        steps: [
          {
            name: 'One pilot deployment with both fences closed, then promote the same ID',
            conclusion: 'failure',
            started_at: '2026-11-12T04:50:59.467Z',
            completed_at: '2026-11-12T04:51:00.216Z', // ~749ms
          },
        ],
      },
    ],
  };

  const mockArtifacts = {
    total_count: 0,
    artifacts: [],
  };

  const mockGhSuccess = (cmd, path) => {
    if (path.endsWith('/actions/runs/' + failedRunId)) return mockRun;
    if (path.endsWith('/actions/runs/' + failedRunId + '/jobs')) return mockJobs;
    if (path.endsWith('/actions/runs/' + failedRunId + '/artifacts')) return mockArtifacts;
    throw new Error('UNEXPECTED_GH_PATH: ' + path);
  };

  const mockFetchSuccess = async (url) => {
    return {
      status: 200,
      json: async () => ({
        deployments: [
          {
            uid: 'dpl_existing1',
            created: Date.parse('2026-11-12T01:00:00Z'),
            meta: {},
          },
        ],
        pagination: { count: 1, next: null, prev: null },
      }),
    };
  };

  const mockCurrentAppSuccess = async () => DEPLOYMENT;

  // 11A: Éxito en reconciliación con evidencia completa demostrada
  const evidence = await gatherReconciliationEvidence(s, failedRunId, {
    gh: mockGhSuccess,
    fetch: mockFetchSuccess,
    currentApp: mockCurrentAppSuccess,
    vercelToken: 'mock_token',
  });
  assert.equal(evidence.evidenceVerified, true);
  assert.equal(evidence.priorRunMutations, 0);
  assert.equal(evidence.phaseProven, 'ARM_PREFLIGHT_ZERO_MUTATIONS');
  assert.equal(evidence.currentAlias, DEPLOYMENT);
  assert.equal(evidence.stagedDeploymentsCount, 0);

  // 11B: Rechazo si el paso de arm duró más de 30s (indica que pudo entrar a staging)
  const mockGhSlowStep = (cmd, path) => {
    if (path.endsWith('/actions/runs/' + failedRunId + '/jobs')) {
      return {
        jobs: [
          {
            name: 'pilot-runtime',
            status: 'completed',
            conclusion: 'failure',
            steps: [
              {
                name: 'One pilot deployment with both fences closed, then promote the same ID',
                conclusion: 'failure',
                started_at: '2026-11-12T04:50:00Z',
                completed_at: '2026-11-12T04:50:45Z', // 45s
              },
            ],
          },
        ],
      };
    }
    return mockGhSuccess(cmd, path);
  };
  await assert.rejects(
    async () => gatherReconciliationEvidence(s, failedRunId, {
      gh: mockGhSlowStep,
      fetch: mockFetchSuccess,
      currentApp: mockCurrentAppSuccess,
      vercelToken: 'mock_token',
    }),
    /BLOCKED_EVIDENCE/
  );

  // 11C: Rechazo si existe artefacto de la corrida previa (mutaciones no probadas cero)
  const mockGhWithArtifact = (cmd, path) => {
    if (path.endsWith('/actions/runs/' + failedRunId + '/artifacts')) {
      return {
        total_count: 1,
        artifacts: [{ name: 'ayrton-runtime-' + failedRunId }],
      };
    }
    return mockGhSuccess(cmd, path);
  };
  await assert.rejects(
    async () => gatherReconciliationEvidence(s, failedRunId, {
      gh: mockGhWithArtifact,
      fetch: mockFetchSuccess,
      currentApp: mockCurrentAppSuccess,
      vercelToken: 'mock_token',
    }),
    /PRIOR_RUN_MUTATIONS_NOT_PROVEN_ZERO/
  );

  // 11D: Rechazo si la paginación de Vercel queda incompleta
  const mockFetchInfinitePagination = async (url) => {
    return {
      status: 200,
      json: async () => ({
        deployments: [],
        pagination: { count: 100, next: 1700000000000, prev: null },
      }),
    };
  };
  await assert.rejects(
    async () => gatherReconciliationEvidence(s, failedRunId, {
      gh: mockGhSuccess,
      fetch: mockFetchInfinitePagination,
      currentApp: mockCurrentAppSuccess,
      vercelToken: 'mock_token',
    }),
    /DEPLOYMENT_LIST_INCOMPLETE/
  );

  // 11E: Rechazo si se creó un deployment de producción durante la ventana de la corrida previa
  const mockFetchDeployDuringRun = async (url) => {
    return {
      status: 200,
      json: async () => ({
        deployments: [
          {
            uid: 'dpl_suspicious',
            target: 'production',
            created: Date.parse('2026-11-12T04:45:00Z'),
            meta: {},
          },
        ],
        pagination: { count: 1, next: null, prev: null },
      }),
    };
  };
  await assert.rejects(
    async () => gatherReconciliationEvidence(s, failedRunId, {
      gh: mockGhSuccess,
      fetch: mockFetchDeployDuringRun,
      currentApp: mockCurrentAppSuccess,
      vercelToken: 'mock_token',
    }),
    /DEPLOYMENTS_CREATED_DURING_PRIOR_RUN/
  );

  // 11F: Rechazo si el alias productivo actual no coincide con el baseline
  await assert.rejects(
    async () => gatherReconciliationEvidence(s, failedRunId, {
      gh: mockGhSuccess,
      fetch: mockFetchSuccess,
      currentApp: async () => 'dpl_other_foreign',
      vercelToken: 'mock_token',
    }),
    /PRODUCTION_ALIAS_NOT_ON_BASELINE/
  );
});

// SCENARIO 12: T777 reconciliación extraordinaria acotada (43156465756 + 43310023302), /v7/deployments y no repetición
test('SCENARIO 12: T777 reconciliación extraordinaria acotada, /v7/deployments y no repetición', async () => {
  const s = sampleState();
  const T777_OP = 'op-ayrton-shadow-20261112-c4f8a2e9';
  const ctx = {
    baselineDeployment: DEPLOYMENT,
    runtimeSha: RUNTIME_SHA,
    operationId: T777_OP,
  };

  // 12A: gatherReconciliationEvidence verifica /v7/deployments (nunca /v6) e ignora previews ajenos en la ventana
  let seenUrls = [];
  const mockGh43310023302 = (cmd, path) => {
    if (path.endsWith('/actions/runs/43310023302')) {
      return {
        id: 43310023302,
        path: '.github/workflows/vdsen-ayrton-runtime.yml',
        head_branch: 'codex/client-app-next',
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'failure',
        created_at: '2026-11-12T21:25:00Z',
        updated_at: '2026-11-12T21:25:12Z',
      };
    }
    if (path.endsWith('/actions/runs/43310023302/jobs')) {
      return {
        jobs: [{
          name: 'pilot-runtime',
          status: 'completed',
          conclusion: 'failure',
          steps: [
            { name: 'One arm attempt per verified OFF baseline; uncertainty requires review', conclusion: 'failure' },
            { name: 'One pilot deployment with both fences closed, then promote the same ID', conclusion: 'skipped' },
          ],
        }],
      };
    }
    if (path.endsWith('/actions/runs/43310023302/artifacts')) {
      return { total_count: 0, artifacts: [] };
    }
    throw new Error('UNEXPECTED_GH_PATH: ' + path);
  };

  const mockFetchV7WithPreview = async (url, opts) => {
    seenUrls.push(String(url));
    assert.ok(String(url).includes('/v7/deployments'), 'Debe consultar /v7/deployments');
    assert.equal(opts.redirect, 'error', 'Debe rechazar redirecciones');
    return {
      status: 200,
      json: async () => ({
        deployments: [
          {
            uid: 'dpl_unrelated_preview',
            target: 'preview',
            created: Date.parse('2026-11-12T21:25:05Z'),
            meta: {},
          },
          {
            uid: 'dpl_older_than_baseline',
            target: 'production',
            created: Date.parse('2026-11-12T00:00:00Z'),
            meta: {},
          },
        ],
        pagination: { count: 2, next: 1700000000000 }, // Early stop because oldestInPage < minTimestampMs!
      }),
    };
  };

  const ev2 = await gatherReconciliationEvidence(s, '43310023302', {
    gh: mockGh43310023302,
    fetch: mockFetchV7WithPreview,
    currentApp: async () => DEPLOYMENT,
    vercelToken: 'mock_token',
  });
  assert.equal(ev2.runId, '43310023302');
  assert.equal(ev2.phaseProven, 'ATTEMPT_GATE_PREFLIGHT_ZERO_MUTATIONS');
  assert.equal(ev2.priorRunMutations, 0);
  assert.equal(ev2.evidenceVerified, true);
  assert.equal(seenUrls.length, 1, 'Paginación acotada debe detenerse al cubrir minTimestampMs');

  // 12B: Rechazo si un deployment de producción fue creado en la ventana del run fallido
  await assert.rejects(
    async () => gatherReconciliationEvidence(s, '43310023302', {
      gh: mockGh43310023302,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          deployments: [
            { uid: 'dpl_prod_window', target: 'production', created: Date.parse('2026-11-12T21:25:05Z'), meta: {} },
          ],
          pagination: { next: null },
        }),
      }),
      currentApp: async () => DEPLOYMENT,
      vercelToken: 'mock_token',
    }),
    /DEPLOYMENTS_CREATED_DURING_PRIOR_RUN/
  );

  // 12C: assertAttemptAllowed acepta reconciliación extraordinaria T779 para exactamente los 3 runs + nueva corrida
  const ev1 = {
    runId: '43156465756',
    baselineDeployment: DEPLOYMENT,
    currentAlias: DEPLOYMENT,
    stagedDeploymentsCount: 0,
    priorRunMutations: 0,
    evidenceVerified: true,
  };
  const ev3 = {
    runId: '43324111384',
    baselineDeployment: DEPLOYMENT,
    currentAlias: DEPLOYMENT,
    stagedDeploymentsCount: 0,
    priorRunMutations: 0,
    evidenceVerified: true,
  };
  const runs4 = [
    { id: 43156465756, status: 'completed', conclusion: 'failure' },
    { id: 43310023302, status: 'completed', conclusion: 'failure' },
    { id: 43324111384, status: 'completed', conclusion: 'failure' },
    { id: 43330000000, status: 'in_progress' },
  ];
  const resT779 = assertAttemptAllowed(runs4, '43330000000', '43156465756,43310023302,43324111384', [ev1, ev2, ev3], ctx);
  assert.equal(resT779.mode, 'T779_EXTRAORDINARY_THREE_RUN_RECOVERY');
  assert.equal(resT779.operationId, T777_OP);

  // 12D: Bloqueo de repetición (5ta corrida), manipulación de operationId, baseline o run IDs
  assert.throws(
    () => assertAttemptAllowed([...runs4, { id: 43330000001, status: 'in_progress' }], '43330000001', '43156465756,43310023302,43324111384', [ev1, ev2, ev3], ctx),
    /ONE_ATTEMPT_PER_BASELINE_EXCEEDED/
  );
  assert.throws(
    () => assertAttemptAllowed(runs4, '43330000000', '43156465756,43310023302,43324111384', [ev1, ev2, ev3], { ...ctx, operationId: 'op-other-hijack' }),
    /EXTRAORDINARY_RECOVERY_NOT_AUTHORIZED/
  );
  assert.throws(
    () => assertAttemptAllowed(runs4, '43330000000', '43156465756,43310023302,43399999999', [ev1, ev2, ev3], ctx),
    /EXTRAORDINARY_RECOVERY_NOT_AUTHORIZED/
  );
  assert.throws(
    () => assertAttemptAllowed(runs4, '43330000000', '43156465756,43310023302,43324111384', [ev1, ev2, { ...ev3, evidenceVerified: false }], ctx),
    /PRIOR_RUN_EVIDENCE_UNVERIFIED/
  );
});
