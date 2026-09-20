'use strict';
/**
 * T271 — Generator integration. Verifies _computeNutritionDecisionForRequest
 * wires the REAL T268-270 chain (window.VDSEN_NUTRITION) into the
 * generation request as `nutritionDecision`, using the identical lazy
 * cross-script-block *ForRequest pattern already used by executionFidelity/
 * learnedState/prescriptionEffectiveness. Also verifies the embedded Motor
 * prompt documents the field with the mandatory guardrails (no automatic
 * mutation, adherence gates calorie changes, one measurement insufficient,
 * no aggressive deficit escalation, respects exact meal count, preserves
 * foods on KEEP, never recomputes a second engine).
 *
 * Run: node tests/t271-nutrition-generator-integration.test.js
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
// Wiring: request assembly calls the new function and attaches its result.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('var nutritionDecision = _computeNutritionDecisionForRequest(logsDoc && logsDoc.entries, clientDoc, fd);'),
  'the request builder computes nutritionDecision from the real T268-270 chain');
ok(COACH.includes('nutritionDecision: nutritionDecision,'),
  'nutritionDecision is attached to the generation request object');

// ─────────────────────────────────────────────────────────────────────────────
// Execute the real _computeNutritionDecisionForRequest against a fake
// window.VDSEN_NUTRITION-equivalent (the REAL T268-270 functions, actually).
// ─────────────────────────────────────────────────────────────────────────────

const forRequestSrc = extractFunction(COACH, 'function _computeNutritionDecisionForRequest(entries, clientDoc, fd)');
ok(forRequestSrc, '_computeNutritionDecisionForRequest extracts cleanly');

const adherenceSrc = extractFunction(COACH, 'function _classifyNutritionAdherence(nutrilogEntries, targets, options)');
const evidenceSrc   = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeConfSrc = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const bodyCompSrc    = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
const responseSrc    = extractFunction(COACH, 'function _classifyNutritionResponse(inbodyResults, objetivoCalorico)');
const decideSrc      = extractFunction(COACH, 'function _decideNutritionAction(input)');
const actionEnumSrc  = extractFunction(COACH, 'var NUTRITION_ACTION = {').replace(/^var NUTRITION_ACTION = /, '');

const runForRequest = new Function(
  'window',
  evidenceSrc + ';\n' + outcomeConfSrc + ';\n' + bodyCompSrc + ';\n' + responseSrc + ';\n' +
  adherenceSrc + ';\n' +
  'var NUTRITION_ACTION = ' + actionEnumSrc + ';\n' +
  decideSrc + ';\n' +
  'window.VDSEN_NUTRITION = { classifyAdherence: _classifyNutritionAdherence, classifyResponse: _classifyNutritionResponse, decide: _decideNutritionAction, ACTION: NUTRITION_ACTION };\n' +
  forRequestSrc + ';\n' +
  'return _computeNutritionDecisionForRequest;'
)({});

// No window.VDSEN_NUTRITION defined -> null, safe fallback (same pattern as
// executionFidelity/learnedState's own `if (typeof window.X === 'undefined') return null;`).
{
  const noWindow = new Function('window', forRequestSrc + ';\nreturn _computeNutritionDecisionForRequest;')({});
  ok(noWindow({}, {}, {}) === null, 'when window.VDSEN_NUTRITION is undefined (script-load-order edge case), returns null safely, never throws');
}

const NOW = Date.now();
function nutrilogEntry(offsetDays, kcal, prot) { return { kcal: kcal, prot: prot, ts: NOW - offsetDays * 86400000 }; }

// ─────────────────────────────────────────────────────────────────────────────
// Real end-to-end: entries with nutrilog_* keys mixed with unrelated keys
// (ci_sem_/log_/postsession_) -- only nutrilog_* is picked up.
// ─────────────────────────────────────────────────────────────────────────────
{
  const entries = {
    'ci_sem_3': { peso: 80, hrv: 55 },
    'log_3_1_0_s1': { carga: 100, reps: 8 },
    'nutrilog_2024-01-01': nutrilogEntry(6, 2200, 185),
    'nutrilog_2024-01-02': nutrilogEntry(5, 2180, 182),
    'nutrilog_2024-01-03': nutrilogEntry(4, 2210, 188),
    'nutrilog_2024-01-04': nutrilogEntry(0, 2190, 180)
  };
  const clientDoc = { nutritionRaw: { calorias: 2200, proteina: 180 }, inbodyResults: null };
  const result = runForRequest(entries, clientDoc, { objetivo_calorico: 'déficit' });

  ok(result && result.adherence && result.adherence.classification === 'HIGH', 'only nutrilog_* keys are extracted from entries (ci_sem_/log_/postsession_ ignored) -- 4 tight-to-target days -> HIGH adherence');
  ok(result.response.classification === 'INSUFFICIENT_DATA', 'no inbodyResults -> response INSUFFICIENT_DATA, never guessed');
  ok(result.action === 'COACH_REVIEW', 'HIGH adherence + INSUFFICIENT_DATA response -> COACH_REVIEW (nothing to decide on yet), never KEEP or a calorie change');
}

// ─────────────────────────────────────────────────────────────────────────────
// No entries at all, no clientDoc.nutritionRaw -> INSUFFICIENT_DATA
// adherence, safe result, no crash.
// ─────────────────────────────────────────────────────────────────────────────
{
  const result = runForRequest(null, {}, {});
  ok(result.adherence.classification === 'INSUFFICIENT_DATA' && result.action === 'FREEZE', 'no entries/targets at all -> INSUFFICIENT_DATA adherence -> FREEZE, no crash on null entries');
}

// ─────────────────────────────────────────────────────────────────────────────
// Motor prompt: the field is documented with the mandatory guardrails.
// ─────────────────────────────────────────────────────────────────────────────

const m = COACH.match(/const _MOTOR_PROMPT_EMBEDDED = "(.*?)";\n/s);
const motorPrompt = eval(m[0].replace('const _MOTOR_PROMPT_EMBEDDED = ', ''));

ok(motorPrompt.includes('CONTEXTO DE DECISION NUTRICIONAL (nutritionDecision)'), 'Motor prompt documents the nutritionDecision context field');
ok(motorPrompt.includes('NUNCA una orden de mutar automaticamente calorias/macros/comidas del plan activo'),
  'Motor prompt explicitly forbids automatic mutation of active nutrition -- action is a review recommendation only');
ok(motorPrompt.includes('NUNCA reduzcas ni escales calorias por esto, el problema es de datos/ejecucion, no del objetivo calorico'),
  'Motor prompt explicitly forbids blaming/changing the calorie target under low/insufficient adherence');
ok(motorPrompt.includes('Una sola medicion de InBody NUNCA justifica un ajuste'),
  'Motor prompt explicitly forbids adjusting on a single measurement');
ok(motorPrompt.includes('NUNCA escales el deficit de forma agresiva ni cambies el numero de comidas sin una razon explicita'),
  'Motor prompt forbids aggressive deficit escalation and unexplained meal-count changes');
ok(motorPrompt.includes('respeta el numero exacto de comidas ya definido por el Coach/cliente'),
  'Motor prompt requires respecting the exact existing meal count');
ok(motorPrompt.includes('Preserva alimentos/sustituciones existentes cuando `action: KEEP`'),
  'Motor prompt requires preserving foods/substitutions when action is KEEP');
ok(motorPrompt.includes('NUNCA recalcules tu propio motor de adherencia/respuesta nutricional a partir de nutrilog/InBody crudos'),
  'Motor prompt forbids recomputing a second nutrition engine from raw data');

console.log('');
console.log('T271 — Generator integration: ' + pass + ' assertions PASSED');
