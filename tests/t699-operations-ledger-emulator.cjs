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
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const C = require('../api/_numericPilotContract');
const ledger = require('../scripts/pilot/numeric-operations-ledger.cjs');
const { runPreflight } = require('../scripts/pilot/numeric-preflight.cjs');

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

function makeValidAttestation(opData) {
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
    provider: 'vercel'
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
    () => ledger.reserveOperation(db, op104Data, { attestation: makeValidAttestation(op104Data) }),
    /OPERATION_ALREADY_EXISTS/
  );

  // 2. Consulta directa del operationId (devuelve null si no existe, o doc exacto si existe)
  const lookupFresh = await ledger.checkOperationUniquenessDirect(db, 'op-never-seen-999');
  assert.equal(lookupFresh.exists, false);
  assert.equal(lookupFresh.status, null);

  // 3. Dos reservas concurrentes (concurrencia atómica: exactamente 1 tiene éxito, 1 falla)
  const concurrentOp = makeValidOpData('op-concurrent-test');
  await armFencesForOp(db, concurrentOp);
  const attempts = await Promise.allSettled([
    ledger.reserveOperation(db, concurrentOp, { attestation: makeValidAttestation(concurrentOp) }),
    ledger.reserveOperation(db, concurrentOp, { attestation: makeValidAttestation(concurrentOp) })
  ]);
  const fulfilled = attempts.filter(a => a.status === 'fulfilled');
  const rejected = attempts.filter(a => a.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'Exactly one concurrent reservation must succeed');
  assert.equal(rejected.length, 1, 'Concurrent duplicate must be rejected');
  assert.match(rejected[0].reason.message, /OPERATION_ALREADY_EXISTS/);

  // 4. Reintento después de reserva
  await assert.rejects(
    () => ledger.reserveOperation(db, concurrentOp, { attestation: makeValidAttestation(concurrentOp) }),
    /OPERATION_ALREADY_EXISTS/
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
    () => ledger.reserveOperation(db, opDisarmed, { attestation: makeValidAttestation(opDisarmed) }),
    /RELEASE_CONTROL_DISARMED/
  );
  await armFencesForOp(db, opDisarmed); // rearm

  // 8b. Reserva con release general desarmado (releaseControl/autonomousProgression)
  const opGenDisarmed = makeValidOpData('op-gen-disarmed');
  await armFencesForOp(db, opGenDisarmed);
  await db.doc('releaseControl/autonomousProgression').set({ enabled: false });
  await assert.rejects(
    () => ledger.reserveOperation(db, opGenDisarmed, { attestation: makeValidAttestation(opGenDisarmed) }),
    /RELEASE_CONTROL_DISARMED/
  );
  await armFencesForOp(db, opGenDisarmed); // restore

  // 8c. Reserva con Coach Canary desarmado
  const opCanaryDisarmed = makeValidOpData('op-canary-disarmed');
  await armFencesForOp(db, opCanaryDisarmed);
  await db.doc('coaches/synthetic-coach').set({ autoApplyCanary: { enabled: false, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] } });
  await assert.rejects(
    () => ledger.reserveOperation(db, opCanaryDisarmed, { attestation: makeValidAttestation(opCanaryDisarmed) }),
    /COACH_CANARY_DISARMED/
  );
  await armFencesForOp(db, opCanaryDisarmed); // restore

  // 9. STOP concurrente (idempotencia y sin carreras)
  const opToStop = makeValidOpData('op-to-stop-concurrent');
  await armFencesForOp(db, opToStop);
  await ledger.reserveOperation(db, opToStop, { attestation: makeValidAttestation(opToStop) });
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
    () => ledger.reserveOperation(db, opToStop, { attestation: makeValidAttestation(opToStop) }),
    /OPERATION_ALREADY_EXISTS/
  );

  // 11. Transiciones de estado inválidas y STOP terminal
  const opTransition = makeValidOpData('op-state-transitions');
  await armFencesForOp(db, opTransition);
  await ledger.reserveOperation(db, opTransition, { attestation: makeValidAttestation(opTransition) });
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
  await ledger.reserveOperation(db, opFailed, { attestation: makeValidAttestation(opFailed) });
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
    () => ledger.reserveOperation(db, opTransition, { attestation: makeValidAttestation(opTransition) }),
    /OPERATION_ALREADY_EXISTS/
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
    () => ledger.reserveOperation(simulatedDb, opNetwork, { attestation: makeValidAttestation(opNetwork) }),
    /UNAVAILABLE: network connection lost/
  );

  // 14. Recuperación de evidencia desinfectada
  const opEvidence = makeValidOpData('op-evidence-recovery');
  await armFencesForOp(db, opEvidence);
  await ledger.reserveOperation(db, opEvidence, { attestation: makeValidAttestation(opEvidence) });
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
    () => ledger.reserveOperation(db, op1, { attestation: makeValidAttestation(op1) }),
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
    () => ledger.reserveOperation(db, op2, { attestation: makeValidAttestation(op2) }),
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
    () => ledger.reserveOperation(db, op3, { attestation: makeValidAttestation(op3) }),
    /FENCE_FIELD_MISSING/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op3.operationId}`).get()).exists, false, 'op3 must not persist reservation');

  // 4. Release general ausente (releaseControl/autonomousProgression)
  const op4 = makeValidOpData('op-neg-no-auto-release');
  await armFencesForOp(db, op4);
  await db.doc('releaseControl/autonomousProgression').delete();
  await assert.rejects(
    () => ledger.reserveOperation(db, op4, { attestation: makeValidAttestation(op4) }),
    /RELEASE_CONTROL_DISARMED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op4.operationId}`).get()).exists, false, 'op4 must not persist reservation');

  // 5. Release general desactivado
  const op5 = makeValidOpData('op-neg-auto-release-disabled');
  await armFencesForOp(db, op5);
  await db.doc('releaseControl/autonomousProgression').update({ enabled: false });
  await assert.rejects(
    () => ledger.reserveOperation(db, op5, { attestation: makeValidAttestation(op5) }),
    /RELEASE_CONTROL_DISARMED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op5.operationId}`).get()).exists, false, 'op5 must not persist reservation');

  // 6. Coach inexistente
  const op6 = makeValidOpData('op-neg-coach-not-found');
  await armFencesForOp(db, op6);
  await db.doc('clients/' + op6.uid).update({ coachId: 'non-existent-coach-id' });
  await assert.rejects(
    () => ledger.reserveOperation(db, op6, { attestation: makeValidAttestation(op6) }),
    /COACH_NOT_FOUND/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op6.operationId}`).get()).exists, false, 'op6 must not persist reservation');

  // 7. Canary inexistente
  const op7 = makeValidOpData('op-neg-canary-not-found');
  await armFencesForOp(db, op7);
  await db.doc('coaches/synthetic-coach').set({ name: 'Coach Without Canary Field' });
  await assert.rejects(
    () => ledger.reserveOperation(db, op7, { attestation: makeValidAttestation(op7) }),
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
    () => ledger.reserveOperation(db, op8, { attestation: makeValidAttestation(op8) }),
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
    () => ledger.reserveOperation(db, op9a, { attestation: makeValidAttestation(op9a) }),
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
    () => ledger.reserveOperation(db, op9b, { attestation: makeValidAttestation(op9b) }),
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
    () => ledger.reserveOperation(db, op9c, { attestation: makeValidAttestation(op9c) }),
    /COACH_CANARY_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op9c.operationId}`).get()).exists, false, 'op9c must not persist reservation');

  // 10. Plan activo sustituido
  const op10 = makeValidOpData('op-neg-plan-substituted');
  await armFencesForOp(db, op10);
  await db.doc('clients/' + op10.uid).update({ activePlanId: 'substituted-plan-id' });
  await assert.rejects(
    () => ledger.reserveOperation(db, op10, { attestation: makeValidAttestation(op10) }),
    /PLAN_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op10.operationId}`).get()).exists, false, 'op10 must not persist reservation');

  // 11. CoachId no acreditado / ausente en cliente
  const op11 = makeValidOpData('op-neg-coach-not-accredited');
  await armFencesForOp(db, op11);
  await db.doc('clients/' + op11.uid).update({ coachId: '' });
  await assert.rejects(
    () => ledger.reserveOperation(db, op11, { attestation: makeValidAttestation(op11) }),
    /COACH_NOT_AUTHORIZED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op11.operationId}`).get()).exists, false, 'op11 must not persist reservation');

  // 12. Attestation ausente
  const op12 = makeValidOpData('op-neg-no-attestation');
  await armFencesForOp(db, op12);
  await assert.rejects(
    () => ledger.reserveOperation(db, op12),
    /ATTESTATION_MISSING/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op12.operationId}`).get()).exists, false, 'op12 must not persist reservation');

  // 13. Attestation falsificada
  // 13a. Falsified deploymentId:
  const op13a = makeValidOpData('op-neg-fake-dpl-attestation');
  await armFencesForOp(db, op13a);
  const fakeDplAtt = { ...makeValidAttestation(op13a), deploymentId: 'dpl_forged_fake_01' };
  await assert.rejects(
    () => ledger.reserveOperation(db, op13a, { attestation: fakeDplAtt }),
    /ATTESTATION_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13a.operationId}`).get()).exists, false, 'op13a must not persist reservation');

  // 13b. Falsified sha:
  const op13b = makeValidOpData('op-neg-fake-sha-attestation');
  await armFencesForOp(db, op13b);
  const fakeShaAtt = { ...makeValidAttestation(op13b), runtimeSha: 'f'.repeat(40) };
  await assert.rejects(
    () => ledger.reserveOperation(db, op13b, { attestation: fakeShaAtt }),
    /ATTESTATION_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13b.operationId}`).get()).exists, false, 'op13b must not persist reservation');

  // 13c. Caller provides only attested: true boolean without accredited fields:
  const op13c = makeValidOpData('op-neg-only-bool-attestation');
  await armFencesForOp(db, op13c);
  await assert.rejects(
    () => ledger.reserveOperation(db, op13c, { attestation: { attested: true } }),
    /ATTESTATION_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13c.operationId}`).get()).exists, false, 'op13c must not persist reservation');

  // 13d. attested: false:
  const op13d = makeValidOpData('op-neg-rejected-attestation');
  await armFencesForOp(db, op13d);
  await assert.rejects(
    () => ledger.reserveOperation(db, op13d, { attestation: { ...makeValidAttestation(op13d), attested: false } }),
    /ATTESTATION_REJECTED/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op13d.operationId}`).get()).exists, false, 'op13d must not persist reservation');

  // 14. Identidad de ventana distinta de la reserva
  const op14 = makeValidOpData('op-neg-window-id-mismatch');
  await armFencesForOp(db, op14);
  op14.window.operationId = 'op-different-window-id';
  await assert.rejects(
    () => ledger.reserveOperation(db, op14, { attestation: makeValidAttestation(op14) }),
    /IDENTITY_MISMATCH/
  );
  assert.equal((await db.doc(`releaseControl/numericPilot/operations/${op14.operationId}`).get()).exists, false, 'op14 must not persist reservation');
});
