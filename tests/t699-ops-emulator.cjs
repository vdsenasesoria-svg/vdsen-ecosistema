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
const { reserveOperation } = require('../scripts/pilot/numeric-operations-ledger.cjs');
const { attestRuntime } = require('../scripts/pilot/numeric-attestation.cjs');
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription');
const consumer = require('../assets/progression-application-consumer');
const F = require('./helpers/lifecycle-fixture');

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

function createMockFetcher(opData) {
  return async (url) => {
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
      json: async () => deploymentObj
    };
  };
}

function webTx(tx) {
  return {
    get: async (ref) => {
      const s = await tx.get(ref);
      return {
        exists: () => s.exists === true,
        data: () => s.data(),
        updateTime: () => {
          const t = s.updateTime;
          return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
        }
      };
    },
    set: (ref, data, opts) => opts ? tx.set(ref, data, opts) : tx.set(ref, data)
  };
}

async function makeValidAttestation(opData, now) {
  return await attestRuntime({
    cohort: opData.window && opData.window.schema === 'vdsen-numeric-cohort-v1',
    schema: opData.window && opData.window.schema,
    deploymentId: opData.deploymentId,
    expectedSha: opData.runtimeSha,
    expectedOperationId: opData.operationId,
    expectedAlias: 'vdsen-ecosistema.vercel.app',
    expectedUid: opData.uid,
    expectedPlanId: opData.planId,
    expectedPid: opData.pid,
    fetcher: createMockFetcher(opData),
    now
  });
}

