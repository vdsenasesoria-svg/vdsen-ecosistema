'use strict';
// T583: the Motor's OUTPUT contract now carries the OPTIONAL per-exercise `repsRange` ({min,max}). The methodology (Compendio A.4) already defines the range per fibre;
// until now only its ceiling travelled (repsTarget). Nothing is invented: fixed-rep prescriptions omit the field, per-set targets stay, and every other variable is unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const generate = require('../api/vdsen-generate.js');
const normalizer = require('../api/vdsen-plan-normalizer.js');
const { importLikeCoach } = require('./helpers/coach-plan-import.js');

const E = normalizer.ERROR_CODES;
const S = (r, n) => Array.from({ length: n || 3 }, (_, i) => ({ setIndex: i, repsTarget: r, rirTarget: 2, load: 0, restSeconds: 90 }));
const planWith = (ex) => ({ days: [{ dayIndex: 0, label: 'D1', exercises: [ex] }] });

test('T583-C1 the in-repo generator prompt documents repsRange (optional, from the methodology, never an invented minimum) and keeps repsTarget mandatory', () => {
  const prompt = generate._internal.buildSystemPrompt();
  assert.match(prompt, /repsRange\?/, 'listed in the canonical field names');
  assert.match(prompt, /21\. repsRange \(OPCIONAL/); assert.match(prompt, /A\.4/); assert.match(prompt, /OMITE repsRange/); assert.match(prompt, /NUNCA inventes el mínimo/);
  assert.match(prompt, /repsTarget sigue siendo obligatorio/);
  assert.match(prompt, /sets:\[\{setIndex, repsTarget, rirTarget, load, restSeconds\}\]/, 'the per-set contract is unchanged');
});

test('T583-C2 both reference documents of the external Motor state the same optional contract', () => {
  for (const f of ['references/instrucciones-maestras-motor-vdsen.md', 'references/prompt-maestro-vdsen-coach.md']) {
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /`repsRange`/, f); assert.match(t, /Nunca inventes el mínimo|NUNCA inventes el mínimo/i, f); assert.match(t, /A\.4/, f); assert.match(t, /Repeticiones fijas/, f);
  }
  assert.match(fs.readFileSync('references/prompt-maestro-vdsen-coach.md', 'utf8'), /"repsRange": \{"min": 6, "max": 10\}/, 'the literal JSON example carries it');
});

test('T583-C3 validator: a valid range, a per-set target inside it, and a plan WITHOUT a range (fixed reps) are all valid', () => {
  assert.deepEqual(normalizer.validateVdsenPlan(planWith({ exerciseName: 'A', repsRange: { min: 6, max: 10 }, sets: [{ repsTarget: 10 }, { repsTarget: 8 }, { repsTarget: 6 }] })), { ok: true });
  assert.deepEqual(normalizer.validateVdsenPlan(planWith({ exerciseName: 'A', sets: S(10) })), { ok: true }, 'fixed reps: no range required, none invented');
  assert.deepEqual(normalizer.validateVdsenPlan(planWith({ exerciseName: 'A', repsRange: null, sets: S(10) })), { ok: true });
});

test('T583-C4 validator: a malformed or contradictory range is rejected with a precise code (never repaired)', () => {
  const bad = (r, sets) => normalizer.validateVdsenPlan(planWith({ exerciseName: 'X', repsRange: r, sets: sets || S(8) }));
  for (const r of [{ min: 10, max: 6 }, { min: 8, max: 8 }, { min: 0, max: 8 }, { min: 6, max: 500 }, { min: '6', max: 10 }, { min: 6.5, max: 10 }, [6, 10], '6-10', 8, {}, { min: 6 }]) {
    const out = bad(r); assert.equal(out.ok, false, JSON.stringify(r)); assert.equal(out.error, E.INVALID_REPS_RANGE, JSON.stringify(r));
  }
  assert.equal(bad({ min: 6, max: 10 }, S(12)).error, E.INVALID_REPS_RANGE, 'a set above the ceiling');
  assert.equal(bad({ min: 6, max: 10 }, [{ repsTarget: 8 }, { repsTarget: 4 }]).error, E.INVALID_REPS_RANGE, 'a set below the floor');
});

