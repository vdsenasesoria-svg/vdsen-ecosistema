'use strict';
// T587 / FASE A: REAL round-trip matrix. A realistic Generator (vdsen-plan-v2) output goes through every Coach route that can create or rewrite a plan, and what comes out is the document the
// autonomous engine reads. Nothing is assumed from earlier phases: each field is checked on each route. Only verified losses are reported (see docs/T587_GENERATOR_COACH_CONTRACT.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importLikeCoach, coachSandbox, jsonTabImport } = require('./helpers/coach-plan-import.js');
const S = require('../assets/progression-structural-policy.js');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

const J = (o) => JSON.parse(JSON.stringify(o));
const sets = (n, o) => Array.from({ length: n }, (_, i) => Object.assign({ setIndex: i, repsTarget: 12, rirTarget: 2, load: 0, restSeconds: 90 }, o || {}));
// Generator output exactly as the documented Motor block states it (plus fields the Generator may add that Coach has no consumer for).
const GEN = () => ({ schema: 'vdsen-plan-v2', entrenamiento: {
  weeks: 6, daysPerWeek: 2, musclePriorities: { PRIORITARIO: ['pectoral', 'delt_lateral'], NO_PRIORITARIO: ['triceps', 'biceps'] },
  days: [
    { dayIndex: 0, label: 'Día 1 — Empuje', grupos_objetivo: ['pectoral', 'triceps'], exercises: [
      { exerciseName: 'Press convergente de pecho', prescriptionExerciseId: 'pid-keep-A', muscleGroup: 'pectoral', repsRange: { min: 8, max: 12 }, technique: 'straight', supersetGroup: '', sets: [{ setIndex: 0, repsTarget: 12, rirTarget: 2, load: 0, restSeconds: 150 }, { setIndex: 1, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 150 }, { setIndex: 2, repsTarget: 8, rirTarget: 1, load: 0, restSeconds: 150 }] },
      { exerciseName: 'Elevación lateral con polea', muscleGroup: 'delt_lateral', technique: 'straight', sets: sets(3, { repsTarget: 15, restSeconds: 60 }) },
      { exerciseName: 'Extensión de tríceps en polea', muscleGroup: 'triceps', exerciseId: 'sf-not-in-catalog', technique: 'straight', sets: sets(3, { repsTarget: 12, restSeconds: 0 }) },
      { exerciseName: 'Ejercicio sin músculo declarado', technique: 'straight', sets: sets(2) }] },
    { dayIndex: 2, label: 'Día 2 — Tirón', exercises: [
      { exerciseName: 'Curl de bíceps', muscleGroup: 'biceps', technique: 'straight', supersetGroup: 'A', sets: sets(3, { repsTarget: 12 }) },
      { exerciseName: 'Ejercicio con músculo inventado', muscleGroup: 'pecho_grande', technique: 'straight', sets: sets(3) }] }] } });

// Everything the engine needs, per route. `plan` = normalized plan the preview / save receive.
function checks(plan, route) {
  const ex = plan.days.flatMap((d) => d.exercises), by = (n) => ex.find((e) => e.exerciseName === n);
  const p = by('Press convergente de pecho');
  assert.deepEqual(p.repsRange, { min: 8, max: 12 }, route + ': repsRange when the Motor states one');
  assert.deepEqual(p.sets.map((s) => s.repsTarget), [12, 10, 8], route + ': per-set targets untouched'); assert.deepEqual(p.sets.map((s) => s.rirTarget), [2, 2, 1], route + ': RIR per set'); assert.deepEqual(p.sets.map((s) => s.restSeconds), [150, 150, 150], route + ': rest');
  assert.equal(p.muscleGroup, 'pectoral', route + ': muscleGroup'); assert.equal(by('Elevación lateral con polea').muscleGroup, 'delt_lateral');
  assert.ok(!('repsRange' in by('Elevación lateral con polea')), route + ': fixed reps get no invented range');
  assert.ok(!('muscleGroup' in by('Ejercicio sin músculo declarado')), route + ': nothing is classified by name'); assert.ok(!('muscleGroup' in by('Ejercicio con músculo inventado')), route + ': out-of-vocabulary dropped');
  assert.equal(by('Extensión de tríceps en polea').sets[0].restSeconds, 0, route + ': an explicit rest of 0 stays 0'); assert.ok(!('exerciseId' in by('Extensión de tríceps en polea')), route + ': an unknown catalog id is dropped, never trusted (and never needed)');
  assert.equal(by('Curl de bíceps').supersetGroup, 'A', route + ': superset group');
  assert.deepEqual(plan.musclePriorities, { PRIORITARIO: ['pectoral', 'delt_lateral'], NO_PRIORITARIO: ['triceps', 'biceps'] }, route + ': plan-level priorities');
  assert.ok(!('grupos_objetivo' in plan.days[0]), route + ': day-level grupos_objetivo has no consumer and is not carried (the contract is the per-exercise muscleGroup)');
  return { ex, by };
}

