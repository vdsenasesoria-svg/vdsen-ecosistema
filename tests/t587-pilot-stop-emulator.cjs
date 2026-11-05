'use strict';
// T587 / FASE E3: the STOP really stops. On the Firestore Emulator, with the REAL trusted executor, the documents written by `scripts/pilot/ayrton-canary.cjs --mode stop` (taken from the same
// builders the script uses) and the kill switches (DISARMED, numeric OFF) are applied to a running athlete: from that instant NO record, NO overlay and NO consumption is written anywhere;
// what was already applied stays readable; re-enabling resumes without duplicating. Synthetic data only (demo-* project).
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't587-stop-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const canary = require('../scripts/pilot/ayrton-canary.cjs');
const { importLikeCoach } = require('./helpers/coach-plan-import.js');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z'), clock = () => '2026-10-01T00:00:00.000Z';
let seq = 0;
async function athlete() {
  const tag = 't587s-' + (++seq) + '-' + Date.now().toString(36), uid = 'Zz' + tag.replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'x').slice(0, 24), planId = 'plan-' + tag, coachId = 'coach-' + tag;
  const planCore = importLikeCoach({ weeks: 6, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D', exercises: [{ exerciseName: 'Press de pecho', technique: 'straight', sets: [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2, load: 100, restSeconds: 90 })) }] }] }, { idPrefix: 'p-' + tag });
  const plan = Object.assign({ schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z' }, planCore), pid = plan.days[0].exercises[0].prescriptionExerciseId;
  const entries = {}; [1, 2].forEach((w) => [0, 1, 2].forEach((s) => { entries['log_' + w + '_0_0_s' + s] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 4, ics: 7.5, prescriptionExerciseId: pid, ts: T0 + w * 1e6 + s }; }));
  entries.progrec_2_0 = { calculatedAt: new Date(T0 + 2e6 + 6e4).toISOString(), recommendations: [{ prescriptionExerciseId: pid, exerciseName: 'Press de pecho', action: 'increase_load', newLoad: 105, newReps: 10 }] };
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: [] });
  await db.doc('plans/' + planId).set(plan); await db.doc('logs/' + uid).set({ planId, entries }); await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries });
  return { uid, planId, coachId, pid, entries };
}
const fences = async (a, rel, can) => {
  await db.doc('releaseControl/autonomousProgression').set(rel); await db.doc('coaches/' + a.coachId).set({ autoApplyCanary: can });
};
const OPEN = (a) => [canary.releaseDoc(a.uid, true, '2026-10-01T01:00:00Z'), canary.canaryField(a.uid, true)], STOPPED = (a) => [canary.releaseDoc(a.uid, false, '2026-10-01T00:00:00Z'), canary.canaryField(a.uid, false)];
const run = (a, extra) => executor.processProgression(Object.assign({ db, clientId: a.uid, planId: a.planId, enabled: true, numericApplyEnabled: true, clock }, extra || {}));
const dump = async (a) => JSON.stringify(await Promise.all(['clients/' + a.uid, 'plans/' + a.planId, 'coaches/' + a.coachId, 'logs/' + a.uid, 'logs/' + a.uid + '/mesos/' + a.planId, 'releaseControl/autonomousProgression'].map(async (p) => (await db.doc(p).get()).data())));
const meso = async (a) => (await db.doc('logs/' + a.uid + '/mesos/' + a.planId).get()).data() || {};
const ov = (m) => Object.values(m.nextExposureOverlays || {}), rec = (m) => Object.values(m.progressionApplications || {});

test('T587-S1 STOP before any processing: stopping the release fence alone, the Coach canary alone, or both => zero writes (nothing materialized, nothing applied)', async () => {
  for (const [name, mk] of [['release stopped', (a) => [STOPPED(a)[0], OPEN(a)[1]]], ['canary stopped', (a) => [OPEN(a)[0], STOPPED(a)[1]]], ['both stopped', STOPPED]]) {
    const a = await athlete(); const [r, c] = mk(a); await fences(a, r, c); const before = await dump(a);
    const out = await run(a); assert.ok(['OUT_OF_ALLOWLIST', 'OUT_OF_CANARY'].includes(out.status), name + ': ' + out.status); assert.equal(await dump(a), before, name + ': not a single document changed');
  }
});

