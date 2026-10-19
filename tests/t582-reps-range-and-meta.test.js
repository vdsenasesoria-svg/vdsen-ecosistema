'use strict';
// T582: the rep RANGE the Motor prescribes must reach the progression engine (repsTarget alone is only the ceiling). The Coach carries it ONLY when the source
// states one; it never invents a range for fixed reps; it keeps it (and the catalog exerciseId) through export / editor saves while they still agree with the plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { coachSandbox, importLikeCoach } = require('./helpers/coach-plan-import.js');

const J = (o) => JSON.parse(JSON.stringify(o));
const S = (r, n) => Array.from({ length: n || 3 }, (_, i) => ({ setIndex: i, repsTarget: r, rirTarget: 1, load: 0, restSeconds: 90 }));
const plan = (exs) => ({ weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D1', exercises: exs }] });
const sb = coachSandbox('t582');
const range = (ex) => J(sb._carryRepsRange(ex));

test('T582-R1 an explicit {min,max} or "8-12" range is carried; fixed reps get NO range (never invented)', () => {
  assert.deepEqual(range({ repsRange: { min: 8, max: 12 }, sets: S(12) }), { repsRange: { min: 8, max: 12 } });
  assert.deepEqual(range({ repsRange: '8-12', sets: S(10) }), { repsRange: { min: 8, max: 12 } });
  assert.deepEqual(range({ repsRange: '10–15', sets: S(15) }), { repsRange: { min: 10, max: 15 } }, 'en dash');
  assert.deepEqual(range({ sets: S(10) }), {}, 'no range in the source => none');
  assert.deepEqual(range({ repsRange: { min: 10, max: 10 }, sets: S(10) }), {}, 'a degenerate range is a fixed prescription');
  assert.deepEqual(range(null), {});
});

test('T582-R2 invalid / contradictory ranges are dropped, not repaired', () => {
  for (const r of [{ min: 12, max: 8 }, { min: 0, max: 8 }, { min: 8, max: 500 }, { min: 'a', max: 12 }, { min: 8.5, max: 12 }, '12-8', '8', 'ocho-doce', [8, 12], 8, true]) assert.deepEqual(range({ repsRange: r, sets: S(10) }), {}, JSON.stringify(r));
  assert.deepEqual(range({ repsRange: { min: 8, max: 12 }, sets: S(15) }), {}, 'a set target above the range makes the prescription ambiguous');
  assert.deepEqual(range({ repsRange: { min: 8, max: 12 }, sets: [{ repsTarget: 10 }, { repsTarget: 6 }] }), {}, 'a set target below the range as well');
});

test('T582-R3 all three Coach import paths carry the range; PID and the rest of the prescription are untouched', () => {
  const out = importLikeCoach(plan([{ exerciseName: 'Press X', repsRange: { min: 8, max: 12 }, sets: S(12) }, { exerciseName: 'Remo X', sets: S(10) }, { exerciseName: 'Curl X', repsRange: '6-10', sets: S(10) }]), { idPrefix: 'p' });
  const e = out.days[0].exercises;
  assert.deepEqual(e[0].repsRange, { min: 8, max: 12 }); assert.ok(!('repsRange' in e[1]), 'fixed reps: no range'); assert.deepEqual(e[2].repsRange, { min: 6, max: 10 });
  assert.deepEqual(e.map((x) => x.sets.map((s) => s.repsTarget)), [[12, 12, 12], [10, 10, 10], [10, 10, 10]], 'repsTarget (the ceiling) is unchanged');
  assert.equal(new Set(e.map((x) => x.prescriptionExerciseId)).size, 3);
  const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
  assert.equal((coach.match(/typeof _carryRepsRange === 'function' \? _carryRepsRange\(ex\)/g) || []).length, 4, 'parsePlanFromJSON + _normalizeTrainingPlan + update-plan modal + export');
});

test('T582-R4 the editor keeps repsRange and exerciseId on save while they still describe the same exercise; it drops them when they no longer do', () => {
  const stored = { exerciseName: 'Belt Squat', exerciseId: 'sf-sd-belt-squat', exerciseIdSource: 'CATALOG_EXACT_NAME', repsRange: { min: 8, max: 12 }, sets: S(12) };
  const meta = J(sb._planMetaForRow(stored));
  assert.deepEqual(J(sb._restorePlanMeta(meta, 'Belt Squat', S(12))), { exerciseId: 'sf-sd-belt-squat', exerciseIdSource: 'CATALOG_EXACT_NAME', repsRange: { min: 8, max: 12 } });
  assert.deepEqual(J(sb._restorePlanMeta(meta, '  belt squat ', S(10))), { exerciseId: 'sf-sd-belt-squat', exerciseIdSource: 'CATALOG_EXACT_NAME', repsRange: { min: 8, max: 12 } }, 'trim / case do not make it a different exercise');
  assert.deepEqual(J(sb._restorePlanMeta(meta, 'Sentadilla hack', S(12))), { repsRange: { min: 8, max: 12 } }, 'renamed exercise: the catalog id is stale and dropped; the prescription range stays');
  assert.deepEqual(J(sb._restorePlanMeta(meta, 'Belt Squat', S(15))), { exerciseId: 'sf-sd-belt-squat', exerciseIdSource: 'CATALOG_EXACT_NAME' }, 'the Coach raised reps above the range: the range no longer applies');
  assert.deepEqual(J(sb._restorePlanMeta(null, 'x', S(10))), {}); assert.deepEqual(J(sb._restorePlanMeta('junk', 'x', S(10))), {});
  assert.deepEqual(J(sb._planMetaForRow({ exerciseName: 'Remo', sets: S(10) })), {}, 'nothing to preserve');
});

test('T582-R5 the editor wiring: the row state carries the meta and the save restores it (static contract)', () => {
  const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
  assert.ok(/meta: \(typeof _planMetaForRow === 'function' \? _planMetaForRow\(e\) : \{\}\)/.test(coach), 'row state');
  assert.ok(/planMeta = pj\.meta \|\| null/.test(coach) && /_restorePlanMeta\(planMeta, name, _setsOut\)/.test(coach), 'save');
  const exp = coach.slice(coach.indexOf('async function exportActivePlanJSON('), coach.indexOf('async function exportActivePlanJSON(') + 2500);
  assert.ok(!/exerciseId\s*:|ex\.exerciseId/.test(exp), 'T552.P4: the export still does not leak catalog ids');
});
