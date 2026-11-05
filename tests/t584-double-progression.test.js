'use strict';
// T584: (1) a VOLUME recommendation (add_sets, the Client's volume-first rule at ICS >= 8) no longer hides an independent LOAD / REPS progression;
//       (2) double progression at the rep-range ceiling ("reps first, then load", docs/CONTEXTO_GENERADOR.md §8) using Rule A's own magnitude: no new thresholds.
// The evidence rules are unchanged (2 comparable exposures, confirmed direction, safety, Coach authority), fixed-rep prescriptions never get an invented range.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));

const PID = 'pid-T584', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const sets = (reps, rir) => [0, 1, 2].map((setIndex) => ({ setIndex, repsTarget: reps, rirTarget: rir, restSeconds: 90, load: 0 }));
const mkPlan = (reps, rir) => ({ clientId: 'client-A', weeks: 6, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map((dayIndex) => ({ dayIndex, exercises: [{ prescriptionExerciseId: PID, exerciseName: 'Remo', sets: sets(reps, rir) }] })) });
function exposure(week, dayIndex, o) {
  o = o || {};
  const mk = (i) => ({ setIndex: i, load: o.load === undefined ? 100 : o.load, reps: o.reps === undefined ? 10 : o.reps, unit: 'KG', done: true, rirPrescribed: o.rirPrescribed === undefined ? 1 : o.rirPrescribed, rirReal: o.rirReal === undefined ? 1 : o.rirReal,
    autoFilled: false, express: false, ts: T0 + week * 86400000 + dayIndex * 3600000 + i });
  return { prescriptionExerciseId: PID, planId: 'plan-A', clientId: 'client-A', week, dayIndex, exerciseIndex: 0, sets: [mk(0), mk(1), mk(2)] };
}
function run(exposures, o) {
  o = o || {}; const plan = mkPlan(o.reps || 10, o.rir === undefined ? 1 : o.rir);
  const prescription = { prescriptionExerciseId: PID, sets: plan.days[0].exercises[0].sets }; if (o.range) prescription.repsRange = o.range;
  return policy.evaluate({ clientId: 'client-A', planId: 'plan-A', prescriptionExerciseId: PID, plan, prescription, exposures, context: o.context || {} });
}
const cand = (d) => d.candidates[0];
const RANGE = { min: 8, max: 12 };
const pair = (o1, o2) => [exposure(1, 0, o1), exposure(1, 2, o2 || o1)];

test('T584-D1 RIR easier at the CEILING with target RIR 1: Rule A has no rep room, so the same rule moves to LOAD (+2.5% per RIR point), flagged as double progression', () => {
  const d = run(pair({ reps: 12, rirReal: 2 }), { range: RANGE });
  assert.equal(d.ruleId, 'A'); assert.equal(d.dimension, 'LOAD'); assert.equal(d.doubleProgression.trigger, 'RIR_EASIER_AT_CEILING'); assert.equal(d.doubleProgression.ceiling, 12);
  assert.equal(cand(d).previousValue, 100); assert.equal(cand(d).rawCandidate, 102.5); assert.equal(cand(d).finalCandidate, null, 'raw only: no equipment claim');
  assert.equal(d.direction, 'UP'); assert.equal(d.directionConsistency, 'CONSISTENT'); assert.equal(d.eligible, true); assert.equal(d.numericApplyAllowed, false);
  const two = run(pair({ reps: 12, rirReal: 3 }), { range: RANGE }); assert.equal(cand(two).rawCandidate, 105, 'two RIR points => 2 x 2.5%');
});

