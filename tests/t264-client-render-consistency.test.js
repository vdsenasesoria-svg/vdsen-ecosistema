'use strict';
/**
 * T264 — Client render consistency. Verifies vdsen-cliente.html reads the
 * post-activation authoritative data (clients/{uid}.nutritionPlan/
 * supplementPlan) correctly: empty states, no fabricated placeholders,
 * no stale UI across a plan switch.
 *
 * Run: node tests/t264-client-render-consistency.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Initial load (loadPlan): absence/empty content -> a clean `null` empty
// state, never a fabricated zeroed object.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("nutricion: (clientData.nutritionPlan && (clientData.nutritionPlan.calorias || clientData.nutritionPlan.texto))\n        ? clientData.nutritionPlan : null,"),
  'PLAN.nutricion resolves to a real null empty state when nutritionPlan is absent (post-deleteField) OR present-but-content-free -- never a fabricated {calorias:0,...} placeholder');
ok(CLIENT.includes("suplementacion: (clientData.supplementPlan && clientData.supplementPlan.texto)\n        ? { texto: clientData.supplementPlan.texto, items: [] }\n        : null,"),
  'PLAN.suplementacion resolves to a real null empty state under the same rule -- symmetric handling for both sections');

// ─────────────────────────────────────────────────────────────────────────────
// A genuinely present, real nutrition/supplement value is never
// second-guessed into null just because loadPlan is re-run (idempotent
// on re-load with the same real data).
// ─────────────────────────────────────────────────────────────────────────────

(function testRealDataNeverNulled() {
  // Exact expression verified present in CLIENT above -- exercised here
  // directly rather than re-sliced from the source string.
  const buildPlanNutricion = new Function('clientData',
    'return (clientData.nutritionPlan && (clientData.nutritionPlan.calorias || clientData.nutritionPlan.texto)) ? clientData.nutritionPlan : null;'
  );
  ok(buildPlanNutricion({ nutritionPlan: { calorias: 2200, texto: '' } }) !== null, 'a real nutritionPlan with calorias -- never nulled');
  ok(buildPlanNutricion({}) === null, 'a genuinely absent nutritionPlan -- correctly null, not fabricated');
  ok(buildPlanNutricion({ nutritionPlan: {} }) === null, 'a present-but-content-free nutritionPlan ({} with neither calorias nor texto) -- also correctly treated as empty state, matching what T261\'s activation would leave behind for a truly empty (but explicitly provided) section');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Plan switch: a full reload is triggered on any activePlanId change
// (T245/T247's already-proven behavior) -- loadPlan() then re-derives
// PLAN.nutricion/suplementacion FRESH from the new client doc, so no
// stale nutrition/supplement data from the PREVIOUS activePlanId can
// survive into the new plan's render.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("showToast('🔄 Tu coach asignó un plan nuevo. Recargando...');") && CLIENT.includes('location.reload();'),
  'a plan switch triggers a full page reload -- loadPlan() re-runs from scratch, re-deriving PLAN.nutricion/suplementacion fresh from the NEW client doc, so no stale previous-plan nutrition/supplement data can leak into the new render');

// ─────────────────────────────────────────────────────────────────────────────
// P3 (documented, NOT fixed -- not currently reachable): the live
// same-plan listener's incremental nutrition/supplement update only
// handles presence->new-content, not presence->absence (an explicit
// mid-session removal without a plan change). Every REAL removal path
// today (T261's deleteField()) always co-occurs with an activePlanId
// change, which always triggers the full-reload branch above instead --
// so this gap is currently unreachable, not a live bug. Documented here,
// not "fixed", per the ticket's own "no cosmetic refactor" instruction.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('if (newData.nutritionPlan) PLAN.nutricion = newData.nutritionPlan;'),
  'confirmed: the SAME-plan live listener only updates PLAN.nutricion on presence (truthy), never on a transition to absence -- P3, currently unreachable since every real removal path also changes activePlanId (triggering the full-reload branch instead), documented rather than spuriously "fixed"');

console.log('');
console.log('T264 — Client render consistency: ' + pass + ' assertions PASSED');
