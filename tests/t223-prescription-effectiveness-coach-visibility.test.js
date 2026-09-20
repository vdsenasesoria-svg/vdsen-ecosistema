'use strict';
/**
 * T223 — Coach visibility for the T218-221 outcome-response/effectiveness
 * layer. One compact card in _renderClientTabMonitor: reuses
 * window.VDSEN_OUTCOME entirely and the SAME progressionHistory-building
 * pattern already used by the T198/T215 cards -- no recalculated logic,
 * no plan mutation. NONE-confidence reads are never shown; LOW-confidence
 * reads are shown but explicitly labeled as non-conclusive (never
 * presented as authoritative). Exceptions-first: only exercises needing
 * attention are named.
 *
 * Run: node tests/t223-prescription-effectiveness-coach-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: reuses the real T219-221 functions, no second engine.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _outcomePerf = window.VDSEN_OUTCOME.computePerformanceResponse(p, _outcomeProgHist);'), 'calls the real T219 performance-response function');
ok(COACH.includes('const _outcomeBodyComp = window.VDSEN_OUTCOME.computeBodyCompositionResponse(c && c.inbodyResults, _outcomeGoal);'), 'calls the real T220 body-composition-response function');
ok(COACH.includes('const _outcomeEffectiveness = window.VDSEN_OUTCOME.computeEffectiveness({'), 'calls the real T221 synthesis function');
ok(COACH.includes('const _outcomeGoal = (_detailFichaData && _detailFichaData.data && _detailFichaData.data.objetivo_calorico) || null;'), 'the stated goal is read from the already-loaded ficha data -- no new Firestore read');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: NONE-confidence is never shown; LOW is shown but explicitly
// labeled as non-conclusive, never presented as authoritative.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("if (_outcomeEffectiveness.confidence !== 'none') {"), 'the whole card is skipped when overall confidence is none');
ok(COACH.includes("_outcomeEffectiveness.confidence === 'low' ? ' <span style=\"font-size:10px;color:#888\">(baja confianza — no concluyente)</span>' : ''"), 'a low-confidence overall verdict is explicitly labeled as non-conclusive, never shown as plain fact');
ok(COACH.includes("_outcomeBodyComp.confidence !== 'none' && _BODY_COMP_LABEL[_outcomeBodyComp.classification]"), 'the body-composition line is hidden entirely when its own confidence is none');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: compact, exceptions-first -- only exercises needing attention
// are named, no giant table.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("['UNDER_RESPONDING', 'RECOVERY_LIMITED', 'COACH_REVIEW'].indexOf(_outcomePerf[pid].classification) !== -1"), 'only UNDER_RESPONDING/RECOVERY_LIMITED/COACH_REVIEW exercises are named in the "Atención" line');
ok(COACH.includes('${_outcomeAttentionNames.length ? `<div class="text-xs mt-1" style="color:#FF8844"><span style="font-weight:700">Atención:</span>'), 'the attention line only renders when there IS something needing attention');
ok(!/<table[^>]*>[\s\S]{0,80}Respuesta a la prescripción/.test(COACH), 'the prescription-response card is not rendered as a giant table');

// ─────────────────────────────────────────────────────────────────────────────
// Structural: gated on the active plan being present, mirroring the
// T198/T200/T215 guard, and never mutates any Firestore document.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("if (p && typeof window.VDSEN_OUTCOME !== 'undefined' && typeof window.VDSEN_LEARNED !== 'undefined' && typeof window.VDSEN_ADHERENCE !== 'undefined' && typeof window.VDSEN_BUILD !== 'undefined') {"),
  'the whole block is gated on the active plan (p) being present and every dependency being loaded');

console.log('');
console.log('T223 — Prescription effectiveness Coach visibility: ' + pass + ' assertions PASSED');