test('T584-D2 effort exactly as prescribed at the ceiling of a REAL range: LOAD +2.5% (ruleId DP) when the previous exposure confirms the direction', () => {
  const d = run(pair({ reps: 12, rirReal: 1 }), { range: RANGE });
  assert.equal(d.ruleId, 'DP'); assert.equal(d.dimension, 'LOAD'); assert.equal(d.doubleProgression.trigger, 'RIR_AS_PRESCRIBED_AT_CEILING');
  assert.equal(cand(d).rawCandidate, 102.5); assert.equal(d.direction, 'UP'); assert.equal(d.directionConsistency, 'CONSISTENT'); assert.equal(d.eligible, true);
  const afterReps = run([exposure(1, 0, { reps: 10, rirReal: 3 }), exposure(1, 2, { reps: 12, rirReal: 1 })], { range: RANGE });
  assert.equal(afterReps.ruleId, 'DP'); assert.equal(afterReps.directionConsistency, 'CONSISTENT', 'the previous exposure showed an UP signal (RIR easier)'); assert.equal(afterReps.eligible, true);
});

test('T584-D3 no single-session jump: the ceiling reached ONCE after a plain on-target exposure is not enough (direction unconfirmed)', () => {
  const d = run([exposure(1, 0, { reps: 10, rirReal: 1 }), exposure(1, 2, { reps: 12, rirReal: 1 })], { range: RANGE });
  assert.equal(d.ruleId, 'DP'); assert.equal(d.directionConsistency, 'UNCONFIRMED'); assert.equal(d.eligible, false);
  assert.ok(d.reasonCodes.includes('DIRECTION_NOT_CONFIRMED_BY_PRIOR_EXPOSURE'));
  const single = run([exposure(1, 2, { reps: 12, rirReal: 1 })], { range: RANGE }); assert.equal(single.eligible, false); assert.ok(single.reasonCodes.includes('INSUFFICIENT_COMPARABLE_EXPOSURES'));
});

test('T584-D4 reps FIRST: while rep room remains the progression is REPS, never LOAD; below the ceiling on target = maintain', () => {
  const reps = run(pair({ reps: 10, rirReal: 2 }), { range: RANGE });
  assert.equal(reps.ruleId, 'A'); assert.equal(reps.dimension, 'REPS'); assert.equal(cand(reps).rawCandidate, 11); assert.ok(!('doubleProgression' in reps));
  const hold = run(pair({ reps: 10, rirReal: 1 }), { range: RANGE }); assert.equal(hold.ruleId, 'MAINTAIN'); assert.equal(hold.candidates.length, 0); assert.equal(hold.eligible, false);
});

test('T584-D5 fixed-rep prescriptions are respected: no range is invented, on-target stays MAINTAIN, and an easier RIR moves by LOAD (REPS has no room)', () => {
  const fixedHold = run(pair({ reps: 10, rirReal: 1 }));
  assert.equal(fixedHold.ruleId, 'MAINTAIN'); assert.equal(fixedHold.candidates.length, 0, 'hitting the fixed target at the prescribed effort is not a progression');
  const fixedEasy = run(pair({ reps: 10, rirReal: 3 })); assert.equal(fixedEasy.ruleId, 'A'); assert.equal(fixedEasy.dimension, 'LOAD'); assert.equal(cand(fixedEasy).rawCandidate, 105); assert.equal(fixedEasy.eligible, true);
  const high = run(pair({ reps: 10, rirReal: 3, rirPrescribed: 2 }), { rir: 2 }); assert.equal(high.dimension, 'LOAD'); assert.ok(!('doubleProgression' in high), 'target RIR >= 2 was already a LOAD rule: unchanged');
});

