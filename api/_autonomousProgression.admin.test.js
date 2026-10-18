'use strict';
// T576: the trusted executor against the REAL Firebase Admin SDK (Firestore emulator). The fake/REST drivers used elsewhere do not enforce
// Admin semantics (undefined values, read-before-write in transactions), which is where the hosted APPLIED path failed.
// Runs only with FIRESTORE_EMULATOR_HOST (e.g. `firebase emulators:exec --only firestore "node --test api/_autonomousProgression.admin.test.js"`).
const test = require('node:test');
const assert = require('node:assert/strict');
const EMU = process.env.FIRESTORE_EMULATOR_HOST;
const skip = EMU ? false : 'FIRESTORE_EMULATOR_HOST not set';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');

async function seed(db, o) {
  o = o || {};
  const pid = 'pid-t576', planId = 'plan-t576-' + (o.tag || 'a'), uid = 'athlete-t576-' + (o.tag || 'a'), logs = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: o.rir === undefined ? 1 : o.rir, rir_real: 3, prescriptionExerciseId: pid, ts: T0 + d * 1000 + s }; }));
  logs.progrec_1_2 = { calculatedAt: new Date(T0 + 60000).toISOString(), recommendations: [{ prescriptionExerciseId: pid, exerciseId: 'ex-t576', exerciseName: 'Press T576', action: 'increase_reps', newReps: 11 }] };
  const plan = { schema: 'vdsen-plan-v2', clientId: uid, coachId: 'coach-t576', status: 'active', weeks: 4, daysPerWeek: 2, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    days: [0, 2].map(dayIndex => ({ dayIndex, label: 'Dia ' + dayIndex, exercises: [{ prescriptionExerciseId: pid, exerciseId: 'ex-t576', exerciseName: 'Press T576', repsRange: { min: 8, max: 12 },
      sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 1, restSeconds: 90, load: 0 })) }] })) };
  await db.doc('clients/' + uid).set({ coachId: 'coach-t576', activePlanId: planId });
  await db.doc('coaches/coach-t576').set({ autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [pid] } });
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [uid] });
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId, pid };
}
const mesoOf = async (db, s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();

test('T576 Admin SDK: PENDING -> APPLIED (REPS overlay) and idempotent repeat', { skip }, async () => {
  const admin = require('firebase-admin');
  const app = admin.initializeApp({ projectId: 'demo-t576' }, 't576-a');
  const db = admin.firestore(app), executor = require('./_autonomousProgression');
  const s = await seed(db);
  const clock = () => '2026-10-01T00:00:00.000Z';
  const out = await executor.processProgression({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock });
  assert.equal(out.status, 'MATERIALIZED');
  assert.equal(out.applied.length, 1);
  assert.equal(out.applied[0].written, true, JSON.stringify(out.applied));
  const m = await mesoOf(db, s);
  const rec = Object.values(m.progressionApplications)[0], ov = Object.values(m.nextExposureOverlays)[0];
  assert.equal(rec.state, 'APPLIED'); assert.equal(ov.dimension, 'REPS'); assert.equal(ov.status, 'APPLIED');
  const again = await executor.processProgression({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock });
  assert.equal(Object.keys((await mesoOf(db, s)).nextExposureOverlays).length, 1, 'repeat does not create a second overlay');
  assert.ok(again);
});
