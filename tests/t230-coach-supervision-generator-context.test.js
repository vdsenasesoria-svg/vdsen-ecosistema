'use strict';
/**
 * T230 — Exposes the T226-227 intervention-priority/reason/action layer to
 * the canonical Generator as a pure guardrail/summary, with prompt rules
 * forbidding it from becoming a redesign trigger or a second
 * prioritization engine.
 *
 * _computeCoachSupervisionForRequest reuses window._computeClientAttentionState/
 * _rankClientPriority/_computeInterventionReasonAction entirely -- no
 * second engine, no recomputation from raw logs. Wired into
 * buildGenerationRequest as an additive `coachSupervision` field.
 *
 * Run: node tests/t230-coach-supervision-generator-context.test.js
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
// _computeCoachSupervisionForRequest verbatim) rather than an inline call.
ok(COACH.includes('_computeCoachSupervisionForRequest(entries, planDoc, weeklyDecision, prescriptionEffectiveness, week)'), 'the real computation still happens verbatim (inside the snapshot builder, T276; T279 added the real week as a 5th arg)');
ok(COACH.includes('var coachSupervision          = snapshot.coachSupervision;'), 'buildGenerationRequest computes coachSupervision (FIXED for T278\'s snapshot routing)');
ok(COACH.includes('coachSupervision:  coachSupervision,'), 'coachSupervision is wired into the assembled request additively');

// T279 added a 5th param (currentWeek) to fix a real Monitor/Generator
// week-divergence bug; the function's own logic is otherwise unchanged.
const computeSrc = extractFunction(COACH, 'function _computeCoachSupervisionForRequest(entries, planDoc, weeklyDecision, prescriptionEffectiveness, currentWeek)');
ok(computeSrc, '_computeCoachSupervisionForRequest extracts cleanly');
ok(computeSrc.includes("typeof window._computeClientAttentionState === 'undefined'"), 'safely returns null rather than guessing if the attention-state classifier is unavailable');
ok(computeSrc.includes('window._rankClientPriority(attn.state, weeklyStatus, effectivenessOverall)'), 'reuses the real T226 priority function, no recomputation');
ok(computeSrc.includes('window._computeInterventionReasonAction(priority, {'), 'reuses the real T227 reason/action function, no recomputation');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: exercise the real function against stubbed window functions.
// ─────────────────────────────────────────────────────────────────────────────

(function testMissingLayerReturnsNullSafely() {
  const fn = new Function('window', computeSrc + ';\nreturn _computeCoachSupervisionForRequest;')({});
  ok(fn({}, {}, null, null) === null, 'window functions unavailable -> null, no throw, no fabricated data');
})();

(function testAssemblesFromRealPieces() {
  const win = {
    _computeClientAttentionState: function(entries, planDoc, week) { return { state: 'REVIEW', reasons: [{ code: 'PAIN', label: 'Dolor articular reportado' }] }; },
    _rankClientPriority: function(attnState, weeklyStatus, effOverall) { return 'URGENT_REVIEW'; },
    _computeInterventionReasonAction: function(priority, input) { return { primaryReason: 'safety_signal', action: 'SAFETY_REVIEW', supportingReasons: ['Dolor articular reportado'] }; }
  };
  const fn = new Function('window', computeSrc + ';\nreturn _computeCoachSupervisionForRequest;')(win);
  const result = fn({ engine_state: { weekNum: 3 } }, { days: [] }, { status: 'PAIN_REVIEW' }, { overall: 'SAFETY_REVIEW' });
  ok(result.priority === 'URGENT_REVIEW', 'priority is the real T226 output');
  ok(result.action === 'SAFETY_REVIEW', 'action is the real T227 output');
  ok(result.supportingReasons.indexOf('Dolor articular reportado') !== -1, 'supportingReasons pass through unchanged');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Prompt regression: forbids treating coachSupervision as a redesign
// trigger or a second prioritization engine.
// ─────────────────────────────────────────────────────────────────────────────

(function testPromptGuidance() {
  const idx = COACH.indexOf('const _MOTOR_PROMPT_EMBEDDED');
  const strStart = COACH.indexOf('"', idx);
  const endIdx = COACH.indexOf('";', strStart);
  const jsStr = COACH.slice(strStart, endIdx + 1);
  const promptText = eval(jsStr); // eslint-disable-line no-eval -- test-only, reads the real embedded prompt string

  ok(promptText.includes('CONTEXTO DE SUPERVISION DEL COACH (coachSupervision)'), 'the prompt documents the new coachSupervision field');
  ok(promptText.includes('URGENT_REVIEW` o `NEEDS_REVIEW` NUNCA deben disparar un rediseño agresivo automatico del plan'), 'the prompt forbids URGENT_REVIEW/NEEDS_REVIEW from triggering an automatic aggressive redesign');
  ok(promptText.includes('priority: ON_TRACK` NO significa licencia para escalar volumen/frecuencia automaticamente'), 'the prompt forbids treating ON_TRACK as automatic escalation license');
  ok(promptText.includes('priority: INSUFFICIENT_DATA` NUNCA justifica un rediseño del plan'), 'the prompt forbids redesigning the plan from INSUFFICIENT_DATA');
  ok(promptText.includes('NUNCA lo trates como autoridad por encima de la evidencia que lo genero'), 'the prompt states coachSupervision never outranks the source evidence that created it (Authority Order)');
  ok(promptText.includes('NUNCA construyas tu propia logica de priorizacion de atencion a partir de'), 'the prompt forbids building a second prioritization engine from raw logs');
})();

console.log('');
console.log('T230 — Coach supervision Generator context: ' + pass + ' assertions PASSED');
