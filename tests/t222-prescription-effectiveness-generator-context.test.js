'use strict';
/**
 * T222 — Exposes the T218-221 outcome-response/effectiveness layer to the
 * canonical Generator additively, with prompt rules forbidding misuse and
 * causal overclaims.
 *
 * _computePrescriptionEffectivenessForRequest reuses window.VDSEN_OUTCOME
 * entirely (T219's performance response, T220's body-composition
 * response, T221's synthesis) plus weeklyDecision.sessionAdherence and
 * learnedState.recoverySensitivity as-is -- no second engine, no
 * recomputation from raw logs. Wired into buildGenerationRequest as an
 * additive `prescriptionEffectiveness` field.
 *
 * Run: node tests/t222-prescription-effectiveness-generator-context.test.js
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

ok(COACH.includes('var prescriptionEffectiveness = _computePrescriptionEffectivenessForRequest(planDoc, fd, clientDoc, weeklyDecision, logsResult.progressionHistory, learnedState);'), 'buildGenerationRequest computes prescriptionEffectiveness');
ok(COACH.includes('prescriptionEffectiveness: prescriptionEffectiveness,'), 'prescriptionEffectiveness is wired into the assembled request additively');

const computeSrc = extractFunction(COACH, 'function _computePrescriptionEffectivenessForRequest(planDoc, fd, clientDoc, weeklyDecision, progressionHistory, learnedState)');
ok(computeSrc, '_computePrescriptionEffectivenessForRequest extracts cleanly');
ok(computeSrc.includes("typeof window.VDSEN_OUTCOME === 'undefined'"), 'safely returns null rather than guessing if the outcome layer is unavailable for any reason');
ok(computeSrc.includes('learnedState.recoverySensitivity'), 'reuses the T213 recoverySensitivity already computed for learnedState, no recomputation');
ok(computeSrc.includes("weeklyDecision && weeklyDecision.status === 'PAIN_REVIEW'"), 'derives hasPain from the already-computed weeklyDecision.status, no second pain detector');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: exercise the real function against a stubbed window.VDSEN_OUTCOME.
// ─────────────────────────────────────────────────────────────────────────────

(function testMissingOutcomeLayerReturnsNullSafely() {
  const fn = new Function('window', computeSrc + ';\nreturn _computePrescriptionEffectivenessForRequest;')({});
  ok(fn({}, {}, {}, null, {}, null) === null, 'window.VDSEN_OUTCOME unavailable -> null, no throw, no fabricated data');
})();

(function testAssemblesFromRealPieces() {
  const win = {
    VDSEN_OUTCOME: {
      computePerformanceResponse: function() { return { 'pid-1': { classification: 'RESPONDING', confidence: 'high' }, 'pid-2': { classification: 'COACH_REVIEW', confidence: 'high' } }; },
      computeBodyCompositionResponse: function(inbody, goal) { return { classification: 'ON_TARGET', confidence: 'medium', measurementsUsed: 3, _goalSeen: goal }; },
      computeEffectiveness: function(input) { return { overall: 'SAFETY_REVIEW', confidence: 'high', reasons: ['safety_signal_present'], _inputSeen: input }; }
    }
  };
  const planDoc = { days: [{ exercises: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Press Banca' }, { prescriptionExerciseId: 'pid-2', exerciseName: 'Sentadilla' }] }] };
  const fd = { objetivo_calorico: 'déficit' };
  const clientDoc = { inbodyResults: [{ peso: 80 }] };
  const weeklyDecision = { status: 'STABLE', sessionAdherence: { executionRate: 0.9 } };
  const learnedState = { recoverySensitivity: { pattern: 'STABLE_AT_CURRENT_STRESS' } };

  const fn = new Function('window', computeSrc + ';\nreturn _computePrescriptionEffectivenessForRequest;')(win);
  const result = fn(planDoc, fd, clientDoc, weeklyDecision, {}, learnedState);

  ok(result.overall === 'SAFETY_REVIEW', 'overall is the real T221 synthesis output');
  ok(result.performanceResponse['pid-1'].classification === 'RESPONDING', 'performanceResponse is the real T219 output, passed through unchanged');
  ok(result.bodyCompositionResponse._goalSeen === 'déficit', 'objetivo_calorico is correctly passed through to the body-composition classifier');
  ok(result.reviewItems.indexOf('Sentadilla') !== -1, 'reviewItems names the COACH_REVIEW-classified exercise by its real name, never a fabricated one');
  ok(result.reviewItems.indexOf('Press Banca') === -1, 'a RESPONDING exercise is never listed in reviewItems');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Prompt regression: forbids misinterpreting/misusing prescriptionEffectiveness
// and forbids causal overclaims.
// ─────────────────────────────────────────────────────────────────────────────

(function testPromptGuidance() {
  const idx = COACH.indexOf('const _MOTOR_PROMPT_EMBEDDED');
  const strStart = COACH.indexOf('"', idx);
  const endIdx = COACH.indexOf('";', strStart);
  const jsStr = COACH.slice(strStart, endIdx + 1);
  const promptText = eval(jsStr); // eslint-disable-line no-eval -- test-only, reads the real embedded prompt string

  ok(promptText.includes('CONTEXTO DE EFECTIVIDAD DE LA PRESCRIPCION (prescriptionEffectiveness)'), 'the prompt documents the new prescriptionEffectiveness field');
  ok(promptText.includes('TOLERANCIA no es lo mismo que EFECTIVIDAD'), 'the prompt states the Core Principle directly');
  ok(promptText.includes('DATA_INSUFFICIENT` significa adherencia/evidencia insuficiente -- NUNCA concluyas que la prescripcion es mala'), 'the prompt forbids concluding a bad prescription from DATA_INSUFFICIENT');
  ok(promptText.includes('SAFETY_REVIEW` significa que hay una señal de dolor o revision de seguridad activa -- NUNCA la trates como una respuesta exitosa'), 'the prompt forbids treating SAFETY_REVIEW as a successful response');
  ok(promptText.includes('NUNCA recalcules tu propia sintesis de efectividad a partir de'), 'the prompt forbids the Generator from building a second effectiveness engine from raw logs');
  ok(promptText.includes('NUNCA rotes ejercicios por novedad usando `prescriptionEffectiveness` como excusa'), 'the prompt forbids exercise rotation for novelty using this context as an excuse');
  ok(promptText.includes('NUNCA escales volumen ni apliques un deload automatico basandote solo en `prescriptionEffectiveness`'), 'the prompt forbids automatic volume escalation or deload from this context alone');
  ok(promptText.includes('NUNCA afirmes causalidad'), 'the prompt explicitly forbids causal overclaims (e.g. "this exercise caused muscle growth")');
  ok(promptText.includes('usa lenguaje de asociacion/tendencia observada'), 'the prompt requires association/trend language instead of proven-cause language');
})();

console.log('');
console.log('T222 — Prescription effectiveness Generator context: ' + pass + ' assertions PASSED');
