'use strict';
/**
 * T212 — Exercise & pattern tolerance learning: PRODUCTIVE/TOLERATED/
 * NEUTRAL/LOW_TOLERANCE/REVIEW/INSUFFICIENT_DATA per currently-prescribed
 * PID.
 *
 * Reuses the same >50% majority convention already established for
 * MAJORITY_STALLED/_classifyWeeklyStatus (no new threshold), T210's shared
 * confidence rule, and a new hadPainFlag field on progressionHistory's
 * history entries (sourced from calculateProgression's existing
 * substituteExercise pain flag -- no new clinical measure). Only PIDs
 * present in the CURRENT plan are classified, so a Coach-initiated
 * substitution silently removes stale history from consideration --
 * stronger evidence than any heuristic, per the ticket's own rule.
 *
 * Run: node tests/t212-exercise-pattern-tolerance.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const { _mapExerciseProgressionHistory } = require('../api/vdsen-build-request.js');

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

// ─────────────────────────────────────────────────────────────────────────────
// hadPainFlag propagation, verified via the real Node-requirable mapper.
// ─────────────────────────────────────────────────────────────────────────────

(function testHadPainFlagPropagation() {
  const progrecs = {
    'progrec_1_0': { recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', substituteExercise: 'Revisar alternativa para patrón: rodilla' }] },
    'progrec_2_0': { recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', substituteExercise: null }] }
  };
  const result = _mapExerciseProgressionHistory(progrecs);
  const hist = result.byPrescriptionExerciseId['pid-1'].history;
  ok(hist[0].hadPainFlag === true, 'a week with substituteExercise set propagates hadPainFlag: true');
  ok(hist[1].hadPainFlag === false, 'a week with no substituteExercise propagates hadPainFlag: false');
})();

// ─────────────────────────────────────────────────────────────────────────────
// _computeExerciseToleranceByPid — extracted from vdsen-coach.html.
// ─────────────────────────────────────────────────────────────────────────────

const confSrc = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const toleranceSrc = extractFunction(COACH, 'function _computeExerciseToleranceByPid(planDoc, progressionHistory)');
ok(confSrc && toleranceSrc, 'prerequisite: _computeExerciseToleranceByPid and its dependency extract cleanly');
const computeExerciseTolerance = new Function(confSrc + ';\n' + toleranceSrc + ';\nreturn _computeExerciseToleranceByPid;')();

ok(COACH.includes('computeExerciseTolerance: _computeExerciseToleranceByPid'), 'exposed via window.VDSEN_LEARNED for T214/T215 reuse');

function plan(pids) {
  return { days: [{ exercises: pids.map(function(pid) { return { prescriptionExerciseId: pid, exerciseName: pid }; }) }] };
}

function historyFor(actions, opts) {
  opts = opts || {};
  return { history: actions.map(function(a, i) {
    return {
      week: i + 1, action: a,
      setCompletionRate: (opts.rates && opts.rates[i] !== undefined) ? opts.rates[i] : 0.95,
      hadPainFlag: !!(opts.pain && opts.pain[i])
    };
  })};
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTIVE — majority real progression.
// ─────────────────────────────────────────────────────────────────────────────

(function testProductive() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': historyFor(['increase_load', 'increase_load', 'increase_load', 'maintain', 'increase_load']) } };
  const result = computeExerciseTolerance(plan(['pid-1']), progressionHistory);
  ok(result['pid-1'].classification === 'PRODUCTIVE', 'majority increase_load -> PRODUCTIVE');
  ok(result['pid-1'].confidence === 'high', 'high adherence + 5 weeks -> high confidence');
})();

// ─────────────────────────────────────────────────────────────────────────────
// LOW_TOLERANCE — majority decline.
// ─────────────────────────────────────────────────────────────────────────────

(function testLowTolerance() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': historyFor(['freeze_load', 'reduce_load', 'freeze_load', 'maintain', 'reduce_load']) } };
  const result = computeExerciseTolerance(plan(['pid-1']), progressionHistory);
  ok(result['pid-1'].classification === 'LOW_TOLERANCE', 'majority freeze/reduce -> LOW_TOLERANCE');
})();

// ─────────────────────────────────────────────────────────────────────────────
// TOLERATED — no decline at all, but not a progression majority either.
// ─────────────────────────────────────────────────────────────────────────────

(function testTolerated() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': historyFor(['maintain', 'maintain', 'maintain', 'increase_load', 'maintain']) } };
  const result = computeExerciseTolerance(plan(['pid-1']), progressionHistory);
  ok(result['pid-1'].classification === 'TOLERATED', 'mostly maintain, zero decline -> TOLERATED');
})();

// ─────────────────────────────────────────────────────────────────────────────
// NEUTRAL — genuinely mixed, no clear majority.
// ─────────────────────────────────────────────────────────────────────────────

(function testNeutral() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': historyFor(['increase_load', 'reduce_load', 'maintain', 'maintain', 'freeze_load']) } };
  const result = computeExerciseTolerance(plan(['pid-1']), progressionHistory);
  ok(result['pid-1'].classification === 'NEUTRAL', 'mixed signals with no majority either way -> NEUTRAL');
})();

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW — pain outranks an otherwise-productive trend.
// ─────────────────────────────────────────────────────────────────────────────

(function testReviewOutranksProductive() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': historyFor(
    ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load'],
    { pain: [false, false, true, false, false] }
  )}};
  const result = computeExerciseTolerance(plan(['pid-1']), progressionHistory);
  ok(result['pid-1'].classification === 'REVIEW', 'a single pain week outranks an otherwise clearly PRODUCTIVE trend -> REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// INSUFFICIENT_DATA — poor adherence or too little history.
// ─────────────────────────────────────────────────────────────────────────────

(function testInsufficientData() {
  const oneWeek = { byPrescriptionExerciseId: { 'pid-1': historyFor(['increase_load']) } };
  ok(computeExerciseTolerance(plan(['pid-1']), oneWeek)['pid-1'].classification === 'INSUFFICIENT_DATA', 'a single week -> INSUFFICIENT_DATA regardless of how good it looks');

  const poorAdherence = { byPrescriptionExerciseId: { 'pid-1': historyFor(['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load'], { rates: [0.2, 0.2, 0.2, 0.2, 0.2] }) } };
  ok(computeExerciseTolerance(plan(['pid-1']), poorAdherence)['pid-1'].classification === 'INSUFFICIENT_DATA', 'poor adherence throughout -> INSUFFICIENT_DATA, never a false PRODUCTIVE label');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Coach substitution respected: a PID no longer in the current plan is not
// classified at all -- stale history can never contradict the Coach.
// ─────────────────────────────────────────────────────────────────────────────

(function testCoachSubstitutionRespected() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-old': historyFor(['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load']) } };
  const result = computeExerciseTolerance(plan(['pid-new']), progressionHistory); // pid-old substituted away, pid-new has no history yet
  ok(!('pid-old' in result), 'a substituted-away PID (not in the current plan) is never classified, however productive its stale history looked');
  ok(result['pid-new'].classification === 'INSUFFICIENT_DATA', 'the new PID has no inherited state -- starts INSUFFICIENT_DATA, not merged from pid-old');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No "best exercise" ranking -- output is a per-PID map, not a sorted list.
// ─────────────────────────────────────────────────────────────────────────────

ok(!toleranceSrc.includes('.sort('), '_computeExerciseToleranceByPid never sorts/ranks candidates -- per-PID classification only, no "best exercise" output');

console.log('');
console.log('T212 — Exercise & pattern tolerance: ' + pass + ' assertions PASSED');
