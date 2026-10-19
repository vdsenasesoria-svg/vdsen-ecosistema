'use strict';
// T581: LOAD identity through the Coach's EXPLICIT link (coaches/{uid}.exerciseLinks: prescriptionExerciseId -> catalog exerciseId), real Admin SDK + Firestore Emulator.
// The Motor / importers do not store an exerciseId in the plan, so without a link the autonomous LOAD path cannot identify the equipment and stays BLOCKED.
// All data is SYNTHETIC (public catalog identity + a synthetic Coach-configured increment).
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const app = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow' }, 't581-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const EX = 'sf-sd-converging-lat-pulldown-plate-loaded', PID = 'pid-t581-link', clock = () => '2026-10-01T00:00:00.000Z';
const STEP = { kind: 'STEP', step: 5, min: 0, unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t581', revision: 1 };
let seq = 0;

async function seed(o) {
  o = o || {};
  const tag = 't581-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, planId = 'plan-' + tag, coachId = 'coach-' + tag, logs = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 4, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }; }));
  logs.progrec_1_2 = { calculatedAt: new Date(T0 + 60000).toISOString(), recommendations: [{ prescriptionExerciseId: PID, exerciseName: 'Jalon T581', action: 'increase_load', newLoad: 105 }] };
  const exercise = { prescriptionExerciseId: PID, exerciseName: 'Jalon T581', repsRange: { min: 8, max: 12 }, sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 0 })) };
  if (o.planExerciseId) exercise.exerciseId = o.planExerciseId;                 // NOTE: the Motor plan has none by default
  const plan = { schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', weeks: 4, daysPerWeek: 2, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    days: [0, 2].map(dayIndex => ({ dayIndex, label: 'Dia ' + dayIndex, exercises: [JSON.parse(JSON.stringify(exercise))] })) };
  const coach = { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [PID] }, equipmentIncrements: { shared: { [EX]: STEP }, gyms: {} } };
  if (o.links) coach.exerciseLinks = o.links;
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId });
  await db.doc('coaches/' + coachId).set(coach);
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId, coachId, logs };
}
const run = async (s) => {
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [s.uid] });
  return executor.processProgression({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock });
};
const meso = async (s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});

test('T581-A (T582) plan WITHOUT exerciseId and NO link => LOAD is an ADVISORY target (machine unknown, progression not withheld)', async () => {
  const s = await seed(); const out = await run(s); const m = await meso(s);
  assert.deepEqual([out.applied[0].written, out.applied[0].blocked], [true, null]);
  assert.equal(overlays(m).length, 1); assert.equal(overlays(m)[0].equipmentId, null); assert.equal(overlays(m)[0].equipmentSnapshot.source, 'ADVISORY_GENERIC'); assert.equal(overlays(m)[0].appliedValue, 105);
});

test('T581-B plan without exerciseId + Coach link by PID => LOAD APPLIED 100 -> 105 KG, plan untouched', async () => {
  const s = await seed({ links: { [PID]: EX } });
  const planBefore = JSON.stringify((await db.doc('plans/' + s.planId).get()).data());
  const out = await run(s); const m = await meso(s), ov = overlays(m)[0];
  assert.deepEqual(out.applied.map(x => x.written), [true]);
  assert.equal(overlays(m).length, 1); assert.equal(ov.dimension, 'LOAD'); assert.equal(ov.previousValue, 100); assert.equal(ov.appliedValue, 105); assert.equal(ov.equipmentId, EX);
  assert.equal(JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), planBefore, 'the link never rewrites the plan or its updatedAt');
  await run(s); await run(s);
  assert.equal(overlays(await meso(s)).length, 1, 'idempotent');
});

test('T581-C (T582) a link for another PID, to an unknown catalog id, or a non-string value does not identify the equipment (the LOAD target stays advisory)', async () => {
  for (const links of [{ 'pid-otro': EX }, { [PID]: 'ex-not-in-catalog' }, { [PID]: 42 }, { [PID]: { x: 1 } }]) {
    const s = await seed({ links }); const out = await run(s);
    assert.deepEqual([out.applied[0].written, out.applied[0].blocked], [true, null], JSON.stringify(links));
    const ov = overlays(await meso(s)); assert.equal(ov.length, 1); assert.equal(ov[0].equipmentId, null, 'a bad link never produces an equipment identity: ' + JSON.stringify(links));
  }
});

test('T581-D the plan own exerciseId wins over a link; a link that is not the athlete coach (other coach doc) is ignored', async () => {
  const s = await seed({ planExerciseId: EX, links: { [PID]: 'ex-not-in-catalog' } });
  const out = await run(s); assert.deepEqual(out.applied.map(x => x.written), [true], 'plan exerciseId is used, the bad link is never consulted');
  const t = await seed(); await db.doc('coaches/some-other-coach').set({ exerciseLinks: { [PID]: EX }, equipmentIncrements: { shared: { [EX]: STEP }, gyms: {} } });
  const out2 = await run(t); assert.equal(out2.applied[0].written, true); assert.equal(overlays(await meso(t))[0].equipmentId, null, 'only the coach of THIS client counts: the other coach link/increment gives no equipment identity (advisory)');
});
