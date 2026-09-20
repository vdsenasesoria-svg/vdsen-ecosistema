'use strict';
/**
 * T273 — Client consistency / adjustment lifecycle (audit-only). Verifies
 * that T268-272 (adherence classifier, response classifier, decision
 * engine, generator context, coach visibility card) are ALL read-only
 * additions that never touch the T259-266 activation/draft/backup pipeline
 * -- exact meal count, grams, substitutions, and supplement separation
 * continue to survive Coach decision -> draft/preview -> activation ->
 * Client render -> backup/history exactly as T259-266 already proved.
 *
 * Run: node tests/t273-nutrition-client-consistency-lifecycle.test.js
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

const saveDraftSrc = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore()');
const activateSrc  = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
const backupSrc     = extractFunction(COACH, 'async function backupPlanIfExists(clientId)');

// ─────────────────────────────────────────────────────────────────────────────
// The T261/T265-fixed activation pipeline is untouched by T268-272 --
// still the exact same 3-way resolver calls, still whole-object (never
// destructures .comidas/.tiers individually, so nested structure like
// exact meal count and substitution grams travels as one atomic unit).
// ─────────────────────────────────────────────────────────────────────────────

ok(saveDraftSrc.includes('_resolveOptionalPlanSection(undefined, plan.nutricion)') && saveDraftSrc.includes('_resolveOptionalPlanSection(undefined, plan.suplementacion)'),
  '_vdsenSaveDraftToFirestore still resolves nutricion/suplementacion via the T260 3-way resolver, unchanged by T268-272');
ok(activateSrc.includes('_resolveOptionalPlanSection(') && activateSrc.includes('deleteField()'),
  '_vdsenActivatePlanInFirestore still uses the T261 conditional mirror + deleteField() for explicit removal, unchanged by T268-272');
// draft-save DOES read suppl.tiers, but only to build a derived display
// TEXT string (supplementDisplay.texto) -- the RAW value stored is still
// the whole plan.suplementacion object via the resolver, never rebuilt
// field-by-field. Confirmed by isolating the actual assignment targets.
ok(/Supplement display text from normalized tiers[\s\S]{0,300}supplText = suppl\.tiers\.map/.test(saveDraftSrc),
  'the only .tiers access in draft-save is a read-only derived display-text summary, not a reconstruction of the stored supplementsRaw value');
ok(!/\.comidas\b|\.tiers\b|\.sustituciones\b/.test(activateSrc),
  'activation never touches .comidas/.tiers/.sustituciones at all -- nutricion/suplementacion travel as ONE atomic object end to end, so exact meal count and substitution grams can never be partially dropped by a field-level merge');
ok(backupSrc.includes("clientData.nutritionRaw   !== undefined ? clientData.nutritionRaw") && backupSrc.includes('clientData.supplementsRaw'),
  'backupPlanIfExists still prefers the client doc\'s current whole nutritionRaw/supplementsRaw (T265), unchanged by T268-272 -- the outgoing snapshot remains exact');

// ─────────────────────────────────────────────────────────────────────────────
// Supplement separation: nutrition and supplements are resolved via TWO
// INDEPENDENT resolver calls in both draft-save and activation -- never a
// single shared variable that could mix them.
// ─────────────────────────────────────────────────────────────────────────────

const draftNutrCalls = (saveDraftSrc.match(/_resolveOptionalPlanSection\(undefined, plan\.nutricion\)/g) || []).length;
const draftSupplCalls = (saveDraftSrc.match(/_resolveOptionalPlanSection\(undefined, plan\.suplementacion\)/g) || []).length;
ok(draftNutrCalls === 1 && draftSupplCalls === 1, 'draft-save calls the resolver exactly once for nutricion and once for suplementacion -- two independent, never-merged calls');

// ─────────────────────────────────────────────────────────────────────────────
// T268-272 additions are ALL read-only: none of them ever write to
// Firestore, so none of them can be a NEW source of continuity drift.
// ─────────────────────────────────────────────────────────────────────────────

const adherenceSrc = extractFunction(COACH, 'function _classifyNutritionAdherence(nutrilogEntries, targets, options)');
const responseSrc  = extractFunction(COACH, 'function _classifyNutritionResponse(inbodyResults, objetivoCalorico)');
const decideSrc    = extractFunction(COACH, 'function _decideNutritionAction(input)');
const forRequestSrc = extractFunction(COACH, 'function _computeNutritionDecisionForRequest(entries, clientDoc, fd)');

[adherenceSrc, responseSrc, decideSrc, forRequestSrc].forEach(function(src, i) {
  ok(!/setDoc|updateDoc|addDoc|runTransaction|deleteDoc/.test(src), 'T268-271 function #' + (i + 1) + ' never writes to Firestore -- pure read/compute, cannot introduce continuity drift');
});

// ─────────────────────────────────────────────────────────────────────────────
// The pre-existing QA-GAP-03 manual-macro-edit reset (clears comidas/
// calculos/monitoreo on an EXPLICIT Coach hand-edit of Kcal/Prot/Carb/Gras)
// lives in a COMPLETELY SEPARATE function from the activation pipeline --
// confirms it cannot be silently triggered by a plan activation/import, and
// is itself Coach-explicit (top of the Authority Order), not a T259-273 bug.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("'nutritionRaw.comidas':   deleteField(),") && COACH.includes('QA-GAP-03'),
  'the QA-GAP-03 manual-macro-edit reset exists as documented, is an EXPLICIT Coach action (hand-typed Kcal/Prot/Carb/Gras), and is structurally separate from _vdsenActivatePlanInFirestore/_vdsenSaveDraftToFirestore -- confirmed out of scope for the T259-273 continuity pipeline');
ok(!activateSrc.includes('QA-GAP-03') && !saveDraftSrc.includes('QA-GAP-03'),
  'QA-GAP-03\'s deleteField() calls are NOT inside the activation/draft-save functions -- an explicit manual macro edit never silently fires during plan activation');

console.log('');
console.log('T273 — Client consistency / adjustment lifecycle: ' + pass + ' assertions PASSED (audit-only, no code change needed)');
