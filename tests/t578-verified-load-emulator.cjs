'use strict';
// T578: LOAD application with VERIFIED equipment data, end to end on the REAL Firebase Admin SDK (Firestore emulator).
// All data is SYNTHETIC: the equipment IDENTITY comes from the shipped exercise catalog (a public file), the INCREMENT configuration is a
// synthetic Coach-configured fixture declared below. Nothing here describes any real client's equipment.
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
const app = admin.initializeApp({ projectId }, 't578-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription.js');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const EXERCISE_ID = 'sf-sd-converging-lat-pulldown-plate-loaded';          // catalog entry with a canonical equipmentId (identity only)
const EQUIPMENT_ID = 'sf-sd-converging-lat-pulldown-plate-loaded';
const PID = 'pid-t578-load';
const clock = () => new Date().toISOString();   // T602: the emulator stamps plan.updateTime with the real clock, so the server-materialization instant must be real too
let seq = 0;

// SYNTHETIC verified increment (Coach-configured, with provenance). Not real gym data.
const stepMeta = (o) => Object.assign({ kind: 'STEP', step: 5, min: 0, unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT',
  configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t578', revision: 1 }, o || {});

async function seed(o) {
  o = o || {};
  const tag = 't578-' + (o.tag || 'x') + '-' + (++seq) + '-' + Date.now().toString(36);
  const uid = 'ath-' + tag, planId = 'plan-' + tag, coachId = 'coach-' + tag, logs = {};
  const rirTarget = o.rirTarget === undefined ? 2 : o.rirTarget, rirReal = o.rirReal === undefined ? 4 : o.rirReal;
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: String(o.load === undefined ? 100 : o.load), reps: '10', unit: o.unit || 'KG', rir: rirTarget, rir_real: rirReal, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }; }));
  logs.progrec_1_2 = { calculatedAt: new Date(T0 + 60000).toISOString(), recommendations: [{ prescriptionExerciseId: PID, exerciseId: o.exerciseId || EXERCISE_ID, exerciseName: 'Jalon T578', action: 'increase_load', newLoad: o.newLoad === undefined ? 105 : o.newLoad }] };
  const plan = { schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', weeks: 4, daysPerWeek: 2, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    days: [0, 2].map(dayIndex => ({ dayIndex, label: 'Dia ' + dayIndex, exercises: [{ prescriptionExerciseId: PID, exerciseId: o.exerciseId || EXERCISE_ID, exerciseName: 'Jalon T578', repsRange: { min: 8, max: 12 },
      sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget, restSeconds: 90, load: 0 })) }] })) };
  const coach = { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [PID] } };
  if (o.increment) coach.equipmentIncrements = { shared: { [EQUIPMENT_ID]: o.increment }, gyms: {} };
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId });
  await db.doc('coaches/' + coachId).set(coach);
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [uid] }, { merge: false });
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId, coachId, plan, logs };
}
// The release allowlist is a single global document: every run opens it for exactly the athlete being processed (unless a test sets it itself).
const run = async (s, extra) => {
  const { keepAllowlist, ...rest } = extra || {};
  if (!keepAllowlist) await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [s.uid] });
  return executor.processProgression(Object.assign({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock }, rest));
};
const meso = async (s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();

const digest = async (s) => JSON.stringify(await Promise.all(['clients/' + s.uid, 'plans/' + s.planId, 'coaches/' + s.coachId, 'logs/' + s.uid].map(async p => (await db.doc(p).get()).data())));
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});
const records = (m) => Object.values((m && m.progressionApplications) || {});
const states = (r) => r.events.map(e => e.state);
const baseSets = [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 100 }));