test('T587-A1 route 1 (paste / PDF / AI apply: _normalizeTrainingPlan) + the save-time stamp: every engine field survives; PIDs are kept or minted once; updatedAt is stamped by the save', () => {
  const plan = importLikeCoach(GEN().entrenamiento, { idPrefix: 'a1' }), { ex } = checks(plan, 'normalizer');
  assert.equal(ex[0].prescriptionExerciseId, 'pid-keep-A', 'an existing PID is kept byte for byte');
  const pids = ex.map((e) => e.prescriptionExerciseId); assert.ok(pids.every((x) => typeof x === 'string' && x) && new Set(pids).size === pids.length, 'every exercise has ONE unique PID');
});

test('T587-A2 route 2 (JSON tab: parsePlanFromJSON, canonical entrenamiento block): same fields, same result, valid status; the preview shows what will be saved', () => {
  const out = jsonTabImport(GEN(), 'a2'); assert.ok(out.plan, out.statusHtml); assert.match(out.statusHtml, /JSON válido/);
  checks(out.plan, 'json-tab'); assert.equal(out.plan.days[0].exercises[0].prescriptionExerciseId, 'pid-keep-A'); assert.ok(out.sandbox.preview, 'preview receives the normalized plan');
});

test('T587-A3 both routes agree on every engine field (no route-dependent behaviour)', () => {
  const a = importLikeCoach(GEN().entrenamiento, { idPrefix: 'x' }), b = jsonTabImport(GEN(), 'y').plan;
  const proj = (p) => p.days.flatMap((d) => d.exercises).map((e) => [e.exerciseName, e.muscleGroup || null, J(e.repsRange || null), e.sets.map((s) => [s.repsTarget, s.rirTarget, s.restSeconds, s.load]), e.supersetGroup]);
  assert.deepEqual(proj(a), proj(b)); assert.deepEqual(a.musclePriorities, b.musclePriorities);
});

