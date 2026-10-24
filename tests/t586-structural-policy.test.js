'use strict';
// T586: pure tests of the structural / fatigue rules, the muscle-priority differentiation and the effective-prescription continuity. No I/O.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../assets/progression-structural-policy.js');
const P = require('../assets/progression-magnitude-policy.js');
const E = require('../assets/progression-effective-prescription.js');

const mk = (o) => Object.assign({ week: 1, dayIndex: 0, unit: 'KG', sets: [] }, o);
const set = (i, o) => Object.assign({ setIndex: i, load: 100, reps: 10, unit: 'KG', rirPrescribed: 2, rirReal: 2, ics: 8, done: true }, o);
const exp = (week, o) => mk({ week, sets: [0, 1, 2].map((i) => set(i, o && o.set)), unit: (o && o.unit) || 'KG' });
const RX = (extra) => Object.assign({ sets: [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90 })) }, extra || {});
const ev = (latest, prior, ctx, rx) => S.evaluate({ prescription: rx || RX(), latest, prior, context: ctx || {} });

test('T586-S1 the MEV/MRV table is the SAME one the athlete app ships (parity with vdsen-cliente.html)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
  const body = /var MEV_MRV_BY_MUSCLE = \{([\s\S]*?)\n\};/.exec(html)[1];
  const client = {}; body.split('\n').forEach((l) => { const m = /'([a-z_]+)':\s*\{mev:\s*(\d+),\s*mrv:\s*(\d+)/.exec(l); if (m) client[m[1]] = { mev: +m[2], mrv: +m[3] }; });
  assert.deepEqual(S.MEV_MRV, client);
});

test('T586-S2 fatigue signals: >= 2 triggers = deload; auto-closed / partial post-sessions carry DEFAULTS and never count', () => {
  const real = { rpeAverage: 9.5, sleepHours: 5 };
  assert.deepEqual(S.fatigueSignals(real, { who5: '40' }, {}).triggers.sort(), ['RPE_HIGH', 'SLEEP_LOW', 'WHO5_LOW']);
  assert.equal(S.fatigueSignals(real, {}, {}).isDeload, true);
  assert.equal(S.fatigueSignals({ rpeAverage: 9.5, sleepHours: 7 }, {}, {}).isDeload, false, 'one signal is not a deload');
  assert.deepEqual(S.fatigueSignals({ rpeAverage: 10, sleepHours: 4, autoClosed: true }, {}, {}).triggers, [], 'autoClosed defaults are missing evidence');
  assert.deepEqual(S.fatigueSignals({ rpeAverage: 10, sleepHours: 4, partial: true }, {}, {}).triggers, []);
  assert.deepEqual(S.fatigueSignals(null, { hrv: '60', energia: '3' }, { hrv: '80' }).triggers.sort(), ['ENERGY_LOW', 'HRV_DOWN']);
  assert.deepEqual(S.fatigueSignals(null, {}, {}).triggers, [], 'absent data invents nothing');
});

test('T586-S3 DELOAD: sets halved (min 1), load x0.90 at the advisory grain, outranks priority; RIR only from a plan-declared rirByWeek', () => {
  const latest = exp(2), post = { rpeAverage: 9.6, sleepHours: 5.5 };
  const d = ev(latest, exp(1), { post, ci: {}, priority: 'PRIORITARIO', plan: { rirByWeek: { 3: 3 } }, targetWeek: 3 });
  assert.equal(d.kind, 'DELOAD'); assert.equal(d.dimension, 'DELOAD'); assert.deepEqual(d.candidate.components, { SETS: 2, LOAD: 90, RIR: 3 });
  assert.equal(d.safety, true); assert.equal(d.minExposures, 1);
  const lb = ev(exp(2, { unit: 'LB', set: { load: 225, unit: 'LB' } }), null, { post });
  assert.deepEqual(lb.candidate.components, { SETS: 2, LOAD: 203 }, 'x0.9 at the 1 LB grain; no RIR component without rirByWeek');
  assert.equal(ev(exp(2, { set: { load: 100 } }), null, { post }, RX()).candidate.finalCandidate, 2);
  assert.equal(S.evaluate({ prescription: RX(), latest: mk({ sets: [set(0)] }), context: { post } }).candidate.finalCandidate, 1, 'never below one set');
});

