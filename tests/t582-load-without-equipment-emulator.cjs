'use strict';
// T582 (owner decision): progressive overload depends on the athlete's LOGBOOK and the VDSEN rules, NOT on knowing the machine.
//   - LOAD is never withheld for lack of equipment identity / increments: without verified equipment the target is ADVISORY (the athlete adapts it).
//   - The load the athlete REALLY executed (logbook) is the evidence of the next evaluation, not the suggested one.
//   - REPS progress inside the rep range the Motor prescribed; with fixed reps nothing is invented.
// Real Firebase Admin SDK + Firestore Emulator, synthetic clients only. Plans are produced by the REAL Coach import normalizer (tests/helpers/coach-plan-import.js).
const test = require('node:test');
const assert = require('node:assert/strict');
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator is required');
const admin = require('firebase-admin');
const projectId = process.env.GCLOUD_PROJECT || 'demo-vdsen-shadow';
assert.match(projectId, /^demo-/);
const app = admin.initializeApp({ projectId }, 't582-admin');
const db = admin.firestore(app);
const executor = require('../api/_autonomousProgression');
const effective = require('../assets/progression-effective-prescription.js');
const { importLikeCoach } = require('./helpers/coach-plan-import.js');
test.after(async () => { await app.delete(); });

const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const clock = () => '2026-10-01T00:00:00.000Z';
const STEP5 = { kind: 'STEP', step: 5, min: 0, unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t582', revision: 1 };
const CATALOG_NAME = 'Jalón Dorsal Convergente discos', CATALOG_ID = 'sf-sd-converging-lat-pulldown-plate-loaded';
let seq = 0;

// o: names, load, unit (null => the logbook carries no unit), rirTarget, rirReal, repsTarget, repsRange, weeks, rec(action,extra) | null, interventions, increments, planUpdatedAt, legacy
async function seed(o) {
  o = o || {};
  const tag = 't582-' + (++seq) + '-' + Date.now().toString(36), uid = 'ath-' + tag, planId = 'plan-' + tag, coachId = 'coach-' + tag;
  const names = o.names || ['Press T582'], rirTarget = o.rirTarget || 2, rirReal = o.rirReal || 4, repsTarget = o.repsTarget || 10;
  let plan;
  if (o.legacy) {   // a hand-written / old plan: PID + name + sets only (no exerciseId, no repsRange, none of the new fields)
    plan = { schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', weeks: 4, daysPerWeek: 1, createdAt: '2026-09-26T00:00:00.000Z', updatedAt: o.planUpdatedAt || '2026-09-26T00:00:00.000Z',
      days: [{ dayIndex: 0, label: 'Dia 0', exercises: names.map((n, e) => Object.assign({ prescriptionExerciseId: 'legacy-' + tag + '-' + e, exerciseName: n,
        sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget, rirTarget, restSeconds: 90, load: 0 })) }, o.repsRange ? { repsRange: o.repsRange } : {})) }] };
  } else {
    const motor = { weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Día 0', exercises: names.map((exerciseName) => Object.assign({ exerciseName, technique: 'straight',
      sets: [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget, rirTarget, load: 0, restSeconds: 90 })) }, o.repsRange ? { repsRange: o.repsRange } : {})) }] };
    plan = Object.assign({ schema: 'vdsen-plan-v2', clientId: uid, coachId, status: 'active', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: o.planUpdatedAt || '2026-09-26T00:00:00.000Z' }, importLikeCoach(motor, { idPrefix: 'pid-' + tag }));
  }
  const pids = plan.days[0].exercises.map((e) => e.prescriptionExerciseId);
  const logs = {}, weeks = o.weeks || [1, 2], last = weeks[weeks.length - 1];
  weeks.forEach((w) => names.forEach((n, e) => [0, 1, 2].forEach((s) => {
    const row = { done: true, carga: String(o.load === undefined ? 100 : o.load), reps: String(repsTarget), rir: rirTarget, rir_real: rirReal, prescriptionExerciseId: pids[e], ts: T0 + w * 1e6 + e * 100 + s };
    if (o.unit !== null) row.unit = o.unit || 'KG';
    logs['log_' + w + '_0_' + e + '_s' + s] = row;
  })));
  if (o.rec !== null) {
    const rec = o.rec || ((action, extra) => Object.assign({ action }, extra));
    const make = (pid, ex, i) => Object.assign({ prescriptionExerciseId: pid, exerciseName: ex.exerciseName }, ex.exerciseId ? { exerciseId: ex.exerciseId } : {}, o.recFor ? o.recFor(i) : { action: 'increase_load', newLoad: 105 });
    logs['progrec_' + last + '_0'] = { calculatedAt: new Date(T0 + last * 1e6 + 60000).toISOString(), recommendations: plan.days[0].exercises.map((ex, i) => make(pids[i], ex, i)) };
  }
  Object.assign(logs, o.extraLogs || {});
  const coach = { autoApplyCanary: { enabled: true, clientIds: [uid], prescriptionExerciseIds: [] } };
  if (o.increments) coach.equipmentIncrements = o.increments;
  await db.doc('clients/' + uid).set({ coachId, activePlanId: planId, coachInterventions: o.interventions || [] });
  await db.doc('coaches/' + coachId).set(coach);
  await db.doc('plans/' + planId).set(plan);
  await db.doc('logs/' + uid).set({ planId, entries: logs });
  await db.doc('logs/' + uid + '/mesos/' + planId).set({ planId, entries: logs });
  return { uid, planId, coachId, plan, pids, logs, last };
}
const open = (ids) => db.doc('releaseControl/autonomousProgression').set({ schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: ids });
const run = async (s, extra) => { const { keepAllowlist, ...rest } = extra || {}; if (!keepAllowlist) await open([s.uid]); return executor.processProgression(Object.assign({ db, clientId: s.uid, planId: s.planId, enabled: true, numericApplyEnabled: true, clock }, rest)); };
const meso = async (s) => (await db.doc('logs/' + s.uid + '/mesos/' + s.planId).get()).data();
const overlays = (m) => Object.values((m && m.nextExposureOverlays) || {});
const records = (m) => Object.values((m && m.progressionApplications) || {});
const digest = async (s) => JSON.stringify(await Promise.all(['clients/' + s.uid, 'plans/' + s.planId, 'coaches/' + s.coachId, 'logs/' + s.uid, 'logs/' + s.uid + '/mesos/' + s.planId].map(async (p) => (await db.doc(p).get()).data())));
const eff = async (s, m, ov, interventions, unit) => {
  const plan = (await db.doc('plans/' + s.planId).get()).data(), ex = plan.days[0].exercises.find((e) => e.prescriptionExerciseId === ov.prescriptionExerciseId);
  return effective.resolveEffective({ clientId: s.uid, planId: s.planId, activePlanId: s.planId, pid: ov.prescriptionExerciseId, week: ov.target.week, dayIndex: ov.target.dayIndex, records: m.progressionApplications || {}, overlays: m.nextExposureOverlays || {},
    interventions: interventions || [], plan, entries: m.entries, baseSets: ex.sets.map((x) => Object.assign({}, x)), canonicalOverlayRead: true, unit });
};