test('T587-A4 the SAVE paths keep every field: the plan document is {...planObj, days: stamp(days)} (import) / {...planData, days: restamp} (duplicate) — plan-level musclePriorities and per-exercise muscleGroup / repsRange travel through the spread; only the PID is re-minted on a duplicate', () => {
  const save = /async function saveImportedPlan[\s\S]*?addDoc\(collection\(db, "plans"\), \{\s*\.\.\.planObj,\s*days: _stampPrescriptionIds\(planObj\.days\),\s*rirByWeek: rirSchemeForWeeks\(planObj\.weeks \|\| 6\),[\s\S]*?updatedAt: new Date\(\)\.toISOString\(\)/;
  assert.match(coach, save, 'saveImportedPlan: spread + stamp + rirByWeek + updatedAt');
  assert.match(coach, /\.\.\.planData,\s*days: _restampPrescriptionIds\(planData\.days\),\s*clientId: targetId,\s*coachId: currentCoach\.uid,\s*status: 'active',\s*generatedBy: 'duplicate-to-client'/, 'duplicate-to-client keeps the plan fields');
  assert.match(coach, /const newPlan = \{ \.\.\.planData, days: _restampPrescriptionIds\(planData\.days\)/, 'duplicatePlan too');
  // the stamp keeps every other field of an exercise
  const sb = coachSandbox('a4'), planObj = importLikeCoach(GEN().entrenamiento, { idPrefix: 'a4' }), re = J(sb._stampPrescriptionIds(planObj.days));
  assert.deepEqual(re.flatMap((d) => d.exercises).map((e) => [e.muscleGroup || null, e.repsRange || null]), planObj.days.flatMap((d) => d.exercises).map((e) => [e.muscleGroup || null, e.repsRange || null]));
  assert.equal(re[0].exercises[0].prescriptionExerciseId, planObj.days[0].exercises[0].prescriptionExerciseId, 'stamping an already-stamped plan changes nothing');
});

test('T587-A5 static wiring of every other route: muscleGroup + musclePriorities + repsRange are carried by import, update-plan modal, export, editor row meta and the AI draft path', () => {
  const count = (re) => (coach.match(re) || []).length;
  assert.equal(count(/typeof _carryMuscleGroup === 'function' \? _carryMuscleGroup\(ex\)/g), 4, 'parsePlanFromJSON + _normalizeTrainingPlan + update-plan modal + export');
  assert.equal(count(/typeof _carryRepsRange === 'function' \? _carryRepsRange\(ex\)/g), 4);
  assert.match(coach, /_planMetaForRow[\s\S]*?_carryMuscleGroup\(e\)[\s\S]*?o\.muscleGroup = mg\.muscleGroup/); assert.match(coach, /_restorePlanMeta[\s\S]*?_carryMuscleGroup\(\{ muscleGroup: meta\.muscleGroup \}\)/);
  assert.equal(count(/_normalizeMusclePriorities\(/g) >= 6, true, 'plan-level priorities are normalized in JSON tab, normalizer, update modal and AI draft');
  assert.match(coach, /_planUpd\.musclePriorities = _mp/); assert.match(coach, /\{ musclePriorities: _normalizeMusclePriorities\(training\.musclePriorities\) \}/);
});

test('T587-A6 the saved document is what the engine consumes: priority and volume ceiling are computed from the imported plan, not from anything else', () => {
  const plan = importLikeCoach(GEN().entrenamiento, { idPrefix: 'a6' }), by = (n) => plan.days.flatMap((d) => d.exercises).find((e) => e.exerciseName === n);
  assert.equal(S.priorityOf(plan, by('Press convergente de pecho').muscleGroup), 'PRIORITARIO'); assert.equal(S.priorityOf(plan, by('Curl de bíceps').muscleGroup), 'NO_PRIORITARIO');
  assert.equal(S.priorityOf(plan, by('Extensión de tríceps en polea').muscleGroup), 'NO_PRIORITARIO');
  assert.equal(S.volumeCeiling('pectoral', 'PRIORITARIO'), 22); assert.equal(S.volumeCeiling('biceps', 'NO_PRIORITARIO'), 13);
  assert.equal(S.weeklyVolume(plan, {}, 1, 'triceps'), 3, 'only the declared primary muscle counts');
});

test('T587-A7 a LEGACY-shaped source (no PID, no muscle fields, no range) imports to a valid plan with nothing invented, and the save-time stamp makes it eligible (PID + updatedAt)', () => {
  const legacy = { weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D', exercises: [{ exerciseName: 'Press banca', sets: sets(3, { repsTarget: 10 }) }, { exerciseName: 'Remo con barra', sets: sets(3, { repsTarget: 10 }) }] }] };
  const plan = importLikeCoach(legacy, { idPrefix: 'a7' }), ex = plan.days[0].exercises;
  assert.ok(ex.every((e) => !('muscleGroup' in e) && !('repsRange' in e) && !('exerciseId' in e))); assert.ok(!('musclePriorities' in plan));
  assert.equal(new Set(ex.map((e) => e.prescriptionExerciseId)).size, 2);
  const out = jsonTabImport({ entrenamiento: legacy }, 'a7b'); assert.equal(out.plan.days[0].exercises.length, 2); assert.ok(!('musclePriorities' in out.plan));
});