test('T586-S4 technique: ICS < 6 -> x0.85, ICS < 7 -> x0.90; absent ICS never triggers', () => {
  const l6 = exp(1, { set: { ics: 5 } }), l7 = exp(1, { set: { ics: 6.5 } });
  assert.equal(ev(l6, null).candidate.rawCandidate, 85); assert.equal(ev(l6, null).ruleId, 'S-ICS-LT6');
  assert.equal(ev(l7, null).candidate.rawCandidate, 90); assert.equal(ev(l7, null).ruleId, 'S-ICS-LT7');
  assert.equal(ev(exp(1, { set: { ics: undefined } }), null), null);
});

test('T586-S5 soreness veto: EIMD 3 removes one set; EIMD 2 does nothing; a defaulted (auto-closed) EIMD never counts', () => {
  assert.equal(ev(exp(1), null, { post: { eimd: 3, rpeAverage: 7, sleepHours: 7 } }).kind, 'REDUCE_SETS');
  assert.equal(ev(exp(1), null, { post: { eimd: 3 } }).candidate.finalCandidate, 2);
  assert.equal(ev(exp(1), null, { post: { eimd: 2 } }), null);
  assert.equal(ev(exp(1), null, { post: { eimd: 3, autoClosed: true } }), null);
});

test('T586-S6 ADD SET: sustained performance + ICS >= 8 + room; needs a previous comparable exposure; capped by max sets and by the muscle ceiling', () => {
  const prior = exp(1), latest = exp(2);
  const d = ev(latest, prior, {}); assert.equal(d.kind, 'ADD_SETS'); assert.equal(d.candidate.finalCandidate, 4); assert.equal(d.minExposures, 2); assert.equal(d.safety, false);
  assert.equal(ev(latest, null, {}), null, 'no previous comparable exposure => no volume increase');
});

test('T586-S6b ADD SET boundaries (explicit)', () => {
  const prior = exp(1), latest = exp(2);
  assert.equal(ev(exp(2, { set: { ics: 7.5 } }), prior, {}), null, 'ICS 7.5 is not >= 8 and not < 7: no structural change');
  const four = mk({ week: 2, sets: [0, 1, 2, 3].map((i) => set(i)) }), p4 = mk({ week: 1, sets: [0, 1, 2, 3].map((i) => set(i)) });
  assert.equal(ev(four, p4, {}), null, 'uncatalogued cap is 4 sets');
  assert.equal(ev(four, p4, {}, RX({ fatigueCost: 2 })).kind, 'ADD_SETS', 'an isolation exercise (fatigue cost 2) allows up to 6');
  const worse = exp(2, { set: { reps: 8 } });
  assert.equal(ev(worse, prior, {}), null, 'reps dropped by more than 0.5 => performance not sustained');
});

test('T586-S7 PRIORITY changes the volume ceiling and nothing else: PRIORITARIO up to MRV, NO_PRIORITARIO up to the MEV/MRV midpoint, undeclared = MRV (as before)', () => {
  const prior = exp(1), latest = exp(2), rx = RX({ muscleGroup: 'biceps' });   // biceps mev 8 mrv 18 -> midpoint 13
  assert.equal(S.volumeCeiling('biceps', 'PRIORITARIO'), 18); assert.equal(S.volumeCeiling('biceps', 'NO_PRIORITARIO'), 13); assert.equal(S.volumeCeiling('biceps', null), 18);
  const at = (priority, volume) => ev(latest, prior, { priority, volume }, rx);
  assert.equal(at('NO_PRIORITARIO', 13), null, 'a non-priority group at 13 weekly sets stops adding');
  assert.equal(at('PRIORITARIO', 13).kind, 'ADD_SETS', 'the same group, same evidence, but prioritised keeps progressing');
  assert.equal(at('PRIORITARIO', 17).kind, 'ADD_SETS'); assert.equal(at('PRIORITARIO', 18), null, 'MRV is still a hard ceiling');
  assert.equal(at(null, 17).kind, 'ADD_SETS', 'legacy plan without declared priorities behaves as before');
  assert.equal(at('NO_PRIORITARIO', 12).kind, 'ADD_SETS', 'below the midpoint it still progresses (not "maintenance")');
  assert.equal(at('NO_PRIORITARIO', 12).evidence.maxSets, 4);
  // priority never overrides safety: deload / low ICS / soreness win for BOTH classes
  const deload = { post: { rpeAverage: 10, sleepHours: 5 } };
  assert.equal(ev(latest, prior, Object.assign({ priority: 'PRIORITARIO', volume: 5 }, deload), rx).kind, 'DELOAD');
  assert.equal(ev(exp(2, { set: { ics: 5 } }), prior, { priority: 'PRIORITARIO', volume: 5 }, rx).kind, 'LOAD_DOWN');
  assert.equal(ev(latest, prior, { priority: 'PRIORITARIO', volume: 5, post: { eimd: 3 } }, rx).kind, 'REDUCE_SETS');
  // an unknown muscle key declares nothing
  assert.equal(S.volumeCeiling('not_a_muscle', 'PRIORITARIO'), null);
});

