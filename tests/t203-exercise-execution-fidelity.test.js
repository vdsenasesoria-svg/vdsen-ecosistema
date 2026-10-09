'use strict';
/**
 * T203 — Per-PID exercise execution fidelity classification.
 *
 * HIGH/MEDIUM/LOW/NONE, classifying the SAME setCompletionRate that T205's
 * confidence fix already averages -- no new data collection. PID-first: the
 * rate is only ever resolved via prescriptionExerciseId (T160/166's own
 * rule), so this classifier can never mislabel one exercise using another's
 * data by matching name.
 *
 * Identical in api/vdsen-build-request.js and vdsen-coach.html's ported
 * copy (mirrors the T205/T166 duplication pattern already used for
 * _mapExerciseProgressionHistory itself).
 *
 * Run: node tests/t203-exercise-execution-fidelity.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const { _classifyExerciseExecutionFidelity, _mapExerciseProgressionHistory } = require('../api/vdsen-build-request.js');

(function testTiers() {
  ok(_classifyExerciseExecutionFidelity(1) === 'HIGH', '100% completion -> HIGH');
  ok(_classifyExerciseExecutionFidelity(0.8) === 'HIGH', '80% completion -> HIGH (boundary)');
  ok(_classifyExerciseExecutionFidelity(0.79) === 'MEDIUM', 'just under 80% -> MEDIUM');
  ok(_classifyExerciseExecutionFidelity(0.5) === 'MEDIUM', '50% completion -> MEDIUM (boundary)');
  ok(_classifyExerciseExecutionFidelity(0.49) === 'LOW', 'just under 50% -> LOW');
  ok(_classifyExerciseExecutionFidelity(0.01) === 'LOW', 'a sliver of execution -> LOW, not NONE');
  ok(_classifyExerciseExecutionFidelity(0) === 'NONE', 'zero completion -> NONE');
  ok(_classifyExerciseExecutionFidelity(null) === 'NONE', 'missing/unknown rate -> NONE (never assumes execution happened)');
  ok(_classifyExerciseExecutionFidelity(undefined) === 'NONE', 'undefined rate -> NONE');
})();

(function testIntegratedIntoHistory() {
  const progrecs = {
    'progrec_1_0': { recommendations: [{ prescriptionExerciseId: 'pid-a', exerciseName: 'Sentadilla', setMetrics: { setCompletionRate: 0.25 } }] }
  };
  const result = _mapExerciseProgressionHistory(progrecs);
  const entry = result.byPrescriptionExerciseId['pid-a'].history[0];
  ok(entry.fidelity === 'LOW', 'each history entry carries its own week\'s fidelity label (0.25 -> LOW)');
})();

(function testPIDFirstNeverByName() {
  // Two DIFFERENT PIDs sharing the same exerciseName -- one well executed,
  // one barely executed. Fidelity must never bleed across them.
  const progrecs = {
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-good', exerciseName: 'Press Banca', setMetrics: { setCompletionRate: 1 } },
      { prescriptionExerciseId: 'pid-bad',  exerciseName: 'Press Banca', setMetrics: { setCompletionRate: 0.1 } }
    ]}
  };
  const result = _mapExerciseProgressionHistory(progrecs);
  ok(result.byPrescriptionExerciseId['pid-good'].history[0].fidelity === 'HIGH', 'pid-good keeps its own HIGH fidelity');
  ok(result.byPrescriptionExerciseId['pid-bad'].history[0].fidelity === 'LOW', 'pid-bad (same exerciseName) keeps its own LOW fidelity -- no cross-contamination by name');
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

const coachFidelitySrc = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
ok(coachFidelitySrc, "vdsen-coach.html's ported _classifyExerciseExecutionFidelity extracts cleanly");
const coachFidelityFn = new Function(coachFidelitySrc + ';\nreturn _classifyExerciseExecutionFidelity;')();

(function testCoachCopyMatches() {
  ok(coachFidelityFn(0.9) === 'HIGH', "vdsen-coach.html's ported copy: 0.9 -> HIGH");
  ok(coachFidelityFn(0.3) === 'LOW', "vdsen-coach.html's ported copy: 0.3 -> LOW");
  ok(coachFidelityFn(0) === 'NONE', "vdsen-coach.html's ported copy: 0 -> NONE");
})();

ok(COACH.includes('_classifyExerciseExecutionFidelity: _classifyExerciseExecutionFidelity'), 'exposed via window.VDSEN_BUILD for Coach Monitor / muscle-adherence reuse (no second engine)');

console.log('');
console.log('T203 — Exercise execution fidelity: ' + pass + ' assertions PASSED');
