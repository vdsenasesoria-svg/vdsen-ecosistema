'use strict';
/**
 * T160 — Knowledge-first progression integration: close the longitudinal
 * chain per exercise into the Generator request.
 *
 * Scope A (this file): api/vdsen-build-request.js — new
 * _mapExerciseProgressionHistory() that turns the raw progrec_W_D entries
 * (already carrying prescriptionExerciseId/exerciseId/prescribedRIR/
 * observedRIR/repRangeTarget/trend since the T159 persistence fix) into a
 * PID-indexed longitudinal summary, exposed as request.progressionHistory.
 * Pure structural adapter — no invented data, no recalculation.
 *
 * PID-first / no silent association: a recommendation with no
 * prescriptionExerciseId (pre-T159 legacy logs) is counted in
 * unindexedCount but never guessed into a bucket by name or position.
 *
 * Additive only: trainingLogs/checkins/engineState/previousPlan are
 * untouched; progressionHistory is a new, independent top-level field.
 *
 * Run: node tests/t160-progression-history-generator-propagation.test.js
 */

const assert = require('assert');
const path   = require('path');
const B = require(path.join(__dirname, '..', 'api', 'vdsen-build-request.js'));
const _mapExerciseProgressionHistory = B._mapExerciseProgressionHistory;
const _mapLogs = B._mapLogs;

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✓ ' + msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Longitudinal indexing by prescriptionExerciseId, across multiple weeks.
// ─────────────────────────────────────────────────────────────────────────────

(function testLongitudinalIndexing() {
  const progrecs = {
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-bench', exerciseId: 'ex-1', exerciseName: 'Press Banca',
        action: 'maintain', newLoad: 80, newReps: 8, newSets: 4, rirTarget: 2,
        prescribedRIR: 2, observedRIR: 2.1, repRangeTarget: { low: 8, high: 12 },
        trend: null, reason: 'RIR en objetivo' }
    ]},
    'progrec_2_0': { recommendations: [
      { prescriptionExerciseId: 'pid-bench', exerciseId: 'ex-1', exerciseName: 'Press Banca',
        action: 'increase_load', newLoad: 82.5, newReps: 12, newSets: 4, rirTarget: 2,
        prescribedRIR: 2, observedRIR: 3.2, repRangeTarget: { low: 8, high: 12 },
        trend: { prevLoad: 80, prevReps: 8, prevSets: 4, prevICS: 8 }, reason: 'Techo de reps alcanzado' }
    ]},
    'progrec_3_0': { recommendations: [
      { prescriptionExerciseId: 'pid-bench', exerciseId: 'ex-1', exerciseName: 'Press Banca',
        action: 'freeze_load', newLoad: 82.5, newReps: 8, newSets: 4, rirTarget: 2,
        prescribedRIR: 2, observedRIR: 0.5, repRangeTarget: { low: 8, high: 12 },
        trend: { prevLoad: 82.5, prevReps: 12, prevSets: 4, prevICS: 8 }, reason: 'Esfuerzo excesivo' }
    ]}
  };

  const result = _mapExerciseProgressionHistory(progrecs);
  ok(result.byPrescriptionExerciseId['pid-bench'], 'a recommendation with prescriptionExerciseId is indexed');
  const bench = result.byPrescriptionExerciseId['pid-bench'];
  ok(bench.exerciseName === 'Press Banca', 'exerciseName is carried through');
  ok(bench.exerciseId === 'ex-1', 'exerciseId is carried through');
  ok(bench.history.length === 3, 'history accumulates across all 3 weeks for this PID');
  ok(bench.history[0].week === 1 && bench.history[1].week === 2 && bench.history[2].week === 3, 'history is ordered by week ascending');
  ok(bench.history[2].action === 'freeze_load' && bench.history[2].observedRIR === 0.5, 'each history entry preserves its own week\'s action/observedRIR');
  ok(bench.latest.week === 3 && bench.latest.action === 'freeze_load', 'latest points at the most recent week\'s entry');
  ok(bench.confidence === 'medium', '3 weeks of real history maps to medium confidence for this exercise');
  ok(result.unindexedCount === 0, 'no unindexed recommendations when every rec carries a PID');
})();

// ─────────────────────────────────────────────────────────────────────────────
// PID-first: recommendations without prescriptionExerciseId are counted but
// NEVER associated by name/position (no silent guessing).
// ─────────────────────────────────────────────────────────────────────────────

