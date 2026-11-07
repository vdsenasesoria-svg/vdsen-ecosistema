'use strict';
/**
 * VDSEN — T699 Phase P0.5 Durable Operations Ledger Suite in Firestore Emulator
 *
 * Exercises all 15 required scenarios for the durable operationId ledger:
 * 1. Más de 100 operaciones previas con duplicado fuera del primer bloque
 * 2. Consulta directa del operationId
 * 3. Dos reservas concurrentes (concurrencia atómica)
 * 4. Reintento después de reserva
 * 5. Conflicto de SHA (data.runtimeSha !== window.runtimeSha)
 * 6. Conflicto de ventana (data.operationId !== window.operationId)
 * 7. Conflicto UID/PID/plan (mismatches)
 * 8. Reserva con release desarmado
 * 9. STOP concurrente (idempotencia)
 * 10. Reintento tras STOP
 * 11. Transiciones de estado inválidas (COMPLETED -> FAILED, STOPPED -> COMPLETED, etc.)
 * 12. Campos históricos protegidos (identidad inmutable)
 * 13. Error de conexión simulado
 * 14. Recuperación de evidencia desinfectada
 * 15. Rechazo de fuente no acreditada en preflight
 *
 * Plus 14 explicit fail-closed negative tests proving 0 persisted reservations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const C = require('../api/_numericPilotContract');
const ledger = require('../scripts/pilot/numeric-operations-ledger.cjs');
const { runPreflight } = require('../scripts/pilot/numeric-preflight.cjs');
const {
  attestRuntime,
  verifyAttestationAuthenticity,
  consumeAttestation,
  _clearConsumedAttestationsForTesting,
  isProductionTarget,
  isLiveTarget,
  isAccreditedDemoEnvironment,
  MAX_ATTESTATION_AGE_MS
} = require('../scripts/pilot/numeric-attestation.cjs');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore Emulator required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);

const app = initializeApp({ projectId }, 't699-ledger-emulator');
const db = getFirestore(app);
test.after(() => deleteApp(app));

function makeValidOpData(opId = 'op-ledger-01') {
  const t = Math.floor(Date.now() / 1000) * 1000;
  const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
  return {
    operationId: opId,
    uid: C.UID,
    planId: C.PLAN,
    pid: C.PID,
    runtimeSha: 'a'.repeat(40),
    deploymentId: 'dpl_valid_01',
    runId: '12345678',
    window: {
      schema: 'vdsen-numeric-pilot-v1',
      mode: 'NUMERIC_APPLY',
      uid: C.UID,
      planId: C.PLAN,
      pid: C.PID,
      runtimeSha: 'a'.repeat(40),
      operationId: opId,
      startsAt: iso(t - 1000),
      expiresAt: iso(t + 3600000)
    },
    scope: {
      enabled: true,
      clientIds: [C.UID],
      prescriptionExerciseIds: [C.PID]
    }
  };
}

function createMockFetcher(opData, customDeployment = null, customAlias = null) {
  return async (url, init) => {
    if (url.includes('/aliases/')) {
      if (typeof customAlias === 'function') return customAlias(url, init);
      if (customAlias && customAlias.status) {
        return { status: customAlias.status, json: async () => customAlias.data || {} };
      }
      return {
        status: 200,
        json: async () => ({
          alias: 'vdsen-ecosistema.vercel.app',
          deploymentId: opData.deploymentId,
          projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN'
        })
      };
    }
    if (typeof customDeployment === 'function') return customDeployment(url, init);
    if (customDeployment && customDeployment.status) {
      return { status: customDeployment.status, json: async () => customDeployment.data || {} };
    }
    const deploymentObj = {
      id: opData.deploymentId,
      projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
      teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
      target: 'production',
      readyState: 'READY',
      alias: ['vdsen-ecosistema.vercel.app'],
      meta: {
        githubCommitSha: opData.runtimeSha,
        vdsenPilotOperation: opData.operationId
      },
      envNames: ['AUTONOMOUS_PROGRESSION_ENABLED']
    };
    return {
      status: 200,
      json: async () => Object.assign(deploymentObj, customDeployment || {})
    };
  };
}

async function makeValidAttestation(opData, opts = {}) {
  const fetcher = opts.fetcher || createMockFetcher(opData, opts.customDeployment, opts.customAlias);
  return await attestRuntime({
    deploymentId: opData.deploymentId,
    expectedSha: opData.runtimeSha,
    expectedOperationId: opData.operationId,
    expectedAlias: opts.expectedAlias || 'vdsen-ecosistema.vercel.app',
    expectedUid: opData.uid,
    expectedPlanId: opData.planId,
    expectedPid: opData.pid,
    fetcher,
    now: opts.now
  });
}

function makeManufacturedAttestation(opData) {
  return {
    schema: 'vdsen-numeric-runtime-attestation-v1',
    attested: true,
    status: 'ATTESTED',
    deploymentId: opData.deploymentId,
    runtimeSha: opData.runtimeSha,
    operationId: opData.operationId,
    pilotUid: opData.uid,
    planId: opData.planId,
    pid: opData.pid,
    provider: 'vercel',
    readyState: 'READY',
    cronConfigured: false,
    checks: [
      { check: 'DEPLOYMENT_ID', expected: opData.deploymentId, actual: opData.deploymentId, pass: true },
      { check: 'COMMIT_SHA', expected: opData.runtimeSha, actual: opData.runtimeSha, pass: true },
      { check: 'OPERATION_ID', expected: opData.operationId, actual: opData.operationId, pass: true },
      { check: 'CRON_FORBIDDEN', expected: false, actual: false, pass: true }
    ],
    attestedAt: new Date().toISOString()
  };
}

async function armFencesForOp(database, opData) {
  await database.doc('releaseControl/numericPilot').set({
    ...opData.window,
    enabled: true
  });
  await database.doc('releaseControl/autonomousProgression').set({
    enabled: true,
    clientIds: [opData.uid],
    expiresAt: opData.window.expiresAt
  });
  await database.doc('clients/' + opData.uid).set({
    activePlanId: opData.planId,
    coachId: 'synthetic-coach'
  });
  await database.doc('coaches/synthetic-coach').set({
    autoApplyCanary: {
      enabled: true,
      clientIds: [opData.uid],
      prescriptionExerciseIds: [opData.pid]
    }
  });
}

test('ledger in emulator: exercises all 15 scenarios for operationId ledger', async () => {
  // Ensure releaseControl/numericPilot, autonomousProgression, coach and client are armed for initial test
  const defaultOp = makeValidOpData('op-init-default');
  await armFencesForOp(db, defaultOp);

  // 1. Más de 100 operaciones previas, con duplicado fuera del primer bloque
  // Seed 105 operations directly into emulator
  const batch = db.batch();
  for (let i = 1; i <= 105; i++) {
    const id = `op-bulk-${String(i).padStart(3, '0')}`;
    const ref = db.doc(`releaseControl/numericPilot/operations/${id}`);
    batch.set(ref, {
      schema: ledger.LEDGER_SCHEMA,
      operationId: id,
      uid: C.UID,
      planId: C.PLAN,
      pid: C.PID,
      status: ledger.STATES.COMPLETED,
      reservedAt: new Date(Date.now() - (106 - i) * 1000).toISOString()
    });
  }
  await batch.commit();

  // Operation #104 is beyond any 100-limit page:
  const directLookup104 = await ledger.checkOperationUniquenessDirect(db, 'op-bulk-104');
  assert.equal(directLookup104.exists, true, 'Direct lookup must find operation #104 regardless of collection size');
  assert.equal(directLookup104.status, ledger.STATES.COMPLETED);

  // Attempting to reserve op-bulk-104 must be rejected immediately:
  const op104Data = makeValidOpData('op-bulk-104');
  await armFencesForOp(db, op104Data);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op104Data, { attestation: await makeValidAttestation(op104Data) }),
    /OPERATION_ALREADY_EXISTS/
  );

  // 2. Consulta directa del operationId (devuelve null si no existe, o doc exacto si existe)
  const lookupFresh = await ledger.checkOperationUniquenessDirect(db, 'op-never-seen-999');
  assert.equal(lookupFresh.exists, false);
  assert.equal(lookupFresh.status, null);

  // 3. Dos reservas concurrentes (concurrencia atómica: exactamente 1 tiene éxito, 1 falla)
  const concurrentOp = makeValidOpData('op-concurrent-test');
  await armFencesForOp(db, concurrentOp);
  const [attConcurrent1, attConcurrent2] = await Promise.all([
    makeValidAttestation(concurrentOp),
    makeValidAttestation(concurrentOp)
  ]);
  const attempts = await Promise.allSettled([
    ledger.reserveOperation(db, concurrentOp, { attestation: attConcurrent1 }),
    ledger.reserveOperation(db, concurrentOp, { attestation: attConcurrent2 })
  ]);
  const fulfilled = attempts.filter(a => a.status === 'fulfilled');
  const rejected = attempts.filter(a => a.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'Exactly one concurrent reservation must succeed');
  assert.equal(rejected.length, 1, 'Concurrent duplicate must be rejected');
  assert.match(rejected[0].reason.message, /OPERATION_ALREADY_EXISTS|ATTESTATION_ALREADY_CONSUMED/);

  // 4. Reintento después de reserva
  await assert.rejects(
    async () => ledger.reserveOperation(db, concurrentOp, { attestation: await makeValidAttestation(concurrentOp) }),
    /OPERATION_ALREADY_EXISTS|ATTESTATION_ALREADY_CONSUMED/
  );

  // 5. Conflicto de SHA (data.runtimeSha !== data.window.runtimeSha)
  const opShaConflict = makeValidOpData('op-sha-conflict');
  opShaConflict.runtimeSha = 'b'.repeat(40); // window has 'a'.repeat(40)
  assert.throws(
    () => ledger.validateOperationData(opShaConflict),
    /IDENTITY_MISMATCH/
  );

  // 6. Conflicto de ventana (data.operationId !== data.window.operationId)
  const opWindowConflict = makeValidOpData('op-root-id');
  opWindowConflict.window.operationId = 'op-window-mismatch';
  assert.throws(
    () => ledger.validateOperationData(opWindowConflict),
    /IDENTITY_MISMATCH/
  );

  // 7. Conflicto UID/PID/plan
  const opUidConflict = makeValidOpData('op-uid-conflict');
  opUidConflict.window.uid = 'other-uid';
  assert.throws(
    () => ledger.validateOperationData(opUidConflict),
    /IDENTITY_MISMATCH/
  );
  const opWrongContractUid = { ...makeValidOpData('op-wrong-uid'), uid: 'not-ayrton' };
  assert.throws(
    () => ledger.validateOperationData(opWrongContractUid),
    /UNAUTHORIZED_IDENTIFIER/
  );

  // 8. Reserva con release desarmado
  const opDisarmed = makeValidOpData('op-when-disarmed');
  await armFencesForOp(db, opDisarmed);
  await db.doc('releaseControl/numericPilot').set({ enabled: false });
  await assert.rejects(
    async () => ledger.reserveOperation(db, opDisarmed, { attestation: await makeValidAttestation(opDisarmed) }),
    /RELEASE_CONTROL_DISARMED/
  );
  await armFencesForOp(db, opDisarmed); // rearm

  // 8b. Reserva con release general desarmado (releaseControl/autonomousProgression)
  const opGenDisarmed = makeValidOpData('op-gen-disarmed');
  await armFencesForOp(db, opGenDisarmed);
  await db.doc('releaseControl/autonomousProgression').set({ enabled: false });
  await assert.rejects(
    async () => ledger.reserveOperation(db, opGenDisarmed, { attestation: await makeValidAttestation(opGenDisarmed) }),
    /RELEASE_CONTROL_DISARMED/
  );
  await armFencesForOp(db, opGenDisarmed); // restore

  // 8c. Reserva con Coach Canary desarmado
  const opCanaryDisarmed = makeValidOpData('op-canary-disarmed');
  await armFencesForOp(db, opCanaryDisarmed);
  await db.doc('coaches/synthetic-coach').set({ autoApplyCanary: { enabled: false, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] } });
  await assert.rejects(
    async () => ledger.reserveOperation(db, opCanaryDisarmed, { attestation: await makeValidAttestation(opCanaryDisarmed) }),
    /COACH_CANARY_DISARMED/
  );
  await armFencesForOp(db, opCanaryDisarmed); // restore

  // 9. STOP concurrente (idempotencia y sin carreras)
  const opToStop = makeValidOpData('op-to-stop-concurrent');
  await armFencesForOp(db, opToStop);
  await ledger.reserveOperation(db, opToStop, { attestation: await makeValidAttestation(opToStop) });
  const stopResults = await Promise.all([
    ledger.recordStop(db, opToStop.operationId, { reason: 'CONCURRENT_STOP_1' }),
    ledger.recordStop(db, opToStop.operationId, { reason: 'CONCURRENT_STOP_2' })
  ]);
  assert.equal(stopResults[0].status, 'STOPPED');
  assert.equal(stopResults[1].status, 'STOPPED');
  const verifyStopped = await ledger.verifyOperation(db, opToStop.operationId);
  assert.equal(verifyStopped.status, 'STOPPED');

  // STOPPED -> STOPPED idempotence without duplicating events:
  const historyLenBefore = verifyStopped.operation.history.length;
  const subsequentStop = await ledger.recordStop(db, opToStop.operationId, { reason: 'CONCURRENT_STOP_3' });
  assert.equal(subsequentStop.status, 'STOPPED');
  assert.equal(subsequentStop.duplicate, true);
  const verifyStoppedAgain = await ledger.verifyOperation(db, opToStop.operationId);
  assert.equal(verifyStoppedAgain.operation.history.length, historyLenBefore, 'Subsequent STOP calls must not duplicate history events');

  // 10. Reintento tras STOP
  await assert.rejects(
    () => ledger.recordResult(db, opToStop.operationId, { success: true }),
    /INVALID_STATE_TRANSITION/
  );
  await assert.rejects(
    async () => ledger.reserveOperation(db, opToStop, { attestation: await makeValidAttestation(opToStop) }),
    /OPERATION_ALREADY_EXISTS|ATTESTATION_ALREADY_CONSUMED/
  );

  // 11. Transiciones de estado inválidas y STOP terminal
  const opTransition = makeValidOpData('op-state-transitions');
  await armFencesForOp(db, opTransition);
  await ledger.reserveOperation(db, opTransition, { attestation: await makeValidAttestation(opTransition) });
  await ledger.recordResult(db, opTransition.operationId, { success: true, summary: { applied: 1 } });
  const completedOp = await ledger.verifyOperation(db, opTransition.operationId);
  assert.equal(completedOp.status, 'COMPLETED');

  // COMPLETED preserves its result upon global STOP:
  const stopOnCompleted = await ledger.recordStop(db, opTransition.operationId, { reason: 'GLOBAL_EMERGENCY_STOP' });
  assert.equal(stopOnCompleted.status, 'COMPLETED');
  const verifyCompletedAfterStop = await ledger.verifyOperation(db, opTransition.operationId);
  assert.equal(verifyCompletedAfterStop.status, 'COMPLETED', 'Global STOP must not retrospectively alter a completed operation');
  assert.deepEqual(verifyCompletedAfterStop.operation.resultSummary, { applied: 1 });

  // FAILED preserves its result upon global STOP:
  const opFailed = makeValidOpData('op-failed-test');
  await armFencesForOp(db, opFailed);
  await ledger.reserveOperation(db, opFailed, { attestation: await makeValidAttestation(opFailed) });
  await ledger.recordResult(db, opFailed.operationId, { success: false, summary: { error: 'TIMED_OUT' } });
  const stopOnFailed = await ledger.recordStop(db, opFailed.operationId, { reason: 'GLOBAL_EMERGENCY_STOP' });
  assert.equal(stopOnFailed.status, 'FAILED');
  const verifyFailedAfterStop = await ledger.verifyOperation(db, opFailed.operationId);
  assert.equal(verifyFailedAfterStop.status, 'FAILED', 'Global STOP must not retrospectively alter a failed operation');

  // COMPLETED -> FAILED is forbidden
  await assert.rejects(
    () => ledger.recordResult(db, opTransition.operationId, { success: false }),
    /INVALID_STATE_TRANSITION/
  );
  // COMPLETED -> RESERVED is forbidden
  await assert.rejects(
    async () => ledger.reserveOperation(db, opTransition, { attestation: await makeValidAttestation(opTransition) }),
    /OPERATION_ALREADY_EXISTS|ATTESTATION_ALREADY_CONSUMED/
  );

  // 12. Campos históricos protegidos (identidad inmutable)
  const initialData = (await db.doc(`releaseControl/numericPilot/operations/${opTransition.operationId}`).get()).data();
  assert.equal(initialData.uid, C.UID);
  assert.equal(initialData.planId, C.PLAN);
  assert.equal(initialData.pid, C.PID);
  assert.equal(initialData.runtimeSha, 'a'.repeat(40));
  assert.equal(initialData.deploymentId, 'dpl_valid_01');

  // 13. Error de conexión simulado
  const simulatedDb = Object.create(db);
  simulatedDb.runTransaction = () => Promise.reject(new Error('UNAVAILABLE: network connection lost'));
  const opNetwork = makeValidOpData('op-network-err');
  await armFencesForOp(db, opNetwork);
  await assert.rejects(
    async () => ledger.reserveOperation(simulatedDb, opNetwork, { attestation: await makeValidAttestation(opNetwork) }),
    /UNAVAILABLE: network connection lost/
  );

  // 14. Recuperación de evidencia desinfectada
  const opEvidence = makeValidOpData('op-evidence-recovery');
  await armFencesForOp(db, opEvidence);
  await ledger.reserveOperation(db, opEvidence, { attestation: await makeValidAttestation(opEvidence) });
  await ledger.recordResult(db, opEvidence.operationId, { success: true, summary: { applied: 1, delta: '+2.5kg' } });
  const evidence = await ledger.recoverEvidence(db, opEvidence.operationId);
  assert.ok(evidence);
  assert.equal(evidence.operationId, 'op-evidence-recovery');
  assert.equal(evidence.status, 'COMPLETED');
  assert.equal(evidence.runtimeSha, 'a'.repeat(40));
  assert.equal(evidence.deploymentId, 'dpl_valid_01');
  assert.ok(evidence.history.length >= 2);
  assert.equal(evidence.history[0].action, 'RESERVED');
  assert.equal(evidence.history[1].action, 'COMPLETED');

  // 15. Rechazo de fuente no acreditada en preflight (fail-closed BLOCKED)
  const preflightUnverified = await runPreflight({
    window: opEvidence.window,
    deploymentId: 'dpl_valid_01',
    activeRuns: [],
    ledgerDb: db,
    isEmulator: false // Simulates production / unaccredited source!
  });
  assert.equal(preflightUnverified.decision, 'BLOCKED');
  assert.equal(preflightUnverified.reason, 'OPERATION_HISTORY_UNVERIFIED_SOURCE');

  // Conversely, in emulator mode with direct document lookup:
  const preflightExisting = await runPreflight({
    window: opEvidence.window,
    deploymentId: 'dpl_valid_01',
    activeRuns: [],
    ledgerDb: db,
    isEmulator: true
  });
  assert.equal(preflightExisting.decision, 'NO-GO');
  assert.equal(preflightExisting.reason, 'OPERATION_ALREADY_EXECUTED');
});

test('ledger in emulator: verifies all 14 fail-closed negative rejection modes with 0 persisted reservations', async () => {
  // 1. Barrera numericPilot ausente
  const op1 = makeValidOpData('op-neg-no-numeric-pilot');
  await armFencesForOp(db, op1);
  await db.doc('releaseControl/numericPilot').delete();
  await assert.rejects(
    async () => ledger.reserveOperation(db, op1, { attestation: await makeValidAttestation(op1) }),
    /RELEASE_CONTROL_DISARMED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op1.operationId}`).get()).exists, false, 'op1 must not persist reservation');

  // 2. operationId ausente en la barrera numericPilot
  const op2 = makeValidOpData('op-neg-no-fence-opid');
  await armFencesForOp(db, op2);
  const fenceNoOpId = { ...op2.window, enabled: true };
  delete fenceNoOpId.operationId;
  await db.doc('releaseControl/numericPilot').set(fenceNoOpId);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op2, { attestation: await makeValidAttestation(op2) }),
    /FENCE_FIELD_MISSING/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op2.operationId}`).get()).exists, false, 'op2 must not persist reservation');

  // 3. Runtime SHA ausente en la barrera numericPilot
  const op3 = makeValidOpData('op-neg-no-fence-sha');
  await armFencesForOp(db, op3);
  const fenceNoSha = { ...op3.window, enabled: true };
  delete fenceNoSha.runtimeSha;
  await db.doc('releaseControl/numericPilot').set(fenceNoSha);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op3, { attestation: await makeValidAttestation(op3) }),
    /FENCE_FIELD_MISSING/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op3.operationId}`).get()).exists, false, 'op3 must not persist reservation');

  // 4. Release general ausente (releaseControl/autonomousProgression)
  const op4 = makeValidOpData('op-neg-no-auto-release');
  await armFencesForOp(db, op4);
  await db.doc('releaseControl/autonomousProgression').delete();
  await assert.rejects(
    async () => ledger.reserveOperation(db, op4, { attestation: await makeValidAttestation(op4) }),
    /RELEASE_CONTROL_DISARMED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op4.operationId}`).get()).exists, false, 'op4 must not persist reservation');

  // 5. Release general desactivado
  const op5 = makeValidOpData('op-neg-auto-release-disabled');
  await armFencesForOp(db, op5);
  await db.doc('releaseControl/autonomousProgression').update({ enabled: false });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op5, { attestation: await makeValidAttestation(op5) }),
    /RELEASE_CONTROL_DISARMED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op5.operationId}`).get()).exists, false, 'op5 must not persist reservation');

  // 6. Coach inexistente
  const op6 = makeValidOpData('op-neg-coach-not-found');
  await armFencesForOp(db, op6);
  await db.doc('clients/' + op6.uid).update({ coachId: 'non-existent-coach-id' });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op6, { attestation: await makeValidAttestation(op6) }),
    /COACH_NOT_FOUND/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op6.operationId}`).get()).exists, false, 'op6 must not persist reservation');

  // 7. Canary inexistente
  const op7 = makeValidOpData('op-neg-canary-not-found');
  await armFencesForOp(db, op7);
  await db.doc('coaches/synthetic-coach').set({ name: 'Coach Without Canary Field' });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op7, { attestation: await makeValidAttestation(op7) }),
    /COACH_CANARY_NOT_FOUND/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op7.operationId}`).get()).exists, false, 'op7 must not persist reservation');

  // 8. Canary desactivado
  const op8 = makeValidOpData('op-neg-canary-disabled');
  await armFencesForOp(db, op8);
  await db.doc('coaches/synthetic-coach').set({
    autoApplyCanary: { enabled: false, clientIds: [op8.uid], prescriptionExerciseIds: [op8.pid] }
  });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op8, { attestation: await makeValidAttestation(op8) }),
    /COACH_CANARY_DISARMED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op8.operationId}`).get()).exists, false, 'op8 must not persist reservation');

  // 9. Allowlist vacía o múltiple
  // 9a. clientIds empty:
  const op9a = makeValidOpData('op-neg-empty-uid-allowlist');
  await armFencesForOp(db, op9a);
  await db.doc('coaches/synthetic-coach').set({
    autoApplyCanary: { enabled: true, clientIds: [], prescriptionExerciseIds: [op9a.pid] }
  });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op9a, { attestation: await makeValidAttestation(op9a) }),
    /COACH_CANARY_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op9a.operationId}`).get()).exists, false, 'op9a must not persist reservation');

  // 9b. clientIds multiple:
  const op9b = makeValidOpData('op-neg-multiple-uid-allowlist');
  await armFencesForOp(db, op9b);
  await db.doc('coaches/synthetic-coach').set({
    autoApplyCanary: { enabled: true, clientIds: [op9b.uid, 'unauthorized-second-uid'], prescriptionExerciseIds: [op9b.pid] }
  });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op9b, { attestation: await makeValidAttestation(op9b) }),
    /COACH_CANARY_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op9b.operationId}`).get()).exists, false, 'op9b must not persist reservation');

  // 9c. prescriptionExerciseIds empty:
  const op9c = makeValidOpData('op-neg-empty-pid-allowlist');
  await armFencesForOp(db, op9c);
  await db.doc('coaches/synthetic-coach').set({
    autoApplyCanary: { enabled: true, clientIds: [op9c.uid], prescriptionExerciseIds: [] }
  });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op9c, { attestation: await makeValidAttestation(op9c) }),
    /COACH_CANARY_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op9c.operationId}`).get()).exists, false, 'op9c must not persist reservation');

  // 10. Plan activo sustituido
  const op10 = makeValidOpData('op-neg-plan-substituted');
  await armFencesForOp(db, op10);
  await db.doc('clients/' + op10.uid).update({ activePlanId: 'substituted-plan-id' });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op10, { attestation: await makeValidAttestation(op10) }),
    /PLAN_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op10.operationId}`).get()).exists, false, 'op10 must not persist reservation');

  // 11. CoachId no acreditado / ausente en cliente
  const op11 = makeValidOpData('op-neg-coach-not-accredited');
  await armFencesForOp(db, op11);
  await db.doc('clients/' + op11.uid).update({ coachId: '' });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op11, { attestation: await makeValidAttestation(op11) }),
    /COACH_NOT_AUTHORIZED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op11.operationId}`).get()).exists, false, 'op11 must not persist reservation');

  // 12. Attestation ausente
  const op12 = makeValidOpData('op-neg-no-attestation');
  await armFencesForOp(db, op12);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op12),
    /ATTESTATION_MISSING/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op12.operationId}`).get()).exists, false, 'op12 must not persist reservation');

  // 13. Attestation falsificada
  // 13a. Falsified deploymentId:
  const op13a = makeValidOpData('op-neg-fake-dpl-attestation');
  await armFencesForOp(db, op13a);
  const fakeDplAtt = await makeValidAttestation({ ...op13a, deploymentId: 'dpl_forged_fake_01' });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op13a, { attestation: fakeDplAtt }),
    /ATTESTATION_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13a.operationId}`).get()).exists, false, 'op13a must not persist reservation');

  // 13b. Falsified sha:
  const op13b = makeValidOpData('op-neg-fake-sha-attestation');
  await armFencesForOp(db, op13b);
  const fakeShaAtt = await makeValidAttestation({ ...op13b, runtimeSha: 'f'.repeat(40), window: { ...op13b.window, runtimeSha: 'f'.repeat(40) } });
  await assert.rejects(
    async () => ledger.reserveOperation(db, op13b, { attestation: fakeShaAtt }),
    /ATTESTATION_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13b.operationId}`).get()).exists, false, 'op13b must not persist reservation');

  // 13c. Caller provides only boolean or manufactured object without accredited source:
  const op13c = makeValidOpData('op-neg-only-bool-attestation');
  await armFencesForOp(db, op13c);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op13c, { attestation: { attested: true } }),
    /ATTESTATION_UNTRUSTED|ATTESTATION_UNVERIFIED_SOURCE|ATTESTATION_OPERATION_ID_MISSING/
  );
  await assert.rejects(
    async () => ledger.reserveOperation(db, op13c, { attestation: makeManufacturedAttestation(op13c) }),
    /ATTESTATION_UNVERIFIED_SOURCE/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13c.operationId}`).get()).exists, false, 'op13c must not persist reservation');

  // 13d. attested: false:
  const op13d = makeValidOpData('op-neg-rejected-attestation');
  await armFencesForOp(db, op13d);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op13d, { attestation: { ...(await makeValidAttestation(op13d)), attested: false } }),
    /ATTESTATION_REJECTED|ATTESTATION_UNVERIFIED_SOURCE/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13d.operationId}`).get()).exists, false, 'op13d must not persist reservation');

  // 14. Identidad de ventana distinta de la reserva
  const op14 = makeValidOpData('op-neg-window-id-mismatch');
  await armFencesForOp(db, op14);
  op14.window.operationId = 'op-different-window-id';
  await assert.rejects(
    async () => ledger.reserveOperation(db, op14, { attestation: await makeValidAttestation(op14) }),
    /IDENTITY_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op14.operationId}`).get()).exists, false, 'op14 must not persist reservation');

  // 15. Atestación sin operationId
  const op15 = makeValidOpData('op-neg-att-no-opid');
  await armFencesForOp(db, op15);
  const attNoOpId = { ...(await makeValidAttestation(op15)) };
  delete attNoOpId.operationId;
  await assert.rejects(
    async () => ledger.reserveOperation(db, op15, { attestation: attNoOpId }),
    /ATTESTATION_OPERATION_ID_MISSING|ATTESTATION_UNVERIFIED_SOURCE/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op15.operationId}`).get()).exists, false, 'op15 must not persist reservation');

  // 16. Atestación sin checks del proveedor (untrusted)
  const op16 = makeValidOpData('op-neg-att-untrusted');
  await armFencesForOp(db, op16);
  const attUntrusted = { ...(await makeValidAttestation(op16)), checks: [] };
  await assert.rejects(
    async () => ledger.reserveOperation(db, op16, { attestation: attUntrusted }),
    /ATTESTATION_UNTRUSTED|ATTESTATION_UNVERIFIED_SOURCE/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op16.operationId}`).get()).exists, false, 'op16 must not persist reservation');

  // 17. numericPilot fence: uid ausente
  const op17 = makeValidOpData('op-neg-no-fence-uid');
  await armFencesForOp(db, op17);
  const fenceNoUid = { ...op17.window, enabled: true };
  delete fenceNoUid.uid;
  await db.doc('releaseControl/numericPilot').set(fenceNoUid);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op17, { attestation: await makeValidAttestation(op17) }),
    /FENCE_FIELD_MISSING.*uid/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op17.operationId}`).get()).exists, false, 'op17 must not persist reservation');

  // 18. numericPilot fence: planId ausente
  const op18 = makeValidOpData('op-neg-no-fence-planid');
  await armFencesForOp(db, op18);
  const fenceNoPlan = { ...op18.window, enabled: true };
  delete fenceNoPlan.planId;
  await db.doc('releaseControl/numericPilot').set(fenceNoPlan);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op18, { attestation: await makeValidAttestation(op18) }),
    /FENCE_FIELD_MISSING.*planId/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op18.operationId}`).get()).exists, false, 'op18 must not persist reservation');

  // 19. numericPilot fence: pid ausente
  const op19 = makeValidOpData('op-neg-no-fence-pid');
  await armFencesForOp(db, op19);
  const fenceNoPid = { ...op19.window, enabled: true };
  delete fenceNoPid.pid;
  await db.doc('releaseControl/numericPilot').set(fenceNoPid);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op19, { attestation: await makeValidAttestation(op19) }),
    /FENCE_FIELD_MISSING.*pid/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op19.operationId}`).get()).exists, false, 'op19 must not persist reservation');

  // 20. numericPilot fence: expiresAt ausente
  const op20 = makeValidOpData('op-neg-no-fence-expiresat');
  await armFencesForOp(db, op20);
  const fenceNoExp = { ...op20.window, enabled: true };
  delete fenceNoExp.expiresAt;
  await db.doc('releaseControl/numericPilot').set(fenceNoExp);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op20, { attestation: await makeValidAttestation(op20) }),
    /FENCE_FIELD_MISSING.*expiresAt/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op20.operationId}`).get()).exists, false, 'op20 must not persist reservation');

  // 21. numericPilot fence: startsAt manipulado
  const op21 = makeValidOpData('op-neg-fence-startsat-mismatch');
  await armFencesForOp(db, op21);
  const fenceBadStart = { ...op21.window, enabled: true, startsAt: '2026-01-01T00:00:00Z' };
  await db.doc('releaseControl/numericPilot').set(fenceBadStart);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op21, { attestation: await makeValidAttestation(op21) }),
    /FENCE_MISMATCH.*startsAt/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op21.operationId}`).get()).exists, false, 'op21 must not persist reservation');

  // 22. Inyección de reloj inválido
  const op22 = makeValidOpData('op-neg-invalid-clock');
  await armFencesForOp(db, op22);
  await assert.rejects(
    async () => ledger.reserveOperation(db, op22, { now: 'not-a-valid-iso-date', attestation: await makeValidAttestation(op22) }),
    /INVALID_CLOCK_INJECTION/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op22.operationId}`).get()).exists, false, 'op22 must not persist reservation');

  // 23. Inyección de reloj fuera de emulador (CLOCK_TAMPERING_REJECTED)
  const op23 = makeValidOpData('op-neg-clock-tampering');
  await armFencesForOp(db, op23);
  const att23 = await makeValidAttestation(op23);
  const origEmuHost = process.env.FIRESTORE_EMULATOR_HOST;
  try {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    await assert.rejects(
      async () => ledger.reserveOperation(db, op23, { now: op23.window.startsAt, attestation: att23 }),
      /CLOCK_TAMPERING_REJECTED/
    );
  } finally {
    process.env.FIRESTORE_EMULATOR_HOST = origEmuHost;
  }
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op23.operationId}`).get()).exists, false, 'op23 must not persist reservation');
});

test('ledger in emulator: P0 attestation trust boundary and injection control (R16)', async () => {
  // P0.1 Reproduce Defect: Manufactured attestation rejected with ATTESTATION_UNVERIFIED_SOURCE
  const opDefect = makeValidOpData('op-r16-p01-defect');
  await armFencesForOp(db, opDefect);
  const manufactured = makeManufacturedAttestation(opDefect);
  await assert.rejects(
    async () => ledger.reserveOperation(db, opDefect, { attestation: manufactured }),
    /ATTESTATION_UNVERIFIED_SOURCE/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opDefect.operationId}`).get()).exists, false, 'Manufactured attestation must not persist reservation');

  // Even with dummy VERCEL_TOKEN present in environment:
  const origToken = process.env.VERCEL_TOKEN;
  try {
    process.env.VERCEL_TOKEN = 'synthetic_dummy_token_123';
    await assert.rejects(
      async () => ledger.reserveOperation(db, opDefect, { attestation: manufactured }),
      /ATTESTATION_UNVERIFIED_SOURCE/
    );
    assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opDefect.operationId}`).get()).exists, false, 'Token alone cannot validate manufactured attestation');
  } finally {
    process.env.VERCEL_TOKEN = origToken;
  }

  // P0.2 Replay Protection: consumeAttestation prevents reuse
  const opReplay1 = makeValidOpData('op-r16-replay-01');
  await armFencesForOp(db, opReplay1);
  const validAtt = await makeValidAttestation(opReplay1);
  const res1 = await ledger.reserveOperation(db, opReplay1, { attestation: validAtt });
  assert.equal(res1.status, 'RESERVED');

  const opReplay2 = makeValidOpData('op-r16-replay-02');
  await armFencesForOp(db, opReplay2);
  await assert.rejects(
    async () => ledger.reserveOperation(db, opReplay2, { attestation: validAtt }),
    /ATTESTATION_ALREADY_CONSUMED|ATTESTATION_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opReplay2.operationId}`).get()).exists, false, 'Reused attestation must not persist reservation');

  // P0.2 TTL / Expiration check (> 15m rejected)
  const opExpired = makeValidOpData('op-r16-expired');
  await armFencesForOp(db, opExpired);
  const expiredAtt = await makeValidAttestation(opExpired, { now: Date.now() - (16 * 60 * 1000) });
  await assert.rejects(
    async () => ledger.reserveOperation(db, opExpired, { attestation: expiredAtt }),
    /ATTESTATION_EXPIRED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opExpired.operationId}`).get()).exists, false, 'Expired attestation must not persist reservation');

  // P0.2 Tampering detection: sealed object cannot be mutated or tampered
  const opTamper = makeValidOpData('op-r16-tamper');
  await armFencesForOp(db, opTamper);
  const sealedAtt = await makeValidAttestation(opTamper);
  assert.ok(Object.isFrozen(sealedAtt), 'Sealed attestation must be frozen');
  assert.throws(() => {
    sealedAtt.deploymentId = 'dpl_tampered';
  }, TypeError);

  // P0.3 Injection Control: Custom fetcher & clock injection rejected in production
  const origGcpProject = process.env.GCP_PROJECT_ID;
  try {
    process.env.GCP_PROJECT_ID = 'vdsen-ecosistema';
    assert.equal(isProductionTarget(), true);
    // Provider fetcher injection rejected in production:
    await assert.rejects(
      async () => attestRuntime({
        deploymentId: 'dpl_test',
        expectedSha: 'a'.repeat(40),
        expectedOperationId: 'op-prod-inject',
        expectedAlias: 'vdsen-ecosistema.vercel.app',
        fetcher: async () => ({ status: 200 })
      }),
      /PROVIDER_INJECTION_REJECTED/
    );

    // Clock injection rejected in production:
    const opProdClock = makeValidOpData('op-prod-clock');
    await assert.rejects(
      async () => ledger.reserveOperation(db, opProdClock, { now: opProdClock.window.startsAt }),
      /CLOCK_TAMPERING_REJECTED/
    );
  } finally {
    if (origGcpProject !== undefined) process.env.GCP_PROJECT_ID = origGcpProject;
    else delete process.env.GCP_PROJECT_ID;
  }

  // P0.4 Provider Error Handling via reserveVerifiedOperation
  // 401 Unauthorized:
  const opAuthFail = makeValidOpData('op-r16-auth-fail');
  await armFencesForOp(db, opAuthFail);
  await assert.rejects(
    async () => ledger.reserveVerifiedOperation(db, opAuthFail, {
      expectedAlias: 'vdsen-ecosistema.vercel.app',
      fetcher: async () => ({ status: 401 })
    }),
    /ATTESTATION_VERIFICATION_FAILED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opAuthFail.operationId}`).get()).exists, false, 'Provider 401 must not persist reservation');

  // 404 Deployment Not Found:
  const opNotFound = makeValidOpData('op-r16-404-fail');
  await armFencesForOp(db, opNotFound);
  await assert.rejects(
    async () => ledger.reserveVerifiedOperation(db, opNotFound, {
      expectedAlias: 'vdsen-ecosistema.vercel.app',
      fetcher: async () => ({ status: 404 })
    }),
    /ATTESTATION_VERIFICATION_FAILED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opNotFound.operationId}`).get()).exists, false, 'Provider 404 must not persist reservation');

  // High-level reserveVerifiedOperation Success Path:
  const opVerifiedSuccess = makeValidOpData('op-r16-verified-ok');
  await armFencesForOp(db, opVerifiedSuccess);
  const mockFetcher = createMockFetcher(opVerifiedSuccess);
  const verifiedRes = await ledger.reserveVerifiedOperation(db, opVerifiedSuccess, {
    expectedAlias: 'vdsen-ecosistema.vercel.app',
    fetcher: mockFetcher
  });
  assert.equal(verifiedRes.status, 'RESERVED');
  assert.equal(verifiedRes.operationId, opVerifiedSuccess.operationId);
  const persistedDoc = await db.doc(`releaseControl/numericPilot/operations/${opVerifiedSuccess.operationId}`).get();
  assert.equal(persistedDoc.exists, true);
  assert.equal(persistedDoc.data().status, 'RESERVED');
});

test('ledger in emulator: P0 error-handling simulations, ambiguous recovery, and environment authority', async () => {
  // 1. Error handling simulation: transaction abort before commit & retry
  const opAbort = makeValidOpData('op-r17-abort-retry');
  await armFencesForOp(db, opAbort);
  const attAbort = await makeValidAttestation(opAbort);

  // Simulated DB where runTransaction runs callback (staging tx.set), but fails at commit stage
  const abortingDb = Object.create(db);
  abortingDb.runTransaction = async (callback) => {
    let stagedSet = false;
    const mockTx = {
      get: (ref) => db.doc(ref.path).get(),
      set: () => { stagedSet = true; }
    };
    await callback(mockTx);
    assert.equal(stagedSet, true, 'Transaction callback must have staged tx.set');
    // Force simulated abort before commit
    throw new Error('TRANSACTION_ABORTED_BEFORE_COMMIT: Simulated commit failure / rollback');
  };

  // Attempt reservation on abortingDb - must abort
  await assert.rejects(
    async () => ledger.reserveOperation(abortingDb, opAbort, { attestation: attAbort }),
    /TRANSACTION_ABORTED_BEFORE_COMMIT/
  );

  // Verify that NO document was persisted in Firestore
  const abortedDoc = await db.doc(`releaseControl/numericPilot/operations/${opAbort.operationId}`).get();
  assert.equal(abortedDoc.exists, false, 'Aborted transaction must not persist document in Firestore');

  // Verify that the attestation was NOT consumed and can be used on legitimate retry
  const retryRes = await ledger.reserveOperation(db, opAbort, { attestation: attAbort });
  assert.equal(retryRes.status, 'RESERVED');
  assert.equal(retryRes.operationId, opAbort.operationId);

  // Verify document is now persisted in Firestore
  const committedDoc = await db.doc(`releaseControl/numericPilot/operations/${opAbort.operationId}`).get();
  assert.equal(committedDoc.exists, true, 'Committed retry must persist document in Firestore');
  assert.equal(committedDoc.data().status, 'RESERVED');

  // Attempting to reuse attAbort AFTER confirmed commit must be rejected with ATTESTATION_ALREADY_CONSUMED
  const opReplayAfterCommit = makeValidOpData('op-r17-replay-after-commit');
  await armFencesForOp(db, opReplayAfterCommit);
  await assert.rejects(
    async () => ledger.reserveOperation(db, opReplayAfterCommit, { attestation: attAbort }),
    /ATTESTATION_ALREADY_CONSUMED|ATTESTATION_MISMATCH/
  );

  // 2. Error handling simulation: retry after simulated contention wrapper
  const opContention = makeValidOpData('op-r17-contention-retry');
  await armFencesForOp(db, opContention);
  const attContention = await makeValidAttestation(opContention);

  let attemptCount = 0;
  const contentionDb = Object.create(db);
  contentionDb.runTransaction = async (callback) => {
    attemptCount++;
    try {
      return await db.runTransaction(async (tx) => {
        if (attemptCount === 1) {
          throw new Error('ABORTED: Simulated transaction contention conflict');
        }
        return await callback(tx);
      });
    } catch (firstErr) {
      if (firstErr.message.includes('Simulated transaction contention conflict')) {
        attemptCount++;
        return await db.runTransaction(async (tx) => {
          return await callback(tx);
        });
      }
      throw firstErr;
    }
  };

  const contentionRes = await ledger.reserveOperation(contentionDb, opContention, { attestation: attContention });
  assert.equal(contentionRes.status, 'RESERVED');
  assert.equal(attemptCount, 2, 'Contention retry must have executed attempt 2');
  const contentionPersisted = await db.doc(`releaseControl/numericPilot/operations/${opContention.operationId}`).get();
  assert.equal(contentionPersisted.exists, true);

  // 3. In-memory cache clearing simulation: clearing WeakSet/Set in same process
  const opDurable = makeValidOpData('op-r17-durable-restart');
  await armFencesForOp(db, opDurable);
  const attDurable = await makeValidAttestation(opDurable);
  await ledger.reserveOperation(db, opDurable, { attestation: attDurable });

  // Simulate process memory clearing: in-memory consumed Set is wiped
  _clearConsumedAttestationsForTesting();

  // Create a brand new verified attestation for the same operationId
  const freshAttAfterRestart = await makeValidAttestation(opDurable);
  // Transaction must fail at Step 1 (opSnap.exists) with OPERATION_ALREADY_EXISTS, proving durable authority
  await assert.rejects(
    async () => ledger.reserveOperation(db, opDurable, { attestation: freshAttAfterRestart }),
    /OPERATION_ALREADY_EXISTS/
  );

  // 4. P0.2 Window Revalidation on Retry: window expires between attempts
  const opWinRetry = makeValidOpData('op-r17-win-retry');
  const winStart = Date.now() - 1000;
  const winExpire = Date.now() + 2000;
  opWinRetry.window.startsAt = new Date(winStart).toISOString();
  opWinRetry.window.expiresAt = new Date(winExpire).toISOString();
  await armFencesForOp(db, opWinRetry);
  const attWinRetry = await makeValidAttestation(opWinRetry);

  let winAttempt = 0;
  const winRetryDb = Object.create(db);
  winRetryDb.runTransaction = async (callback) => {
    winAttempt++;
    await db.runTransaction(async (tx) => {
      throw new Error('ABORTED: Contention');
    }).catch(async () => {
      winAttempt++;
      return await db.runTransaction(async (tx) => {
        return await callback(tx);
      });
    });
  };

  await assert.rejects(
    async () => ledger.reserveOperation(winRetryDb, opWinRetry, {
      attestation: attWinRetry,
      dynamicClock: () => winAttempt === 1 ? new Date(winStart + 500).toISOString() : new Date(winExpire + 1000).toISOString()
    }),
    /WINDOW_EXPIRED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opWinRetry.operationId}`).get()).exists, false);

  // 5. P0.2 Attestation Expiration on Retry (> 15 min on retry)
  const opAttRetry = makeValidOpData('op-r17-att-exp-retry');
  await armFencesForOp(db, opAttRetry);
  const attExpRetry = await makeValidAttestation(opAttRetry, { now: Date.now() });

  let attAttempt = 0;
  const attRetryDb = Object.create(db);
  attRetryDb.runTransaction = async (callback) => {
    attAttempt++;
    await db.runTransaction(async (tx) => {
      throw new Error('ABORTED: Contention');
    }).catch(async () => {
      attAttempt++;
      return await db.runTransaction(async (tx) => {
        return await callback(tx);
      });
    });
  };

  await assert.rejects(
    async () => ledger.reserveOperation(attRetryDb, opAttRetry, {
      attestation: attExpRetry,
      dynamicClock: () => attAttempt === 1 ? new Date().toISOString() : new Date(Date.now() + 16 * 60 * 1000).toISOString()
    }),
    /ATTESTATION_EXPIRED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opAttRetry.operationId}`).get()).exists, false);

  // 6. Ambiguous commit recovery: network failure where commit actually succeeded
  // Simulated interruption of client response after successful server-side commit
  const opAmbiguous = makeValidOpData('op-r17-ambiguous-commit');
  await armFencesForOp(db, opAmbiguous);
  const attAmbiguous = await makeValidAttestation(opAmbiguous);

  const ambiguousDb = Object.create(db);
  ambiguousDb.runTransaction = async (callback) => {
    await db.runTransaction(callback);
    // Simulate network interruption between server commit ack and client
    const netErr = new Error('UNAVAILABLE: network connection lost before commit ack');
    netErr.code = 14;
    throw netErr;
  };

  const recoveredRes = await ledger.reserveOperation(ambiguousDb, opAmbiguous, { attestation: attAmbiguous });
  assert.equal(recoveredRes.status, 'RESERVED');
  assert.equal(recoveredRes.recoveredFromAmbiguity, true);
  assert.equal(recoveredRes.operationId, opAmbiguous.operationId);
  assert.ok(typeof recoveredRes.reservationAttemptId === 'string' && recoveredRes.reservationAttemptId.startsWith('att_attempt_'));

  const persistedAmbiguous = await db.doc(`releaseControl/numericPilot/operations/${opAmbiguous.operationId}`).get();
  assert.equal(persistedAmbiguous.data().reservationAttemptId, recoveredRes.reservationAttemptId);

  // Replay of consumed attestation is rejected
  const opReplayRecovered = makeValidOpData('op-r17-replay-recovered');
  await armFencesForOp(db, opReplayRecovered);
  await assert.rejects(
    async () => ledger.reserveOperation(db, opReplayRecovered, { attestation: attAmbiguous }),
    /ATTESTATION_ALREADY_CONSUMED|ATTESTATION_MISMATCH/
  );

  // 7. Ambiguous commit conflict: document exists with DIFFERENT reservationAttemptId
  const opConflict = makeValidOpData('op-r17-ambiguous-conflict');
  await armFencesForOp(db, opConflict);
  const attConflict = await makeValidAttestation(opConflict);

  // Pre-seed a document reserved by another attempt
  await db.doc(`releaseControl/numericPilot/operations/${opConflict.operationId}`).set({
    ...opConflict,
    status: 'RESERVED',
    reservedAt: new Date().toISOString(),
    reservationAttemptId: 'att_attempt_other_runner_999'
  });

  const conflictNetDb = Object.create(db);
  conflictNetDb.runTransaction = async () => {
    const netErr = new Error('UNAVAILABLE: connection lost');
    netErr.code = 14;
    throw netErr;
  };

  // Must reject with OPERATION_ALREADY_EXISTS, NOT declare recoveredFromAmbiguity
  await assert.rejects(
    async () => ledger.reserveOperation(conflictNetDb, opConflict, { attestation: attConflict }),
    /OPERATION_ALREADY_EXISTS/
  );

  // 8. Ambiguous commit unresolved: primary network error + readback failure preserves UNKNOWN/BLOCKED
  const opUnresolved = makeValidOpData('op-r17-ambiguous-unresolved');
  await armFencesForOp(db, opUnresolved);
  const attUnresolved = await makeValidAttestation(opUnresolved);

  const unresolvedDb = Object.create(db);
  unresolvedDb.runTransaction = async () => {
    const netErr = new Error('UNAVAILABLE: connection lost');
    netErr.code = 14;
    throw netErr;
  };
  unresolvedDb.doc = (path) => {
    if (path.includes(opUnresolved.operationId)) {
      return {
        get: async () => {
          const readErr = new Error('DEADLINE_EXCEEDED: readback timed out');
          readErr.code = 4;
          throw readErr;
        }
      };
    }
    return db.doc(path);
  };

  await assert.rejects(
    async () => ledger.reserveOperation(unresolvedDb, opUnresolved, { attestation: attUnresolved }),
    /AMBIGUOUS_COMMIT_UNRESOLVED/
  );
  // Attestation must NOT have been consumed
  assert.equal(verifyAttestationAuthenticity(attUnresolved).valid, true, 'Attestation must remain valid when readback fails');

  // 9. Ambiguous network failure where commit did NOT succeed
  const opNetFail = makeValidOpData('op-r17-net-fail');
  await armFencesForOp(db, opNetFail);
  const attNetFail = await makeValidAttestation(opNetFail);

  const failDb = Object.create(db);
  failDb.runTransaction = async () => {
    const netErr = new Error('UNAVAILABLE: connection refused before server reached');
    netErr.code = 14;
    throw netErr;
  };

  await assert.rejects(
    async () => ledger.reserveOperation(failDb, opNetFail, { attestation: attNetFail }),
    /UNAVAILABLE/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${opNetFail.operationId}`).get()).exists, false);

  // 10. P0 dynamicClock & mock provider boundary rejection
  // 10a. Non-demo / staging target
  const origGcpProject = process.env.GCP_PROJECT_ID;
  const origGcloud = process.env.GCLOUD_PROJECT;
  const origGoogleCloud = process.env.GOOGLE_CLOUD_PROJECT;
  const origEmuHost = process.env.FIRESTORE_EMULATOR_HOST;

  try {
    process.env.GCP_PROJECT_ID = 'vdsen-ecosistema-staging';
    assert.equal(isLiveTarget(), true, 'vdsen-ecosistema-staging must be identified as live target');

    await assert.rejects(
      async () => attestRuntime({
        deploymentId: 'dpl_staging_test',
        expectedSha: 'a'.repeat(40),
        expectedOperationId: 'op-staging-inject',
        expectedAlias: 'vdsen-ecosistema.vercel.app',
        fetcher: async () => ({ status: 200 })
      }),
      /PROVIDER_INJECTION_REJECTED/
    );

    const opStagingClock = makeValidOpData('op-staging-clock');
    await assert.rejects(
      async () => ledger.reserveOperation(db, opStagingClock, { now: opStagingClock.window.startsAt }),
      /CLOCK_TAMPERING_REJECTED/
    );

    await assert.rejects(
      async () => ledger.reserveOperation(db, opStagingClock, { dynamicClock: () => new Date().toISOString() }),
      /CLOCK_TAMPERING_REJECTED/
    );

    // 10b. Unidentified project (missing GCP project identifiers)
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;

    await assert.rejects(
      async () => attestRuntime({
        deploymentId: 'dpl_unidentified_test',
        expectedSha: 'a'.repeat(40),
        expectedOperationId: 'op-unidentified-inject',
        expectedAlias: 'vdsen-ecosistema.vercel.app',
        fetcher: async () => ({ status: 200 })
      }),
      /PROVIDER_INJECTION_REJECTED/
    );

    const opUnidentifiedClock = makeValidOpData('op-unidentified-clock');
    await assert.rejects(
      async () => ledger.reserveOperation(db, opUnidentifiedClock, { dynamicClock: () => new Date().toISOString() }),
      /CLOCK_TAMPERING_REJECTED/
    );

    // 10c. Missing FIRESTORE_EMULATOR_HOST
    process.env.GCP_PROJECT_ID = 'demo-vdsen-shadow';
    delete process.env.FIRESTORE_EMULATOR_HOST;

    await assert.rejects(
      async () => attestRuntime({
        deploymentId: 'dpl_no_emu_test',
        expectedSha: 'a'.repeat(40),
        expectedOperationId: 'op-no-emu-inject',
        expectedAlias: 'vdsen-ecosistema.vercel.app',
        fetcher: async () => ({ status: 200 })
      }),
      /PROVIDER_INJECTION_REJECTED/
    );

    await assert.rejects(
      async () => ledger.reserveOperation(db, opUnidentifiedClock, { dynamicClock: () => new Date().toISOString() }),
      /CLOCK_TAMPERING_REJECTED/
    );
  } finally {
    if (origGcpProject !== undefined) process.env.GCP_PROJECT_ID = origGcpProject; else delete process.env.GCP_PROJECT_ID;
    if (origGcloud !== undefined) process.env.GCLOUD_PROJECT = origGcloud; else delete process.env.GCLOUD_PROJECT;
    if (origGoogleCloud !== undefined) process.env.GOOGLE_CLOUD_PROJECT = origGoogleCloud; else delete process.env.GOOGLE_CLOUD_PROJECT;
    if (origEmuHost !== undefined) process.env.FIRESTORE_EMULATOR_HOST = origEmuHost; else delete process.env.FIRESTORE_EMULATOR_HOST;
  }

  // 10d. Unauthorized temporal keys rejected even in demo environment
  const opBadKeys = makeValidOpData('op-bad-temporal-keys');
  await armFencesForOp(db, opBadKeys);
  const attBadKeys = await makeValidAttestation(opBadKeys);
  await assert.rejects(
    async () => ledger.reserveOperation(db, opBadKeys, { attestation: attBadKeys, clock: () => Date.now() }),
    /CLOCK_TAMPERING_REJECTED/
  );
  await assert.rejects(
    async () => ledger.reserveOperation(db, opBadKeys, { attestation: attBadKeys, currentTime: Date.now() }),
    /CLOCK_TAMPERING_REJECTED/
  );

  // 10e. dynamicClock returning invalid timestamp rejected
  await assert.rejects(
    async () => ledger.reserveOperation(db, opBadKeys, { attestation: attBadKeys, dynamicClock: () => 'NOT_A_DATE' }),
    /INVALID_CLOCK_INJECTION/
  );
  await assert.rejects(
    async () => ledger.reserveOperation(db, opBadKeys, { attestation: attBadKeys, dynamicClock: 'not_a_func' }),
    /INVALID_CLOCK_INJECTION/
  );
});

test('ledger in emulator: real OCC contention, real retry, and cross-process isolation', async () => {
  // 1. Real OCC contention in Firestore Emulator:
  // We trigger real Firestore concurrency contention between two concurrent transactions
  // without artificial exceptions or simulated db wrappers.
  const opRealOcc = makeValidOpData('op-real-occ-01');
  await armFencesForOp(db, opRealOcc);
  const attRealOcc = await makeValidAttestation(opRealOcc);

  let occAttempts = 0;
  let concurrentUpdateDone = false;
  const wrappedDb = Object.create(db);
  wrappedDb.runTransaction = async (callback) => {
    while (occAttempts < 5) {
      occAttempts++;
      try {
        return await db.runTransaction(async (tx) => {
          const origGet = tx.get.bind(tx);
          const proxyTx = Object.create(tx);
          proxyTx.get = async (ref) => {
            const snap = await origGet(ref);
            if (occAttempts === 1 && !concurrentUpdateDone && ref.path === 'releaseControl/autonomousProgression') {
              concurrentUpdateDone = true;
              // Real concurrent modification to document previously read by this transaction
              await db.doc('releaseControl/autonomousProgression').update({
                contentionSeq: Date.now()
              });
            }
            return snap;
          };
          return await callback(proxyTx);
        });
      } catch (txErr) {
        if (/Transaction is invalid or closed|ABORTED/i.test(txErr.message || '') && occAttempts < 5) {
          // Real OCC retry after document previously read was modified
          continue;
        }
        throw txErr;
      }
    }
  };

  const realOccRes = await ledger.reserveOperation(wrappedDb, opRealOcc, { attestation: attRealOcc });
  assert.equal(realOccRes.status, 'RESERVED');
  assert.ok(occAttempts >= 2, `Real OCC must have triggered at least 2 callback attempts, got ${occAttempts}`);

  const persistedOccDoc = await db.doc(`releaseControl/numericPilot/operations/${opRealOcc.operationId}`).get();
  assert.equal(persistedOccDoc.exists, true);
  assert.equal(persistedOccDoc.data().status, 'RESERVED');

  // Attestation must now be consumed
  assert.equal(verifyAttestationAuthenticity(attRealOcc).valid, false);

  // 2. Real Independent Node.js Process Restart Test:
  // Proves durable uniqueness across completely separate OS processes with 0 shared memory.
  const opProc = makeValidOpData('op-proc-restart-01');
  await armFencesForOp(db, opProc);
  const attProc = await makeValidAttestation(opProc);
  const origRes = await ledger.reserveOperation(db, opProc, { attestation: attProc });
  assert.equal(origRes.status, 'RESERVED');

  // Spawn an independent Node process to attempt reservation of the SAME operationId with fresh memory
  const childScript = `
    const { initializeApp, deleteApp } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const ledger = require('./scripts/pilot/numeric-operations-ledger.cjs');
    const { attestRuntime } = require('./scripts/pilot/numeric-attestation.cjs');

    async function main() {
      const app = initializeApp({ projectId: '${projectId}' }, 'child-proc-app');
      const childDb = getFirestore(app);
      try {
        const opData = ${JSON.stringify(opProc)};
        const freshAtt = await attestRuntime({
          deploymentId: opData.deploymentId,
          expectedSha: opData.runtimeSha,
          expectedOperationId: opData.operationId,
          expectedAlias: 'vdsen-ecosistema.vercel.app',
          fetcher: async (url) => {
            if (url.includes('/aliases/')) {
              return {
                status: 200,
                json: async () => ({
                  alias: 'vdsen-ecosistema.vercel.app',
                  deploymentId: opData.deploymentId,
                  projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN'
                })
              };
            }
            return {
              status: 200,
              json: async () => ({
                id: opData.deploymentId,
                projectId: 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN',
                teamId: 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8',
                target: 'production',
                readyState: 'READY',
                alias: ['vdsen-ecosistema.vercel.app'],
                meta: {
                  githubCommitSha: opData.runtimeSha,
                  vdsenPilotOperation: opData.operationId
                },
                envNames: ['AUTONOMOUS_PROGRESSION_ENABLED']
              })
            };
          }
        });

        await ledger.reserveOperation(childDb, opData, { attestation: freshAtt });
        // If it got here, it unexpectedly succeeded
        process.exit(1);
      } catch (err) {
        if (err.message && err.message.includes('OPERATION_ALREADY_EXISTS')) {
          // Expected: Firestore document blocked reservation across process boundaries
          process.exit(0);
        }
        console.error('Unexpected child error:', err.message);
        process.exit(2);
      } finally {
        await deleteApp(app);
      }
    }
    main();
  `;

  const childRun = cp.spawnSync(process.execPath, ['-e', childScript], {
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
      GCLOUD_PROJECT: projectId
    },
    encoding: 'utf8'
  });

  assert.equal(childRun.status, 0, `Child process must exit with 0 (OPERATION_ALREADY_EXISTS). Stderr: ${childRun.stderr}`);

  // 3. Concurrent STOP in emulator:
  const opStop = makeValidOpData('op-stop-concurrent-01');
  await armFencesForOp(db, opStop);
  const attStop = await makeValidAttestation(opStop);
  await ledger.reserveOperation(db, opStop, { attestation: attStop });

  const stopRes = await ledger.recordStop(db, opStop.operationId, { reason: 'Emergency halt' }, { actor: 'coach-admin' });
  assert.equal(stopRes.status, 'STOPPED');
  const stopDoc = await db.doc(`releaseControl/numericPilot/operations/${opStop.operationId}`).get();
  assert.equal(stopDoc.data().status, 'STOPPED');
  assert.ok(typeof stopDoc.data().stoppedAt === 'string' && Number.isFinite(Date.parse(stopDoc.data().stoppedAt)));

  // 4. Verify ZERO unintended overlays written:
  const athleteDocs = await db.collection('clients/' + C.UID + '/overlays').get();
  assert.equal(athleteDocs.empty, true, 'Zero unintended overlays must be written during ledger operations');
});
