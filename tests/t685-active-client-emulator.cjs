// T685: Real Firestore Emulator + firestore.rules verification for smart active-client eligibility,
// new-client onboarding (first real training interaction), inactive/planless/synthetic exclusion,
// and progressive cohort activation. Synthetic data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, setDoc, runTransaction, serverTimestamp } = require('firebase/firestore');
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

const eligibility = require('../api/_clientEligibility.js');
const executor = require('../api/_autonomousProgression.js');
const sweep = require('../api/_autonomousProgressionSweep.js');
const consumer = require('../assets/progression-application-consumer.js');

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const adminApp = initAdmin({ projectId }, 't685-admin');
const db = getAdminFirestore(adminApp);
const apps = [];

async function signedIn(uid) {
  uid = uid || 't685-' + randomUUID().replace(/-/g, '').slice(0, 20);
  const app = initializeApp({ apiKey: 'demo-key', authDomain: projectId + '.firebaseapp.com', projectId }, 't685-' + apps.length);
  apps.push(app);
  const cdb = getFirestore(app);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  connectFirestoreEmulator(cdb, host, Number(port), { mockUserToken: { sub: uid } });
  return { uid, db: cdb };
}
test.after(async () => { await Promise.all(apps.map(deleteApp)); await deleteAdmin(adminApp); });

const PID = 'pid-press';
const T_NOW_ISO = '2026-10-15T12:00:00.000Z';
const T_NOW = Date.parse(T_NOW_ISO);
const DAY_MS = 86400000;

function makePlanDoc(uid, coachId, overrides) {
  return Object.assign({
    clientId: uid,
    coachId: coachId,
    status: 'active',
    weeks: 4,
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    days: [0, 2].map(dayIndex => ({
      dayIndex,
      exercises: [
        {
          prescriptionExerciseId: PID,
          exerciseId: 'ex-press',
          exerciseName: 'Press banca',
          repsRange: { min: 8, max: 12 },
          sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 1, restSeconds: 90 }))
        },
        {
          prescriptionExerciseId: 'pid-cardio',
          exerciseName: 'Bici estática',
          exerciseType: 'cardio',
          sets: [{ setIndex: 0, durationMinutes: 20 }]
        }
      ]
    }))
  }, overrides || {});
}

function makeRecurrentLogs(t1, t2) {
  t1 = t1 || (T_NOW - 4 * DAY_MS);
  t2 = t2 || (T_NOW - 2 * DAY_MS);
  const logs = {};
  [[1, 0, t1], [1, 2, t2]].forEach(([w, d, ts]) => {
    [0, 1, 2].forEach(s => {
      logs['log_' + w + '_' + d + '_0_s' + s] = {
        done: true, carga: '100', reps: '10', unit: 'KG', rir: 1, rir_real: 3,
        prescriptionExerciseId: PID, ts: ts + s * 1000
      };
    });
    logs['done_' + w + '_' + d] = { ts: ts + 5000 };
    logs['postsession_' + w + '_' + d] = { completedAt: new Date(ts + 6000).toISOString(), eimd: 1, sleepHours: 8, rpeAverage: 7 };
  });
  logs.progrec_1_2 = {
    calculatedAt: new Date(t2 + 10000).toISOString(),
    recommendations: [
      { prescriptionExerciseId: PID, exerciseId: 'ex-press', exerciseName: 'Press banca', action: 'increase_reps', newReps: 11 },
      { prescriptionExerciseId: 'pid-cardio', exerciseName: 'Bici estática', action: 'increase_load', newLoad: 5 }
    ]
  };
  return logs;
}