test('T586-S8 weekly volume counts ONLY the declared primary muscle (a multi-joint exercise is never counted as several prime movers); executed sets win over the plan', () => {
  const plan = { days: [
    { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'p1', muscleGroup: 'pectoral', sets: [{}, {}, {}] }, { prescriptionExerciseId: 'p2', muscleGroup: 'triceps', sets: [{}, {}] }] },
    { dayIndex: 2, exercises: [{ prescriptionExerciseId: 'p3', muscleGroup: 'pectoral', sets: [{}, {}, {}, {}] }, { prescriptionExerciseId: 'p4', sets: [{}, {}] }] }] };
  assert.equal(S.weeklyVolume(plan, {}, 1, 'pectoral'), 7, 'planned 3 + 4');
  assert.equal(S.weeklyVolume(plan, {}, 1, 'triceps'), 2, 'the press is NOT also counted for triceps');
  assert.equal(S.weeklyVolume(plan, {}, 1, 'dorsal_ancho'), 0);
  const entries = { log_1_0_0_s0: { done: true, prescriptionExerciseId: 'p1' }, log_1_0_0_s1: { done: true, prescriptionExerciseId: 'p1' }, log_1_0_0_s2: { done: true, prescriptionExerciseId: 'p1', express: true } };
  assert.equal(S.weeklyVolume(plan, entries, 1, 'pectoral'), 2 + 4, 'executed (non-express) sets replace the plan count of that exercise only');
  assert.equal(S.weeklyVolume(plan, {}, 1, 'pectoral', { p1: 5 }), 5 + 4, 'a carried (already applied) set count replaces the prescribed one');
  assert.equal(S.priorityOf({ musclePriorities: { PRIORITARIO: ['pectoral'], NO_PRIORITARIO: ['triceps'] } }, 'triceps'), 'NO_PRIORITARIO');
  assert.equal(S.priorityOf({}, 'triceps'), null, 'no declaration => never inferred');
});

test('T586-S9 effort rules: RIR 0 outside the band or effort harder than prescribed -> FREEZE; the same at two consecutive exposures -> load x0.95', () => {
  const hard = (w) => exp(w, { set: { rirReal: 0 } }), prior = exp(1, { set: { rirReal: 2 } });
  assert.equal(ev(hard(2), prior, {}).kind, 'FREEZE_LOAD');
  const mixed = mk({ week: 2, sets: [set(0, { rirReal: 3 }), set(1, { rirReal: 0 }), set(2, { rirReal: 2 })] });
  assert.equal(ev(mixed, prior, {}).ruleId, 'S-FREEZE-ZERO');
  const h = (w) => exp(w, { set: { rirReal: 1, rirPrescribed: 3 } });   // harder than prescribed but not a failure set
  assert.equal(ev(h(2), exp(1), {}).ruleId, 'S-FREEZE-HARD', 'first time: hold the load');
  const twice = ev(h(2), h(1), {}); assert.equal(twice.ruleId, 'S-HARD-TWICE'); assert.equal(twice.candidate.rawCandidate, 95);
  assert.equal(ev(hard(2), hard(1), {}).ruleId, 'S-FREEZE-ZERO', 'failure sets keep freezing (v3.1 order), they are never turned into a cut by themselves');
  assert.equal(ev(exp(2, { set: { rirReal: 1 } }), prior, {}).kind, 'ADD_SETS', 'within the +-1 band is a match: no freeze / regression (the add-set rule then decides)');
  assert.equal(ev(exp(2, { set: { rirReal: undefined } }), prior, {}), null, 'absent RIR judges nothing');
});

