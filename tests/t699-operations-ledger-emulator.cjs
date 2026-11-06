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

test('ledger in emulator: exercises all 15 scenarios for operationId ledger', async () => {
  // Ensure releaseControl/numericPilot is armed for reservation tests
  await db.doc('releaseControl/numericPilot').set({ enabled: true });

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
  await assert.rejects(
    () => ledger.reserveOperation(db, op104Data),
    /OPERATION_ALREADY_EXISTS/
  );

  // 2. Consulta directa del operationId (devuelve null si no existe, o doc exacto si existe)
  const lookupFresh = await ledger.checkOperationUniquenessDirect(db, 'op-never-seen-999');
  assert.equal(lookupFresh.exists, false);
  assert.equal(lookupFresh.status, null);

  // 3. Dos reservas concurrentes (concurrencia atómica: exactamente 1 tiene éxito, 1 falla)
  const concurrentOp = makeValidOpData('op-concurrent-test');
  const attempts = await Promise.allSettled([
    ledger.reserveOperation(db, concurrentOp),
    ledger.reserveOperation(db, concurrentOp)
  ]);
  const fulfilled = attempts.filter(a => a.status === 'fulfilled');
  const rejected = attempts.filter(a => a.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'Exactly one concurrent reservation must succeed');
  assert.equal(rejected.length, 1, 'Concurrent duplicate must be rejected');
  assert.match(rejected[0].reason.message, /OPERATION_ALREADY_EXISTS/);

  // 4. Reintento después de reserva
  await assert.rejects(
    () => ledger.reserveOperation(db, concurrentOp),
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
  await db.doc('releaseControl/numericPilot').set({ enabled: false });
  const opDisarmed = makeValidOpData('op-when-disarmed');
  await assert.rejects(
    () => ledger.reserveOperation(db, opDisarmed),
    /RELEASE_CONTROL_DISARMED/
  );
  await db.doc('releaseControl/numericPilot').set({ enabled: true }); // rearm

  // 9. STOP concurrente (idempotencia y sin carreras)
  const opToStop = makeValidOpData('op-to-stop-concurrent');
  await ledger.reserveOperation(db, opToStop);
  const stopResults = await Promise.all([
    ledger.recordStop(db, opToStop.operationId, { reason: 'CONCURRENT_STOP_1' }),
    ledger.recordStop(db, opToStop.operationId, { reason: 'CONCURRENT_STOP_2' })
  ]);
  assert.equal(stopResults[0].status, 'STOPPED');
  assert.equal(stopResults[1].status, 'STOPPED');
  const verifyStopped = await ledger.verifyOperation(db, opToStop.operationId);
  assert.equal(verifyStopped.status, 'STOPPED');

  // 10. Reintento tras STOP
  await assert.rejects(
    () => ledger.recordResult(db, opToStop.operationId, { success: true }),
    /INVALID_STATE_TRANSITION/
  );
  await assert.rejects(
    () => ledger.reserveOperation(db, opToStop),
    /OPERATION_ALREADY_EXISTS/
  );

  // 11. Transiciones de estado inválidas
  const opTransition = makeValidOpData('op-state-transitions');
  await ledger.reserveOperation(db, opTransition);
  await ledger.recordResult(db, opTransition.operationId, { success: true, summary: { applied: 1 } });
  const completedOp = await ledger.verifyOperation(db, opTransition.operationId);
  assert.equal(completedOp.status, 'COMPLETED');

  // COMPLETED -> FAILED is forbidden
  await assert.rejects(
    () => ledger.recordResult(db, opTransition.operationId, { success: false }),
    /INVALID_STATE_TRANSITION/
  );
  // COMPLETED -> RESERVED is forbidden
  await assert.rejects(
    () => ledger.reserveOperation(db, opTransition),
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
  await assert.rejects(
    () => ledger.reserveOperation(simulatedDb, opNetwork),
    /UNAVAILABLE: network connection lost/
  );

  // 14. Recuperación de evidencia desinfectada
  const opEvidence = makeValidOpData('op-evidence-recovery');
  await ledger.reserveOperation(db, opEvidence);
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