test('T685.E1 cohort selection & execution on emulator: recurrent (PRIORITY_A) and new active (PRIORITY_B) vs excluded clients', { timeout: 90000 }, async () => {
  const coach = await signedIn();
  const recurrent = await signedIn();
  const newIdle = await signedIn();
  const noPlan = await signedIn();
  const importedOnly = await signedIn();
  const inactive = await signedIn();

  const pRec = 'plan-' + recurrent.uid;
  const pNew = 'plan-' + newIdle.uid;
  const pImp = 'plan-' + importedOnly.uid;
  const pInact = 'plan-' + inactive.uid;

  await db.doc('coaches/' + coach.uid).set({
    role: 'coach',
    autoApplyCanary: { enabled: true, clientIds: [recurrent.uid, newIdle.uid, noPlan.uid, importedOnly.uid, inactive.uid], prescriptionExerciseIds: [] }
  });
  await db.doc('releaseControl/autonomousProgression').set({
    schema: 'vdsen-autonomous-release-v1',
    enabled: true,
    expiresAt: '2026-10-20T00:00:00.000Z',
    clientIds: [recurrent.uid, newIdle.uid, noPlan.uid, importedOnly.uid, inactive.uid]
  });

  // 1) Recurrent active client
  const recLogs = makeRecurrentLogs();
  await db.doc('clients/' + recurrent.uid).set({ coachId: coach.uid, activePlanId: pRec, createdAt: '2026-07-01T00:00:00.000Z' });
  await db.doc('plans/' + pRec).set(makePlanDoc(recurrent.uid, coach.uid));
  await db.doc('logs/' + recurrent.uid).set({ planId: pRec, entries: recLogs, updatedAt: 2 });
  await db.doc('logs/' + recurrent.uid + '/mesos/' + pRec).set({ planId: pRec, entries: recLogs, updatedAt: 2 });

  // 2) Brand-new client with active plan but 0 training interactions
  await db.doc('clients/' + newIdle.uid).set({ coachId: coach.uid, activePlanId: pNew, createdAt: '2026-10-14T00:00:00.000Z' });
  await db.doc('plans/' + pNew).set(makePlanDoc(newIdle.uid, coach.uid, { createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' }));
  await db.doc('logs/' + newIdle.uid).set({ planId: pNew, entries: {}, updatedAt: 1 });
  await db.doc('logs/' + newIdle.uid + '/mesos/' + pNew).set({ planId: pNew, entries: {}, updatedAt: 1 });

  // 3) Client without active plan
  await db.doc('clients/' + noPlan.uid).set({ coachId: coach.uid, activePlanId: null });

  // 4) Client with only imported / coach_admin entries
  const synthLogs = makeRecurrentLogs();
  Object.keys(synthLogs).forEach(k => { synthLogs[k] = Object.assign({}, synthLogs[k], { imported: true, source: 'historical_import' }); });
  await db.doc('clients/' + importedOnly.uid).set({ coachId: coach.uid, activePlanId: pImp, createdAt: '2026-06-01T00:00:00.000Z' });
  await db.doc('plans/' + pImp).set(makePlanDoc(importedOnly.uid, coach.uid));
  await db.doc('logs/' + importedOnly.uid).set({ planId: pImp, entries: synthLogs, updatedAt: 2 });
  await db.doc('logs/' + importedOnly.uid + '/mesos/' + pImp).set({ planId: pImp, entries: synthLogs, updatedAt: 2 });

  // 5) Inactive client (last activity 40 days ago)
  const oldLogs = makeRecurrentLogs(T_NOW - 45 * DAY_MS, T_NOW - 40 * DAY_MS);
  await db.doc('clients/' + inactive.uid).set({ coachId: coach.uid, activePlanId: pInact, createdAt: '2026-06-01T00:00:00.000Z', status: 'inactive' });
  await db.doc('plans/' + pInact).set(makePlanDoc(inactive.uid, coach.uid, { createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }));
  await db.doc('logs/' + inactive.uid).set({ planId: pInact, entries: oldLogs, updatedAt: 2 });
  await db.doc('logs/' + inactive.uid + '/mesos/' + pInact).set({ planId: pInact, entries: oldLogs, updatedAt: 2 });

  const sw = await sweep.runSweep({ db, enabled: true, numericApplyEnabled: true, clock: () => T_NOW_ISO });
  assert.equal(sw.status, 'SWEPT');

  const recMeso = (await db.doc('logs/' + recurrent.uid + '/mesos/' + pRec).get()).data();
  const newMeso = (await db.doc('logs/' + newIdle.uid + '/mesos/' + pNew).get()).data();
  const impMeso = (await db.doc('logs/' + importedOnly.uid + '/mesos/' + pImp).get()).data();
  const inactMeso = (await db.doc('logs/' + inactive.uid + '/mesos/' + pInact).get()).data();

  assert.equal(Object.values(recMeso.nextExposureOverlays || {}).length, 1, 'recurrent client receives applied overlay');
  assert.equal(Object.values(newMeso.nextExposureOverlays || {}).length, 0, 'new client without activity has 0 overlays');
  assert.equal(Object.values(impMeso.nextExposureOverlays || {}).length, 0, 'imported-only client has 0 overlays');
  assert.equal(Object.values(inactMeso.nextExposureOverlays || {}).length, 0, 'inactive client has 0 overlays');
});

test('T685.E2 new client onboarding on emulator: 0 activity -> first real set + start marker (PRIORITY_B) -> second exposure -> PENDING -> APPLIED -> CONSUMED', { timeout: 90000 }, async () => {
  const coach = await signedIn(), athlete = await signedIn();
  const planId = 'plan-' + athlete.uid;
  const plan = makePlanDoc(athlete.uid, coach.uid, { createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
  const clientDoc = { coachId: coach.uid, activePlanId: planId, createdAt: '2026-10-10T00:00:00.000Z', onboardedAt: '2026-10-10T00:00:00.000Z' };

  await db.doc('coaches/' + coach.uid).set({ role: 'coach', autoApplyCanary: { enabled: true, clientIds: [athlete.uid], prescriptionExerciseIds: [] } });
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: new Date(Date.now() + 36e5).toISOString(), clientIds: [athlete.uid] });
  await db.doc('clients/' + athlete.uid).set(clientDoc);
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + athlete.uid).set({ planId, entries: {}, updatedAt: 1 });
  await db.doc('logs/' + athlete.uid + '/mesos/' + planId).set({ planId, entries: {}, updatedAt: 1 });

  // Step 1: Account just created -> awaiting first activity
  let ev = eligibility.evaluateClientEligibility({ clientId: athlete.uid, client: clientDoc, plan, entries: {}, now: T_NOW_ISO });
  assert.equal(ev.eligible, false);
  assert.equal(ev.reason, 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY');

  // Step 2: Athlete logs first real working set via authenticated client SDK + immutable start marker
  const t1 = T_NOW - 3 * DAY_MS;
  const firstEntries = {};
  [0, 1, 2].forEach(s => {
    firstEntries['log_1_0_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 1, rir_real: 3, prescriptionExerciseId: PID, ts: t1 + s * 1000 };
  });
  await setDoc(doc(athlete.db, 'logs', athlete.uid, 'mesos', planId), { planId, entries: firstEntries, updatedAt: 2 }, { merge: true });
  await setDoc(doc(athlete.db, 'logs', athlete.uid), { planId, entries: firstEntries, updatedAt: 2 }, { merge: true });
  await setDoc(doc(athlete.db, 'logs', athlete.uid, 'starts', planId + '_1_0_0'), { planId, week: 1, dayIndex: 0, exerciseIndex: 0, setKey: 'log_1_0_0_s0', at: serverTimestamp() });

  ev = eligibility.evaluateClientEligibility({ clientId: athlete.uid, client: clientDoc, plan, entries: firstEntries, now: T_NOW_ISO });
  assert.equal(ev.eligible, true);
  assert.equal(ev.priority, 'PRIORITY_B');

  // Step 3: Athlete logs second session -> becomes PRIORITY_A, motor materializes & applies -> athlete acknowledges -> server consumes
  const fullEntries = makeRecurrentLogs(t1, T_NOW - 1 * DAY_MS);
  await setDoc(doc(athlete.db, 'logs', athlete.uid, 'mesos', planId), { planId, entries: fullEntries, updatedAt: 3 }, { merge: true });
  await setDoc(doc(athlete.db, 'logs', athlete.uid), { planId, entries: fullEntries, updatedAt: 3 }, { merge: true });

  ev = eligibility.evaluateClientEligibility({ clientId: athlete.uid, client: clientDoc, plan, entries: fullEntries, now: T_NOW_ISO });
  assert.equal(ev.eligible, true);
  assert.equal(ev.priority, 'PRIORITY_A');
  assert.equal(ev.readyForMotorProgression, true);

  const appliedOut = await executor.processProgression({ db, clientId: athlete.uid, planId, enabled: true, numericApplyEnabled: true, clock: () => new Date().toISOString() });
  assert.equal(appliedOut.status, 'MATERIALIZED');
  assert.deepEqual(appliedOut.applied.map(x => [x.written, x.reason]), [[true, null]]);

  const mesoAfterApply = (await db.doc('logs/' + athlete.uid + '/mesos/' + planId).get()).data();
  const [rec] = Object.values(mesoAfterApply.progressionApplications);
  const [ovl] = Object.values(mesoAfterApply.nextExposureOverlays);
  assert.equal(rec.state, 'APPLIED');
  assert.equal(ovl.status, 'APPLIED');

  // Athlete logs first set of target exposure (week 2, day 0) and writes receipt
  const targetKey = 'log_' + ovl.target.week + '_' + ovl.target.dayIndex + '_0_s0';
  await setDoc(doc(athlete.db, 'logs', athlete.uid, 'mesos', planId), { planId, entries: { [targetKey]: { done: true, carga: '100', reps: '12', unit: 'KG', rir: 1, rir_real: 2, prescriptionExerciseId: PID, ts: T_NOW } } }, { merge: true });
  await setDoc(doc(athlete.db, 'logs', athlete.uid), { planId, entries: { [targetKey]: { done: true, carga: '100', reps: '12', unit: 'KG', rir: 1, rir_real: 2, prescriptionExerciseId: PID, ts: T_NOW } } }, { merge: true });

  await setDoc(doc(athlete.db, 'logs', athlete.uid, 'starts', planId + '_' + ovl.target.week + '_' + ovl.target.dayIndex + '_0'),
    { planId, week: ovl.target.week, dayIndex: ovl.target.dayIndex, exerciseIndex: 0, setKey: targetKey, at: serverTimestamp() });

  const ack = await runTransaction(athlete.db, tx => consumer.recordConsumptionReceiptTransaction(
    tx,
    { meso: doc(athlete.db, 'logs', athlete.uid, 'mesos', planId), root: doc(athlete.db, 'logs', athlete.uid) },
    { recordKey: rec.key, clientId: athlete.uid, now: T_NOW_ISO, shown: { provenance: 'CANONICAL_OVERLAY', overlayKey: ovl.key, dimension: ovl.dimension, appliedValue: ovl.appliedValue } },
    { isCurrent: () => true, canonicalOverlayRead: true }
  ));
  assert.equal(ack.written, true);

  const consumedOut = await executor.processProgression({ db, clientId: athlete.uid, planId, enabled: true, numericApplyEnabled: true, clock: () => new Date().toISOString() });
  assert.deepEqual(consumedOut.consumed.map(x => [x.written, x.reason]), [[true, null]]);
  const mesoFinal = (await db.doc('logs/' + athlete.uid + '/mesos/' + planId).get()).data();
  assert.equal(mesoFinal.progressionApplications[rec.key].state, 'CONSUMED');
  assert.equal(mesoFinal.nextExposureOverlays[ovl.key].status, 'CONSUMED');
});

test('T685.E3 plan suspension, draft status, or client deactivation immediately blocks progression on emulator with zero writes', { timeout: 60000 }, async () => {
  const coach = await signedIn(), athlete = await signedIn();
  const planId = 'plan-' + athlete.uid;
  const logs = makeRecurrentLogs();

  await db.doc('coaches/' + coach.uid).set({ role: 'coach', autoApplyCanary: { enabled: true, clientIds: [athlete.uid], prescriptionExerciseIds: [] } });
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-20T00:00:00.000Z', clientIds: [athlete.uid] });
  await db.doc('clients/' + athlete.uid).set({ coachId: coach.uid, activePlanId: planId });
  await db.doc('plans/' + planId).set(makePlanDoc(athlete.uid, coach.uid, { status: 'suspended' }));
  await db.doc('logs/' + athlete.uid).set({ planId, entries: logs, updatedAt: 2 });
  await db.doc('logs/' + athlete.uid + '/mesos/' + planId).set({ planId, entries: logs, updatedAt: 2 });

  const outSuspended = await executor.processProgression({ db, clientId: athlete.uid, planId, enabled: true, numericApplyEnabled: true, clock: () => T_NOW_ISO });
  assert.equal(outSuspended.status, 'SOURCE_INVALID');
  const m1 = (await db.doc('logs/' + athlete.uid + '/mesos/' + planId).get()).data();
  assert.equal(m1.progressionApplications, undefined);

  // Draft plan test on real emulator
  await db.doc('plans/' + planId).set(makePlanDoc(athlete.uid, coach.uid, { status: 'draft' }));
  const outDraft = await executor.processProgression({ db, clientId: athlete.uid, planId, enabled: true, numericApplyEnabled: true, clock: () => T_NOW_ISO });
  assert.equal(outDraft.status, 'SOURCE_INVALID', 'Draft plan is strictly excluded');
  const mDraft = (await db.doc('logs/' + athlete.uid + '/mesos/' + planId).get()).data();
  assert.equal(mDraft.progressionApplications, undefined, 'Zero progression applications written for draft plan');
});