test('T586-S10 the magnitude policy takes the structural decision BEFORE A/C/D/E: one candidate per exposure; pain still suppresses everything; protective rules need 1 exposure', () => {
  const prescription = { prescriptionExerciseId: 'p', sets: RX().sets, muscleGroup: 'pectoral' };
  const entriesFor = (extra) => { const e = {}; [1, 2].forEach((w) => [0, 1, 2].forEach((i) => { e['log_' + w + '_0_0_s' + i] = { done: true, carga: '100', reps: '10', unit: 'KG', rir: 2, rir_real: 4, ics: 8, prescriptionExerciseId: 'p', ts: 1e12 + w * 1e6 + i }; })); return Object.assign(e, extra); };
  const run = (entries, extraCtx) => P.evaluate({ clientId: 'c', planId: 'pl', prescriptionExerciseId: 'p', plan: { updatedAt: '2001-01-01T00:00:00.000Z', musclePriorities: { PRIORITARIO: ['pectoral'] }, days: [] }, prescription,
    exposures: P.extractExposures(entries, 'p', { planId: 'pl', clientId: 'c' }), context: Object.assign({ structural: { entries, targetWeek: 3, carriedSets: {} } }, extraCtx || {}) });
  const add = run(entriesFor({})); assert.equal(add.dimension, 'SETS'); assert.equal(add.ruleId, 'S-ADD'); assert.equal(add.eligible, true); assert.equal(add.candidates.length, 1);
  assert.equal(add.structural.volume.priority, 'PRIORITARIO');
  const del = run(entriesFor({ postsession_2_0: { eimd: 2, rpeAverage: 9.8, sleepHours: 5, ts: 1 } })); assert.equal(del.dimension, 'DELOAD'); assert.equal(del.eligible, true);
  const pain = run(entriesFor({ postsession_2_0: { articularPain: { present: true }, eimd: 3 } })); assert.equal(pain.eligible, false); assert.ok(pain.reasonCodes.includes('SAFETY_CONFLICT'));
  const without = P.evaluate({ clientId: 'c', planId: 'pl', prescriptionExerciseId: 'p', plan: { updatedAt: '2001-01-01T00:00:00.000Z', days: [] }, prescription, exposures: P.extractExposures(entriesFor({}), 'p', { planId: 'pl', clientId: 'c' }), context: {} });
  assert.notEqual(without.dimension, 'SETS', 'without the trusted structural context the legacy rules decide exactly as before');
});

// ---- effective prescription: new dimensions and continuity ----
const OV = (o) => Object.assign({ schema: E.OVERLAY_SCHEMA, clientId: 'c', planId: 'pl', prescriptionExerciseId: 'p', previousValue: 3, status: 'CONSUMED', unit: 'SETS', equipmentId: null }, o);
const REC = (key, state, o) => Object.assign({ key, clientId: 'c', planId: 'pl', prescriptionExerciseId: 'p', state: state || 'CONSUMED', lifecycle: { overlayKey: 'ovl_' + key } }, o);
function world(list) {   // list: [{key, dimension, week, day, value, status, extra}]
  const overlays = {}, records = {};
  list.forEach((x) => {
    overlays['ovl_' + x.key] = OV(Object.assign({ key: 'ovl_' + x.key, sourceRecordKey: x.key, dimension: x.dimension, appliedValue: x.value, unit: x.unit || (x.dimension === 'SETS' ? 'SETS' : x.dimension === 'LOAD' ? 'KG' : 'REPS'),
      target: { week: x.week, dayIndex: x.day }, source: { week: x.week - 1, dayIndex: x.day, calculatedAt: '2026-10-01T00:00:00.000Z' }, status: x.status || 'CONSUMED' }, x.extra || {}));
    records[x.key] = REC(x.key, x.status || 'CONSUMED', { source: { week: x.week - 1, dayIndex: x.day, calculatedAt: '2026-10-01T00:00:00.000Z' } });
  });
  return { overlays, records };
}
const plan = { updatedAt: '2026-09-26T00:00:00.000Z', weeks: 6, days: [{ dayIndex: 0, exercises: [{ prescriptionExerciseId: 'p', sets: [] }] }] };
const BASE = [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2, load: 100, restSeconds: 90 }));
const resolve = (w, week, extra) => E.resolveEffective(Object.assign({ clientId: 'c', planId: 'pl', activePlanId: 'pl', pid: 'p', week, dayIndex: 0, records: w.records, overlays: w.overlays, interventions: [], plan, entries: {}, baseSets: BASE, unit: 'KG', canonicalOverlayRead: true }, extra || {}));