test('T582-01 LOAD WITHOUT any equipment data: the target is advisory (100 -> 105 KG), the next session shows it, the base plan is untouched', async () => {
  const s = await seed();
  assert.ok(!('exerciseId' in s.plan.days[0].exercises[0]), 'unknown to the catalog: no exerciseId'); assert.equal((await db.doc('coaches/' + s.coachId).get()).data().equipmentIncrements, undefined);
  const planBefore = JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), entriesBefore = JSON.stringify((await meso(s)).entries);
  const out = await run(s);
  assert.equal(out.status, 'MATERIALIZED', JSON.stringify(out)); assert.deepEqual(out.applied.map((a) => [a.written, a.blocked, a.reason]), [[true, null, null]]);
  const m = await meso(s), [ov] = overlays(m), [rec] = records(m);
  assert.equal(rec.state, 'APPLIED'); assert.deepEqual(rec.events.map((e) => e.state), ['PENDING', 'APPLIED']);
  assert.equal(ov.dimension, 'LOAD'); assert.equal(ov.previousValue, 100); assert.equal(ov.appliedValue, 105); assert.equal(ov.unit, 'KG');
  assert.equal(ov.equipmentId, null); assert.equal(ov.equipmentSnapshot.source, 'ADVISORY_GENERIC'); assert.match(ov.roundingReason, /^ADVISORY_/); assert.deepEqual(ov.target, { week: 3, dayIndex: 0 });
  assert.equal(JSON.stringify((await db.doc('plans/' + s.planId).get()).data()), planBefore, 'base plan immutable'); assert.equal(JSON.stringify(m.entries), entriesBefore, 'logbook untouched');
  const e = await eff(s, m, ov); assert.equal(e.provenance, 'CANONICAL_OVERLAY'); assert.equal(e.sets[0].effective.load, 105); assert.equal(e.sets[0].base.load, 0, 'the base prescription keeps load 0 (the athlete logs the real load)'); assert.equal(e.unit, 'KG');
  assert.match(e.presentation.text, /100 → 105 kg/);
  assert.notEqual((await eff(s, m, ov, [], 'LB')).provenance, 'CANONICAL_OVERLAY', 'a different display unit never shows a number in the wrong unit');
});

