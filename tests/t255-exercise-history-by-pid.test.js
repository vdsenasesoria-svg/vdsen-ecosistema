'use strict';
/**
 * T255 — Exercise history by PID, within a historical mesociclo.
 * Deliberately does NOT reconstruct per-set carga/reps/RIR-real from raw
 * log_{W}_{D}_{E}_s{S} entries (positional, day+exercise INDEX -- unsafe
 * if the plan was reordered mid-mesociclo, T241/T246's audited finding).
 * The only PID-safe evolution data is each week's progrec recommendation,
 * reusing window.VDSEN_BUILD._mapExerciseProgressionHistory (T160/166)
 * verbatim -- no second engine, no per-set reconstruction invented.
 *
 * Run: node tests/t255-exercise-history-by-pid.test.js
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

const fidelitySrc = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
const mapHistSrc  = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
const detailFnSrc = extractFunction(COACH, 'function _buildHistoricalExerciseDetail(planId, mesoDoc, planDoc, prescriptionExerciseId)');
const selectSrc   = extractFunction(COACH, 'window._onHistoricalExerciseSelect = async function(planId, prescriptionExerciseId)');

ok([fidelitySrc, mapHistSrc, detailFnSrc, selectSrc].every(Boolean), 'prerequisite: _buildHistoricalExerciseDetail and its real dependencies extract cleanly');
ok(COACH.includes('window._buildHistoricalExerciseDetail = _buildHistoricalExerciseDetail;'), 'exposed for reuse/testing');
ok(!/log_\\d\+_\\d\+_\\d\+_s/.test(detailFnSrc) && !detailFnSrc.includes("match(/^log_"), 'confirmed: never reads positional per-set log_ entries -- only PID-exact progrec recommendations');
ok(!detailFnSrc.includes('updateDoc') && !detailFnSrc.includes('setDoc') && !detailFnSrc.includes('getDoc'), 'pure function -- no Firestore access');
ok(selectSrc.includes('_historicalMesoState.planDocCache[planId]'), 'the UI handler reuses the ALREADY-cached plan doc from the T254 mesociclo-level selection -- no extra read per exercise click');

function makeEngine() {
  const fakeWindow = { VDSEN_BUILD: { _mapExerciseProgressionHistory: new Function(fidelitySrc + ';\n' + mapHistSrc + '; return _mapExerciseProgressionHistory;')() } };
  return new Function('window', detailFnSrc + ';\nreturn _buildHistoricalExerciseDetail;')(fakeWindow);
}
const build = makeEngine();

// ─────────────────────────────────────────────────────────────────────────────
// Basic resolution: real evidence for a real PID.
// ─────────────────────────────────────────────────────────────────────────────

(function testBasicResolution() {
  const planDoc = { days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-1' }] }] };
  const mesoDoc = { entries: {
    'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', action: 'maintain', newLoad: 80, newReps: 8, observedRIR: 2 }] },
    'progrec_2_0': { calculatedAt: '2026-01-08T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', action: 'increase_load', newLoad: 82.5, newReps: 8, observedRIR: 1 }] }
  } };
  const detail = build('plan-A', mesoDoc, planDoc, 'pid-1');
  ok(detail.resolved === true, 'a PID with real evidence resolves');
  ok(detail.exerciseName === 'Sentadilla' && detail.weeksExecuted.join(',') === '1,2', 'name (from the real plan doc) and weeks executed are correct');
  ok(detail.weeklyEvolution.length === 2 && detail.weeklyEvolution[1].newLoad === 82.5, 'weekly evolution (load/reps/RIR real) is the real per-week recommendation data, unmodified');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Mismo nombre / PID diferente: never bleeds evidence between them.
// ─────────────────────────────────────────────────────────────────────────────

(function testSameNameDifferentPid() {
  const planDoc = { days: [{ exercises: [
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-old' },
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-new' }
  ] }] };
  const mesoDoc = { entries: { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-new', exerciseName: 'Sentadilla', newLoad: 100 }] } } };
  const oldDetail = build('plan-B', mesoDoc, planDoc, 'pid-old');
  const newDetail = build('plan-B', mesoDoc, planDoc, 'pid-new');
  ok(oldDetail.resolved === false, 'pid-old has NO evidence of its own -- never inherits pid-new\'s data despite the identical name');
  ok(newDetail.resolved === true && newDetail.weeklyEvolution[0].newLoad === 100, 'pid-new correctly resolves its own real evidence');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Reorder: the SAME progrec data, plan doc with exercises in reverse
// array order -- the result must be identical (PID-exact, index-free).
// ─────────────────────────────────────────────────────────────────────────────

(function testReorderImmune() {
  const mesoDoc = { entries: { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Peso Muerto', newLoad: 120 }] } } };
  const planForward = { days: [{ exercises: [{ exerciseName: 'Peso Muerto', prescriptionExerciseId: 'pid-1' }, { exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-2' }] }] };
  const planReversed = { days: [{ exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-2' }, { exerciseName: 'Peso Muerto', prescriptionExerciseId: 'pid-1' }] }] };
  const a = build('plan-C', mesoDoc, planForward, 'pid-1');
  const b = build('plan-C', mesoDoc, planReversed, 'pid-1');
  ok(JSON.stringify(a) === JSON.stringify(b), 'reordering the plan\'s exercise array produces IDENTICAL historical detail for the same PID -- position never affects identity');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Legacy PID-less: never assigned automatically, no evidence returned.
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyPidLess() {
  const mesoDoc = { entries: { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ exerciseName: 'Ejercicio legado' }] } } };
  const detail = build('plan-D', mesoDoc, null, 'pid-does-not-exist-in-legacy-data');
  ok(detail.resolved === false, 'a PID with no matching (PID-less legacy) recommendation resolves as unresolved, never guessed from the legacy entry');
})();

(function testNoPidRequested() {
  ok(build('plan-D', {}, null, null) === null, 'calling with no PID at all -> null, never a fabricated detail view');
  ok(build(null, {}, null, 'pid-1') === null, 'calling with no planId at all -> null');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Plan doc missing: exercise name falls back to the recommendation's own
// real name, never invented.
// ─────────────────────────────────────────────────────────────────────────────

(function testPlanDocMissingFallback() {
  const mesoDoc = { entries: { 'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Remo con Barra', newLoad: 60 }] } } };
  const detail = build('plan-E', mesoDoc, null, 'pid-1');
  ok(detail.resolved === true && detail.exerciseName === 'Remo con Barra', 'without a plan doc, the exercise name still resolves from the recommendation\'s own REAL name field, never a guess');
})();

console.log('');
console.log('T255 — Exercise history by PID: ' + pass + ' assertions PASSED');
