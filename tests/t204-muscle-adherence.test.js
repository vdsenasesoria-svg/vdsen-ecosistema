'use strict';
/**
 * T204 — Muscle-level adherence: PRESCRIBED vs EXECUTED fractional volume.
 *
 * Zero new muscle-classification logic: computeMuscleAdherence calls the
 * EXISTING auditFractionalVolume (P9.3/P10.7, direct×1/indirect×0.5/
 * stabilizer×0, unchanged) TWICE -- once against the real plan, once
 * against a synthetic "executed" shape where each exercise's set count is
 * replaced with however many sets were actually done this week (sourced
 * from T203's setCompletionRate, PID-first, never by name). The ratio
 * between the two fractionalTotals per muscle is adherence EVIDENCE only
 * -- it is never wired to auto-change a plan.
 *
 * Run: node tests/t204-muscle-adherence.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// Pull in every real dependency computeMuscleAdherence needs, in the exact
// order they appear, so the extracted source is self-contained.
const musclesSrc   = COACH.slice(COACH.indexOf('var _MOTOR_MUSCLES'), COACH.indexOf('var _EXERCISE_CANONICAL_METADATA = {'));
const metaSrc      = COACH.slice(COACH.indexOf('var _EXERCISE_CANONICAL_METADATA = {'), COACH.indexOf('function auditFractionalVolume'));
const auditSrc     = extractFunction(COACH, 'function auditFractionalVolume(training, exercisesCatalog)');
const shapeSrc     = extractFunction(COACH, 'function _buildExecutedTrainingShape(training, progressionHistory)');
const computeSrc   = extractFunction(COACH, 'function computeMuscleAdherence(training, exercisesCatalog, progressionHistory)');
ok(metaSrc && musclesSrc && auditSrc && shapeSrc && computeSrc, 'prerequisite: computeMuscleAdherence and every dependency extract cleanly');

const computeMuscleAdherence = new Function(
  metaSrc + ';\n' + musclesSrc + ';\n' + auditSrc + ';\n' + shapeSrc + ';\n' + computeSrc + ';\nreturn computeMuscleAdherence;'
)();

function plan(exercises) {
  return { days: [{ exercises: exercises }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full execution -> adherence ratio ~1.0 for every muscle involved.
// ─────────────────────────────────────────────────────────────────────────────

(function testFullExecutionRatioIsOne() {
  const training = plan([
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-1', sets: [{}, {}, {}, {}] }
  ]);
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-1': { latest: { setCompletionRate: 1 } }
  }};
  const result = computeMuscleAdherence(training, [], progressionHistory);
  const muscles = Object.keys(result.muscles);
  ok(muscles.length > 0, 'Press Banca classifies into at least one muscle via canonical metadata');
  muscles.forEach(function(m) {
    ok(result.muscles[m].adherenceRatio === 1, 'muscle ' + m + ' shows adherenceRatio 1.0 when every prescribed set was executed');
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Worked example: 1-of-4 sets executed -> adherenceRatio ~0.25.
// ─────────────────────────────────────────────────────────────────────────────

(function testPartialExecutionRatio() {
  const training = plan([
    { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-1', sets: [{}, {}, {}, {}] }
  ]);
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-1': { latest: { setCompletionRate: 0.25 } }
  }};
  const result = computeMuscleAdherence(training, [], progressionHistory);
  const anyMuscle = Object.keys(result.muscles)[0];
  ok(Math.abs(result.muscles[anyMuscle].adherenceRatio - 0.25) < 0.05, 'a 1-of-4-sets-executed exercise reports ~0.25 adherenceRatio for its target muscle (got: ' + result.muscles[anyMuscle].adherenceRatio + ')');
})();

// ─────────────────────────────────────────────────────────────────────────────
// PID-first: no PID / no progression entry -> 0 executed, never guessed.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoPidMeansZeroExecutedNeverGuessed() {
  const training = plan([
    { exerciseName: 'Press Banca', sets: [{}, {}, {}, {}] } // no prescriptionExerciseId at all
  ]);
  const result = computeMuscleAdherence(training, [], { byPrescriptionExerciseId: {} });
  const anyMuscle = Object.keys(result.muscles)[0];
  ok(result.muscles[anyMuscle].adherenceRatio === 0, 'an exercise with no PID (no execution evidence) reports 0 adherence, never assumed/guessed from name');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Never an automatic trigger -- pure evidence, no plan mutation anywhere in
// the function body.
// ─────────────────────────────────────────────────────────────────────────────

(function testNeverAutoMutatesAnything() {
  ok(!computeSrc.includes('updateDoc') && !computeSrc.includes('setDoc'), 'computeMuscleAdherence never writes to Firestore -- pure evidence, no auto-adjustment');
  ok(!shapeSrc.includes('updateDoc') && !shapeSrc.includes('setDoc'), '_buildExecutedTrainingShape never writes to Firestore either');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural: exposed via window.VDSEN_ADHERENCE for Coach/Generator reuse.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('computeMuscleAdherence: computeMuscleAdherence // T204'), 'exposed via the same window.VDSEN_ADHERENCE object as T202 (no second engine, no separate export point)');

console.log('');
console.log('T204 — Muscle-level adherence: ' + pass + ' assertions PASSED');
