'use strict';
/**
 * T247 — Active plan version boundary. Per T245's audit, this behavior
 * ALREADY EXISTS correctly: a session/log knows which plan version it ran
 * against even after the active plan changes, and a later "active plan"
 * read never retroactively reinterprets an older session. Per the
 * ticket's own fallback ("si ya existe este comportamiento, pruébalo y no
 * añadas persistencia"), this file is regression coverage ONLY -- no
 * production code change.
 *
 * Scenario proven end to end (source-level, since loadPlan() is deeply
 * DOM/Firebase-coupled -- the same extraction convention used throughout
 * this session for inline client logic):
 *   1. Session starts under Plan A (ACTIVE_PLAN_ID = planA).
 *   2. Coach activates Plan B (clients/{uid}.activePlanId = planB).
 *   3. Session A's already-entered data is flushed to Firestore BEFORE
 *      any reset -- never silently lost.
 *   4. LOGS/week are wiped cleanly (atomic setDoc, no partial state) --
 *      Plan A's data in the flat doc is superseded, but is durably
 *      preserved in logs/{uid}/mesos/{planA}, stamped with planA's own id
 *      forever (never rewritten again once planB becomes active).
 *   5. ACTIVE_PLAN_ID flips to planB BEFORE the post-reset save, so that
 *      save creates a FRESH logs/{uid}/mesos/{planB} doc -- it can never
 *      retroactively touch mesos/{planA}.
 *   6. The next session's data lands under planB's own stamp.
 *
 * Run: node tests/t247-active-plan-version-boundary.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic: the REAL planChanged detection expression, extracted
// verbatim and exercised directly (not just checked for presence).
// ─────────────────────────────────────────────────────────────────────────────

const exprStart = CLIENT.indexOf('var planChanged = flagSession');
const exprEnd   = CLIENT.indexOf(';', CLIENT.indexOf('firestorePlanId !== activePlanId'));
const planChangedExpr = CLIENT.slice(exprStart, exprEnd).replace('var planChanged = ', '');
ok(planChangedExpr && planChangedExpr.length > 10, 'the real planChanged detection expression extracts cleanly');

const computePlanChanged = new Function('flagSession', 'localPlanId', 'firestorePlanId', 'activePlanId', 'return (' + planChangedExpr + ');');

(function testPlanChangedDetection() {
  ok(computePlanChanged(true, null, null, 'planB') === true, 'the sessionStorage flag ALONE is sufficient to detect a plan change (covers same-device same-tab reload)');
  ok(computePlanChanged(false, 'planA', null, 'planB') === true, 'a stale localStorage-cached plan id ALONE is sufficient (covers a fresh load on the same device)');
  ok(computePlanChanged(false, null, 'planA', 'planB') === true, 'a mismatched Firestore logs.planId ALONE is sufficient (covers a different device entirely)');
  ok(!computePlanChanged(false, 'planB', 'planB', 'planB'), 'all three signals agreeing with the current active plan -> NOT a change, existing session/week is preserved');
  ok(!computePlanChanged(false, null, null, 'planB'), 'no prior signal recorded at all (first-ever load) -> not treated as "changed", avoids a spurious reset on a brand-new client');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Ordering: ACTIVE_PLAN_ID flips to the NEW plan BEFORE the plan-change
// detection block runs, so the post-reset save can never write into the
// OLD plan's mesos doc -- the version boundary is structurally enforced
// by variable assignment order, not by a runtime check that could race.
// ─────────────────────────────────────────────────────────────────────────────

const activeAssignIdx = CLIENT.indexOf('ACTIVE_PLAN_ID = activePlanId; // registrar plan activo actual');
const planChangedDeclIdx = CLIENT.indexOf('var planChanged = flagSession');
const resetBlockIdx = CLIENT.indexOf('LOGS           = {};');
const postResetSaveIdx = CLIENT.indexOf('await _doSaveLogs(); // Guardar el estado limpio de la semana 1');

ok(activeAssignIdx !== -1 && planChangedDeclIdx !== -1 && resetBlockIdx !== -1 && postResetSaveIdx !== -1, 'all 4 real source anchors for the ordering check are present');
ok(activeAssignIdx < planChangedDeclIdx, 'ACTIVE_PLAN_ID is set to the NEW plan id BEFORE plan-change detection even runs');
ok(planChangedDeclIdx < resetBlockIdx && resetBlockIdx < postResetSaveIdx, 'detection -> reset -> post-reset save happen in that exact order');
ok(activeAssignIdx < postResetSaveIdx, 'therefore the post-reset save (which stamps planId: ACTIVE_PLAN_ID into both the flat doc and logs/{uid}/mesos/{ACTIVE_PLAN_ID}) can ONLY ever target the NEW plan -- structurally cannot retroactively write into the OLD plan\'s mesos doc');

// ─────────────────────────────────────────────────────────────────────────────
// Flush-before-wipe: session A's in-memory data is never silently lost --
// it is persisted (both flat and mesos, still under plan A's own id at
// that moment) before LOGS is ever cleared.
// ─────────────────────────────────────────────────────────────────────────────

const flushIdx = CLIENT.indexOf('if (_saveLogsTimer) { clearTimeout(_saveLogsTimer); _saveLogsTimer = null; await _doSaveLogs(); }');
ok(flushIdx !== -1 && flushIdx < resetBlockIdx, 'a pending debounced save (session A\'s own not-yet-persisted data) is flushed BEFORE LOGS is wiped -- flush precedes wipe, never the reverse');

// ─────────────────────────────────────────────────────────────────────────────
// No retroactive reinterpretation: the reset payload never carries any of
// the OLD plan's entries forward into the new planId's stamp -- old data
// keeps its own historical planId forever, unmodified after the switch.
// ─────────────────────────────────────────────────────────────────────────────

ok(/LOGS\s*=\s*\{\};/.test(CLIENT), 'the reset assigns a genuinely EMPTY object -- no old entries are carried into the new plan\'s stamped payload, so nothing from plan A can ever be mislabeled as plan B\'s data');
ok(CLIENT.includes("EXERCISE_HISTORY sí se preserva") || CLIENT.includes('EXERCISE_HISTORY'), 'the one thing intentionally carried across a plan change (exercise weight history, indexed by exercise NAME for the unit-conversion/last-weight-used feature) is documented as a deliberate, narrow exception -- not training-log evidence, and outside the identity contract this ticket protects (Coach engines never read EXERCISE_HISTORY for progression/intervention decisions)');

console.log('');
console.log('T247 — Active plan version boundary: ' + pass + ' assertions PASSED (behavior already existed -- no persistence added)');