test('T709: Multiclient authentic emulator verification: Ayrton and Client B 8-step canonical cycle, concurrent revocation safety, zero cross-writes, replay idempotency, fail-closed expired window', async () => {
  const io = createEmulatorIo(db);

  const uid1 = 'synthetic-ayrton-709';
  const plan1 = 'meso-ayrton-709';
  const pid1 = 'pid-bench-709';
  const opId1 = 'op-emu-ayrton-709';
  const sha = 'a'.repeat(40);

  const uid2 = 'synthetic-bravo-709';
  const plan2 = 'meso-bravo-709';
  const pid2 = 'pid-squat-709';
  const opId2 = 'op-emu-bravo-709';

  const coachId = 'coach-multiclient-emu-709';

  const sc1 = F.scenario({ pid: pid1, clientId: uid1, planId: plan1 });
  const sc2 = F.scenario({ pid: pid2, clientId: uid2, planId: plan2 });

  // 1. Coach prescribes and activates base plans first so serverPlanUpdatedAt is strictly prior to evidence calculation
  await db.doc('coaches/' + coachId).set({
    name: 'Head Coach Multiclient',
    autoApplyCanary: {
      schema: 'vdsen-canary-cohort-v1',
      enabled: true,
      clientIds: [uid1, uid2],
      prescriptionExerciseIds: [pid1, pid2]
    }
  });

  await db.doc('clients/' + uid1).set({ coachId, activePlanId: plan1, coachInterventions: [] });
  await db.doc('clients/' + uid2).set({ coachId, activePlanId: plan2, coachInterventions: [] });

  await db.doc('plans/' + plan1).set(Object.assign({}, sc1.plan, { coachId, status: 'active' }));
  await db.doc('plans/' + plan2).set(Object.assign({}, sc2.plan, { coachId, status: 'active' }));

  // Ensure serverPlanUpdatedAt committed on Firestore clock is strictly prior to calculation timestamp
  await new Promise(r => setTimeout(r, 1100));

  const nowSec = Math.floor(Date.now() / 1000) * 1000;
  const startsAt = new Date(nowSec).toISOString().replace('.000Z', 'Z');
  const expiresAt = new Date(nowSec + 3600000).toISOString().replace('.000Z', 'Z');

  const win1 = {
    schema: 'vdsen-numeric-cohort-v1',
    mode: 'NUMERIC_APPLY',
    uid: uid1,
    coachId: coachId,
    planId: plan1,
    pid: pid1,
    operationId: opId1,
    runtimeSha: sha,
    startsAt: startsAt,
    expiresAt: expiresAt
  };

  const win2 = {
    schema: 'vdsen-numeric-cohort-v1',
    mode: 'NUMERIC_APPLY',
    uid: uid2,
    coachId: coachId,
    planId: plan2,
    pid: pid2,
    operationId: opId2,
    runtimeSha: sha,
    startsAt: startsAt,
    expiresAt: expiresAt
  };

  const env = {
    AUTONOMOUS_PROGRESSION_ENABLED: 'true',
    AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_RUNTIME_SHA: sha,
    VDSEN_NUMERIC_COHORT_WINDOWS: JSON.stringify([win1, win2])
  };
  const prevEnv = Object.keys(env).map(k => [k, process.env[k]]);
  Object.assign(process.env, env);
  delete process.env.CRON_SECRET;

  try {
    const evidence1 = structuredClone(sc1.entries);
    evidence1.progrec_1_2 = {
      calculatedAt: startsAt,
      recommendations: [{
        prescriptionExerciseId: pid1,
        exerciseId: sc1.exerciseId,
        exerciseName: 'Bench Press',
        action: 'increase_load',
        newLoad: 5,
        newReps: 10
      }]
    };

    const evidence2 = structuredClone(sc2.entries);
    evidence2.progrec_1_2 = {
      calculatedAt: startsAt,
      recommendations: [{
        prescriptionExerciseId: pid2,
        exerciseId: sc2.exerciseId,
        exerciseName: 'Squat',
        action: 'increase_load',
        newLoad: 5,
        newReps: 10
      }]
    };

    await db.doc('releaseControl/numericPilot').set({
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: {
        [uid1]: { ...win1, enabled: true },
        [uid2]: { ...win2, enabled: true }
      }
    });

    await db.doc('releaseControl/autonomousProgression').set({
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [uid1, uid2],
      expiresAt: expiresAt
    });

    // 2. Client generates valid evidence
    await db.doc('logs/' + uid1).set({ planId: plan1, entries: evidence1 });
    await db.doc('logs/' + uid2).set({ planId: plan2, entries: evidence2 });

    await db.doc('logs/' + uid1 + '/mesos/' + plan1).set({
      planId: plan1,
      entries: evidence1,
      progressionApplications: {},
      nextExposureOverlays: {},
      consumptionReceipts: {}
    });

    await db.doc('logs/' + uid2 + '/mesos/' + plan2).set({
      planId: plan2,
      entries: evidence2,
      progressionApplications: {},
      nextExposureOverlays: {},
      consumptionReceipts: {}
    });

    // 3. Motor materializes PENDING via canonical handler
    const mat1 = await executor.materialize(db, uid1, plan1, () => startsAt);
    assert.equal(mat1.status, 'MATERIALIZED');
    const meso1PostMat = (await db.doc('logs/' + uid1 + '/mesos/' + plan1).get()).data();
    const recs1 = Object.values(meso1PostMat.progressionApplications || {});
    assert.equal(recs1.length, 1);
    assert.equal(recs1[0].state, 'PENDING');
    assert.equal(recs1[0].prescriptionExerciseId, pid1);
    const ayrtonRecKey = recs1[0].key;

    const mat2 = await executor.materialize(db, uid2, plan2, () => startsAt);
    assert.equal(mat2.status, 'MATERIALIZED');
    const meso2PostMat = (await db.doc('logs/' + uid2 + '/mesos/' + plan2).get()).data();
    const recs2 = Object.values(meso2PostMat.progressionApplications || {});
    assert.equal(recs2.length, 1);
    assert.equal(recs2[0].state, 'PENDING');
    assert.equal(recs2[0].prescriptionExerciseId, pid2);
    const bravoRecKey = recs2[0].key;

    // Zero cross-pollution after materialization
    assert.equal(meso1PostMat.progressionApplications[bravoRecKey], undefined);
    assert.equal(meso2PostMat.progressionApplications[ayrtonRecKey], undefined);

    // 4. Operation obtains accredited reservation via reserveOperation
    const opData1 = {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: opId1,
      uid: uid1,
      planId: plan1,
      pid: pid1,
      runtimeSha: sha,
      deploymentId: 'dpl_emu_cohort_1',
      runId: 'run-ayrton-709',
      window: win1,
      scope: { enabled: true, clientIds: [uid1], prescriptionExerciseIds: [pid1] }
    };
    const att1 = await makeValidAttestation(opData1, startsAt);
    const res1 = await reserveOperation(db, opData1, { attestation: att1, now: startsAt });
    assert.equal(res1.status, 'RESERVED');

    const opData2 = {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: opId2,
      uid: uid2,
      planId: plan2,
      pid: pid2,
      runtimeSha: sha,
      deploymentId: 'dpl_emu_cohort_2',
      runId: 'run-bravo-709',
      window: win2,
      scope: { enabled: true, clientIds: [uid2], prescriptionExerciseIds: [pid2] }
    };
    const att2 = await makeValidAttestation(opData2, startsAt);
    const res2 = await reserveOperation(db, opData2, { attestation: att2, now: startsAt });
    assert.equal(res2.status, 'RESERVED');

    // 5. Servidor ejecuta applyPending con reserva válida
    const applyRes1 = await executor.applyPending(db, uid1, plan1, () => startsAt);
    assert.equal(applyRes1.length, 1);
    assert.equal(applyRes1[0].written, true);

    const meso1PostApply = (await db.doc('logs/' + uid1 + '/mesos/' + plan1).get()).data();
    assert.equal(meso1PostApply.progressionApplications[ayrtonRecKey].state, 'APPLIED');
    const ovl1 = meso1PostApply.nextExposureOverlays['ovl_' + ayrtonRecKey];
    assert.ok(ovl1, 'Overlay created for Ayrton');
    assert.equal(ovl1.status, 'APPLIED');

    // Verify Ayrton's ledger updated with RECORD_APPLIED
    const op1PostApply = (await db.doc('releaseControl/numericPilot/operations/' + opId1).get()).data();
    assert.deepEqual(op1PostApply.appliedRecordKeys, [ayrtonRecKey]);
    assert.equal(op1PostApply.history.some(h => h.action === 'RECORD_APPLIED' && h.recordKey === ayrtonRecKey), true);

    // Client 2's meso and ledger remain completely untouched
    const meso2PreApply = (await db.doc('logs/' + uid2 + '/mesos/' + plan2).get()).data();
    assert.equal(meso2PreApply.progressionApplications[bravoRecKey].state, 'PENDING');
    assert.deepEqual(meso2PreApply.nextExposureOverlays, {});
    const op2PostApply1 = (await db.doc('releaseControl/numericPilot/operations/' + opId2).get()).data();
    assert.ok(!op2PostApply1.appliedRecordKeys || op2PostApply1.appliedRecordKeys.length === 0, 'Client 2 ledger has no applied records');

    // 6. Cliente obtiene prescripción efectiva con overlay
    const eff1 = await effective.resolveEffective({
      clientId: uid1,
      planId: plan1,
      activePlanId: plan1,
      pid: pid1,
      week: ovl1.target.week,
      dayIndex: ovl1.target.dayIndex,
      records: meso1PostApply.progressionApplications,
      overlays: meso1PostApply.nextExposureOverlays,
      interventions: [],
      plan: sc1.plan,
      entries: meso1PostApply.entries,
      baseSets: F.baseSets(),
      canonicalOverlayRead: true
    });
    assert.equal(eff1.provenance, 'CANONICAL_OVERLAY');
    assert.ok(eff1.sets.some(s => s.effective && s.effective.load === ovl1.appliedValue));

    // 7. Cliente registra ejecución con consumption receipt
    const tgtLogKey1 = 'log_' + ovl1.target.week + '_' + ovl1.target.dayIndex + '_0_s0';
    const targetEntry1 = {
      carga: String(ovl1.appliedValue),
      reps: '10',
      unit: 'KG',
      done: true,
      rir: 2,
      rir_real: 2,
      prescriptionExerciseId: pid1,
      ts: Date.parse(startsAt) + 1000,
      sts: Date.parse(startsAt) + 1000
    };
    await db.doc('logs/' + uid1 + '/mesos/' + plan1).update({ ['entries.' + tgtLogKey1]: targetEntry1 });
    await db.doc('logs/' + uid1).update({ ['entries.' + tgtLogKey1]: targetEntry1 });

    // Canonical T603 exposure start marker (at exposure start, after evidence calculation)
    const exposureStartAt1 = new Date(Date.parse(startsAt) + 1000).toISOString().replace('.000Z', 'Z');
    await db.doc('logs/' + uid1 + '/starts/' + plan1 + '_' + ovl1.target.week + '_' + ovl1.target.dayIndex + '_0').set({
      at: exposureStartAt1,
      planId: plan1,
      week: ovl1.target.week,
      dayIndex: ovl1.target.dayIndex,
      exerciseIndex: 0
    });

    const refs1 = {
      meso: db.doc('logs/' + uid1 + '/mesos/' + plan1),
      root: db.doc('logs/' + uid1)
    };
    const rAck1 = await db.runTransaction(async tx => {
      return consumer.recordConsumptionReceiptTransaction(webTx(tx), refs1, {
        recordKey: ayrtonRecKey,
        clientId: uid1,
        now: exposureStartAt1,
        shown: {
          provenance: 'CANONICAL_OVERLAY',
          overlayKey: ovl1.key,
          dimension: ovl1.dimension,
          appliedValue: ovl1.appliedValue
        }
      }, { isCurrent: () => true, canonicalOverlayRead: true });
    });
    assert.equal(rAck1.written, true);

    // 8. Servidor valida recibo y consume ajuste
    const consumeRes1 = await executor.consumePending(db, uid1, plan1, () => new Date(Date.parse(startsAt) + 2000).toISOString().replace('.000Z', 'Z'));
    assert.equal(consumeRes1.length, 1);
    assert.equal(consumeRes1[0].written, true);

    const meso1PostConsume = (await db.doc('logs/' + uid1 + '/mesos/' + plan1).get()).data();
    assert.equal(meso1PostConsume.progressionApplications[ayrtonRecKey].state, 'CONSUMED');
    assert.equal(meso1PostConsume.nextExposureOverlays[ovl1.key].status, 'CONSUMED');

    // 9. Replay & Idempotency: Re-applying on Ayrton's ledger rejects duplicate record
    assert.equal(C.ledgerValid(op1PostApply, win1, ayrtonRecKey), false, 'Already applied record must be rejected for replay');
    assert.equal(C.ledgerValid(op1PostApply, win1, 'fresh-rec-key-99'), true, 'Fresh record key is permitted');

    // 10. Individual Client Revocation: revoke Ayrton without stopping Client 2
    const revReport = await executeClientRevocation({
      clientId: uid1,
      operationId: opId1,
      coachId: coachId,
      reason: 'EMU_TARGETED_REVOCATION'
    }, io);

    assert.equal(revReport.status, 'REVOCATION_CONFIRMED');
    assert.equal(revReport.success, true);

    // Read back fences from emulator
    const savedNum = (await db.doc('releaseControl/numericPilot').get()).data();
    assert.equal(savedNum.enabled, true, 'Global numeric pilot must remain enabled');
    assert.equal(savedNum.windows[uid1].enabled, false, 'Ayrton window must be disabled');
    assert.equal(savedNum.windows[uid2].enabled, true, 'Client 2 window must remain enabled');

    const savedRel = (await db.doc('releaseControl/autonomousProgression').get()).data();
    assert.equal(savedRel.enabled, true, 'Global release control must remain enabled');
    assert.deepEqual(savedRel.clientIds, [uid2], 'Only Client 2 must remain in release allowlist');

    const savedCoach = (await db.doc('coaches/' + coachId).get()).data();
    assert.equal(savedCoach.autoApplyCanary.enabled, true, 'Coach canary must remain enabled');
    assert.deepEqual(savedCoach.autoApplyCanary.clientIds, [uid2], 'Only Client 2 must remain in coach canary');

    const savedOp1 = (await db.doc('releaseControl/numericPilot/operations/' + opId1).get()).data();
    assert.equal(savedOp1.status, 'STOPPED');

    const savedOp2 = (await db.doc('releaseControl/numericPilot/operations/' + opId2).get()).data();
    assert.equal(savedOp2.status, 'RESERVED', 'Client 2 ledger operation must remain RESERVED');

    // 11. Client 2 progresses independently to CONSUMED
    const applyRes2 = await executor.applyPending(db, uid2, plan2, () => startsAt);
    assert.equal(applyRes2.length, 1);
    assert.equal(applyRes2[0].written, true);

    const meso2PostApply = (await db.doc('logs/' + uid2 + '/mesos/' + plan2).get()).data();
    assert.equal(meso2PostApply.progressionApplications[bravoRecKey].state, 'APPLIED');
    const ovl2 = meso2PostApply.nextExposureOverlays['ovl_' + bravoRecKey];
    assert.ok(ovl2);

    const eff2 = await effective.resolveEffective({
      clientId: uid2,
      planId: plan2,
      activePlanId: plan2,
      pid: pid2,
      week: ovl2.target.week,
      dayIndex: ovl2.target.dayIndex,
      records: meso2PostApply.progressionApplications,
      overlays: meso2PostApply.nextExposureOverlays,
      interventions: [],
      plan: sc2.plan,
      entries: meso2PostApply.entries,
      baseSets: F.baseSets(),
      canonicalOverlayRead: true
    });
    assert.equal(eff2.provenance, 'CANONICAL_OVERLAY');

    const tgtLogKey2 = 'log_' + ovl2.target.week + '_' + ovl2.target.dayIndex + '_0_s0';
    const targetEntry2 = {
      carga: String(ovl2.appliedValue),
      reps: '10',
      unit: 'KG',
      done: true,
      rir: 2,
      rir_real: 2,
      prescriptionExerciseId: pid2,
      ts: Date.parse(startsAt) + 1000,
      sts: Date.parse(startsAt) + 1000
    };
    await db.doc('logs/' + uid2 + '/mesos/' + plan2).update({ ['entries.' + tgtLogKey2]: targetEntry2 });
    await db.doc('logs/' + uid2).update({ ['entries.' + tgtLogKey2]: targetEntry2 });

    // Canonical T603 exposure start marker (at exposure start, after evidence calculation)
    const exposureStartAt2 = new Date(Date.parse(startsAt) + 1000).toISOString().replace('.000Z', 'Z');
    await db.doc('logs/' + uid2 + '/starts/' + plan2 + '_' + ovl2.target.week + '_' + ovl2.target.dayIndex + '_0').set({
      at: exposureStartAt2,
      planId: plan2,
      week: ovl2.target.week,
      dayIndex: ovl2.target.dayIndex,
      exerciseIndex: 0
    });

    const refs2 = {
      meso: db.doc('logs/' + uid2 + '/mesos/' + plan2),
      root: db.doc('logs/' + uid2)
    };
    const rAck2 = await db.runTransaction(async tx => {
      return consumer.recordConsumptionReceiptTransaction(webTx(tx), refs2, {
        recordKey: bravoRecKey,
        clientId: uid2,
        now: exposureStartAt2,
        shown: {
          provenance: 'CANONICAL_OVERLAY',
          overlayKey: ovl2.key,
          dimension: ovl2.dimension,
          appliedValue: ovl2.appliedValue
        }
      }, { isCurrent: () => true, canonicalOverlayRead: true });
    });
    assert.equal(rAck2.written, true);

    const consumeRes2 = await executor.consumePending(db, uid2, plan2, () => new Date(Date.parse(startsAt) + 2000).toISOString().replace('.000Z', 'Z'));
    assert.equal(consumeRes2.length, 1);
    assert.equal(consumeRes2[0].written, true);

    const meso2Final = (await db.doc('logs/' + uid2 + '/mesos/' + plan2).get()).data();
    assert.equal(meso2Final.progressionApplications[bravoRecKey].state, 'CONSUMED');
    assert.equal(meso2Final.nextExposureOverlays[ovl2.key].status, 'CONSUMED');

    // Ayrton's meso was completely untouched throughout Client 2's operations
    const meso1Final = (await db.doc('logs/' + uid1 + '/mesos/' + plan1).get()).data();
    assert.equal(meso1Final.progressionApplications[ayrtonRecKey].state, 'CONSUMED');
    assert.equal(meso1Final.nextExposureOverlays[ovl1.key].status, 'CONSUMED');

    // 12. T710 Focused Security Battery against real Firestore Emulator
    // 12A. Revocar un cliente con el operationId de otro: rechazo, cero mutaciones indebidas
    const cA = 'synth-conc-a', cB = 'synth-conc-b';
    const opA = 'op-conc-a-709', opB = 'op-conc-b-709';
    const cCoach = 'coach-conc-rev-709';
    await db.doc('coaches/' + cCoach).set({
      autoApplyCanary: { enabled: true, clientIds: [cA, cB], prescriptionExerciseIds: ['pA', 'pB'] }
    });
    await db.doc('releaseControl/numericPilot').set({
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: {
        [cA]: { ...win1, uid: cA, coachId: cCoach, operationId: opA, enabled: true },
        [cB]: { ...win2, uid: cB, coachId: cCoach, operationId: opB, enabled: true }
      }
    });
    await db.doc('releaseControl/autonomousProgression').set({
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [cA, cB],
      expiresAt: expiresAt
    });
    await db.doc('releaseControl/numericPilot/operations/' + opA).set({
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: opA,
      uid: cA,
      coachId: cCoach,
      planId: win1.planId,
      pid: win1.pid,
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: startsAt }]
    });
    await db.doc('releaseControl/numericPilot/operations/' + opB).set({
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: opB,
      uid: cB,
      coachId: cCoach,
      planId: win2.planId,
      pid: win2.pid,
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: startsAt }]
    });

    // Cross-client revocation attempt: cA attempts to revoke opB
    const crossRev = await executeClientRevocation({
      clientId: cA,
      operationId: opB,
      coachId: cCoach,
      reason: 'MALICIOUS_CROSS_STOP'
    }, io);

    assert.equal(crossRev.status, 'REVOCATION_INCOMPLETE');
    assert.equal(crossRev.success, false);
    assert.ok(crossRev.errors.some(e => e.includes('CROSS_CLIENT_OPERATION_DENIED') || e.includes('OPERATION_MISMATCH')));

    // Verify ZERO mutations on opB and fences
    const opBPre = (await db.doc('releaseControl/numericPilot/operations/' + opB).get()).data();
    assert.equal(opBPre.status, 'RESERVED', 'Client B operation must remain RESERVED after cross-client attempt');
    assert.equal(opBPre.history.length, 1);
    const numPre = (await db.doc('releaseControl/numericPilot').get()).data();
    assert.equal(numPre.windows[cA].enabled, true);
    assert.equal(numPre.windows[cB].enabled, true);
    const relPre = (await db.doc('releaseControl/autonomousProgression').get()).data();
    assert.deepEqual(relPre.clientIds, [cA, cB]);

    // 12B. Revocar un cliente cuya ventana no existe: resultado incompleto
    const ghostRev = await executeClientRevocation({
      clientId: 'ghost-non-existent-uid',
      operationId: 'op-ghost-99',
      coachId: cCoach
    }, io);
    assert.equal(ghostRev.status, 'REVOCATION_INCOMPLETE');
    assert.equal(ghostRev.success, false);
    assert.ok(ghostRev.errors.some(e => e.includes('WINDOW_NOT_FOUND')));

    // 12C. Dos revocaciones concurrentes con intercalación controlada: sin pérdida de cambios
    const [revA, revB] = await Promise.all([
      executeClientRevocation({ clientId: cA, operationId: opA, coachId: cCoach, reason: 'CONCURRENT_A' }, io),
      executeClientRevocation({ clientId: cB, operationId: opB, coachId: cCoach, reason: 'CONCURRENT_B' }, io)
    ]);
    assert.equal(revA.status, 'REVOCATION_CONFIRMED');
    assert.equal(revB.status, 'REVOCATION_CONFIRMED');

    const finalConcRel = (await db.doc('releaseControl/autonomousProgression').get()).data();
    assert.deepEqual(finalConcRel.clientIds, [], 'Both clients removed without lost update');
    const finalConcCoach = (await db.doc('coaches/' + cCoach).get()).data();
    assert.deepEqual(finalConcCoach.autoApplyCanary.clientIds, [], 'Both clients removed from coach canary without lost update');

    // 12D. Admisión y revocación concurrentes: conservar miembros autorizados y excluir al revocado
    const cKeep = 'synth-keep-d', cRev = 'synth-rev-d', cNew = 'synth-new-admitted-d';
    const opKeep = 'op-keep-d', opRev = 'op-rev-d';
    await db.doc('coaches/' + cCoach).set({
      autoApplyCanary: { enabled: true, clientIds: [cKeep, cRev], prescriptionExerciseIds: ['pK', 'pR'] }
    });
    await db.doc('releaseControl/numericPilot').set({
      schema: 'vdsen-numeric-cohort-v1',
      enabled: true,
      windows: {
        [cKeep]: { ...win1, uid: cKeep, coachId: cCoach, operationId: opKeep, enabled: true },
        [cRev]: { ...win2, uid: cRev, coachId: cCoach, operationId: opRev, enabled: true }
      }
    });
    await db.doc('releaseControl/autonomousProgression').set({
      schema: 'vdsen-autonomous-release-v1',
      enabled: true,
      clientIds: [cKeep, cRev],
      expiresAt: expiresAt
    });
    await db.doc('releaseControl/numericPilot/operations/' + opRev).set({
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: opRev,
      uid: cRev,
      coachId: cCoach,
      planId: win2.planId,
      pid: win2.pid,
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: startsAt }]
    });

    const admissionTask = db.runTransaction(async tx => {
      const relRef = db.doc('releaseControl/autonomousProgression');
      const coachRef = db.doc('coaches/' + cCoach);
      const [rSnap, cSnap] = await Promise.all([tx.get(relRef), tx.get(coachRef)]);
      const rData = rSnap.data(), cData = cSnap.data();
      tx.set(relRef, { clientIds: [...rData.clientIds, cNew] }, { merge: true });
      tx.set(coachRef, { autoApplyCanary: { ...cData.autoApplyCanary, clientIds: [...cData.autoApplyCanary.clientIds, cNew] } }, { merge: true });
      return true;
    });
    const revocationTask = executeClientRevocation({
      clientId: cRev,
      operationId: opRev,
      coachId: cCoach,
      reason: 'CONCURRENT_REV_TEST'
    }, io);

    const [admittedD, revReportD] = await Promise.all([admissionTask, revocationTask]);
    assert.equal(admittedD, true);
    assert.equal(revReportD.status, 'REVOCATION_CONFIRMED');

    const mixedRel = (await db.doc('releaseControl/autonomousProgression').get()).data();
    assert.ok(mixedRel.clientIds.includes(cKeep), 'Existing client preserved');
    assert.ok(mixedRel.clientIds.includes(cNew), 'Newly admitted client preserved');
    assert.ok(!mixedRel.clientIds.includes(cRev), 'Revoked client excluded');

    // 12E. Adaptador REST sin precondiciones OCC: rechazo seguro, sin escritura
    let insecureWrites = 0;
    const insecureIo = {
      readFence: async () => ({ enabled: true }),
      writeFence: async () => { insecureWrites++; return true; },
      recordStop: async () => ({ success: true })
    };
    const insecureRes = await executeClientRevocation({
      clientId: cKeep,
      operationId: opKeep,
      coachId: cCoach
    }, insecureIo);
    assert.equal(insecureRes.status, 'REVOCATION_INCOMPLETE');
    assert.equal(insecureRes.success, false);
    assert.equal(insecureWrites, 0, 'Zero writes on insecure adapter');
    assert.ok(insecureRes.errors.some(e => e.includes('ADAPTER_UNSUPPORTED_CONCURRENCY_GUARANTEES')));

    // 12F. STOP repetido y estados terminales: integridad e idempotencia
    const repOpDocPre = (await db.doc('releaseControl/numericPilot/operations/' + opRev).get()).data();
    assert.equal(repOpDocPre.status, 'STOPPED');
    const historyCount = repOpDocPre.history.length;

    // Second revocation on already STOPPED operation
    const repeatRev = await executeClientRevocation({
      clientId: cRev,
      operationId: opRev,
      coachId: cCoach,
      reason: 'REPEAT_STOP'
    }, io);
    assert.equal(repeatRev.status, 'REVOCATION_CONFIRMED');

    const repOpDocPost = (await db.doc('releaseControl/numericPilot/operations/' + opRev).get()).data();
    assert.equal(repOpDocPost.status, 'STOPPED');
    assert.equal(repOpDocPost.history.length, historyCount, 'No duplicate STOPPED event appended to history');

    // 13. Fail closed on expired window
    const expiredWin = {
      ...win1,
      expiresAt: new Date(Date.now() - 3600000).toISOString().replace('.000Z', 'Z')
    };
    assert.equal(C.windowValid(expiredWin, Date.now()), false, 'Expired window must fail closed');
  } finally {
    prevEnv.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});