test('T584-D6 harder effort, insufficient reps, pain and Coach/stale context all still win over the ceiling logic', () => {
  const hard = run(pair({ reps: 12, rirReal: 0 }), { range: RANGE }); assert.equal(hard.candidates.length, 0); assert.ok(hard.coachReviewRequired, 'effort harder than prescribed => Coach review (D)');
  const short = run(pair({ reps: 9, rirReal: 1 }), { range: RANGE }); assert.equal(short.eligible, false);
  const pain = run([Object.assign(exposure(1, 0, { reps: 12, rirReal: 2 }), { painFlag: true }), Object.assign(exposure(1, 2, { reps: 12, rirReal: 2 }), { painFlag: true })], { range: RANGE });
  assert.equal(pain.eligible, false); assert.ok(pain.reasonCodes.includes('SAFETY_CONFLICT'));
  assert.equal(run(pair({ reps: 12, rirReal: 2 }), { range: RANGE, context: { coachOverride: true } }).eligible, false);
  assert.equal(run(pair({ reps: 12, rirReal: 2 }), { range: RANGE, context: { safetyConflict: true } }).eligible, false);
  assert.equal(run(pair({ reps: 12, rirReal: 2 }), { range: RANGE, context: { readinessVeto: true } }).eligible, false);
});

test('T584-D7 the load baseline is the EXECUTED load: the candidate is computed from what the athlete really lifted', () => {
  const d = run(pair({ reps: 12, rirReal: 2, load: 102.5 }), { range: RANGE });
  assert.equal(cand(d).previousValue, 102.5); assert.equal(cand(d).rawCandidate, 105.0625);
});

// ---- assess(): the Client recommendation is a gate, not a second policy ----
const RANGE_PLAN = mkPlan(10, 1);
const rec = (action, extra) => Object.assign({ prescriptionExerciseId: PID, exerciseName: 'Remo', action }, extra);
const assess = (r) => shadow.assess({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', plan: RANGE_PLAN, week: 1, dayIndex: 0, calculatedAt: '2026-09-27T12:00:00.000Z', recommendation: r, sourcePidCount: 1 });

test('T584-A1 add_sets (volume) no longer rejects the record: it stays PENDING and the numeric dimension is left to the policy', () => {
  const a = assess(rec('add_sets', { newLoad: 100, newSets: 4, newReps: 10 }));
  assert.equal(a.state, 'PENDING', JSON.stringify(a)); assert.equal(a.dimension, null); assert.deepEqual(a.nextExposure, { week: 1, dayIndex: 2 });
  assert.notEqual(a.reasonCode, 'UNSUPPORTED_ACTION');
});

test('T586-A2 structural / fatigue recommendations (deload, reduce_sets, freeze_load) are now SUPPORTED triggers (the structural policy decides what is applied); anything else stays unsupported', () => {
  for (const action of ['deload', 'reduce_sets', 'freeze_load']) { const r = assess(rec(action, { newLoad: 90, newReps: 10 })); assert.equal(r.state, 'PENDING', action); assert.equal(r.dimension, null, action + ': the policy, not the recommendation, picks the dimension'); }
  for (const action of ['substitute', 'remove_exercise', 'teleport']) assert.equal(assess(rec(action, { newLoad: 90, newReps: 10 })).reasonCode, 'UNSUPPORTED_ACTION', action);
});

test('T584-A3 supported actions keep their validation exactly (load needs a positive newLoad; reps need integers; maintain at the target is no delta)', () => {
  assert.equal(assess(rec('increase_load', { newLoad: 105 })).state, 'PENDING'); assert.equal(assess(rec('increase_load', { newLoad: 0 })).reasonCode, 'NON_COMPARABLE_VALUE');
  assert.equal(assess(rec('increase_reps', { newReps: 11 })).state, 'PENDING'); assert.equal(assess(rec('maintain', { newReps: 10 })).reasonCode, 'NO_NUMERIC_DELTA');
  assert.equal(assess(rec('add_sets', { newLoad: 100 }), 0).state, 'PENDING');
  assert.equal(shadow.assess({ clientId: 'client-A', planId: 'plan-A', activePlanId: 'plan-A', plan: RANGE_PLAN, week: 1, dayIndex: 0, calculatedAt: null, recommendation: rec('add_sets'), sourcePidCount: 1 }).reasonCode, 'CALCULATED_AT_MISSING', 'identity / freshness gates still apply to a volume recommendation');
  assert.equal(assess(rec('add_sets', { prescriptionExerciseId: undefined })).reasonCode, 'IDENTITY_MISSING');
});
