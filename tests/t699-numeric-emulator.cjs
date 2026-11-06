'use strict';
// All data below is synthetic; the exact identifiers exercise the real production contract in a demo project only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const C = require('../api/_numericPilotContract');
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription');
const F = require('./helpers/lifecycle-fixture');
const { executeStop } = require('../scripts/pilot/numeric-stop-recovery.cjs');
const { createEmulatorIo, executeAuditStatus } = require('../scripts/pilot/numeric-pilot-ops.cjs');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'emulator required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = initializeApp({ projectId }, 't699-real-contract');
const db = getFirestore(app);
test.after(() => deleteApp(app));

test('real contract in emulator: pending -> applied overlay -> effective prescription', async () => {
  const sc = F.scenario({ clientId: C.UID, planId: C.PLAN, pid: C.PID });
  const coach = 'synthetic-coach-t699';
  const t = Math.floor(Date.now() / 1000) * 1000;
  const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
  const window = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid: C.UID, planId: C.PLAN, pid: C.PID,
    runtimeSha: 'a'.repeat(40), operationId: 'synthetic-emulator-699', startsAt: iso(t - 1000), expiresAt: iso(t + 3600000) };
  const env = { AUTONOMOUS_PROGRESSION_ENABLED: 'true', AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED: 'true',
    VDSEN_NUMERIC_PILOT_ENABLED: 'true', VDSEN_NUMERIC_PILOT_RUNTIME_SHA: window.runtimeSha, VDSEN_NUMERIC_PILOT_WINDOW: JSON.stringify(window) };
  const keys = [...Object.keys(env), 'CRON_SECRET'];
  const previous = keys.map(k => [k, process.env[k]]);
  try {
    Object.assign(process.env, env); delete process.env.CRON_SECRET;
    await db.doc('clients/' + C.UID).set({ activePlanId: C.PLAN, coachId: coach });
    await db.doc('coaches/' + coach).set({ autoApplyCanary: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] } });
    await db.doc('plans/' + C.PLAN).set(sc.plan);
    await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [C.UID], expiresAt: window.expiresAt });
    await db.doc('releaseControl/numericPilot').set({ ...window, enabled: true });
    await db.doc('logs/' + C.UID).set({ planId: C.PLAN, entries: sc.entries });
    const meso = db.doc('logs/' + C.UID + '/mesos/' + C.PLAN);
    await meso.set({ planId: C.PLAN, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec }, nextExposureOverlays: {} });
    const base = (await db.doc('plans/' + C.PLAN).get()).data();
    const result = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(result.length, 1); assert.equal(result[0].written, true, JSON.stringify(result));
    const m = (await meso.get()).data();
    assert.equal(m.progressionApplications[sc.rec.key].state, 'APPLIED');
    const overlays = Object.values(m.nextExposureOverlays);
    assert.equal(overlays.length, 1); assert.equal(overlays[0].status, 'APPLIED');
    const resolved = effective.resolveEffective({ clientId: C.UID, planId: C.PLAN, activePlanId: C.PLAN, pid: C.PID,
      week: overlays[0].target.week, dayIndex: overlays[0].target.dayIndex, records: m.progressionApplications,
      overlays: m.nextExposureOverlays, interventions: [], plan: base, entries: sc.entries, baseSets: F.baseSets(), canonicalOverlayRead: true });
    assert.equal(resolved.provenance, 'CANONICAL_OVERLAY');
    assert.deepEqual((await db.doc('plans/' + C.PLAN).get()).data(), base);
    assert.deepEqual(await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString()), []);
    // Reset only synthetic emulator data to test concurrent application of one pending decision.
    const pending = { planId: C.PLAN, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec }, nextExposureOverlays: {} };
    await meso.set(pending);
    const simultaneous = await Promise.all(Array.from({ length: 3 }, () => executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString())));
    assert.equal(simultaneous.flat().filter(r => r.written).length, 1);
    const concurrentResult = (await meso.get()).data();
    assert.equal(concurrentResult.progressionApplications[sc.rec.key].state, 'APPLIED');
    assert.equal(Object.keys(concurrentResult.nextExposureOverlays).length, 1);
    await meso.set(pending);
    await db.doc('releaseControl/numericPilot').set({ enabled: false }, { merge: true });
    const stopped = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.ok(stopped.every(r => !r.written));
    const afterStop = (await meso.get()).data();
    assert.equal(afterStop.progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual(afterStop.nextExposureOverlays, {});
    // Materialize from synthetic execution evidence containing two exercise IDs.
    const other = 'synthetic-other-pid';
    const expandedPlan = structuredClone(sc.plan);
    expandedPlan.days.forEach(day => day.exercises.push({ ...day.exercises[0], prescriptionExerciseId: other }));
    const evidence = structuredClone(sc.entries);
    Object.entries(sc.entries).forEach(([key, entry]) => {
      evidence[key.replace(/_0_s(\d+)$/, '_1_s$1')] = { ...entry, prescriptionExerciseId: other };
    });
    evidence.progrec_1_2 = { calculatedAt: '2026-09-27T12:00:00.000Z', recommendations: [C.PID, other].map(pid => ({
      prescriptionExerciseId: pid, exerciseId: sc.exerciseId, exerciseName: 'X', action: 'increase_load', newLoad: 5, newReps: 10
    })) };
    await db.doc('plans/' + C.PLAN).set(expandedPlan);
    await db.doc('logs/' + C.UID).set({ planId: C.PLAN, entries: evidence });
    await meso.set({ planId: C.PLAN, entries: evidence, progressionApplications: {}, nextExposureOverlays: {} });
    // STOP must block materialization as well as application.
    assert.equal((await executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString())).status, 'OUT_OF_NUMERIC_PILOT');
    assert.deepEqual((await meso.get()).data().progressionApplications, {});
    await db.doc('releaseControl/numericPilot').set({ enabled: true }, { merge: true });
    const materialized = await executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(materialized.status, 'MATERIALIZED', JSON.stringify(materialized));
    const materializedRecords = Object.values((await meso.get()).data().progressionApplications);
    assert.equal(materializedRecords.length, 1);
    assert.equal(materializedRecords[0].prescriptionExerciseId, C.PID);
    assert.equal((await executor.materialize(db, 'synthetic-foreign-user', C.PLAN, () => new Date().toISOString())).status, 'OUT_OF_NUMERIC_PILOT');
    assert.equal((await executor.materialize(db, C.UID, 'synthetic-foreign-plan', () => new Date().toISOString())).status, 'OUT_OF_NUMERIC_PILOT');
    assert.equal((await db.doc('logs/synthetic-foreign-user').get()).exists, false);
    process.env.VDSEN_NUMERIC_PILOT_ENABLED = 'false';
    assert.equal((await executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString())).status, 'OUT_OF_NUMERIC_PILOT');
    assert.deepEqual(await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString()), []);
    process.env.VDSEN_NUMERIC_PILOT_ENABLED = 'true';
    // Abort after a staged transaction write; Firestore must commit neither document.
    await db.doc('plans/' + C.PLAN).set(sc.plan);
    await meso.set(pending);
    const abortingDb = Object.create(db);
    abortingDb.collection = name => db.collection(name);
    abortingDb.runTransaction = fn => db.runTransaction(tx => {
      let writes = 0;
      return fn({ get: tx.get.bind(tx), set(ref, data, opts) {
        if (++writes === 2) throw new Error('SYNTHETIC_ABORT_BEFORE_COMMIT');
        return opts ? tx.set(ref, data, opts) : tx.set(ref, data);
      } });
    });
    await assert.rejects(() => executor.applyPending(abortingDb, C.UID, C.PLAN, () => new Date().toISOString()), /SYNTHETIC_ABORT_BEFORE_COMMIT/);
    const rolledBack = (await meso.get()).data();
    assert.equal(rolledBack.progressionApplications[sc.rec.key].state, 'PENDING');
    assert.deepEqual(rolledBack.nextExposureOverlays, {});
  } finally {
    previous.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});

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
    writeFence: async (path, fields, opts) => {
      if (path === 'releaseControl/autonomousProgression') {
        throw new Error('SYNTHETIC_EMULATOR_WRITE_TIMEOUT');
      }
      return io.writeFence(path, fields, opts);
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