test('T582-02 the unit is identified from the logbook: LB evidence gives an LB target (never converted to KG)', async () => {
  const s = await seed({ load: 220, unit: 'LB' }); await run(s); const [ov] = overlays(await meso(s));
  assert.equal(ov.unit, 'LB'); assert.equal(ov.previousValue, 220); assert.equal(ov.appliedValue, 231); assert.equal(ov.roundingReason, 'ADVISORY_GRAIN_1');
});

test('T582-03 the target is the rule step tidied to a generic grain (0.5 KG), not an equipment claim', async () => {
  const s = await seed({ load: 47 }); await run(s); const [ov] = overlays(await meso(s));
  assert.equal(ov.previousValue, 47); assert.equal(ov.requestedValue, 49.35); assert.equal(ov.appliedValue, 49.5); assert.equal(ov.roundingReason, 'ADVISORY_GRAIN_0.5');
});

test('T582-04 unit handling: a logbook with no unit uses the Client default (KG) and says so; an UNKNOWN unit is the only LOAD data block left (nothing invented)', async () => {
  const dflt = await seed({ unit: null }); await run(dflt); const [ov] = overlays(await meso(dflt));
  assert.equal(ov.unit, 'KG', 'the overlay always carries the unit it is expressed in'); assert.equal(ov.appliedValue, 105);
  const odd = await seed({ unit: 'stone' }); const out = await run(odd); const m = await meso(odd);
  assert.equal(overlays(m).length, 0, JSON.stringify(out)); assert.deepEqual(out.applied.map((a) => [a.written, a.reason, a.blocked]), [[false, 'ADVISORY_LOAD_UNAVAILABLE', 'BLOCKED_LOAD_DATA']]);
  assert.equal(records(m)[0].state, 'PENDING', 'the record stays reviewable');
});

test('T582-05 verified equipment is OPTIONAL extra precision: it is used when it resolves, and never blocks when it does not', async () => {
  const inc = { shared: { [CATALOG_ID]: STEP5 }, gyms: {} };
  const exact = await seed({ names: [CATALOG_NAME], increments: inc }); await run(exact); const [o1] = overlays(await meso(exact));
  assert.equal(exact.plan.days[0].exercises[0].exerciseId, CATALOG_ID); assert.equal(o1.equipmentId, CATALOG_ID); assert.equal(o1.appliedValue, 105); assert.equal(o1.roundingReason, 'EXACT', 'machine-exact grid');
  const tie = await seed({ names: [CATALOG_NAME], increments: inc, rirReal: 3, recFor: () => ({ action: 'increase_load', newLoad: 102.5 }) }); const out = await run(tie); const [o2] = overlays(await meso(tie));
  assert.deepEqual(out.applied.map((a) => [a.written, a.blocked]), [[true, null]], 'a +2.5 step on a 5 kg grid is a tie => advisory fallback, not a block');
  assert.equal(o2.equipmentId, null); assert.equal(o2.appliedValue, 102.5);
});

test('T582-06 REPS progress INSIDE the prescribed range; fixed reps get no invented range; a step past the ceiling is not applied', async () => {
  const inRange = await seed({ rirTarget: 1, rirReal: 3, repsRange: { min: 8, max: 12 }, recFor: () => ({ action: 'increase_reps', newReps: 12 }) });
  assert.deepEqual(inRange.plan.days[0].exercises[0].repsRange, { min: 8, max: 12 }, 'the Coach kept the Motor range');
  const out = await run(inRange); const m = await meso(inRange), [ov] = overlays(m);
  assert.deepEqual(out.applied.map((a) => [a.written, a.blocked]), [[true, null]]); assert.equal(ov.dimension, 'REPS'); assert.equal(ov.previousValue, 10); assert.equal(ov.appliedValue, 12); assert.equal(ov.equipmentId, null);
  const e = await eff(inRange, m, ov); assert.equal(e.provenance, 'CANONICAL_OVERLAY'); assert.deepEqual(e.sets.map((x) => x.effective.repsTarget), [12, 12, 12]);
  const fixed = await seed({ rirTarget: 1, rirReal: 3, recFor: () => ({ action: 'increase_reps', newReps: 12 }) });
  assert.ok(!('repsRange' in fixed.plan.days[0].exercises[0]), 'fixed reps: no range invented'); await run(fixed); assert.equal(overlays(await meso(fixed)).length, 0, 'no room to progress reps without a range');
  const over = await seed({ rirTarget: 1, rirReal: 5, repsRange: { min: 8, max: 12 }, recFor: () => ({ action: 'increase_reps', newReps: 12 }) }); await run(over);
  assert.equal(overlays(await meso(over)).length, 0, 'a +4 step would exceed the ceiling (14 > 12): not truncated, not applied');
});

