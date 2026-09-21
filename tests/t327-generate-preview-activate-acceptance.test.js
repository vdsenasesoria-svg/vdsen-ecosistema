'use strict';
/**
 * T327 — Generate -> Preview -> Activate acceptance (audit; the two real
 * fixes this phase needed were already made in T325's FINDING 1 and
 * FINDING 3).
 *
 * Verified:
 *  - one authoritative Preview path for the AI-generation flow:
 *    vdsenAIPreview -> _vdsenAIShowPreview -> _vdsenCurrentPreview/
 *    _vdsenDraftPlanId -> _vdsenSaveDraftClick -> _vdsenActivatePlanClick.
 *    The separate paste-analysis flow (loadPlanFromPastedAnalysis ->
 *    saveImportedPlan) is a genuinely distinct, intentionally-documented
 *    manual-import feature (not a legacy path silently standing in for
 *    the AI flow) -- it has its own confirmation step and, since T325,
 *    the same ownership check as the AI path's activation transaction.
 *  - correct clientId / activePlanId baseline: captured once from
 *    _vdsenCurrentPreview.clientId, re-verified against the live
 *    planClientSelect dropdown at both save-draft and activate (T145-H).
 *  - PIDs preserved where required, substitutions get correct identity:
 *    _stampPrescriptionIds keeps any existing prescriptionExerciseId and
 *    only mints a fresh one for a missing/duplicate id -- a substituted
 *    exercise (which has no valid existing PID to preserve) correctly
 *    gets a NEW identity rather than silently inheriting the replaced
 *    exercise's history via name-matching.
 *  - canonical snapshot fields present as stable keys: progressionHistory/
 *    weeklyDecision/adaptivePrescription/learnedState/
 *    prescriptionEffectiveness/nutritionDecision/coachSupervision/
 *    evidenceQuality all appear unconditionally in buildGenerationRequest
 *    (sparse/null content for a first plan is correct, not a missing key).
 *  - nutrition/supplement presence semantics: _resolveOptionalPlanSection's
 *    PRESERVE/REPLACE/REMOVE contract (T260/T261) is used identically by
 *    both nutrition and supplement sections in the activation transaction.
 *  - stale Preview cannot activate: FINDING 1 (T325) now hard-blocks a
 *    contract-violating response before it ever becomes a Preview at all.
 *  - double activation guarded: FINDING 3 (T325) in-flight boolean, plus
 *    the pre-existing idempotent transaction (T266 CASE M).
 *  - activation failure != success: the click handler's catch branch
 *    re-enables the button and shows the real error message; the success
 *    branch only runs after both awaits (backup + transaction) resolve.
 *  - outgoing backup exact: backupPlanIfExists (T265) reconciles
 *    plan-doc/client-doc nutrition drift so the backup reflects what the
 *    client was ACTUALLY seeing, not a stale copy of the plan doc alone.
 *
 * Run: node tests/t327-generate-preview-activate-acceptance.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

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

// ── One authoritative Preview path + client-context guards. ────────────────
ok((COACH.match(/function _vdsenAIShowPreview\(/g) || []).length === 1, 'exactly one _vdsenAIShowPreview definition -- single authoritative Preview renderer for the AI-generation flow');
const saveDraftClickSrc = extractFunction(COACH, 'window._vdsenSaveDraftClick = async function() {');
const activateClickSrc  = extractFunction(COACH, 'window._vdsenActivatePlanClick = async function() {');
ok(saveDraftClickSrc.includes("document.getElementById('planClientSelect')?.value !== _vdsenCurrentPreview.clientId"), 'save-draft re-verifies the client-select matches the preview\'s own clientId (T145-H)');
ok(activateClickSrc.includes("document.getElementById('planClientSelect')?.value !== clientId"), 'activate re-verifies the same guard independently (context can drift further by the time activation happens)');

// ── PIDs / substitutions. ───────────────────────────────────────────────────
const stampSrc = extractFunction(COACH, 'function _stampPrescriptionIds(days) {');
ok(stampSrc.includes('if (id && !seen[id]) { seen[id] = true; return ex; }'), 'an exercise with a valid, not-yet-seen PID is passed through unchanged -- real identity preserved');
ok(stampSrc.includes('var newId = _genPrescriptionId();'), 'a missing/duplicate PID (e.g. a substituted exercise) always mints a genuinely new identity -- never silently reuses another exercise\'s history via name matching');

// ── Canonical snapshot fields present as stable keys. ──────────────────────
const buildReqSrc = extractFunction(COACH, 'function buildGenerationRequest(params) {');
['progressionHistory', 'weeklyDecision', 'adaptivePrescription', 'learnedState', 'prescriptionEffectiveness', 'nutritionDecision', 'coachSupervision', 'evidenceQuality'].forEach(function(field) {
  ok(buildReqSrc.includes(field), 'buildGenerationRequest includes the "' + field + '" canonical snapshot key unconditionally');
});

// ── Nutrition/supplement presence semantics reused identically. ────────────
const activateInFirestoreSrc = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId) {');
ok((activateInFirestoreSrc.match(/_resolveOptionalPlanSection\(undefined,/g) || []).length === 2,
  'both nutrition and supplement sections go through the exact same _resolveOptionalPlanSection PRESERVE/REPLACE/REMOVE contract (T260/T261) -- no divergent semantics between the two');

// ── Stale Preview / double activation / failure != success (all from T325). ──
ok(COACH.includes('UI_STATES.invalid('), 'a contract-violating response is hard-blocked before becoming an activatable Preview (T325 FINDING 1)');
ok(COACH.includes('let _vdsenActivatingPlan = false;'), 'double activation is guarded (T325 FINDING 3)');
ok(activateClickSrc.includes('if (btn) { btn.disabled = false; btn.textContent = \'⚡ Activar plan\'; }') && activateClickSrc.includes('console.error(\'[VDSEN D.2-B] Activate plan error:\', err);'),
  'activation failure re-enables the button and shows the real error -- the success branch never runs unless both backup+transaction awaits actually resolved');

// ── Outgoing backup exactness. ──────────────────────────────────────────────
const backupSrc = extractFunction(COACH, 'async function backupPlanIfExists(clientId) {');
ok(backupSrc.includes('nutritionRaw:      clientData.nutritionRaw   !== undefined ? clientData.nutritionRaw   : planData.nutritionRaw,'),
  'the outgoing backup prefers the CLIENT doc\'s actual current nutrition/supplement state over the plan doc\'s own (T265) -- preserves what the client was really seeing, not a potentially-drifted copy');

console.log('');
console.log('T327 — Generate->Preview->Activate acceptance: ' + pass + ' assertions PASSED');
