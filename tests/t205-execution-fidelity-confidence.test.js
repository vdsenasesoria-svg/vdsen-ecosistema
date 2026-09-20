'use strict';
/**
 * T205 — Execution fidelity gates progression confidence.
 *
 * Core Principle (T201-T208): LOW ADHERENCE MUST REDUCE DECISION CONFIDENCE.
 * _mapExerciseProgressionHistory's per-PID confidence was based PURELY on
 * week count (history.length), completely ignoring how much of the
 * prescribed sets were actually executed each week. A PID with several
 * weeks of barely-executed sets (e.g. 1-of-4 sets/week) could read as
 * 'high' confidence — directly contradicting the ticket's own example:
 * "A progression recommendation must not receive high confidence from one
 * partially executed set when 4 sets were prescribed."
 *
 * Fix (identical in api/vdsen-build-request.js and vdsen-coach.html's
 * ported copy): each history entry now carries setCompletionRate (sourced
 * from the already-computed, already-PID-scoped, already-autoFilled-
 * excluding rec.setMetrics.setCompletionRate). The count-based confidence
 * tier is then gated by the AVERAGE completion rate across weeks that have
 * it: avg < 0.5 caps at 'low', avg < 0.75 caps 'high' down to 'medium'.
 * Weeks without the field (legacy data) are excluded from the average, not
 * treated as poor execution — so old data is never punished retroactively.
 *
 * Run: node tests/t205-execution-fidelity-confidence.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function makeProgrecs(weeks, completionRates) {
  const progrecs = {};
  weeks.forEach(function(w, i) {
    const rec = { prescriptionExerciseId: 'pid-1', exerciseName: 'Press Banca', action: 'increase_load' };
    if (completionRates[i] !== null) rec.setMetrics = { setCompletionRate: completionRates[i] };
    progrecs['progrec_' + w + '_0'] = { recommendations: [rec] };
  });
  return progrecs;
}

// ─────────────────────────────────────────────────────────────────────────────
// api/vdsen-build-request.js — the canonical Node module.
// ─────────────────────────────────────────────────────────────────────────────

const { _mapExerciseProgressionHistory } = require('../api/vdsen-build-request.js');

(function testWorkedExample_LowCompletionNeverHigh() {
  // 5 weeks of history (would be 'high' by count alone) but only 1-of-4 sets
  // (0.25) executed each week.
  const progrecs = makeProgrecs([1, 2, 3, 4, 5], [0.25, 0.25, 0.25, 0.25, 0.25]);
  const result = _mapExerciseProgressionHistory(progrecs);
  const pidEntry = result.byPrescriptionExerciseId['pid-1'];
  ok(pidEntry.history.length === 5, 'sanity: 5 weeks of history recorded');
  ok(pidEntry.confidence === 'low', 'T205 worked example: 5 weeks of 1-of-4-sets execution must NEVER read as high confidence (got: ' + pidEntry.confidence + ')');
  ok(pidEntry.executionCompleteness === 0.25, 'executionCompleteness reflects the true average completion rate');
})();

(function testHighCompletionKeepsHighConfidence() {
  const progrecs = makeProgrecs([1, 2, 3, 4, 5], [1, 1, 0.9, 1, 1]);
  const result = _mapExerciseProgressionHistory(progrecs);
  const pidEntry = result.byPrescriptionExerciseId['pid-1'];
  ok(pidEntry.confidence === 'high', 'genuinely well-executed weeks still reach high confidence when count and completion both justify it');
})();

(function testMediumCompletionCapsHighToMedium() {
  const progrecs = makeProgrecs([1, 2, 3, 4, 5], [0.6, 0.6, 0.6, 0.6, 0.6]);
  const result = _mapExerciseProgressionHistory(progrecs);
  const pidEntry = result.byPrescriptionExerciseId['pid-1'];
  ok(pidEntry.confidence === 'medium', '5 weeks at 60% completion downgrades what would be high confidence to medium (got: ' + pidEntry.confidence + ')');
})();

(function testLegacyMissingSetMetricsNotPunished() {
  // No setMetrics on any recommendation (pre-T205 data) — must behave exactly
  // as before: pure count-based tier, no downgrade from unknown data.
  const progrecs = makeProgrecs([1, 2, 3, 4, 5], [null, null, null, null, null]);
  const result = _mapExerciseProgressionHistory(progrecs);
  const pidEntry = result.byPrescriptionExerciseId['pid-1'];
  ok(pidEntry.confidence === 'high', 'legacy history without setMetrics falls back to pure count-based confidence (unchanged behavior)');
  ok(pidEntry.executionCompleteness === null, 'executionCompleteness is null (unknown), not 0, when no week carries the field');
})();

(function testLowCountStillLow() {
  const progrecs = makeProgrecs([1], [1]);
  const result = _mapExerciseProgressionHistory(progrecs);
  const pidEntry = result.byPrescriptionExerciseId['pid-1'];
  ok(pidEntry.confidence === 'low', 'a single well-executed week is still only low confidence (count still matters, completion cannot inflate it)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// vdsen-coach.html — the ported copy must behave identically.
// ─────────────────────────────────────────────────────────────────────────────

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

const coachSrc = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
ok(coachSrc, "vdsen-coach.html's ported _mapExerciseProgressionHistory extracts cleanly");
ok(coachSrc.includes('setCompletionRate'), 'the ported copy carries the same T205 setCompletionRate fix');
ok(coachSrc.includes('executionCompleteness'), 'the ported copy carries the same T205 executionCompleteness field');

const coachMapFn = new Function(coachSrc + ';\nreturn _mapExerciseProgressionHistory;')();

(function testCoachCopyMatchesApiCopy() {
  const progrecs = makeProgrecs([1, 2, 3, 4, 5], [0.25, 0.25, 0.25, 0.25, 0.25]);
  const result = coachMapFn(progrecs);
  const pidEntry = result.byPrescriptionExerciseId['pid-1'];
  ok(pidEntry.confidence === 'low', "vdsen-coach.html's ported copy produces the SAME low-adherence-caps-confidence result as api/vdsen-build-request.js");
})();

console.log('');
console.log('T205 — Execution fidelity confidence: ' + pass + ' assertions PASSED');
