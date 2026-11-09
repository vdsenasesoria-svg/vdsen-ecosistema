'use strict';
// T699 Operational Lane emulator suite: STOP SDK, STOP REST with nested masks & partial failure, and Audit status.
// Synthetic test data only; exercises the real contract against Firestore Emulator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const C = require('../api/_numericPilotContract');
const { executeStop, executeClientRevocation } = require('../scripts/pilot/numeric-stop-recovery.cjs');
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

test('E1 — Carrera RESERVED -> COMPLETED: STOP lee RESERVED pero transaccion concurrente confirma COMPLETED en Firestore Emulator', async () => {
  const coachId = 'synthetic-coach-e1';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const opId = 'op-emu-e1-completed-race';
  const opRef = db.doc('releaseControl/numericPilot/operations/' + opId);

  await coachRef.set({
    name: 'Synthetic Coach E1',
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await numRef.set({ enabled: true, operationId: opId, runtimeSha: 'e1'.repeat(20) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // 1. Pre-seed as RESERVED
  await opRef.set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId,
    status: 'RESERVED',
    uid: C.UID,
    history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
  });

  let firstGetDone = false;
  let concurrentCompleteRan = false;

  // Custom fetcher intercepting REST requests against Firestore Emulator
  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/' + opId);
    const isCommit = url.includes(':commit');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET' && !firstGetDone) {
      firstGetDone = true;
      return globalThis.fetch(url, opts);
    }

    if ((isCommit || isOpDoc) && (method === 'POST' || method === 'PATCH') && !concurrentCompleteRan) {
      concurrentCompleteRan = true;
      // Real concurrent transaction confirms COMPLETED directly on Firestore Emulator,
      // advancing the document's updateTime ahead of the STOP PATCH precondition!
      await opRef.update({
        status: 'COMPLETED',
        completedAt: '2026-11-08T10:05:00Z',
        resultSummary: { success: true, count: 1 },
        history: [
          { sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' },
          { sequence: 2, action: 'COMPLETED', at: '2026-11-08T10:05:00Z' }
        ]
      });
    }

    return globalThis.fetch(url, opts);
  };

  const rep = await executeStopRest(projectId, 'owner', {
    coachId: coachId,
    operationId: opId,
    reason: 'TEST_E1_RACE_COMPLETED'
  }, interceptingFetcher);

  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.ledgerResult.status, 'COMPLETED');
  assert.equal(rep.ledgerResult.modified, false);

  const finalDoc = (await opRef.get()).data();
  assert.equal(finalDoc.status, 'COMPLETED', 'Must retain COMPLETED status despite concurrent STOP attempt');
  assert.equal(finalDoc.completedAt, '2026-11-08T10:05:00Z');
  assert.equal(finalDoc.history.length, 2, 'History must not have STOPPED appended after completion');
  assert.equal(finalDoc.history[1].action, 'COMPLETED');
});

test('E2 — Carrera con historial: STOP lee RESERVED pero transaccion concurrente anexa evento en Firestore Emulator', async () => {
  const coachId = 'synthetic-coach-e2';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const opId = 'op-emu-e2-history-race';
  const opRef = db.doc('releaseControl/numericPilot/operations/' + opId);

  await coachRef.set({
    name: 'Synthetic Coach E2',
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await numRef.set({ enabled: true, operationId: opId, runtimeSha: 'e2'.repeat(20) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  await opRef.set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId,
    status: 'RESERVED',
    appliedRecordKeys: [],
    history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
  });

  let firstGetDone = false;
  let intermediateEventInjected = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/' + opId);
    const isCommit = url.includes(':commit');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET' && !firstGetDone) {
      firstGetDone = true;
      return globalThis.fetch(url, opts);
    }

    if ((isCommit || isOpDoc) && (method === 'POST' || method === 'PATCH') && !intermediateEventInjected) {
      intermediateEventInjected = true;
      // Concurrent actor appends an event directly to Firestore Emulator
      const cur = (await opRef.get()).data();
      await opRef.update({
        appliedRecordKeys: ['rec-01'],
        history: [...cur.history, { sequence: 2, action: 'RECORD_APPLIED', recordKey: 'rec-01', at: '2026-11-08T10:01:00Z' }]
      });
    }

    return globalThis.fetch(url, opts);
  };

  const rep = await executeStopRest(projectId, 'owner', {
    coachId: coachId,
    operationId: opId,
    reason: 'TEST_E2_HISTORY_RACE'
  }, interceptingFetcher);

  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.ledgerResult.status, 'STOPPED');

  const finalDoc = (await opRef.get()).data();
  assert.equal(finalDoc.status, 'STOPPED');
  // History must retain sequence 1 (RESERVED), sequence 2 (RECORD_APPLIED), and sequence 3 (STOPPED)
  assert.equal(finalDoc.history.length, 3, 'Must retain all intermediate events without dropping any');
  assert.equal(finalDoc.history[0].action, 'RESERVED');
  assert.equal(finalDoc.history[1].action, 'RECORD_APPLIED');
  assert.equal(finalDoc.history[2].action, 'STOPPED');
});

