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
    const opDoc = {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: window.operationId,
      status: 'RESERVED',
      reservedAt: new Date().toISOString(),
      completedAt: null,
      stoppedAt: null,
      uid: C.UID,
      planId: C.PLAN,
      pid: C.PID,
      runtimeSha: window.runtimeSha,
      deploymentId: 'dpl_emulator_test_contract',
      runId: 'run-contract-1',
      window: structuredClone(window),
      scope: { enabled: true, clientIds: [C.UID], prescriptionExerciseIds: [C.PID] },
      appliedRecordKeys: [],
      history: []
    };
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).set(opDoc);
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
    // Verify ledger doc recorded the applied key inside the transaction
    const savedOpDoc = (await db.doc('releaseControl/numericPilot/operations/' + window.operationId).get()).data();
    assert.ok(Array.isArray(savedOpDoc.appliedRecordKeys) && savedOpDoc.appliedRecordKeys.includes(sc.rec.key));
    assert.equal(savedOpDoc.status, 'RESERVED', 'Operation remains RESERVED during record applications');

    // Reset only synthetic emulator data to test concurrent application of one pending decision.
    const pending = { planId: C.PLAN, entries: sc.entries, progressionApplications: { [sc.rec.key]: sc.rec }, nextExposureOverlays: {} };
    await meso.set(pending);
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).update({ appliedRecordKeys: [] });
    const simultaneous = await Promise.all(Array.from({ length: 3 }, () => executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString())));
    assert.equal(simultaneous.flat().filter(r => r.written).length, 1);
    const concurrentResult = (await meso.get()).data();
    assert.equal(concurrentResult.progressionApplications[sc.rec.key].state, 'APPLIED');
    assert.equal(Object.keys(concurrentResult.nextExposureOverlays).length, 1);

    // Replay with already applied key in ledger: rejected
    const replayRes = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.deepEqual(replayRes, []); // already in APPLIED state in meso

    // If meso reset to pending but ledger already has the key: must reject without write
    await meso.set(pending);
    const ledgerReplay = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(ledgerReplay.length, 1);
    assert.equal(ledgerReplay[0].written, false);
    assert.equal(ledgerReplay[0].reason, 'ALREADY_APPLIED_FOR_OPERATION');

    // If ledger operation is STOPPED: must reject without write
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).update({ status: 'STOPPED', appliedRecordKeys: [] });
    const stoppedLedgerRes = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(stoppedLedgerRes.length, 1);
    assert.equal(stoppedLedgerRes[0].written, false);
    assert.equal(stoppedLedgerRes[0].reason, 'NUMERIC_LEDGER_NOT_RESERVED');
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).update({ status: 'RESERVED' });

    // If ledger operation document is missing: must reject without write
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).delete();
    const missingLedgerRes = await executor.applyPending(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(missingLedgerRes.length, 1);
    assert.equal(missingLedgerRes[0].written, false);
    assert.equal(missingLedgerRes[0].reason, 'NUMERIC_LEDGER_MISSING');
    await db.doc('releaseControl/numericPilot/operations/' + window.operationId).set(opDoc);

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
    const foreign = { ...structuredClone(sc.rec), key: 'synthetic-foreign-record', prescriptionExerciseId: other };
    await meso.set({ planId: C.PLAN, entries: evidence, progressionApplications: { [foreign.key]: foreign }, nextExposureOverlays: {} });
    // STOP must block materialization as well as application.
    assert.equal((await executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString())).status, 'OUT_OF_NUMERIC_PILOT');
    assert.deepEqual((await meso.get()).data().progressionApplications, { [foreign.key]: foreign });
    await db.doc('releaseControl/numericPilot').set({ enabled: true }, { merge: true });
    const materialized = await executor.materialize(db, C.UID, C.PLAN, () => new Date().toISOString());
    assert.equal(materialized.status, 'MATERIALIZED', JSON.stringify(materialized));
    const materializedRecords = Object.values((await meso.get()).data().progressionApplications);
    assert.equal(materializedRecords.length, 2);
    assert.deepEqual((await meso.get()).data().progressionApplications[foreign.key], foreign, 'a foreign pending record must not be staled by numeric materialization');
    assert.equal(materializedRecords.filter(r => r.prescriptionExerciseId === C.PID).length, 1);
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
    const ledgerAfterRollback = (await db.doc('releaseControl/numericPilot/operations/' + window.operationId).get()).data();
    assert.ok(!ledgerAfterRollback.appliedRecordKeys.includes(sc.rec.key), 'Ledger update must roll back atomically with overlay');
  } finally {
    previous.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});