test('T586-E1 SETS overlay changes the number of standard working sets; tagged warm-up / drop sets are untouched; setIndex is renumbered', () => {
  const w = world([{ key: 'v1_a', dimension: 'SETS', week: 2, day: 0, value: 4, status: 'APPLIED' }]);
  const r = resolve(w, 2); assert.equal(r.provenance, 'CANONICAL_OVERLAY'); assert.equal(r.sets.length, 4); assert.deepEqual(r.sets.map((x) => x.effective.setIndex), [0, 1, 2, 3]); assert.equal(r.presentation.text, '3 → 4 series');
  const mixed = [{ setIndex: 0, setType: 'warmup', load: 40, repsTarget: 12 }].concat(BASE.map((b, i) => Object.assign({}, b, { setIndex: i + 1 })));
  const r2 = resolve(w, 2, { baseSets: mixed }); assert.equal(r2.sets.length, 5); assert.equal(r2.sets[0].effective.setType, 'warmup'); assert.equal(r2.sets[0].effective.load, 40);
  const down = world([{ key: 'v1_b', dimension: 'SETS', week: 2, day: 0, value: 2, status: 'APPLIED' }]); assert.equal(resolve(down, 2).sets.length, 2);
});

test('T586-E2 FREEZE and DELOAD: freeze keeps the carried load and says so; deload is a composite (sets + load) scoped to its own exposure', () => {
  const f = world([{ key: 'v1_f', dimension: 'FREEZE', week: 2, day: 0, value: 100, unit: 'KG', status: 'APPLIED' }]);
  const rf = resolve(f, 2); assert.equal(rf.presentation.text, 'Carga congelada · 100 kg'); assert.ok(rf.sets.every((x) => x.effective.load === 100));
  const d = world([{ key: 'v1_d', dimension: 'DELOAD', week: 2, day: 0, value: 2, status: 'APPLIED', extra: { components: { SETS: 2, LOAD: 90 }, previousValue: 3, loadUnit: 'KG' } }]);
  const rd = resolve(d, 2); assert.equal(rd.sets.length, 2); assert.ok(rd.sets.every((x) => x.effective.load === 90)); assert.equal(rd.presentation.text, 'Descarga: 3 → 2 series · carga 90 kg');
  const after = world([{ key: 'v1_d', dimension: 'DELOAD', week: 2, day: 0, value: 2, status: 'CONSUMED', extra: { components: { SETS: 2, LOAD: 90 } } }]);
  const r3 = resolve(after, 3); assert.equal(r3.sets.length, 3, 'a consumed deload is NOT the new baseline'); assert.ok(r3.sets.every((x) => x.effective.load === 100)); assert.equal(r3.provenance, 'BASE_PLAN');
});

test('T586-E3 CONTINUITY: a consumed application keeps governing later exposures (LOAD + SETS + REPS carry together); a later application replaces it only for its dimension', () => {
  const w = world([{ key: 'v1_s', dimension: 'SETS', week: 2, day: 0, value: 4 }, { key: 'v1_l', dimension: 'LOAD', week: 2, day: 0, value: 105, unit: 'KG' }]);
  const r3 = resolve(w, 3); assert.equal(r3.provenance, 'CARRIED_OVERLAY'); assert.equal(r3.sets.length, 4); assert.ok(r3.sets.every((x) => x.effective.load === 105)); assert.match(r3.presentation.text, /^Vigente: /);
  const r5 = resolve(w, 5); assert.equal(r5.sets.length, 4, 'still in force three exposures later'); assert.equal(r5.sets[0].effective.load, 105);
  const w2 = world([{ key: 'v1_s', dimension: 'SETS', week: 2, day: 0, value: 4 }, { key: 'v1_l', dimension: 'LOAD', week: 2, day: 0, value: 105, unit: 'KG' }, { key: 'v1_l2', dimension: 'LOAD', week: 3, day: 0, value: 108, unit: 'KG' }]);
  const r4 = resolve(w2, 4); assert.equal(r4.sets[0].effective.load, 108); assert.equal(r4.sets.length, 4);
  const own = world([{ key: 'v1_s', dimension: 'SETS', week: 2, day: 0, value: 4 }, { key: 'v1_n', dimension: 'LOAD', week: 3, day: 0, value: 106, unit: 'KG', status: 'APPLIED' }]);
  const r = resolve(own, 3); assert.equal(r.provenance, 'CANONICAL_OVERLAY'); assert.equal(r.sets.length, 4, 'the exposure overlay is stacked on the carried sets'); assert.equal(r.sets[0].effective.load, 106);
});