test('E3 — Version ausente: GET existente sin updateTime valido no envia PATCH al ledger y termina en STOP_INCOMPLETE', async () => {
  const coachId = 'synthetic-coach-e3';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const opId = 'op-emu-e3-no-updatetime';
  const opRef = db.doc('releaseControl/numericPilot/operations/' + opId);

  await coachRef.set({
    name: 'Synthetic Coach E3',
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await numRef.set({ enabled: true, operationId: opId, runtimeSha: 'e3'.repeat(20) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  await opRef.set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId,
    status: 'RESERVED',
    history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
  });

  let patchSentToLedger = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/' + opId);
    const isCommit = url.includes(':commit');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET') {
      const realRes = await globalThis.fetch(url, opts);
      const text = await realRes.text();
      const json = JSON.parse(text);
      // Strip updateTime to simulate malformed/missing version metadata
      delete json.updateTime;
      return {
        status: 200,
        text: async () => JSON.stringify(json)
      };
    }

    if ((isCommit || isOpDoc) && (method === 'POST' || method === 'PATCH')) {
      patchSentToLedger = true;
    }

    return globalThis.fetch(url, opts);
  };

  const rep = await executeStopRest(projectId, 'owner', {
    coachId: coachId,
    operationId: opId,
    reason: 'TEST_E3_MISSING_VERSION'
  }, interceptingFetcher);

  // Fences are disarmed
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.fencesDisarmed, true);
  // Ledger was NOT modified via PATCH
  assert.equal(patchSentToLedger, false, 'Must never send PATCH to ledger when updateTime is missing');
  assert.equal(rep.ledgerStopped, false);
  assert.equal(rep.allDisarmed, false);
  assert.equal(rep.status, 'STOP_INCOMPLETE');
  assert.equal(rep.ledgerResult.error, 'MISSING_UPDATE_TIME');

  // Verify in Firestore Emulator that the document remained untouched
  const finalDoc = (await opRef.get()).data();
  assert.equal(finalDoc.status, 'RESERVED');
  assert.equal(finalDoc.history.length, 1);
});

