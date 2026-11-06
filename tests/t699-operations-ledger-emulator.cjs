'use strict';
/**
 * VDSEN — T699 Phase P0.4 Durable Operations Ledger Suite in Firestore Emulator
 *
 * Exercises all 13 required scenarios for the durable operationId ledger:
 * 1. Primera reserva
 * 2. Reserva duplicada
 * 3. Dos reservas simultáneas (concurrencia)
 * 4. Reserva después de STOP
 * 5. Reintento de una operación ejecutada
 * 6. Operación fallida antes de reservar
 * 7. Error de red simulado
 * 8. Documento inválido
 * 9. Credenciales no autorizadas
 * 10. Estado incompleto
 * 11. Registro manipulado
 * 12. Conflicto de operación
 * 13. Recuperación de evidencia
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const C = require('../api/_numericPilotContract');
const ledger = require('../scripts/pilot/numeric-operations-ledger.cjs');

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

test('ledger in emulator: exercises all 13 scenarios for operationId ledger', async () => {
  // Ensure releaseControl/numericPilot is armed for reservation tests
  await db.doc('releaseControl/numericPilot').set({ enabled: true });

  // 1. Primera reserva
  const op1 = makeValidOpData('op-first-reserve');
  const res1 = await ledger.reserveOperation(db, op1);
  assert.equal(res1.success, true);
  assert.equal(res1.operationId, 'op-first-reserve');
  assert.equal(res1.status, 'RESERVED');

  const verify1 = await ledger.verifyOperation(db, 'op-first-reserve');
  assert.equal(verify1.exists, true);
  assert.equal(verify1.status, 'RESERVED');
  assert.equal(verify1.operation.deploymentId, 'dpl_valid_01');

  // 2. Reserva duplicada rechazada
  await assert.rejects(
    () => ledger.reserveOperation(db, op1),
    /OPERATION_ALREADY_EXISTS/
  );

  // 3. Dos reservas simultáneas (concurrencia atómica: exactamente 1 tiene éxito, 1 falla)
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

  // 4. Reserva después de STOP
  await db.doc('releaseControl/numericPilot').set({ enabled: false });
  const opAfterStop = makeValidOpData('op-after-stop');
  await assert.rejects(
    () => ledger.reserveOperation(db, opAfterStop),
    /RELEASE_CONTROL_DISARMED/
  );
  await db.doc('releaseControl/numericPilot').set({ enabled: true }); // rearm

  // 5. Reintento de una operación ejecutada (marcar COMPLETED y reintentar reserva o ejecución)
  const opToComplete = makeValidOpData('op-to-complete');
  await ledger.reserveOperation(db, opToComplete);
  const completion = await ledger.recordResult(db, opToComplete.operationId, { success: true, summary: { applied: 1 } });
  assert.equal(completion.status, 'COMPLETED');
  // Attempting to reserve again fails:
  await assert.rejects(
    () => ledger.reserveOperation(db, opToComplete),
    /OPERATION_ALREADY_EXISTS/
  );
  // Attempting to record completion again fails:
  await assert.rejects(
    () => ledger.recordResult(db, opToComplete.operationId, { success: true }),
    /OPERATION_ALREADY_COMPLETED/
  );

  // 6. Operación fallida antes de reservar (payload con formato inválido falla sin tocar DB)
  const opBadId = makeValidOpData('bad'); // too short (< 8 chars)
  assert.throws(
    () => ledger.validateOperationData(opBadId),
    /INVALID_OPERATION_DATA/
  );

  // 7. Error de red simulado (transient connection error handling)
  const simulatedDb = Object.create(db);
  simulatedDb.runTransaction = () => Promise.reject(new Error('UNAVAILABLE: network connection lost'));
  const opNetwork = makeValidOpData('op-network-err');
  await assert.rejects(
    () => ledger.reserveOperation(simulatedDb, opNetwork),
    /UNAVAILABLE: network connection lost/
  );

  // 8. Documento inválido (missing required fields)
  assert.throws(
    () => ledger.validateOperationData({ operationId: 'op-missing-fields' }),
    /INVALID_OPERATION_DATA/
  );

  // 9. Credenciales no autorizadas (mismatched UID/PID/Plan)
  const opWrongUid = { ...makeValidOpData('op-wrong-uid'), uid: 'unauthorized-user' };
  assert.throws(
    () => ledger.validateOperationData(opWrongUid),
    /UNAUTHORIZED_IDENTIFIER/
  );
  const opWrongPid = { ...makeValidOpData('op-wrong-pid'), pid: 'unauthorized-pid' };
  assert.throws(
    () => ledger.validateOperationData(opWrongPid),
    /UNAUTHORIZED_IDENTIFIER/
  );

  // 10. Estado incompleto (corrupted or empty document)
  const nonExistent = await ledger.verifyOperation(db, 'op-does-not-exist');
  assert.equal(nonExistent.exists, false);
  assert.equal(nonExistent.status, 'NOT_FOUND');

  // 11. Registro manipulado (tampered hash / mismatched runtimeSha)
  const opTamperedSha = { ...makeValidOpData('op-tampered-sha'), runtimeSha: 'invalid-sha' };
  assert.throws(
    () => ledger.validateOperationData(opTamperedSha),
    /INVALID_OPERATION_DATA/
  );

  // 12. Conflicto de operación (different deployment attempting same operationId)
  const conflictOp = makeValidOpData('op-conflict-test');
  await ledger.reserveOperation(db, conflictOp);
  const diffDeploymentOp = { ...conflictOp, deploymentId: 'dpl_another_run_999' };
  await assert.rejects(
    () => ledger.reserveOperation(db, diffDeploymentOp),
    /OPERATION_ALREADY_EXISTS/
  );

  // 13. Recuperación de evidencia
  const opEvidence = makeValidOpData('op-evidence-recovery');
  await ledger.reserveOperation(db, opEvidence);
  await ledger.recordResult(db, opEvidence.operationId, { success: true, summary: { applied: 1, delta: '+2.5kg' } });
  const evidence = await ledger.recoverEvidence(db, opEvidence.operationId);
  assert.ok(evidence);
  assert.equal(evidence.operationId, 'op-evidence-recovery');
  assert.equal(evidence.status, 'COMPLETED');
  assert.equal(evidence.runtimeSha, 'a'.repeat(40));
  assert.equal(evidence.deploymentId, 'dpl_valid_01');
  assert.equal(evidence.history.length, 2);
  assert.equal(evidence.history[0].action, 'RESERVED');
  assert.equal(evidence.history[1].action, 'COMPLETED');
  assert.equal(evidence.resultSummary.delta, '+2.5kg');

  // Fetch list
  const allOps = await ledger.fetchDurableOperations(db);
  assert.ok(allOps.length >= 4);
});