(function testNoSilentAssociation() {
  const progrecs = {
    'progrec_1_0': { recommendations: [
      { exerciseName: 'Sentadilla', action: 'maintain', newLoad: 100 }, // legacy, no PID
      { prescriptionExerciseId: 'pid-squat', exerciseName: 'Sentadilla', action: 'maintain', newLoad: 100 }
    ]}
  };
  const result = _mapExerciseProgressionHistory(progrecs);
  ok(result.unindexedCount === 1, 'a recommendation with no prescriptionExerciseId is counted as unindexed');
  ok(Object.keys(result.byPrescriptionExerciseId).length === 1, 'the unindexed legacy entry is NOT merged into any PID bucket by matching exerciseName');
  ok(result.byPrescriptionExerciseId['pid-squat'].history.length === 1, 'only the PID-carrying recommendation is indexed');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Confidence scale and empty-input safety.
// ─────────────────────────────────────────────────────────────────────────────

(function testConfidenceScaleAndEmptyInput() {
  const single = _mapExerciseProgressionHistory({ 'progrec_1_0': { recommendations: [
    { prescriptionExerciseId: 'pid-x', exerciseName: 'X', action: 'maintain' }
  ]}});
  ok(single.byPrescriptionExerciseId['pid-x'].confidence === 'low', '1 week of history maps to low confidence');

  const five = {};
  for (let w = 1; w <= 5; w++) {
    five['progrec_' + w + '_0'] = { recommendations: [
      { prescriptionExerciseId: 'pid-y', exerciseName: 'Y', action: 'maintain' }
    ]};
  }
  const fiveResult = _mapExerciseProgressionHistory(five);
  ok(fiveResult.byPrescriptionExerciseId['pid-y'].confidence === 'high', '5 weeks of history maps to high confidence');

  const empty = _mapExerciseProgressionHistory({});
  ok(Object.keys(empty.byPrescriptionExerciseId).length === 0 && empty.unindexedCount === 0, 'empty progrecs input produces an empty, safe result (no throw, no invented data)');

  const nullish = _mapExerciseProgressionHistory(null);
  ok(Object.keys(nullish.byPrescriptionExerciseId).length === 0, 'null progrecs input does not throw and produces an empty result');

  const malformed = _mapExerciseProgressionHistory({ 'progrec_1_0': { recommendations: null }, 'progrec_2_0': null });
  ok(Object.keys(malformed.byPrescriptionExerciseId).length === 0 && malformed.unindexedCount === 0, 'malformed entries (null recommendations/null entry) are skipped safely');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Wiring: _mapLogs exposes progressionHistory additively; existing fields
// (trainingLogs/checkins/engineState) are untouched.
// ─────────────────────────────────────────────────────────────────────────────

(function testMapLogsWiring() {
  const logsDoc = {
    currentWeek: 2,
    entries: {
      'log_1_0_0_s0': { carga: 80, reps: 8, done: true },
      'progrec_1_0': { recommendations: [
        { prescriptionExerciseId: 'pid-bench', exerciseName: 'Press Banca', action: 'maintain' }
      ]},
      'ci_sem_1': { peso: 82 },
      'engine_state': { confidence: 'low' }
    }
  };
  const result = _mapLogs(logsDoc);
  ok(result.progressionHistory && result.progressionHistory.byPrescriptionExerciseId['pid-bench'], '_mapLogs exposes progressionHistory built from the same entries');
  ok(result.trainingLogs && result.trainingLogs.progrecs['progrec_1_0'], 'T160 regression: trainingLogs.progrecs (raw, pre-T160) is untouched');
  ok(result.checkins && result.checkins.ciByWeek['ci_sem_1'], 'T160 regression: checkins block is untouched');
  ok(result.engineState && result.engineState.confidence === 'low', 'T160 regression: engineState block is untouched');

  const noLogsResult = _mapLogs(null);
  ok(noLogsResult.progressionHistory === null, '_mapLogs(null) safely yields progressionHistory=null (no throw)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Scope C: legacy-rule audit on the embedded Generator prompt (vdsen-coach.html).
// The prompt must now tell the Generator to consume progressionHistory
// directly (no second progression engine re-derived from raw logs) and to
// preserve well-performing exercises across mesocycles instead of rotating
// "for variety" — closing the gap identified for section 20 of the
// knowledge-first directive. The T159 deload-legacy fix must still hold.
// ─────────────────────────────────────────────────────────────────────────────

(function testGeneratorPromptKnowledgeFirst() {
  const fs = require('fs');
  const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

  ok(COACH.includes('`progressionHistory` por `prescriptionExerciseId`'), 'the prompt tells the Generator progressionHistory is the precomputed progression output');
  ok(COACH.includes('NO recalcules progresión desde `trainingLogs` crudo cuando `progressionHistory` esté disponible'), 'the prompt forbids the LLM from re-deriving a second, ad-hoc progression engine from raw logs');
  ok(COACH.includes('Continuidad de ejercicios entre mesociclos'), 'the prompt now has an explicit exercise-continuity rule');
  ok(COACH.includes('no los rotes \\"para variar\\"'), 'the prompt explicitly forbids calendar/variety-based exercise rotation');
  ok(COACH.includes('El menor cambio suficiente gana.'), 'the prompt states the "smallest sufficient change" principle for exercise substitution');

  // T159 regression — must still hold under T160's edits to the same prompt.
  ok(!COACH.includes('Semana 6 = deload automático'), 'T160 regression: the T159 deload-legacy fix must remain (no automatic week-6 deload claim)');
  ok(COACH.includes('Deload reactivo, no por calendario'), 'T160 regression: the reactive deload description must remain');
})();

console.log('');
console.log('T160 — Exercise progression history propagation: ' + pass + ' assertions PASSED');