test('T586-E4 the carry is dropped (back to the plan) on: plan revision, Coach decision, articular pain, unit change; never from an unconsumed or unrelated overlay', () => {
  const w = world([{ key: 'v1_l', dimension: 'LOAD', week: 2, day: 0, value: 105, unit: 'KG' }]);
  assert.equal(resolve(w, 3).sets[0].effective.load, 105);
  assert.equal(resolve(w, 3, { plan: Object.assign({}, plan, { updatedAt: '2026-10-02T00:00:00.000Z' }) }).sets[0].effective.load, 100, 'the Coach revised the plan after the calculation');
  assert.equal(resolve(w, 3, { interventions: [{ targetType: 'EXERCISE', targetId: 'p', decidedAt: '2026-10-02T00:00:00.000Z', action: 'REDUCE_SETS' }] }).sets[0].effective.load, 100);
  assert.equal(resolve(w, 3, { entries: { postsession_2_0: { articularPain: { present: true } } } }).sets[0].effective.load, 100, 'pain after the source => plan');
  assert.equal(resolve(w, 3, { unit: 'LB' }).sets[0].effective.load, 100, 'unit changed: never mixes KG and LB');
  const unconsumed = world([{ key: 'v1_u', dimension: 'LOAD', week: 2, day: 0, value: 105, unit: 'KG', status: 'APPLIED' }]);
  assert.equal(resolve(unconsumed, 3).sets[0].effective.load, 100, 'an exposure the athlete never executed is not a baseline');
  assert.equal(resolve(w, 3, { pid: 'other' }).sets[0].effective.load, 100, 'other exercises are untouched');
  assert.equal(resolve(w, 1).provenance, 'BASE_PLAN', 'a carry never applies to an exposure before the one it targets');
});

// ---- Coach contract: muscle priority is declared explicitly, never inferred ----
const { importLikeCoach, coachSandbox } = require('./helpers/coach-plan-import.js');
test('T586-C1 the Coach carries ONLY a declared, in-vocabulary muscleGroup and musclePriorities (vocabulary = the MEV/MRV keys); nothing is inferred from names', () => {
  const sb = coachSandbox('c1');
  assert.deepEqual([...sb._MUSCLE_KEYS].sort(), Object.keys(S.MEV_MRV).sort(), 'one vocabulary for Coach, Client table and server policy');
  const motor = { weeks: 4, daysPerWeek: 1, musclePriorities: { PRIORITARIO: ['pectoral', 'bogus'], NO_PRIORITARIO: ['triceps', 'pectoral'] },
    days: [{ dayIndex: 0, label: 'D', exercises: [
      { exerciseName: 'Press banca', muscleGroup: 'pectoral', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }] },
      { exerciseName: 'Extensión tríceps', muscleGroup: 'not_a_muscle', sets: [{ setIndex: 0, repsTarget: 12, rirTarget: 2, load: 0, restSeconds: 60 }] },
      { exerciseName: 'Curl bíceps', sets: [{ setIndex: 0, repsTarget: 12, rirTarget: 2, load: 0, restSeconds: 60 }] }] }] };
  const plan = importLikeCoach(motor, { idPrefix: 'c1' }), ex = plan.days[0].exercises;
  assert.equal(ex[0].muscleGroup, 'pectoral'); assert.ok(!('muscleGroup' in ex[1]), 'out-of-vocabulary dropped'); assert.ok(!('muscleGroup' in ex[2]), 'an exercise named "Curl bíceps" is NOT classified by name');
  assert.deepEqual(plan.musclePriorities, { PRIORITARIO: [], NO_PRIORITARIO: ['triceps'] }, 'pectoral declared in BOTH classes is ambiguous and dropped from both; the unambiguous declaration survives');
  const ok = importLikeCoach(Object.assign({}, motor, { musclePriorities: { PRIORITARIO: ['pectoral', 'bogus'], NO_PRIORITARIO: ['triceps'] } }), { idPrefix: 'c2' });
  assert.deepEqual(ok.musclePriorities, { PRIORITARIO: ['pectoral'], NO_PRIORITARIO: ['triceps'] });
  const none = importLikeCoach({ weeks: 4, daysPerWeek: 1, days: motor.days }, { idPrefix: 'c3' }); assert.ok(!('musclePriorities' in none), 'a legacy plan declares nothing: nothing is invented');
  assert.deepEqual(sb._normalizeMusclePriorities({ PRIORITARIO: 'x' }), null);
  assert.deepEqual(sb._planMetaForRow({ exerciseName: 'x', muscleGroup: 'biceps' }).muscleGroup, 'biceps', 'the editor keeps it');
  assert.equal(sb._restorePlanMeta({ muscleGroup: 'biceps' }, 'x', []).muscleGroup, 'biceps');
  assert.equal(JSON.stringify(sb._restorePlanMeta({ muscleGroup: 'nope' }, 'x', [])), '{}');
});