test('T582-07 MAINTAIN: when the RIR matches the prescription nothing is applied and the base prescription stays', async () => {
  const s = await seed({ rirReal: 2, rec: null }); const out = await run(s); const m = await meso(s);
  assert.equal(overlays(m).length, 0, JSON.stringify(out)); assert.ok(records(m).every((r) => r.state !== 'APPLIED'));
  const same = await seed({ rirReal: 2, recFor: () => ({ action: 'maintain', newReps: 10 }) }); await run(same); assert.equal(overlays(await meso(same)).length, 0);
});

test('T582-08 individual restrictions still win: a pain report blocks the increase (SAFETY), with or without equipment data', async () => {
  const s = await seed({ extraLogs: { postsession_2_0: { articular: 'si', patron: 'jalon', eimd: 1, sleep: 8, rpe: 7 } } }); const out = await run(s); const m = await meso(s);
  assert.equal(overlays(m).length, 0, JSON.stringify(out)); assert.ok(records(m).every((r) => r.state !== 'APPLIED'), JSON.stringify(records(m).map((r) => [r.state, r.reasonCode])));
  const noRir = await seed({ rirTarget: 2, rirReal: 4, rec: null, weeks: [1] }); await run(noRir); assert.equal(overlays(await meso(noRir)).length, 0, 'a single exposure is insufficient evidence');
});

test('T582-09 the load the athlete REALLY used is the evidence of the next evaluation (not the suggested one)', async () => {
  const s = await seed(); await run(s); let m = await meso(s); const first = overlays(m)[0];
  assert.equal(first.appliedValue, 105, 'suggested');
  // W3 D0: the athlete cannot use 105 and trains with 102.5 kg, still finding it easy (RIR 4 vs prescribed 2)
  const entries = Object.assign({}, m.entries);
  [0, 1, 2].forEach((si) => { entries['log_3_0_0_s' + si] = { done: true, carga: '102.5', reps: '10', unit: 'KG', rir: 2, rir_real: 4, prescriptionExerciseId: s.pids[0], ts: T0 + 3e6 + si }; });
  entries.progrec_3_0 = { calculatedAt: new Date(T0 + 3e6 + 60000).toISOString(), recommendations: [{ prescriptionExerciseId: s.pids[0], exerciseName: s.plan.days[0].exercises[0].exerciseName, action: 'increase_load', newLoad: 107 }] };
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ entries }, { merge: true }); await db.doc('logs/' + s.uid).set({ entries }, { merge: true });
  const out = await run(s); m = await meso(s);
  const second = overlays(m).filter((o) => o.target.week === 4)[0];
  assert.ok(second, 'a new overlay for the next exposure: ' + JSON.stringify(out.applied));
  assert.equal(second.previousValue, 102.5, 'the baseline is the EXECUTED load, not the suggested 105'); assert.equal(second.appliedValue, 107.5); assert.equal(second.unit, 'KG');
  assert.equal(overlays(m).filter((o) => o.target.week === 3).length, 1, 'the first overlay is not duplicated or rewritten');
});

test('T582-10 legacy plans keep working: PID + name + sets only (and a hand-written repsRange object) progress with no new fields', async () => {
  const load = await seed({ legacy: true }); await run(load); const [o] = overlays(await meso(load));
  assert.equal(o.dimension, 'LOAD'); assert.equal(o.appliedValue, 105); assert.equal(o.equipmentId, null); assert.ok(!('exerciseId' in load.plan.days[0].exercises[0]));
  const reps = await seed({ legacy: true, rirTarget: 1, rirReal: 3, repsRange: { min: 8, max: 12 }, recFor: () => ({ action: 'increase_reps', newReps: 12 }) }); await run(reps);
  assert.equal(overlays(await meso(reps))[0].dimension, 'REPS'); assert.equal(overlays(await meso(reps))[0].appliedValue, 12);
});