test('T578-A verified STEP increment: LOAD 100 -> 105 KG is APPLIED, read by the next exposure, then CONSUMED', async () => {
  const s = await seed({ tag: 'a', increment: stepMeta() });
  const bystander = await seed({ tag: 'bystander', increment: stepMeta() });
  const planBefore = JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), byBefore = await digest(bystander), entriesBefore = JSON.stringify((await meso(s)).entries);
  const out = await run(s);
  assert.equal(out.status, 'MATERIALIZED');
  assert.deepEqual(out.applied.map(x => [x.written, x.reason, x.blocked]), [[true, null, null]]);
  let m = await meso(s);
  const ov = overlays(m)[0], rec = records(m)[0];
  assert.equal(overlays(m).length, 1); assert.equal(records(m).length, 1);
  assert.equal(rec.state, 'APPLIED'); assert.deepEqual(states(rec), ['PENDING', 'APPLIED']);
  assert.equal(ov.dimension, 'LOAD'); assert.equal(ov.status, 'APPLIED');
  assert.equal(ov.previousValue, 100); assert.equal(ov.requestedValue, 105); assert.equal(ov.appliedValue, 105);
  assert.equal(ov.unit, 'KG'); assert.equal(ov.roundingReason, 'EXACT');
  assert.equal(ov.equipmentId, EQUIPMENT_ID); assert.equal(ov.prescriptionExerciseId, PID);
  assert.equal(ov.equipmentSnapshot.kind, 'STEP'); assert.equal(ov.equipmentSnapshot.source, 'COACH_CONFIGURED'); assert.equal(ov.equipmentSnapshot.unit, 'KG');
  assert.equal(ov.equipmentSnapshot.scope, 'SHARED_EQUIPMENT'); assert.equal(ov.equipmentSnapshot.revision, 1);
  assert.deepEqual(ov.target, { week: 2, dayIndex: 0 });
  assert.equal(ov.clientId, s.uid); assert.equal(ov.planId, s.planId);
  assert.equal(JSON.stringify(m.entries), entriesBefore, 'execution evidence untouched');
  assert.equal(JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), planBefore, 'base plan immutable');
  assert.equal(await digest(bystander), byBefore, 'no write outside the processed athlete');
  const plan = (await db.doc('plans/' + s.planId).get()).data();
  const eff = effective.resolveEffective({ clientId: s.uid, planId: s.planId, activePlanId: s.planId, pid: PID, week: ov.target.week, dayIndex: ov.target.dayIndex,
    records: m.progressionApplications, overlays: m.nextExposureOverlays, interventions: [], plan, entries: m.entries, baseSets, canonicalOverlayRead: true });
  assert.equal(eff.provenance, 'CANONICAL_OVERLAY');
  assert.equal(eff.sets[0].effective.load, 105);
  const t = ov.target, first = {};
  first['log_' + t.week + '_' + t.dayIndex + '_0_s0'] = { done: true, carga: '105', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: T0 + 9e6 };
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ entries: first }, { merge: true });
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ consumptionReceipts: { [rec.key]: { recordKey: rec.key, overlayKey: ov.key, dimension: 'LOAD', appliedValue: 105, provenance: 'CANONICAL_OVERLAY', ackAt: clock() } } }, { merge: true });
  const out2 = await run(s);
  assert.deepEqual(out2.consumed.map(x => x.written), [true], JSON.stringify(out2.consumed));
  m = await meso(s);
  assert.equal(records(m)[0].state, 'CONSUMED'); assert.equal(overlays(m)[0].status, 'CONSUMED');
  assert.equal(overlays(m)[0].appliedValue, 105, 'applied value unchanged by consumption');
  assert.equal(states(records(m)[0]).filter(x => x === 'CONSUMED').length, 1);
  await run(s); await run(s);
  m = await meso(s);
  assert.equal(overlays(m).length, 1); assert.equal(states(records(m)[0]).filter(x => x === 'CONSUMED').length, 1, 'repeat after CONSUMED adds nothing');
});

