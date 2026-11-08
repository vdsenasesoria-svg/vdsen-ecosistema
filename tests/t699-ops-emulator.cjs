'use strict';
// T699 Operational Lane emulator suite: STOP SDK, STOP REST with nested masks & partial failure, and Audit status.
// Synthetic test data only; exercises the real contract against Firestore Emulator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const C = require('../api/_numericPilotContract');
const { executeStop } = require('../scripts/pilot/numeric-stop-recovery.cjs');
const { createEmulatorIo, executeStopRest, executeAuditStatus } = require('../scripts/pilot/numeric-pilot-ops.cjs');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'emulator required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = initializeApp({ projectId }, 't699-ops-emulator');
const db = getFirestore(app);
test.after(() => deleteApp(app));

test('real STOP in emulator: disarms autoApplyCanary.enabled preserving coach profile, clientIds and PIDs', async () => {
  const coachId = 'synthetic-coach-emulator-stop';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');

  // 1. Pre-seed Coach with autoApplyCanary.enabled=true, clientIds, PIDs, and extra profile fields
  const initialCoachData = {
    name: 'Synthetic Head Coach',
    activeClients: 12,
    specialization: 'Powerlifting',
    equipmentIncrements: { barbell: 2.5, dumbbell: 2 },
    autoApplyCanary: {
      enabled: true,
      clientIds: [C.UID],
      prescriptionExerciseIds: [C.PID]
    }
  };
  await coachRef.set(initialCoachData);
  await numRef.set({ enabled: true, operationId: 'op-emu-stop-01', runtimeSha: 'a'.repeat(40) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  const io = createEmulatorIo(db);

  // 2. Execute STOP
  const rep = await executeStop({
    coachId: coachId,
    operationId: 'op-emu-stop-01',
    reason: 'EMULATOR_SAFETY_STOP_TEST'
  }, io);

  // 3. Confirm report
  assert.equal(rep.schema, 'vdsen-numeric-stop-v1');
  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.coachFieldsPreserved, true);

  // 4. Read back Coach document directly from emulator
  const savedCoach = (await coachRef.get()).data();
  assert.equal(savedCoach.autoApplyCanary.enabled, false);
  assert.deepEqual(savedCoach.autoApplyCanary.clientIds, [C.UID]);
  assert.deepEqual(savedCoach.autoApplyCanary.prescriptionExerciseIds, [C.PID]);
  assert.equal(savedCoach.name, 'Synthetic Head Coach');
  assert.equal(savedCoach.activeClients, 12);
  assert.equal(savedCoach.specialization, 'Powerlifting');
  assert.deepEqual(savedCoach.equipmentIncrements, { barbell: 2.5, dumbbell: 2 });

  // 5. Read back the other two fences
  const savedNum = (await numRef.get()).data();
  assert.equal(savedNum.enabled, false);
  assert.equal(savedNum.stoppedOperation, 'op-emu-stop-01');

  const savedRel = (await relRef.get()).data();
  assert.equal(savedRel.enabled, false);

  // 6. Partial failure test
  // Force a failure on autonomousProgression write
  const failingIo = {
    writeFence: async (docPath, fields, opts) => {
      if (docPath === 'releaseControl/autonomousProgression') {
        throw new Error('SYNTHETIC_EMULATOR_WRITE_TIMEOUT');
      }
      return io.writeFence(docPath, fields, opts);
    },
    readFence: io.readFence
  };

  // Re-enable fences
  await numRef.set({ enabled: true });
  await relRef.set({ enabled: true });
  await coachRef.set({ ...initialCoachData, autoApplyCanary: { ...initialCoachData.autoApplyCanary, enabled: true } });

  const repPartial = await executeStop({
    coachId: coachId,
    operationId: 'op-emu-partial',
    reason: 'EMULATOR_PARTIAL_FAILURE_TEST'
  }, failingIo);

  assert.equal(repPartial.status, 'STOP_INCOMPLETE');
  assert.equal(repPartial.allDisarmed, false);
  assert.equal(repPartial.primaryFenceDisarmed, true);
  assert.ok(repPartial.errors.some(e => e.includes('SYNTHETIC_EMULATOR_WRITE_TIMEOUT')));
});

test('real STOP REST in emulator: executeStopRest disarms autoApplyCanary.enabled via HTTP REST preserving coach profile, clientIds and PIDs, and handles partial failures', async () => {
  const coachId = 'synthetic-coach-rest-stop';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');

  // 1. Pre-seed Coach with autoApplyCanary.enabled=true, clientIds, PIDs, and profile data
  const initialCoachData = {
    name: 'Synthetic REST Coach',
    activeClients: 14,
    specialization: 'Powerlifting',
    equipmentIncrements: { barbell: 2.5, dumbbell: 2 },
    autoApplyCanary: {
      enabled: true,
      clientIds: [C.UID],
      prescriptionExerciseIds: [C.PID]
    }
  };
  await coachRef.set(initialCoachData);
  await numRef.set({ enabled: true, operationId: 'op-rest-stop-01', runtimeSha: 'b'.repeat(40) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // 2. Execute STOP via HTTP REST against the Firestore Emulator
  const rep = await executeStopRest(projectId, 'owner', {
    coachId: coachId,
    operationId: 'op-rest-stop-01',
    reason: 'EMULATOR_REST_STOP_TEST'
  });

  // 3. Confirm stop report
  assert.equal(rep.schema, 'vdsen-numeric-stop-v1');
  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.coachFieldsPreserved, true);

  // 4. Verify Coach document directly in emulator: nested autoApplyCanary.enabled is false, profile preserved
  const savedCoach = (await coachRef.get()).data();
  assert.equal(savedCoach.autoApplyCanary.enabled, false);
  assert.deepEqual(savedCoach.autoApplyCanary.clientIds, [C.UID]);
  assert.deepEqual(savedCoach.autoApplyCanary.prescriptionExerciseIds, [C.PID]);
  assert.equal(savedCoach.name, 'Synthetic REST Coach');
  assert.equal(savedCoach.activeClients, 14);
  assert.equal(savedCoach.specialization, 'Powerlifting');
  assert.deepEqual(savedCoach.equipmentIncrements, { barbell: 2.5, dumbbell: 2 });

  // 5. Verify other fences were disarmed via REST
  const savedNum = (await numRef.get()).data();
  assert.equal(savedNum.enabled, false);
  assert.equal(savedNum.stoppedOperation, 'op-rest-stop-01');

  const savedRel = (await relRef.get()).data();
  assert.equal(savedRel.enabled, false);

  // 6. Partial failure test via HTTP REST
  // Re-enable fences
  await numRef.set({ enabled: true });
  await relRef.set({ enabled: true });
  await coachRef.set({ ...initialCoachData, autoApplyCanary: { ...initialCoachData.autoApplyCanary, enabled: true } });

  // Custom fetcher that fails on autonomousProgression HTTP PATCH
  const failingFetcher = async (url, fetchOpts) => {
    if (url.includes('releaseControl/autonomousProgression')) {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error: simulated write timeout on releaseControl'
      };
    }
    return globalThis.fetch(url, fetchOpts);
  };

  const repPartial = await executeStopRest(projectId, 'owner', {
    coachId: coachId,
    operationId: 'op-rest-partial',
    reason: 'EMULATOR_REST_PARTIAL_FAILURE_TEST'
  }, failingFetcher);

  assert.equal(repPartial.status, 'STOP_INCOMPLETE');
  assert.equal(repPartial.allDisarmed, false);
  assert.equal(repPartial.primaryFenceDisarmed, true);
  assert.ok(repPartial.errors.some(e => e.includes('WRITE_FENCE_FAILED_500')));

  // Primary fence (Coach canary) must be disarmed even on downstream partial failure
  const coachAfterPartial = (await coachRef.get()).data();
  assert.equal(coachAfterPartial.autoApplyCanary.enabled, false);
  assert.equal(coachAfterPartial.name, 'Synthetic REST Coach');
});

test('real STOP REST OCC in emulator: preserves concurrent COMPLETED operation in durable ledger without overwrite', async () => {
  const coachId = 'synthetic-coach-occ';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const opId = 'op-emu-occ-completed';
  const opRef = db.doc('releaseControl/numericPilot/operations/' + opId);

  await coachRef.set({
    name: 'Synthetic OCC Coach',
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await numRef.set({ enabled: true, operationId: opId, runtimeSha: 'c'.repeat(40) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // Pre-seed operation as COMPLETED
  await opRef.set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId,
    status: 'COMPLETED',
    completedAt: '2026-11-08T10:00:00Z',
    resultSummary: { success: true, count: 1 },
    history: [{ sequence: 1, action: 'RESERVED' }, { sequence: 2, action: 'COMPLETED' }]
  });

  const rep = await executeStopRest(projectId, 'owner', {
    coachId: coachId,
    operationId: opId,
    reason: 'TEST_OCC_TERMINAL_PRESERVATION'
  });

  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.ledgerResult.status, 'COMPLETED');
  assert.equal(rep.ledgerResult.modified, false);

  const finalDoc = (await opRef.get()).data();
  assert.equal(finalDoc.status, 'COMPLETED');
  assert.equal(finalDoc.completedAt, '2026-11-08T10:00:00Z');
  assert.equal(finalDoc.history.length, 2);
});

test('real audit in emulator: validates logs/{uid}/mesos/{planId} and returns BLOCKED on missing doc or read error', async () => {
  const mesoRef = db.doc('logs/' + C.UID + '/mesos/' + C.PLAN);

  // 1. Documento válido
  const validMeso = {
    planId: C.PLAN,
    progressionApplications: {
      app_01: { prescriptionExerciseId: C.PID, state: 'APPLIED', calculatedAt: '2026-11-06T10:00:00Z' }
    },
    nextExposureOverlays: {
      ov_01: { sourceRecordKey: 'app_01', status: 'APPLIED', dimension: 'load' }
    },
    consumptionReceipts: {}
  };
  await mesoRef.set(validMeso);

  const repValid = await executeAuditStatus({ pilotUid: C.UID, planId: C.PLAN, db });
  assert.equal(repValid.status, 'AUDIT_SUCCESS');
  assert.equal(repValid.isConsistent, true);
  assert.equal(repValid.path, 'logs/' + C.UID + '/mesos/' + C.PLAN);

  // 2. Overlay huérfano
  const orphanMeso = {
    planId: C.PLAN,
    progressionApplications: {},
    nextExposureOverlays: {
      ov_orphan: { sourceRecordKey: 'non_existent_key', status: 'APPLIED' }
    }
  };
  await mesoRef.set(orphanMeso);
  const repOrphan = await executeAuditStatus({ pilotUid: C.UID, planId: C.PLAN, db });
  assert.equal(repOrphan.status, 'AUDIT_INCONSISTENT');
  assert.equal(repOrphan.isConsistent, false);
  assert.equal(repOrphan.classified.orphanedOverlays.length, 1);

  // 3. Registro inconsistente (PID fuera de alcance)
  const foreignPidMeso = {
    planId: C.PLAN,
    progressionApplications: {
      app_foreign: { prescriptionExerciseId: 'foreign-pid-999', state: 'PENDING' }
    },
    nextExposureOverlays: {}
  };
  await mesoRef.set(foreignPidMeso);
  const repForeign = await executeAuditStatus({ pilotUid: C.UID, planId: C.PLAN, db });
  assert.equal(repForeign.status, 'AUDIT_INCONSISTENT');
  assert.equal(repForeign.isConsistent, false);
  assert.equal(repForeign.classified.outOfScopePids.length, 1);

  // 4. Documento ausente
  await mesoRef.delete();
  const repMissing = await executeAuditStatus({ pilotUid: C.UID, planId: C.PLAN, db });
  assert.equal(repMissing.status, 'BLOCKED');
  assert.equal(repMissing.reason, 'MESO_DOCUMENT_NOT_FOUND');
  assert.equal(repMissing.isConsistent, false);

  // 5. Error de lectura (adapter error)
  const failingIo = {
    readDoc: async () => {
      throw new Error('SYNTHETIC_READ_ERROR_ON_MESO');
    }
  };
  const repErr = await executeAuditStatus({ pilotUid: C.UID, planId: C.PLAN }, failingIo);
  assert.equal(repErr.status, 'BLOCKED');
  assert.equal(repErr.reason, 'MESO_READ_ERROR');
  assert.equal(repErr.isConsistent, false);
});
