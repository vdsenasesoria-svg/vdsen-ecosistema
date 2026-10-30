'use strict';
/**
 * T213 — Recovery sensitivity learning: identifies whether the client
 * repeatedly shows recovery decline at HIGHER training-stress weeks vs
 * their own lower-stress weeks.
 *
 * Purely comparative -- this client's own high-stress weeks vs this
 * client's own low-stress weeks -- using the EXISTING per-week deload-
 * trigger record (progrec_{W}_{D}.deloadTriggers, already computed with
 * existing clinical thresholds from T162's reactive deload logic; no new
 * threshold invented here) and T211's own weekly execution snapshots
 * (total executed sets) as the stress-level proxy. No new clinical score,
 * no absolute/population threshold.
 *
 * Run: node tests/t213-recovery-sensitivity.test.js
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

const confSrc = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const snapSrc = extractFunction(COACH, 'function _buildWeeklyExecutionSnapshots(planDoc, progressionHistory)');
const sensSrc = extractFunction(COACH, 'function _computeRecoverySensitivity(entries, planDoc, progressionHistory)');
const traceSrc = extractFunction(COACH, 'function _buildSraTrace(input)');
ok(confSrc && snapSrc && sensSrc && traceSrc, 'prerequisite: recovery and SRA trace helpers extract cleanly');

const { computeRecoverySensitivity, buildSraTrace } = require('../assets/sra-context.js');
const SRA_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'assets/sra-context.js'), 'utf8');


ok(COACH.includes('computeRecoverySensitivity: _computeRecoverySensitivity'), 'exposed via window.VDSEN_LEARNED for T214/T215 reuse');

function plan(sets) {
  return { days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-1', sets: new Array(sets).fill({}) }] }] };
}

function entriesWithDeload(weeks) {
  // weeks: [{week, deloadTriggerCount}]
  var e = {};
  weeks.forEach(function(w) { e['progrec_' + w.week + '_0'] = { deloadTriggers: new Array(w.deloadTriggerCount).fill('X') }; for (let i = 0; i < (w.week % 2 ? 8 : 4); i++) e['log_' + w.week + '_0_0_s' + i] = { done: true, prescriptionExerciseId: 'pid-1' }; });
  return e;
}

function historyWithRates(weeks) {
  // weeks: [{week, rate}] -- rate drives executed-set count (stress proxy) via T211's snapshot builder
  return { byPrescriptionExerciseId: { 'pid-1': {
    exerciseName: 'Sentadilla',
    history: weeks.map(function(w) { return { week: w.week, action: 'maintain', setCompletionRate: w.rate }; })
  }}};
}

// ─────────────────────────────────────────────────────────────────────────────
// DECLINES_AT_HIGHER_STRESS — high-stress weeks (full sets executed) show
// deload triggers; low-stress weeks (half sets) do not.
// ─────────────────────────────────────────────────────────────────────────────

(function testDeclinesAtHigherStress() {
  const planDoc = plan(8); // 8 prescribed sets -> rate 1.0 = 8 executed sets (high), rate 0.5 = 4 (low)
  const progressionHistory = historyWithRates([
    { week: 1, rate: 1.0 }, { week: 2, rate: 0.5 }, { week: 3, rate: 1.0 }, { week: 4, rate: 0.5 }, { week: 5, rate: 1.0 }, { week: 6, rate: 0.5 }
  ]);
  const entries = entriesWithDeload([
    { week: 1, deloadTriggerCount: 2 }, { week: 2, deloadTriggerCount: 0 },
    { week: 3, deloadTriggerCount: 3 }, { week: 4, deloadTriggerCount: 0 },
    { week: 5, deloadTriggerCount: 2 }, { week: 6, deloadTriggerCount: 0 }
  ]);
  const result = computeRecoverySensitivity(entries, planDoc, progressionHistory);
  ok(result.pattern === 'DECLINES_AT_HIGHER_STRESS', 'deload triggers cluster exclusively in the higher-stress (full-set) weeks -> DECLINES_AT_HIGHER_STRESS (got: ' + result.pattern + ')');
  ok(result.confidence !== 'none' && result.confidence !== 'low', '6 usable weeks -> real confidence');
  ok(result.highStressDeloadRate === 1, 'highStressDeloadRate correctly reports 100% of high-stress weeks triggering deload');
  ok(result.lowStressDeloadRate === 0, 'lowStressDeloadRate correctly reports 0% of low-stress weeks triggering deload');
  ok(result.classification === 'MONITOR' && result.signal === 'RECOVERY_REVIEW' && result.reviewRequired === true, 'S02: persisted recovery concern is a MONITOR requiring Coach review, never a mutation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// STABLE_AT_CURRENT_STRESS — no deload triggers regardless of stress level.
// ─────────────────────────────────────────────────────────────────────────────

(function testStableAtCurrentStress() {
  const planDoc = plan(8);
  const progressionHistory = historyWithRates([
    { week: 1, rate: 1.0 }, { week: 2, rate: 0.5 }, { week: 3, rate: 1.0 }, { week: 4, rate: 0.5 }, { week: 5, rate: 1.0 }, { week: 6, rate: 0.5 }
  ]);
  const entries = entriesWithDeload([
    { week: 1, deloadTriggerCount: 0 }, { week: 2, deloadTriggerCount: 0 },
    { week: 3, deloadTriggerCount: 0 }, { week: 4, deloadTriggerCount: 0 },
    { week: 5, deloadTriggerCount: 0 }, { week: 6, deloadTriggerCount: 0 }
  ]);
  const result = computeRecoverySensitivity(entries, planDoc, progressionHistory);
  ok(result.pattern === 'STABLE_AT_CURRENT_STRESS', 'no deload triggers at any stress level -> STABLE_AT_CURRENT_STRESS');
  ok(result.classification === 'MONITOR' && result.signal === 'RECOVERY_MONITOR' && result.reviewRequired === false, 'S01: stable persisted evidence remains an informational monitor');
})();

// ─────────────────────────────────────────────────────────────────────────────
// INSUFFICIENT_DATA — too few usable weeks (both signals must overlap).
// ─────────────────────────────────────────────────────────────────────────────

(function testInsufficientData() {
  const planDoc = plan(8);
  const progressionHistory = historyWithRates([{ week: 1, rate: 1.0 }]);
  const entries = entriesWithDeload([{ week: 1, deloadTriggerCount: 2 }]);
  const result = computeRecoverySensitivity(entries, planDoc, progressionHistory);
  ok(result.pattern === 'INSUFFICIENT_DATA', 'a single overlapping week -> INSUFFICIENT_DATA, no pattern concluded');
  ok(result.dataStatus === 'INSUFFICIENT_DATA' && result.reviewRequired === true, 'S07/S08: insufficient or missing recovery evidence fails closed');
})();

(function testNoOverlapIsInsufficient() {
  const planDoc = plan(8);
  const progressionHistory = historyWithRates([{ week: 1, rate: 1.0 }, { week: 2, rate: 1.0 }]);
  const entries = {}; // no progrec_ deload records at all
  const result = computeRecoverySensitivity(entries, planDoc, progressionHistory);
  ok(result.pattern === 'INSUFFICIENT_DATA', 'no deload-trigger records at all to compare against stress -> INSUFFICIENT_DATA, never guessed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No invented threshold: deload trigger source reused verbatim from
// existing progrec_{W}_{D}.deloadTriggers, never recomputed here.
// ─────────────────────────────────────────────────────────────────────────────

ok(SRA_SOURCE.includes('entry.deloadTriggers'), 'reuses the EXISTING progrec_{W}_{D}.deloadTriggers record, never recomputes deload logic');
ok(!sensSrc.includes('who5') && !sensSrc.includes('hrv'), 'does not re-derive clinical thresholds itself -- consumes the already-computed trigger record only');

(function testTraceFailsClosedAndKeepsSignalsSeparate() {
  const incomplete = buildSraTrace({ clientId: 'c1' });
  ok(incomplete.dataStatus === 'INSUFFICIENT_DATA' && incomplete.reviewRequired, 'S11/S12: trace rejects missing PID rather than matching name or position');
  const trace = buildSraTrace({ clientId: 'c1', prescriptionExerciseId: 'pid-1', progressionSignal: 'FAVORABLE', recommendation: 'MAINTAIN', sra: { classification: 'MONITOR', signal: 'RECOVERY_REVIEW', reason: 'persisted conflict', evidence: { persistedWeeks: 6 }, weeksObserved: 6, dataStatus: 'PERSISTED_COMPARABLE_EVIDENCE', reviewRequired: true } });
  ok(trace.progressionSignal === 'FAVORABLE' && trace.sraSignal === 'RECOVERY_REVIEW' && trace.reviewRequired && trace.mutation === 'NONE', 'S03/S04/S10: trace preserves distinct progression and SRA signals with no mutation');
})();

console.log('');
console.log('T213 — Recovery sensitivity learning: ' + pass + ' assertions PASSED');