test('T582-11 multi-client isolation: different loads / units / plans; processing one never writes the other; no cross-plan request', async () => {
  const a = await seed({ load: 100 }), b = await seed({ load: 220, unit: 'LB', names: ['Remo T582', 'Curl T582'] });
  await open([a.uid, b.uid]); const bBefore = await digest(b);
  await run(a, { keepAllowlist: true }); assert.equal(await digest(b), bBefore, 'processing A wrote nothing of B');
  await run(b, { keepAllowlist: true });
  const ma = await meso(a), mb = await meso(b);
  assert.deepEqual(overlays(ma).map((o) => [o.clientId, o.previousValue, o.appliedValue, o.unit]), [[a.uid, 100, 105, 'KG']]);
  assert.deepEqual(overlays(mb).map((o) => [o.clientId, o.previousValue, o.appliedValue, o.unit]).sort(), [[b.uid, 220, 231, 'LB'], [b.uid, 220, 231, 'LB']]);
  assert.ok(overlays(mb).every((o) => b.pids.includes(o.prescriptionExerciseId)) && overlays(ma).every((o) => a.pids.includes(o.prescriptionExerciseId)), 'no identity crosses clients');
  const cross = await executor.processProgression({ db, clientId: a.uid, planId: b.planId, enabled: true, numericApplyEnabled: true, clock }); assert.equal(cross.status, 'PLAN_MISMATCH');
});

test('T582-12 idempotency: five simultaneous requests and a reopened session => exactly ONE application', async () => {
  const s = await seed(); await Promise.all([run(s), run(s), run(s), run(s), run(s)]);
  await db.doc('logs/' + s.uid + '/mesos/' + s.planId).set({ planId: s.planId, entries: s.logs }, { merge: true }); await db.doc('logs/' + s.uid).set({ planId: s.planId, entries: s.logs }, { merge: true });
  await run(s); await run(s); const m = await meso(s);
  assert.equal(records(m).length, 1); assert.equal(overlays(m).length, 1); assert.equal(records(m)[0].events.filter((e) => e.state === 'APPLIED').length, 1);
});

test('T582-13 the Coach decides: a Coach decision after the calculation, or after the application, prevails over the advisory target', async () => {
  const a = await seed(); await db.doc('clients/' + a.uid).update({ coachInterventions: [{ id: 'iv-1', targetType: 'EXERCISE', targetId: a.pids[0], action: 'REDUCE_SETS', decidedAt: '2026-09-27T14:00:00.000Z' }] });
  await run(a); assert.equal(overlays(await meso(a)).length, 0); assert.equal(records(await meso(a))[0].reasonCode, 'COACH_OVERRIDE');
  const b = await seed({ planUpdatedAt: '2026-09-28T00:00:00.000Z' }); await run(b); assert.equal(overlays(await meso(b)).length, 0); assert.equal(records(await meso(b))[0].reasonCode, 'PLAN_CHANGED');
  const c = await seed(); await run(c); const m = await meso(c), [ov] = overlays(m);
  assert.equal((await eff(c, m, ov)).provenance, 'CANONICAL_OVERLAY');
  assert.notEqual((await eff(c, m, ov, [{ id: 'iv-2', targetType: 'EXERCISE', targetId: c.pids[0], action: 'REDUCE_SETS', decidedAt: '2026-10-02T00:00:00.000Z' }])).provenance, 'CANONICAL_OVERLAY');
});

test('T582-14 flags OFF: no numeric write of any kind; numeric apply OFF leaves the record PENDING (no overlay); outside the allowlist nothing is written', async () => {
  const s = await seed(); const d0 = await digest(s);
  assert.deepEqual(await run(s, { enabled: false }), { status: 'DISARMED', writes: 0 }); assert.equal(await digest(s), d0);
  const pend = await run(s, { numericApplyEnabled: false }); assert.deepEqual([pend.applied, pend.consumed], [[], []]);
  const m = await meso(s); assert.equal(overlays(m).length, 0); assert.equal(records(m)[0].state, 'PENDING');
  const t = await seed(); await open(['someone-else']); const d1 = await digest(t);
  assert.equal((await run(t, { keepAllowlist: true })).status, 'OUT_OF_ALLOWLIST'); assert.equal(await digest(t), d1);
});
