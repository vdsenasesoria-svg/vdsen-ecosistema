'use strict';
/**
 * T219 — Performance response classification: RESPONDING/STABLE/
 * UNDER_RESPONDING/RECOVERY_LIMITED/INSUFFICIENT_DATA/COACH_REVIEW per
 * currently-prescribed PID, distinct from T212's TOLERANCE question --
 * this is about whether the exercise is moving the client toward the goal.
 *
 * Reuses progressionHistory's own action trend, T203's hadPainFlag, and
 * T218's outcome confidence (week numbers converted to a relative day
 * timeline so the time-horizon gate is meaningful). No new data
 * collection. PID-first, same "only PIDs in the current plan" rule as T212.
 *
 * Run: node tests/t219-performance-response.test.js
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

const confSrc     = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeSrc  = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const responseSrc = extractFunction(COACH, 'function _classifyPerformanceResponse(planDoc, progressionHistory)');
ok(confSrc && outcomeSrc && responseSrc, 'prerequisite: _classifyPerformanceResponse and its dependencies extract cleanly');
const computePerformanceResponse = new Function(confSrc + ';\n' + outcomeSrc + ';\n' + responseSrc + ';\nreturn _classifyPerformanceResponse;')();

ok(COACH.includes('computePerformanceResponse: _classifyPerformanceResponse'), 'exposed via window.VDSEN_OUTCOME for T221/T222 reuse');

function plan(pid) { return { days: [{ exercises: [{ exerciseName: pid, prescriptionExerciseId: pid, sets: [{}, {}, {}, {}] }] }] }; }
function hist(actions, opts) {
  opts = opts || {};
  return { byPrescriptionExerciseId: { 'pid-1': { history: actions.map(function(a, i) {
    return { week: i + 1, action: a, setCompletionRate: (opts.rates && opts.rates[i] !== undefined) ? opts.rates[i] : 0.95, hadPainFlag: !!(opts.pain && opts.pain[i]) };
  })}}};
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONDING — majority real progression, no pain.
// ─────────────────────────────────────────────────────────────────────────────

(function testResponding() {
  const result = computePerformanceResponse(plan('pid-1'), hist(['increase_load', 'increase_load', 'increase_load', 'maintain', 'increase_load']));
  ok(result['pid-1'].classification === 'RESPONDING', 'majority increase_load, no pain -> RESPONDING');
})();

// ─────────────────────────────────────────────────────────────────────────────
// UNDER_RESPONDING — repeated decline under real adherence/time.
// ─────────────────────────────────────────────────────────────────────────────

(function testUnderRespondingFromDecline() {
  const result = computePerformanceResponse(plan('pid-1'), hist(['freeze_load', 'reduce_load', 'freeze_load', 'maintain', 'reduce_load']));
  ok(result['pid-1'].classification === 'UNDER_RESPONDING', 'majority decline under real adherence -> UNDER_RESPONDING');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Core Principle: no progress + poor adherence -> INSUFFICIENT_DATA, NEVER
// UNDER_RESPONDING.
// ─────────────────────────────────────────────────────────────────────────────

(function testPoorAdherenceNeverUnderResponding() {
  const result = computePerformanceResponse(plan('pid-1'), hist(
    ['freeze_load', 'reduce_load', 'freeze_load', 'maintain', 'reduce_load'],
    { rates: [0.15, 0.1, 0.2, 0.1, 0.15] }
  ));
  ok(result['pid-1'].classification === 'INSUFFICIENT_DATA', 'CORE PRINCIPLE: no progress + poor adherence -> INSUFFICIENT_DATA, never UNDER_RESPONDING, however bad the trend looks');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No progress + high adherence + sufficient time (high confidence) ->
// UNDER_RESPONDING may be valid, even without active decline.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoProgressHighConfidenceUnderResponding() {
  const result = computePerformanceResponse(plan('pid-1'), hist(
    ['maintain', 'maintain', 'maintain', 'maintain', 'maintain'],
    { rates: [0.95, 0.95, 0.95, 0.95, 0.95] }
  ));
  ok(result['pid-1'].confidence === 'high', 'sanity: 5 weeks of high-quality maintain -> high confidence');
  ok(result['pid-1'].classification === 'UNDER_RESPONDING', 'no progress + high adherence + sufficient time (high confidence) -> UNDER_RESPONDING is a valid read');
})();

(function testNoProgressMediumConfidenceStaysStable() {
  const result = computePerformanceResponse(plan('pid-1'), hist(['maintain', 'maintain', 'maintain'], { rates: [0.95, 0.95, 0.95] }));
  ok(result['pid-1'].confidence === 'medium', 'sanity: 3 weeks -> medium confidence');
  ok(result['pid-1'].classification === 'STABLE', 'no progress with only medium confidence (not enough sustained evidence) -> cautious STABLE, not UNDER_RESPONDING yet');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Good progression + pain -> COACH_REVIEW, not "successful response".
// ─────────────────────────────────────────────────────────────────────────────

(function testGoodProgressionWithPainIsReview() {
  const result = computePerformanceResponse(plan('pid-1'), hist(
    ['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load'],
    { pain: [false, false, true, false, false] }
  ));
  ok(result['pid-1'].classification === 'COACH_REVIEW', 'good progression despite a pain signal -> COACH_REVIEW, never labeled a successful response');
})();

// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY_LIMITED — pain present, no clear progression majority.
// ─────────────────────────────────────────────────────────────────────────────

(function testRecoveryLimited() {
  const result = computePerformanceResponse(plan('pid-1'), hist(
    ['maintain', 'freeze_load', 'maintain', 'reduce_load', 'maintain'],
    { pain: [true, false, false, false, false] }
  ));
  ok(result['pid-1'].classification === 'RECOVERY_LIMITED', 'pain present without a clear progression majority -> RECOVERY_LIMITED, distinct from a plain non-response');
})();

// ─────────────────────────────────────────────────────────────────────────────
// PID-first: a substituted-away PID is never classified.
// ─────────────────────────────────────────────────────────────────────────────

(function testCoachSubstitutionRespected() {
  const oldHistory = hist(['increase_load', 'increase_load', 'increase_load', 'increase_load', 'increase_load']);
  oldHistory.byPrescriptionExerciseId['pid-old'] = oldHistory.byPrescriptionExerciseId['pid-1'];
  delete oldHistory.byPrescriptionExerciseId['pid-1'];
  const result = computePerformanceResponse(plan('pid-new'), oldHistory);
  ok(!('pid-old' in result), 'a substituted-away PID is never classified, however good its stale trend looked');
  ok(result['pid-new'].classification === 'INSUFFICIENT_DATA', 'the new PID starts with no inherited response state');
})();

console.log('');
console.log('T219 — Performance response classification: ' + pass + ' assertions PASSED');
