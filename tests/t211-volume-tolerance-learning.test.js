'use strict';
/**
 * T211 — Volume tolerance learning: a client-specific tolerated fractional-
 * volume RANGE per muscle, learned from REPEATED real weekly outcomes.
 *
 * Reuses auditFractionalVolume UNMODIFIED (black-box, same trick as T204's
 * _buildExecutedTrainingShape) against one synthetic per-week shape
 * reconstructed from progressionHistory alone, and _computeEvidenceConfidence
 * (T210) gated on that muscle's own weekly execution quality (setMetrics.
 * setCompletionRate, PID-scoped). Never auto-changes volume -- only learns
 * the prior; _decideAdaptivePrescription remains the sole place that ever
 * recommends a change.
 *
 * Run: node tests/t211-volume-tolerance-learning.test.js
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

const musclesSrc  = COACH.slice(COACH.indexOf('var _MOTOR_MUSCLES'), COACH.indexOf('var _EXERCISE_CANONICAL_METADATA = {'));
const metaSrc      = COACH.slice(COACH.indexOf('var _EXERCISE_CANONICAL_METADATA = {'), COACH.indexOf('function auditFractionalVolume'));
const auditSrc     = extractFunction(COACH, 'function auditFractionalVolume(training, exercisesCatalog)');
const confSrc      = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const snapSrc      = extractFunction(COACH, 'function _buildWeeklyExecutionSnapshots(planDoc, progressionHistory)');
const toleranceSrc = extractFunction(COACH, 'function _computeVolumeToleranceByMuscle(planDoc, progressionHistory, exercisesCatalog)');
ok([musclesSrc, metaSrc, auditSrc, confSrc, snapSrc, toleranceSrc].every(Boolean), 'prerequisite: computeVolumeTolerance and every dependency extract cleanly');

const computeVolumeTolerance = new Function(
  musclesSrc + ';\n' + metaSrc + ';\n' + auditSrc + ';\n' + confSrc + ';\n' + snapSrc + ';\n' + toleranceSrc + ';\nreturn _computeVolumeToleranceByMuscle;'
)();

ok(COACH.includes('computeVolumeTolerance: _computeVolumeToleranceByMuscle'), 'exposed via window.VDSEN_LEARNED for T214 Generator/T215 Coach reuse');

function plan(sets) {
  return { days: [{ exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-1', sets: new Array(sets).fill({}) }] }] };
}

function historyWeeks(weeks) {
  // weeks: [{week, action, rate}]
  return { byPrescriptionExerciseId: { 'pid-1': {
    exerciseName: 'Press Banca',
    history: weeks.map(function(w) { return { week: w.week, action: w.action, setCompletionRate: w.rate }; })
  }}};
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A (from T216's own spec): 4+ valid weeks, high adherence, good
// progression -> HIGH confidence, TOLERATED, a real range.
// ─────────────────────────────────────────────────────────────────────────────

(function testToleratedWithHighConfidence() {
  const progressionHistory = historyWeeks([
    { week: 1, action: 'increase_load', rate: 0.95 },
    { week: 2, action: 'increase_load', rate: 1 },
    { week: 3, action: 'maintain', rate: 0.9 },
    { week: 4, action: 'increase_load', rate: 0.95 },
    { week: 5, action: 'increase_load', rate: 1 }
  ]);
  const result = computeVolumeTolerance(plan(4), progressionHistory, []);
  const anyMuscle = Object.keys(result)[0];
  ok(anyMuscle, 'Press Banca classifies into at least one muscle');
  const rec = result[anyMuscle];
  ok(rec.confidence === 'high', '5 weeks of high-quality, good-outcome execution -> high confidence');
  ok(rec.evidence === 'TOLERATED', 'good outcomes at this volume -> TOLERATED');
  ok(rec.toleratedRange !== null && rec.toleratedRange.min > 0, 'a real tolerated range is produced');
  ok(rec.weeksObserved === 5, 'weeksObserved reflects the real week count');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B: repeated recovery decline (freeze/reduce) at a similar volume ->
// MAY_EXCEED_TOLERANCE, still with real confidence (adherence was high).
// ─────────────────────────────────────────────────────────────────────────────

(function testMayExceedTolerance() {
  const progressionHistory = historyWeeks([
    { week: 1, action: 'freeze_load', rate: 0.95 },
    { week: 2, action: 'reduce_load', rate: 0.9 },
    { week: 3, action: 'freeze_load', rate: 1 },
    { week: 4, action: 'reduce_load', rate: 0.95 },
    { week: 5, action: 'freeze_load', rate: 1 }
  ]);
  const result = computeVolumeTolerance(plan(4), progressionHistory, []);
  const anyMuscle = Object.keys(result)[0];
  const rec = result[anyMuscle];
  ok(rec.confidence === 'high', 'high adherence throughout -> real confidence even though the outcome is bad');
  ok(rec.evidence === 'MAY_EXCEED_TOLERANCE', 'repeated decline at high adherence -> MAY_EXCEED_TOLERANCE, not silently TOLERATED');
  ok(rec.toleratedRange === null, 'no tolerated range when every observed week was a bad outcome');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C: poor adherence throughout -> confidence stays LOW/NONE, and the
// Core Principle holds -- NEVER concludes low tolerance from low adherence.
// ─────────────────────────────────────────────────────────────────────────────

(function testPoorAdherenceNeverConcludesLowTolerance() {
  const progressionHistory = historyWeeks([
    { week: 1, action: 'freeze_load', rate: 0.2 },
    { week: 2, action: 'reduce_load', rate: 0.15 },
    { week: 3, action: 'freeze_load', rate: 0.25 },
    { week: 4, action: 'reduce_load', rate: 0.1 },
    { week: 5, action: 'freeze_load', rate: 0.2 }
  ]);
  const result = computeVolumeTolerance(plan(4), progressionHistory, []);
  const anyMuscle = Object.keys(result)[0];
  const rec = result[anyMuscle];
  ok(rec.confidence === 'low' || rec.confidence === 'none', 'poor adherence caps confidence at low/none, regardless of week count (got: ' + rec.confidence + ')');
  ok(rec.evidence === 'INSUFFICIENT_DATA', 'CORE PRINCIPLE: low adherence -> INSUFFICIENT_DATA, NEVER MAY_EXCEED_TOLERANCE, even though every action looked bad');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D: one excellent week -> no HIGH confidence, evidence stays
// INSUFFICIENT_DATA.
// ─────────────────────────────────────────────────────────────────────────────

(function testOneWeekNeverHighConfidence() {
  const progressionHistory = historyWeeks([{ week: 1, action: 'increase_load', rate: 1 }]);
  const result = computeVolumeTolerance(plan(4), progressionHistory, []);
  const anyMuscle = Object.keys(result)[0];
  const rec = result[anyMuscle];
  ok(rec.confidence !== 'high', 'a single excellent week never reaches high confidence');
  ok(rec.evidence === 'INSUFFICIENT_DATA', 'a single week is INSUFFICIENT_DATA, not a conclusion either way');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural: never auto-changes volume -- pure learning, no plan mutation.
// ─────────────────────────────────────────────────────────────────────────────

(function testNeverAutoMutatesAnything() {
  ok(!toleranceSrc.includes('updateDoc') && !toleranceSrc.includes('setDoc'), '_computeVolumeToleranceByMuscle never writes to Firestore -- pure learning, no auto-adjustment');
  ok(!snapSrc.includes('updateDoc') && !snapSrc.includes('setDoc'), '_buildWeeklyExecutionSnapshots never writes to Firestore either');
})();

console.log('');
console.log('T211 — Volume tolerance learning: ' + pass + ' assertions PASSED');