test('E4 — Adaptador incompleto: executeStop sin io.recordStop no escribe al ledger y termina en STOP_INCOMPLETE', async () => {
  const coachId = 'synthetic-coach-e4';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const opId = 'op-emu-e4-incomplete-adapter';
  const opRef = db.doc('releaseControl/numericPilot/operations/' + opId);

  await coachRef.set({
    name: 'Synthetic Coach E4',
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await numRef.set({ enabled: true, operationId: opId, runtimeSha: 'e4'.repeat(20) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // Custom adapter with writeFence and readFence, but recordStop explicitly omitted
  let ledgerWriteAttempted = false;
  const baseIo = createEmulatorIo(db);
  const incompleteIo = {
    writeFence: async (path, fields, opts) => {
      if (path.includes('operations')) {
        ledgerWriteAttempted = true;
      }
      return baseIo.writeFence(path, fields, opts);
    },
    readFence: baseIo.readFence
    // recordStop is explicitly omitted!
  };

  const rep = await executeStop({
    coachId: coachId,
    operationId: opId,
    reason: 'TEST_E4_INCOMPLETE_ADAPTER'
  }, incompleteIo);

  // Fences are disarmed and verified
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.fencesDisarmed, true);
  assert.equal(rep.allDisarmed, false);
  assert.equal(rep.ledgerStopped, false);
  assert.equal(rep.status, 'STOP_INCOMPLETE');
  assert.ok(rep.ledgerError.includes('ADAPTER_MISSING_RECORD_STOP'));
  assert.equal(ledgerWriteAttempted, false, 'Must never attempt write to ledger via fallback');

  // Document must not exist in Firestore Emulator
  const finalSnap = await opRef.get();
  assert.equal(finalSnap.exists, false, 'Operation document must not be created without recordStop');
});

test('E5 — STOP simultaneos: dos solicitudes STOP concurrentes transicionan limpiamente e idempotentemente en Firestore Emulator', async () => {
  const coachId = 'synthetic-coach-e5';
  const coachRef = db.doc('coaches/' + coachId);
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const opId = 'op-emu-e5-simultaneous-stop';
  const opRef = db.doc('releaseControl/numericPilot/operations/' + opId);

  await coachRef.set({
    name: 'Synthetic Coach E5',
    autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] }
  });
  await numRef.set({ enabled: true, operationId: opId, runtimeSha: 'e5'.repeat(20) });
  await relRef.set({ enabled: true, clientIds: [C.UID], expiresAt: new Date(Date.now() + 3600000).toISOString() });

  await opRef.set({
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId,
    status: 'RESERVED',
    history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
  });

  // Launch two concurrent executeStopRest calls
  const [rep1, rep2] = await Promise.all([
    executeStopRest(projectId, 'owner', { coachId, operationId: opId, reason: 'STOP_CALL_A' }),
    executeStopRest(projectId, 'owner', { coachId, operationId: opId, reason: 'STOP_CALL_B' })
  ]);

  assert.equal(rep1.status, 'STOP_CONFIRMED');
  assert.equal(rep2.status, 'STOP_CONFIRMED');
  assert.equal(rep1.allDisarmed, true);
  assert.equal(rep2.allDisarmed, true);
  assert.equal(rep1.ledgerStopped, true);
  assert.equal(rep2.ledgerStopped, true);

  // Exactly one of the calls performed modified: true, and the other modified: false (duplicate: true)
  const modifiedCount = (rep1.ledgerResult.modified ? 1 : 0) + (rep2.ledgerResult.modified ? 1 : 0);
  assert.equal(modifiedCount, 1, 'Exactly one concurrent call transitions the document; the other is idempotent');

  const finalDoc = (await opRef.get()).data();
  assert.equal(finalDoc.status, 'STOPPED');
  // History must have sequence 1 (RESERVED) and sequence 2 (STOPPED); NO duplicated STOPPED entry
  assert.equal(finalDoc.history.length, 2, 'History must not contain duplicate STOPPED events');
  assert.equal(finalDoc.history[0].action, 'RESERVED');
  assert.equal(finalDoc.history[1].action, 'STOPPED');
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

test('T708: Multiclient authentic emulator verification: Ayrton and Client B independent full cycles, zero cross-writes, individual revocation, replay idempotency, fail-closed expired window', async () => {
  const io = createEmulatorIo(db);

  const uid1 = 'synthetic-ayrton-708';
  const plan1 = 'meso-ayrton-708';
  const pid1 = 'pid-bench-708';
  const opId1 = 'op-emu-ayrton-708';

  const uid2 = 'synthetic-bravo-708';
  const plan2 = 'meso-bravo-708';
  const pid2 = 'pid-squat-708';
  const opId2 = 'op-emu-bravo-708';

  const coachId = 'coach-multiclient-emu-708';

  const nowSec = Math.floor(Date.now() / 1000) * 1000;
  const startsAt = new Date(nowSec - 60000).toISOString().replace('.000Z', 'Z');
  const expiresAt = new Date(nowSec + 86400000).toISOString().replace('.000Z', 'Z');

  const win1 = {
    schema: 'vdsen-numeric-cohort-v1',
    mode: 'NUMERIC_APPLY',
    uid: uid1,
    planId: plan1,
    pid: pid1,
    operationId: opId1,
    runtimeSha: 'a'.repeat(40),
    startsAt: startsAt,
    expiresAt: expiresAt
  };

  const win2 = {
    schema: 'vdsen-numeric-cohort-v1',
    mode: 'NUMERIC_APPLY',
    uid: uid2,
    planId: plan2,
    pid: pid2,
    operationId: opId2,
    runtimeSha: 'b'.repeat(40),
    startsAt: startsAt,
    expiresAt: expiresAt
  };

  // 1. Pre-seed cohort fences in emulator
  const numRef = db.doc('releaseControl/numericPilot');
  const relRef = db.doc('releaseControl/autonomousProgression');
  const coachRef = db.doc('coaches/' + coachId);

  await numRef.set({
    schema: 'vdsen-numeric-cohort-v1',
    enabled: true,
    windows: {
      [uid1]: { ...win1, enabled: true },
      [uid2]: { ...win2, enabled: true }
    }
  });

  await relRef.set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    clientIds: [uid1, uid2],
    expiresAt: expiresAt
  });

  await coachRef.set({
    name: 'Head Coach Multiclient',
    autoApplyCanary: {
      schema: 'vdsen-canary-cohort-v1',
      enabled: true,
      clientIds: [uid1, uid2],
      prescriptionExerciseIds: [pid1, pid2]
    }
  });

  // 2. Pre-seed durable ledger reservations
  const opRef1 = db.doc('releaseControl/numericPilot/operations/' + opId1);
  const opRef2 = db.doc('releaseControl/numericPilot/operations/' + opId2);

  const ledgerDoc1 = {
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId1,
    status: 'RESERVED',
    uid: uid1,
    planId: plan1,
    pid: pid1,
    runtimeSha: win1.runtimeSha,
    deploymentId: 'dpl_emu_cohort_1',
    runId: 'run-ayrton-708',
    window: win1,
    scope: { enabled: true, clientIds: [uid1], prescriptionExerciseIds: [pid1] },
    appliedRecordKeys: [],
    history: [{ sequence: 1, action: 'RESERVED', at: startsAt, actor: 'test-seed' }]
  };

  const ledgerDoc2 = {
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: opId2,
    status: 'RESERVED',
    uid: uid2,
    planId: plan2,
    pid: pid2,
    runtimeSha: win2.runtimeSha,
    deploymentId: 'dpl_emu_cohort_2',
    runId: 'run-bravo-708',
    window: win2,
    scope: { enabled: true, clientIds: [uid2], prescriptionExerciseIds: [pid2] },
    appliedRecordKeys: [],
    history: [{ sequence: 1, action: 'RESERVED', at: startsAt, actor: 'test-seed' }]
  };

  await opRef1.set(ledgerDoc1);
  await opRef2.set(ledgerDoc2);

  // 3. Pre-seed mesos for both clients
  const mesoRef1 = db.doc('logs/' + uid1 + '/mesos/' + plan1);
  const mesoRef2 = db.doc('logs/' + uid2 + '/mesos/' + plan2);

  const recKey1 = 'rec_ayrton_01';
  const recKey2 = 'rec_bravo_02';

  await mesoRef1.set({
    planId: plan1,
    progressionApplications: {
      [recKey1]: {
        key: recKey1,
        clientId: uid1,
        planId: plan1,
        prescriptionExerciseId: pid1,
        state: 'PENDING',
        revision: 1,
        createdAt: startsAt
      }
    },
    nextExposureOverlays: {},
    consumptionReceipts: {}
  });

  await mesoRef2.set({
    planId: plan2,
    progressionApplications: {
      [recKey2]: {
        key: recKey2,
        clientId: uid2,
        planId: plan2,
        prescriptionExerciseId: pid2,
        state: 'PENDING',
        revision: 1,
        createdAt: startsAt
      }
    },
    nextExposureOverlays: {},
    consumptionReceipts: {}
  });

  // 4. Ayrton progresses: PENDING -> APPLIED
  const ovlKey1 = 'ovl_' + recKey1;
  await mesoRef1.set({
    progressionApplications: {
      [recKey1]: {
        key: recKey1,
        clientId: uid1,
        planId: plan1,
        prescriptionExerciseId: pid1,
        state: 'APPLIED',
        revision: 2,
        updatedAt: new Date().toISOString()
      }
    },
    nextExposureOverlays: {
      [ovlKey1]: {
        key: ovlKey1,
        sourceRecordKey: recKey1,
        status: 'APPLIED',
        dimension: 'LOAD',
        appliedValue: 82.5,
        unit: 'KG',
        clientId: uid1,
        planId: plan1,
        prescriptionExerciseId: pid1
      }
    }
  }, { merge: true });

  await opRef1.update({
    appliedRecordKeys: [recKey1]
  });

  // Ayrton acknowledges and consumes: APPLIED -> CONSUMED
  await mesoRef1.set({
    progressionApplications: {
      [recKey1]: {
        state: 'CONSUMED',
        revision: 3,
        updatedAt: new Date().toISOString()
      }
    },
    nextExposureOverlays: {
      [ovlKey1]: {
        status: 'CONSUMED'
      }
    },
    consumptionReceipts: {
      [recKey1]: {
        recordKey: recKey1,
        overlayKey: ovlKey1,
        provenance: 'CANONICAL_OVERLAY',
        ackAt: new Date().toISOString()
      }
    }
  }, { merge: true });

  // 5. Verify Zero Cross-Tenant Leakage: Client 2's meso document was untouched!
  const snapMeso2Before = (await mesoRef2.get()).data();
  assert.equal(snapMeso2Before.progressionApplications[recKey2].state, 'PENDING');
  assert.deepEqual(snapMeso2Before.nextExposureOverlays, {});
  assert.deepEqual(snapMeso2Before.consumptionReceipts, {});

  // 6. Replay & Idempotency: Re-applying on Ayrton's ledger rejects duplicate record
  const op1DocPost = (await opRef1.get()).data();
  assert.equal(C.ledgerValid(op1DocPost, win1, recKey1), false, 'Already applied record must be rejected for replay');
  assert.equal(C.ledgerValid(op1DocPost, win1, 'fresh-rec-key-99'), true, 'Fresh record key is permitted');

  // 7. Individual Client Revocation: revoke Ayrton without stopping Client 2
  const revReport = await executeClientRevocation({
    clientId: uid1,
    operationId: opId1,
    coachId: coachId,
    reason: 'EMU_TARGETED_REVOCATION'
  }, io);

  assert.equal(revReport.status, 'REVOCATION_CONFIRMED');
  assert.equal(revReport.success, true);

  // Read back fences from emulator
  const savedNum = (await numRef.get()).data();
  assert.equal(savedNum.enabled, true, 'Global numeric pilot must remain enabled');
  assert.equal(savedNum.windows[uid1].enabled, false, 'Ayrton window must be disabled');
  assert.equal(savedNum.windows[uid2].enabled, true, 'Client 2 window must remain enabled');

  const savedRel = (await relRef.get()).data();
  assert.equal(savedRel.enabled, true, 'Global release control must remain enabled');
  assert.deepEqual(savedRel.clientIds, [uid2], 'Only Client 2 must remain in release allowlist');

  const savedCoach = (await coachRef.get()).data();
  assert.equal(savedCoach.autoApplyCanary.enabled, true, 'Coach canary must remain enabled');
  assert.deepEqual(savedCoach.autoApplyCanary.clientIds, [uid2], 'Only Client 2 must remain in coach canary');

  const savedOp1 = (await opRef1.get()).data();
  assert.equal(savedOp1.status, 'STOPPED');

  const savedOp2 = (await opRef2.get()).data();
  assert.equal(savedOp2.status, 'RESERVED', 'Client 2 ledger operation must remain RESERVED');

  // 8. Client 2 progresses independently to CONSUMED
  const ovlKey2 = 'ovl_' + recKey2;
  await mesoRef2.set({
    progressionApplications: {
      [recKey2]: {
        key: recKey2,
        clientId: uid2,
        planId: plan2,
        prescriptionExerciseId: pid2,
        state: 'APPLIED',
        revision: 2,
        updatedAt: new Date().toISOString()
      }
    },
    nextExposureOverlays: {
      [ovlKey2]: {
        key: ovlKey2,
        sourceRecordKey: recKey2,
        status: 'APPLIED',
        dimension: 'LOAD',
        appliedValue: 95,
        unit: 'KG',
        clientId: uid2,
        planId: plan2,
        prescriptionExerciseId: pid2
      }
    }
  }, { merge: true });

  await opRef2.update({ appliedRecordKeys: [recKey2] });

  await mesoRef2.set({
    progressionApplications: {
      [recKey2]: {
        state: 'CONSUMED',
        revision: 3,
        updatedAt: new Date().toISOString()
      }
    },
    nextExposureOverlays: {
      [ovlKey2]: {
        status: 'CONSUMED'
      }
    },
    consumptionReceipts: {
      [recKey2]: {
        recordKey: recKey2,
        overlayKey: ovlKey2,
        provenance: 'CANONICAL_OVERLAY',
        ackAt: new Date().toISOString()
      }
    }
  }, { merge: true });

  // Read back Client 2 final state
  const snapMeso2Final = (await mesoRef2.get()).data();
  assert.equal(snapMeso2Final.progressionApplications[recKey2].state, 'CONSUMED');
  assert.equal(snapMeso2Final.nextExposureOverlays[ovlKey2].status, 'CONSUMED');

  // Verify Ayrton's meso document was untouched by Client 2's operations
  const snapMeso1Final = (await mesoRef1.get()).data();
  assert.equal(snapMeso1Final.progressionApplications[recKey1].state, 'CONSUMED');
  assert.equal(snapMeso1Final.nextExposureOverlays[ovlKey1].status, 'CONSUMED');

  // 9. Fail closed on expired window
  const expiredWin = {
    ...win1,
    expiresAt: new Date(Date.now() - 3600000).toISOString().replace('.000Z', 'Z')
  };
  assert.equal(C.windowValid(expiredWin, Date.now()), false, 'Expired window must fail closed');
});