test('T587-S2 STOP while running: a first cycle applies; after the stop, new evidence produces NO new record / overlay / consumption (an acknowledged overlay is NOT consumed); what was applied stays readable', async () => {
  const a = await athlete(); await fences(a, ...OPEN(a));
  const out1 = await run(a); assert.equal(out1.status, 'MATERIALIZED'); let m = await meso(a); assert.equal(ov(m).length, 1); const first = ov(m)[0]; assert.equal(first.status, 'APPLIED');
  await fences(a, ...STOPPED(a));
  // the athlete keeps training: a new exposure + a receipt for the applied overlay + a new recommendation
  const w3 = {}; [0, 1, 2].forEach((s) => { w3['log_3_0_0_s' + s] = { done: true, carga: '105', reps: '10', unit: 'KG', rir: 2, rir_real: 4, ics: 7.5, prescriptionExerciseId: a.pid, ts: T0 + 3e6 + s }; });
  w3.progrec_3_0 = { calculatedAt: new Date(T0 + 3e6 + 6e4).toISOString(), recommendations: [{ prescriptionExerciseId: a.pid, exerciseName: 'Press de pecho', action: 'increase_load', newLoad: 110, newReps: 10 }] };
  const r = rec(m)[0]; await db.doc('logs/' + a.uid + '/mesos/' + a.planId).set({ entries: w3, consumptionReceipts: { [r.key]: { recordKey: r.key, overlayKey: first.key, dimension: first.dimension, appliedValue: first.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: clock() } } }, { merge: true });
  await db.doc('logs/' + a.uid).set({ entries: w3 }, { merge: true });
  const before = await dump(a); const out2 = await run(a); assert.ok(['OUT_OF_ALLOWLIST', 'OUT_OF_CANARY'].includes(out2.status), out2.status); assert.deepEqual([out2.applied, out2.consumed], [[], []]);
  assert.equal(await dump(a), before, 'after STOP nothing is written, not even the consumption of an acknowledged overlay');
  m = await meso(a); assert.equal(ov(m).length, 1); assert.equal(ov(m)[0].status, 'APPLIED', 'the applied overlay is still there (readable), not consumed'); assert.equal(rec(m).length, 1);
});

test('T587-S3 kill switches: DISARMED writes nothing; numeric apply OFF only materializes PENDING (what would be prescribed) and never an overlay; after re-enabling, the SAME records apply exactly once', async () => {
  const a = await athlete(); await fences(a, ...OPEN(a)); const d0 = await dump(a);
  assert.deepEqual(await run(a, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await dump(a), d0);
  const obs = await run(a, { numericApplyEnabled: false }); assert.deepEqual([obs.applied, obs.consumed], [[], []]); let m = await meso(a); assert.equal(ov(m).length, 0); assert.ok(rec(m).every((x) => x.state === 'PENDING'));
  const keys = rec(m).map((x) => x.key).sort(); await run(a); await run(a); m = await meso(a);
  assert.deepEqual(rec(m).map((x) => x.key).sort(), keys, 'the observed records are the ones applied: no duplicates'); assert.equal(ov(m).length, 1); assert.equal(rec(m)[0].events.filter((e) => e.state === 'APPLIED').length, 1);
});

test('T587-S4 the stop is per athlete: stopping one athlete does not touch another listed in the same allowlist; a second athlete still processes normally', async () => {
  const a = await athlete(), b = await athlete();
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: '2026-10-01T01:00:00Z', clientIds: [a.uid, b.uid] });
  await db.doc('coaches/' + a.coachId).set({ autoApplyCanary: canary.canaryField(a.uid, false) }); await db.doc('coaches/' + b.coachId).set({ autoApplyCanary: canary.canaryField(b.uid, true) });
  const da = await dump(a); assert.equal((await run(a)).status, 'OUT_OF_CANARY'); assert.equal(await dump(a), da);
  assert.equal((await run(b)).status, 'MATERIALIZED'); assert.equal(ov(await meso(b)).length, 1);
});