for (const [name, mk] of [
  ['PLATE_LOADED_BAR (bar 20, plate 2.5 => 5 kg grid)', () => ({ kind: 'PLATE_LOADED_BAR', unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t578', revision: 1, barWeight: 20, smallestPlate: 2.5 })],
  ['AVAILABLE_LOADS [90,100,105,110]', () => ({ kind: 'AVAILABLE_LOADS', unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t578', revision: 1, loads: [90, 100, 105, 110] })]]) {
  test('T578-A2 verified ' + name + ' realizes 105', async () => {
    const increment = mk(), s = await seed({ tag: 'a2', increment });
    const out = await run(s); const ov = overlays(await meso(s));
    assert.deepEqual(out.applied.map(x => x.written), [true]);
    assert.equal(ov.length, 1); assert.equal(ov[0].appliedValue, 105); assert.equal(ov[0].previousValue, 100); assert.equal(ov[0].equipmentSnapshot.kind, increment.kind);
  });
}

// T582 (owner decision): equipment data is OPTIONAL. Whatever the state of the equipment information (none, unknown exercise, tie on the grid, configured limit,
// unit mismatch, invalid metadata) the LOAD progression is NOT withheld: it becomes an ADVISORY target (no machine claim) that the athlete adapts to what they have.
const advisoryCases = [
  ['B1 no increment configured for a KNOWN equipment', {}, 105],
  ['B2 unknown exercise => equipment identity unresolved', { exerciseId: 'ex-t578-not-in-catalog', increment: stepMeta() }, 105],
  ['C1 raw 102.5 is a tie between 100 and 105 on the configured grid', { increment: stepMeta(), rirReal: 3, newLoad: 102.5 }, 102.5],
  ['C2 available loads lack the step above (tie)', { increment: { kind: 'AVAILABLE_LOADS', unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', revision: 1, loads: [90, 100, 110] } }, 105],
  ['C3 equipment maximum 100 kg', { increment: stepMeta({ max: 100 }) }, 105],
  ['C4 increment configured in LB, evidence in KG', { increment: stepMeta({ unit: 'LB' }) }, 105],
  ['C5 invalid increment metadata (step 0)', { increment: stepMeta({ step: 0 }) }, 105]
];
for (const [name, o, expected] of advisoryCases) {
  test('T578-' + name + ' => ADVISORY LOAD target (T582), applied, no machine claim', async () => {
    const s = await seed(Object.assign({ tag: 'advisory' }, o));
    const out = await run(s);
    assert.equal(out.applied.length, 1);
    assert.deepEqual([out.applied[0].written, out.applied[0].blocked, out.applied[0].reason], [true, null, null], JSON.stringify(out.applied));
    const m = await meso(s), ov = overlays(m)[0];
    assert.equal(overlays(m).length, 1); assert.equal(records(m).length, 1); assert.equal(records(m)[0].state, 'APPLIED');
    assert.equal(ov.dimension, 'LOAD'); assert.equal(ov.previousValue, 100); assert.equal(ov.appliedValue, expected); assert.equal(ov.unit, 'KG');
    assert.equal(ov.equipmentId, null, 'an advisory target makes no equipment claim'); assert.equal(ov.equipmentSnapshot.source, 'ADVISORY_GENERIC'); assert.match(ov.roundingReason, /^ADVISORY_/);
    assert.equal(JSON.stringify(m.entries), JSON.stringify(s.logs), 'evidence untouched');
    await run(s); await run(s);
    const m2 = await meso(s); assert.equal(overlays(m2).length, 1); assert.equal(records(m2).length, 1);
  });
}

test('T578-D idempotency: sequential and concurrent repeats create ONE record, ONE APPLIED event, ONE overlay', async () => {
  const s = await seed({ tag: 'd', increment: stepMeta() });
  await run(s); await run(s);
  await Promise.all([run(s), run(s), run(s), run(s)]);
  const m = await meso(s);
  assert.equal(records(m).length, 1); assert.equal(overlays(m).length, 1);
  assert.equal(states(records(m)[0]).filter(x => x === 'APPLIED').length, 1);
  assert.equal(overlays(m)[0].appliedValue, 105);
});

test('T578-E flags OFF: DISARMED writes nothing; numeric apply OFF materializes PENDING only (no LOAD overlay)', async () => {
  const s = await seed({ tag: 'e', increment: stepMeta() });
  const d0 = await digest(s), m0 = JSON.stringify(await meso(s));
  const off = await run(s, { enabled: false });
  assert.deepEqual(off, { status: 'DISARMED', writes: 0 });
  assert.equal(await digest(s), d0); assert.equal(JSON.stringify(await meso(s)), m0);
  const pend = await run(s, { numericApplyEnabled: false });
  assert.deepEqual([pend.applied, pend.consumed], [[], []]);
  const m = await meso(s);
  assert.equal(overlays(m).length, 0); assert.equal(records(m)[0].state, 'PENDING');
  const on = await run(s);
  assert.deepEqual(on.applied.map(x => x.written), [true]);
  assert.equal(records(await meso(s)).length, 1);
});

test('T578-F scope: a PID outside the canary and a client outside the allowlist get no LOAD record or overlay', async () => {
  const s = await seed({ tag: 'f', increment: stepMeta() });
  await db.doc('coaches/' + s.coachId).set({ autoApplyCanary: { enabled: true, clientIds: [s.uid], prescriptionExerciseIds: ['pid-other'] }, equipmentIncrements: { shared: { [EQUIPMENT_ID]: stepMeta() }, gyms: {} } });
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [s.uid] });
  const a = await run(s, { keepAllowlist: true }); let m = await meso(s);
  assert.equal(records(m).length, 0); assert.equal(overlays(m).length, 0); assert.equal(a.status, 'NO_CHANGE');
  const g = await seed({ tag: 'g', increment: stepMeta() });
  await db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ['someone-else'] });
  const b = await run(g, { keepAllowlist: true });
  assert.equal(b.status, 'OUT_OF_ALLOWLIST'); m = await meso(g); assert.equal(records(m).length, 0); assert.equal(overlays(m).length, 0);
});

test('T578-G result does not depend on processing order', async () => {
  const mk = async (tag) => seed({ tag, increment: stepMeta() });
  const a1 = await mk('o1a'), b1 = await mk('o1b'), a2 = await mk('o2a'), b2 = await mk('o2b');
  await run(a1); await run(b1); await run(b2); await run(a2);
  const val = async (s) => { const o = overlays(await meso(s))[0]; return [o.dimension, o.previousValue, o.appliedValue, o.unit, o.roundingReason]; };
  assert.deepEqual(await val(a1), await val(a2)); assert.deepEqual(await val(b1), await val(b2)); assert.deepEqual(await val(a1), ['LOAD', 100, 105, 'KG', 'EXACT']);
});