// ---- Motor output contract: muscle priority is optional, declared, validated, never invented ----
test('T586-M1 the Motor contract states muscleGroup / musclePriorities (optional, declared only, one vocabulary shared by prompt, normalizer, Coach, Client table and server policy)', () => {
  const normalizer = require('../api/vdsen-plan-normalizer.js'), generate = require('../api/vdsen-generate.js');
  const prompt = generate._internal.buildSystemPrompt();
  assert.match(prompt, /23\. PRIORIDAD MUSCULAR \(OPCIONAL/); assert.match(prompt, /nunca inferida/); assert.match(prompt, /NO_PRIORITARIO NO significa mantenimiento/); assert.match(prompt, /nunca los deduzcas del nombre/);
  Object.keys(S.MEV_MRV).forEach((k) => assert.ok(prompt.includes(k), 'prompt lists ' + k));
  const doc = fs.readFileSync(path.join(__dirname, '..', 'references', 'motor-bloque-salida-entrenamiento.md'), 'utf8');
  assert.match(doc, /\| `muscleGroup` \|/); assert.match(doc, /musclePriorities/); assert.match(doc, /NO_PRIORITARIO` no es mantenimiento/);
  const planWith = (ex) => ({ days: [{ dayIndex: 0, label: 'D1', exercises: [ex] }] }), sets = [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90 }];
  assert.deepEqual(normalizer.validateVdsenPlan(planWith({ exerciseName: 'Press', muscleGroup: 'pectoral', sets })), { ok: true });
  assert.deepEqual(normalizer.validateVdsenPlan(planWith({ exerciseName: 'Press', sets })), { ok: true }, 'absent: valid, never invented');
  const bad = normalizer.validateVdsenPlan(planWith({ exerciseName: 'Press', muscleGroup: 'chest', sets }));
  assert.equal(bad.ok, false); assert.equal(bad.error, normalizer.ERROR_CODES.INVALID_MUSCLE_GROUP);
  // one vocabulary everywhere
  const norm = fs.readFileSync(path.join(__dirname, '..', 'api', 'vdsen-plan-normalizer.js'), 'utf8'), keys = /var MUSCLE_KEYS = \[([^\]]*)\]/.exec(norm)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(keys.slice().sort(), Object.keys(S.MEV_MRV).sort());
});

test('T586-M2 the structural policy and the Client table never drift: every rule constant lives in ONE module and the Client keeps no second copy of the structural thresholds that the server applies', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
  // The Client still COMPUTES the advisory recommendation with its own v3.1 code; the server is the authority. Their numeric factors must agree with the shared module.
  assert.match(html, /load \* 0\.9, unit/); assert.match(html, /load \* 0\.85/); assert.match(html, /load \* 0\.95/); assert.match(html, /numSets \/ 2/);
  assert.equal(S.FACTOR.DELOAD_LOAD, 0.9); assert.equal(S.FACTOR.ICS_LT6, 0.85); assert.equal(S.FACTOR.ICS_LT7, 0.9); assert.equal(S.FACTOR.HARD_TWICE, 0.95);
  assert.equal(S.FATIGUE.WHO5_MIN, 52); assert.equal(S.FATIGUE.RPE_MAX, 9); assert.equal(S.FATIGUE.SLEEP_MIN, 6); assert.equal(S.FATIGUE.HRV_DROP, 0.85); assert.equal(S.FATIGUE.ENERGY_MAX, 3);
  assert.match(html, /who5 < 52/); assert.match(html, /rpe > 9/); assert.match(html, /sleep < 6/); assert.match(html, /\* 0\.85\)\)/); assert.match(html, /energia\) <= 3/);
});