test('T583-C5 Motor output -> Coach import (the same gate every AI / paste / PDF path uses): the range, per-set targets, RIR, rest and series all arrive intact; fixed reps stay fixed', () => {
  const motor = { weeks: 6, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Día 1 - Push', exercises: [
    { exerciseName: 'Press convergente de pecho', technique: 'straight', repsRange: { min: 6, max: 10 }, sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 120 }, { setIndex: 1, repsTarget: 8, rirTarget: 1, load: 0, restSeconds: 150 }] },
    { exerciseName: 'Elevaciones laterales', technique: 'straight', sets: S(15) },
    { exerciseName: 'Gemelo de pie', technique: 'straight', repsRange: { min: 12, max: 20 }, sets: S(20, 4) }] }] };
  const out = importLikeCoach(motor, { idPrefix: 't583' }), e = out.days[0].exercises;
  assert.deepEqual(e[0].repsRange, { min: 6, max: 10 }); assert.deepEqual(e[0].sets.map((s) => [s.repsTarget, s.rirTarget, s.restSeconds]), [[10, 2, 120], [8, 1, 150]], 'per-set targets, RIR and rest are preserved');
  assert.ok(!('repsRange' in e[1]), 'fixed reps (15): no range'); assert.deepEqual(e[1].sets.map((s) => s.repsTarget), [15, 15, 15]);
  assert.deepEqual(e[2].repsRange, { min: 12, max: 20 }); assert.equal(e[2].sets.length, 4);
  assert.equal(new Set(e.map((x) => x.prescriptionExerciseId)).size, 3);
  assert.deepEqual(out.weeks, 6);
});

test('T583-C6 existing plans keep working: a stored plan without repsRange imports and validates exactly as before', () => {
  const legacy = { weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D', exercises: [{ exerciseName: 'Press X', prescriptionExerciseId: 'legacy-pid-1', sets: S(10) }] }] };
  const out = importLikeCoach(legacy, { idPrefix: 'l' }); assert.equal(out.days[0].exercises[0].prescriptionExerciseId, 'legacy-pid-1'); assert.ok(!('repsRange' in out.days[0].exercises[0]));
  assert.deepEqual(normalizer.validateVdsenPlan(legacy), { ok: true });
});

// ---- T584: the definitive block for the external Motor ----
test('T584-M1 the ready-to-paste Motor block covers every field of the output contract and states that it does NOT update the external Motor', () => {
  const t = fs.readFileSync('references/motor-bloque-salida-entrenamiento.md', 'utf8');
  for (const field of ['exerciseName', 'prescriptionExerciseId', 'exerciseId', 'repsRange', 'repsTarget', 'rirTarget', 'restSeconds', 'setIndex', 'load']) assert.ok(t.includes('`' + field + '`'), field);
  assert.match(t, /NO actualiza el Motor externo/); assert.match(t, /Repeticiones fijas ⇒ OMÍTELO/); assert.match(t, /Nunca inventes el mínimo/); assert.match(t, /NUNCA lo inventes ni lo generes/);
  assert.match(t, /OMÍTELO \(la app lo asigna al guardar/, 'new / substituted / moved exercises get no PID from the Motor');
  assert.match(t, /Su ausencia no impide la progresión/, 'exerciseId is never a requirement');
  assert.match(t, /No cambia ningún criterio científico/);
});

test('T584-M2 the in-repo generator prompt carries the same identifier rule (rule 22) and never asks the model to mint a prescriptionExerciseId', () => {
  const p = generate._internal.buildSystemPrompt();
  assert.match(p, /22\. IDENTIFICADORES \(OPCIONALES\)/); assert.match(p, /prescriptionExerciseId NUNCA lo inventes/); assert.match(p, /Ninguno de los dos es requisito para la progresión/);
  assert.ok(!/genera(r)? (un )?prescriptionExerciseId/i.test(p));
});
