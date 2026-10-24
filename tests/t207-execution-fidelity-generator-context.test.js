'use strict';
/**
 * T207 — Exposes the adherence/execution-fidelity layer (T202-204)
 * additively to the canonical Generator, and forbids the Generator from
 * misinterpreting it.
 *
 * _computeExecutionFidelityForRequest reuses window.VDSEN_ADHERENCE
 * entirely (T202/203/204's computeSessionSummary/computeMuscleAdherence,
 * and progressionHistory's own confidence/executionCompleteness/fidelity
 * fields from T205) -- no second engine, no recalculated adherence.
 * Wired into buildGenerationRequest as `executionFidelity`, additive.
 *
 * The prompt gets a new section explicitly forbidding: (a) treating
 * low-progress + low-adherence as proof the prescription/exercise/
 * mesocycle is bad, (b) using executionFidelity to directly justify a
 * volume/exercise/mesocycle change (that's weeklyDecision/
 * adaptivePrescription/mesocycleDecision's job), (c) building a second
 * adherence engine from raw trainingLogs/checkins.
 *
 * Run: node tests/t207-execution-fidelity-generator-context.test.js
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

// ─────────────────────────────────────────────────────────────────────────────
// Structural: wired into buildGenerationRequest additively.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('var executionFidelity = _computeExecutionFidelityForRequest(planDoc, weeklyDecision, logsResult.progressionHistory);'), 'buildGenerationRequest computes executionFidelity');
ok(COACH.includes('executionFidelity: executionFidelity,'), 'executionFidelity is wired into the assembled request additively');

const computeSrc = extractFunction(COACH, 'function _computeExecutionFidelityForRequest(planDoc, weeklyDecision, progressionHistory)');
ok(computeSrc, '_computeExecutionFidelityForRequest extracts cleanly');
ok(computeSrc.includes("typeof window.VDSEN_ADHERENCE === 'undefined'"), 'safely returns null rather than guessing if the adherence layer is unavailable for any reason');
ok(computeSrc.includes('window.VDSEN_ADHERENCE.computeMuscleAdherence'), 'reuses the real T204 muscle-adherence function, no recomputation');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: exercise the real function.
// ─────────────────────────────────────────────────────────────────────────────

(function testMissingAdherenceLayerReturnsNullSafely() {
  const fn = new Function('window', computeSrc + ';\nreturn _computeExecutionFidelityForRequest;')({});
  const result = fn({}, null, null);
  ok(result === null, 'window.VDSEN_ADHERENCE unavailable -> null, no throw, no fabricated data');
})();

(function testAssemblesFromRealPieces() {
  const win = {
    VDSEN_ADHERENCE: {
      computeMuscleAdherence: function(planDoc, catalog, progHist) {
        return { muscles: { pectoral: { adherenceRatio: 0.45 } }, unclassified: [] };
      }
    }
  };
  const fn2 = new Function('window', computeSrc + ';\nreturn _computeExecutionFidelityForRequest;')(win);
  const planDoc = { days: [] };
  const weeklyDecision = { status: 'ADHERENCE_LIMITED', sessionAdherence: { executionRate: 0.45, week: 4 } };
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-1': { confidence: 'low', executionCompleteness: 0.3, latest: { fidelity: 'LOW' } }
  }};
  const result = fn2(planDoc, weeklyDecision, progressionHistory);
  ok(result.sessionAdherence.executionRate === 0.45, 'sessionAdherence is passed through from weeklyDecision (T202), not recomputed');
  ok(result.exerciseConfidenceByPid['pid-1'].confidence === 'low', 'exerciseConfidenceByPid surfaces the real T205 confidence per PID');
  ok(result.exerciseConfidenceByPid['pid-1'].latestFidelity === 'LOW', 'exerciseConfidenceByPid surfaces the real T203 fidelity label per PID');
  ok(result.muscleExecution.muscles.pectoral.adherenceRatio === 0.45, 'muscleExecution is the real T204 output, passed through unchanged');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Prompt regression: forbids misinterpreting the adherence layer.
// ─────────────────────────────────────────────────────────────────────────────

(function testPromptGuidance() {
  const idx = COACH.indexOf('const _MOTOR_PROMPT_EMBEDDED');
  const strStart = COACH.indexOf('"', idx);
  const endIdx = COACH.indexOf('";', strStart);
  const jsStr = COACH.slice(strStart, endIdx + 1);
  const promptText = eval(jsStr); // eslint-disable-line no-eval -- test-only, reads the real embedded prompt string

  ok(promptText.includes('CONTEXTO DE EJECUCION Y ADHERENCIA (executionFidelity)'), 'the prompt documents the new executionFidelity field');
  ok(promptText.includes('NUNCA interpretes "sin progreso" + adherencia/ejecucion baja como prueba de que la prescripcion, un ejercicio o el mesociclo estan mal disenados'), 'the prompt explicitly forbids treating low-progress+low-adherence as proof of a bad prescription/exercise/mesocycle (Core Principle)');
  ok(promptText.includes('NUNCA uses `executionFidelity` como justificacion directa para aumentar volumen, cambiar un ejercicio o forzar una transicion de mesociclo'), 'the prompt forbids using executionFidelity as direct justification for a plan change -- that stays weeklyDecision/adaptivePrescription/mesocycleDecision\'s job');
  ok(promptText.includes('NUNCA construyas tu propio calculo de adherencia a partir de'), 'the prompt forbids the Generator from building a second adherence engine from raw logs');
})();

console.log('');
console.log('T207 — Execution fidelity Generator context: ' + pass + ' assertions PASSED');
