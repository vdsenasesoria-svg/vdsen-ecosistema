'use strict';
/**
 * T214 — Exposes the T210-213 longitudinal learned-state layer to the
 * canonical Generator additively, with prompt rules forbidding misuse.
 *
 * _computeLearnedStateForRequest reuses window.VDSEN_LEARNED entirely
 * (T210's confidence rule, T211's volume tolerance, T212's exercise/
 * pattern tolerance, T213's recovery sensitivity) -- no second engine, no
 * recomputation from raw logs. Wired into buildGenerationRequest as an
 * additive `learnedState` field.
 *
 * Run: node tests/t214-learned-state-generator-context.test.js
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

// T278: buildGenerationRequest now sources this from the canonical
// _buildClientDecisionSnapshot (which itself still calls the exact same
// _computeLearnedStateForRequest verbatim) rather than an inline call.
ok(COACH.includes('_computeLearnedStateForRequest(entries, planDoc, logsResult.progressionHistory)'), 'the real computation still happens verbatim (inside the snapshot builder, T276)');
ok(COACH.includes('var learnedState              = snapshot.learnedState;'), 'buildGenerationRequest computes learnedState (FIXED for T278\'s snapshot routing)');
ok(COACH.includes('learnedState:      learnedState,'), 'learnedState is wired into the assembled request additively');

const computeSrc = extractFunction(COACH, 'function _computeLearnedStateForRequest(entries, planDoc, progressionHistory)');
ok(computeSrc, '_computeLearnedStateForRequest extracts cleanly');
ok(computeSrc.includes("typeof window.VDSEN_LEARNED === 'undefined'"), 'safely returns null rather than guessing if the learned-state layer is unavailable for any reason');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: exercise the real function against a stubbed window.VDSEN_LEARNED.
// ─────────────────────────────────────────────────────────────────────────────

(function testMissingLearnedLayerReturnsNullSafely() {
  const fn = new Function('window', computeSrc + ';\nreturn _computeLearnedStateForRequest;')({});
  ok(fn({}, {}, {}) === null, 'window.VDSEN_LEARNED unavailable -> null, no throw, no fabricated data');
})();

(function testAssemblesFromRealPieces() {
  const win = {
    VDSEN_LEARNED: {
      computeVolumeTolerance: function() { return { pectoral: { toleratedRange: { min: 10, max: 16 }, confidence: 'high', evidence: 'TOLERATED', weeksObserved: 5 } }; },
      computeExerciseTolerance: function() { return { 'pid-1': { classification: 'PRODUCTIVE', confidence: 'medium', weeksObserved: 4 } }; },
      computePatternTolerance: function() { return { press_horizontal: { classification: 'PRODUCTIVE', exerciseCount: 1 } }; },
      computeRecoverySensitivity: function() { return { pattern: 'STABLE_AT_CURRENT_STRESS', confidence: 'low', weeksObserved: 3 }; }
    }
  };
  const fn = new Function('window', computeSrc + ';\nreturn _computeLearnedStateForRequest;')(win);
  const result = fn({}, { days: [] }, {});
  ok(result.volumeToleranceByMuscle.pectoral.evidence === 'TOLERATED', 'volumeToleranceByMuscle is the real T211 output, passed through unchanged');
  ok(result.exerciseToleranceByPid['pid-1'].classification === 'PRODUCTIVE', 'exerciseToleranceByPid is the real T212 output, passed through unchanged');
  ok(result.patternTolerance.press_horizontal.classification === 'PRODUCTIVE', 'patternTolerance is the real T212 pattern rollup, passed through unchanged');
  ok(result.recoverySensitivity.pattern === 'STABLE_AT_CURRENT_STRESS', 'recoverySensitivity is the real T213 output, passed through unchanged');
  ok(result.confidence === 'high', 'overall confidence surfaces the best-evidenced domain present (volume=high here)');
})();

(function testOverallConfidenceNoneWhenNothingIsEvidenced() {
  const win = {
    VDSEN_LEARNED: {
      computeVolumeTolerance: function() { return {}; },
      computeExerciseTolerance: function() { return {}; },
      computePatternTolerance: function() { return {}; },
      computeRecoverySensitivity: function() { return { pattern: 'INSUFFICIENT_DATA', confidence: 'none', weeksObserved: 0 }; }
    }
  };
  const fn = new Function('window', computeSrc + ';\nreturn _computeLearnedStateForRequest;')(win);
  const result = fn({}, { days: [] }, {});
  ok(result.confidence === 'none', 'no evidenced domain at all -> overall confidence none, never fabricated');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Prompt regression: forbids misinterpreting/misusing learnedState.
// ─────────────────────────────────────────────────────────────────────────────

(function testPromptGuidance() {
  const idx = COACH.indexOf('const _MOTOR_PROMPT_EMBEDDED');
  const strStart = COACH.indexOf('"', idx);
  const endIdx = COACH.indexOf('";', strStart);
  const jsStr = COACH.slice(strStart, endIdx + 1);
  const promptText = eval(jsStr); // eslint-disable-line no-eval -- test-only, reads the real embedded prompt string

  ok(promptText.includes('CONTEXTO DE ESTADO APRENDIDO (learnedState)'), 'the prompt documents the new learnedState field');
  ok(promptText.includes('un `learnedState` CONFIABLE (confidence medium/high en el item especifico que estas usando) tiene prioridad sobre el prior poblacional'), 'the prompt states reliable learned_state outranks population/Ehrenstein priors, per the Authority Order');
  ok(promptText.includes('un item en INSUFFICIENT_DATA o confidence none/low NUNCA reemplaza al prior'), 'the prompt explicitly forbids low-confidence learned_state from outranking the prior');
  ok(promptText.includes('NUNCA recalcules tu propia version de tolerancia/aprendizaje a partir de'), 'the prompt forbids the Generator from building a second learned-state engine from raw logs');
  ok(promptText.includes('NUNCA uses `learnedState` para inventar un ranking de "mejor ejercicio"'), 'the prompt forbids inferring a "best exercise" ranking from learnedState');
  ok(promptText.includes('NUNCA escales volumen ni agregues frecuencia solo porque `volumeToleranceByMuscle` marca TOLERATED'), 'the prompt forbids escalating volume merely because tolerance reads high/TOLERATED');
  ok(promptText.includes('DECLINES_AT_HIGHER_STRESS` es contexto para moderar el ritmo de progresion, NUNCA una orden automatica de deload'), 'the prompt forbids treating recoverySensitivity as an automatic deload trigger');
  ok(promptText.includes('Seguridad y las decisiones explicitas del Coach siempre superan a `learnedState`'), 'the prompt states safety and Coach decisions always outrank learnedState, per the Authority Order');
})();

console.log('');
console.log('T214 — Learned-state Generator context: ' + pass + ' assertions PASSED');
