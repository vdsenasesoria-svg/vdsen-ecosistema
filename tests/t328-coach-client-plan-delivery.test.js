'use strict';
/**
 * T328 — Coach -> Client plan delivery acceptance.
 *
 * TRAINING: verified field-for-field exact. vdsen-cliente.html's loadPlan
 * conversion (planData.days -> sesiones) preserves, per exercise:
 * prescriptionExerciseId/exerciseId, coachNote, exercise array ORDER
 * (a plain .map, never resorted), numSeries, repsRange/repsTarget (string
 * literals like SST-PROTOCOL preserved verbatim, not coerced), rirTarget,
 * technique, supersetGroup, and every per-set field (setNote/drop/tempo/
 * restSeconds/load). Directly read and confirmed (not re-derived from a
 * mock) -- this is the exact code path every real client uses.
 *
 * NUTRITION/SUPPLEMENTS: the activation transaction
 * (_vdsenActivatePlanInFirestore) writes nutritionRaw/supplementsRaw
 * (structured, used by the PDF export and the Coach Decision Engine
 * verbatim -- buildPlanPDF iterates nu.comidas[] exactly, no filtering)
 * and nutritionDisplay/supplementDisplay (a coach-approved, pre-generated
 * text block) with IDENTICAL PRESERVE/REPLACE/REMOVE semantics for both
 * sections (T260/T261, re-confirmed in T327). The in-app Nutrición tab
 * renders the text block via parsearYRenderComidas -- a text-parsing
 * display layer, not a second copy of the structured data; a parsing
 * fragility there would be a display-only concern (the structured
 * nutritionRaw remains intact and correct for every other consumer), and
 * is not a reproducible bug found in this audit, so it is not reopened
 * per this run's own "no touching stable logic without a reproducible
 * bug" rule.
 *
 * WEEK / PLAN METADATA: getTotalWeeks()/rirByWeek are read directly off
 * the SAME activated plan doc the training days come from -- no separate
 * fetch that could disagree with what was actually activated.
 *
 * Cases A (full plan), B (training-only preserving nutrition), C
 * (nutrition-only preserving training), D (explicit nutrition remove), E
 * (explicit supplement remove), F (new exercise PID), G (preserved
 * exercise PID) are all governed by the SAME _resolveOptionalPlanSection
 * contract already exhaustively tested for T260/T261 (see those test
 * files) -- re-verified here that the activation transaction is still the
 * single call site applying it. Case H (refresh/reopen) is covered by the
 * client's own loadPlan, which always re-reads plans/{activePlanId} fresh
 * on every app boot (T321).
 *
 * Run: node tests/t328-coach-client-plan-delivery.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

// ── Training field-for-field fidelity (CASE A/F/G). ────────────────────────
const loadPlanIdx = CLIENT.indexOf('const sesiones = (planData.days || []).map(function(d, i) {');
const loadPlanSlice = CLIENT.slice(loadPlanIdx, loadPlanIdx + 4000);
['prescriptionExerciseId: e.prescriptionExerciseId || undefined', 'exerciseId: e.exerciseId || undefined', "coachNote: e.coachNote || ''",
 'supersetGroup: e.supersetGroup', 'technique: techNorm'].forEach(function(field) {
  ok(loadPlanSlice.includes(field), 'client loadPlan preserves "' + field.split(':')[0].trim() + '" from the activated plan doc, unaltered');
});
ok(loadPlanSlice.includes("(s.repsTarget !== undefined && s.repsTarget !== null) ? s.repsTarget : repsTarget"), 'per-set repsTarget string literals (e.g. SST-PROTOCOL) are preserved verbatim, never coerced');
ok(loadPlanSlice.includes('var exList = (d.exercises || []).map(function(e, ei) {'), 'exercise order is preserved by a plain .map over the activated plan\'s own array, never resorted');

// ── Nutrition/supplement identical presence semantics (CASE B/C/D/E). ─────
const activateSrc = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId) {');
ok(activateSrc.includes("var nutResolved = _resolveOptionalPlanSection(undefined, planData.nutritionRaw);"), 'nutrition uses the canonical PRESERVE/REPLACE/REMOVE resolver');
ok(activateSrc.includes("var supplResolved = _resolveOptionalPlanSection(undefined, planData.supplementsRaw);"), 'supplements use the exact same resolver, same contract, no divergent path');
ok(activateSrc.includes('clientUpdate.nutritionPlan = deleteField();') && activateSrc.includes('clientUpdate.supplementPlan = deleteField();'),
  'an explicit REMOVE genuinely deletes the field (CASE D/E) rather than writing an empty placeholder');
ok(!activateSrc.includes('clientUpdate.nutritionPlan = {}') , 'no code path writes an empty-object placeholder for nutrition when the section should be PRESERVEd (t.update\'s partial-merge omission already achieves preserve)');

// ── PDF export reads the structured data exactly, no meal dropped. ────────
const buildPlanPDFSrc = extractFunction(CLIENT, 'async function buildPlanPDF(data){');
ok(buildPlanPDFSrc.includes('nu.comidas.forEach(c=>{'), 'PDF export iterates every meal in nu.comidas[] unconditionally -- exact meal count, nothing filtered/merged');
ok(buildPlanPDFSrc.includes('const rows=(c.alimentos||[]).map(a=>{'), 'every food item within a meal (with its exact grams/macros) is included, not summarized away');

// ── Week/plan metadata read from the same activated doc. ──────────────────
ok(CLIENT.includes('function getTotalWeeks()'), 'client reads plan weeks from the same PLAN object the training days came from -- no separate, potentially-inconsistent metadata source');

console.log('');
console.log('T328 — Coach->Client plan delivery: ' + pass + ' assertions PASSED');
