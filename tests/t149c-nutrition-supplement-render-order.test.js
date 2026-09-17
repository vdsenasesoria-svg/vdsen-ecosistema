'use strict';
/**
 * T149 — Client propagation of Coach changes.
 *
 * Scope: plan listener, nutrition listener/read, week change, activePlanId,
 * updatedAt, relevant transient cleanup.
 *
 * Bug found: the client-doc onSnapshot listener (_liveUnsubClient) updated
 * PLAN.nutricion and called renderNutricion() BEFORE updating
 * PLAN.suplementacion on the very next line:
 *
 *   if (newData.nutritionPlan) { PLAN.nutricion = newData.nutritionPlan; renderNutricion(); }
 *   if (newData.supplementPlan) { PLAN.suplementacion = {...}; }
 *
 * renderNutricion() reads both PLAN.nutricion AND PLAN.suplementacion. Since
 * newData is the FULL current client doc (not a diff), newData.nutritionPlan
 * is truthy on essentially every snapshot fire for a client with an assigned
 * plan — including when the coach edits ONLY the supplement plan via
 * saveSupplementPlan (which never touches nutritionPlan at all). So a
 * supplement-only coach edit still triggered the render, but PLAN.suplementacion
 * hadn't been updated to the new value yet when it ran — the client saw stale
 * supplement text until some unrelated future re-render happened to occur.
 *
 * Fix: both PLAN.nutricion and PLAN.suplementacion are now updated before
 * renderNutricion() is called, so a supplement-only edit renders with fresh
 * data on the very first snapshot, matching the already-correct behavior for
 * nutrition-only edits. The render trigger condition (newData.nutritionPlan
 * truthy) is unchanged — this is purely an ordering fix, not a new render
 * path or a new listener.
 *
 * Run: node tests/t149c-nutrition-supplement-render-order.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

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

const clientListenerFn = extractFunction(
  CLIENT,
  "_liveUnsubClient = FB.onSnapshot(FB.doc(FB.db, 'clients', user.uid), function(snap)"
);
assert.ok(clientListenerFn, 'the client-doc onSnapshot callback must exist');

// ─────────────────────────────────────────────────────────────────────────────
// Fix: both PLAN.nutricion and PLAN.suplementacion assignments must occur
// before renderNutricion() is called.
// ─────────────────────────────────────────────────────────────────────────────

const nutricionAssignIdx    = clientListenerFn.indexOf('PLAN.nutricion = newData.nutritionPlan');
const suplementacionAssignIdx = clientListenerFn.indexOf('PLAN.suplementacion = { texto: newData.supplementPlan.texto');
const renderCallIdx         = clientListenerFn.indexOf('renderNutricion();');

assert.ok(nutricionAssignIdx !== -1, 'T149-C prerequisite: PLAN.nutricion assignment must exist');
assert.ok(suplementacionAssignIdx !== -1, 'T149-C prerequisite: PLAN.suplementacion assignment must exist');
assert.ok(renderCallIdx !== -1, 'T149-C prerequisite: renderNutricion() call must exist');

assert.ok(
  nutricionAssignIdx < renderCallIdx,
  'T149-C: PLAN.nutricion must be assigned before renderNutricion() is called'
);
assert.ok(
  suplementacionAssignIdx < renderCallIdx,
  'T149-C: PLAN.suplementacion must be assigned before renderNutricion() is called (this was the bug — ' +
  'it previously ran AFTER the render call, so a supplement-only edit rendered stale data)'
);

console.log('Both PLAN.nutricion and PLAN.suplementacion are updated before renderNutricion() runs — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — render trigger condition unchanged (still gated on
// nutritionPlan presence, not a new/different condition), profile-type
// in-place update and the "new plan -> full reload" branch remain untouched.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /var _nutricionChanged = !!newData\.nutritionPlan;/.test(clientListenerFn),
  'T149-C regression: the render trigger must still be gated on newData.nutritionPlan being present'
);
assert.ok(
  /if \(_nutricionChanged\) \{ try \{ renderNutricion\(\); \} catch\(e\)\{\} \}/.test(clientListenerFn),
  'T149-C regression: renderNutricion() call must still be wrapped in try/catch'
);
assert.ok(
  clientListenerFn.includes("newData.profileType && newData.profileType !== PLAN.profileType") &&
  clientListenerFn.includes('renderPerfil();'),
  'T149-C regression: profile-type in-place update must remain unchanged'
);
assert.ok(
  clientListenerFn.includes("newPlanId && newPlanId !== activePlanId") &&
  clientListenerFn.includes("location.reload();"),
  'T149-C regression: the "coach assigned a completely new plan -> full reload" branch must remain unchanged'
);

console.log('Render trigger condition, profile update, and new-plan reload branch all unchanged — OK');

console.log('');
console.log('T149 — Client propagation of Coach changes: ALL ASSERTIONS PASSED');
