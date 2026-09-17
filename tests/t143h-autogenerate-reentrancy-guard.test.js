'use strict';
/**
 * T143-H — Instant generation safety: autoGeneratePlan() re-entrancy guard.
 *
 * Scope per T143: autoGeneratePlan(), saveImportedPlan(), autoGenBtn,
 * planClientSelect, activePlanId/selected-client context.
 *
 * Audit findings:
 *   - clientId is captured ONCE from #planClientSelect at function entry into
 *     a local const, so a stale/changed dropdown selection during the AI call
 *     cannot redirect the eventual Firestore write to a different client —
 *     no stale-client write bug here.
 *   - saveImportedPlan() already has its own _savingImportedPlan re-entrancy
 *     guard, a confirm-before-replace gate (only when an activePlanId already
 *     exists), a pre-write backup, and a strict true/false success contract
 *     (T136-H) that autoGeneratePlan() correctly checks before continuing to
 *     write nutrition/supplements/pharma — so no false-success, no missing
 *     replace-confirmation, no write-failure-shows-success bug.
 *   - autoGeneratePlan() ITSELF had no re-entrancy guard beyond disabling
 *     #autoGenBtn — reachable a second time regardless of the button's state
 *     via window.autoGeneratePlan() (exported), or via the dormant
 *     `_modalImportPlan('ia', clientId)` branch, which repoints
 *     #planClientSelect and calls autoGeneratePlan() with zero guard check.
 *     A concurrent second call re-runs the whole (10-40s) AI generation for
 *     no reason (wasted API cost), and whichever saveImportedPlan() call
 *     loses the race gets a confusing "Generación cancelada" message even
 *     though nothing was actually cancelled by a person — a race, not a
 *     decision (P2: real, reproducible, but saveImportedPlan's own guard
 *     already prevents any actual duplicate/wrong-client Firestore write).
 *
 * Fix: added the same `_saving*`-style boolean guard used everywhere else in
 * this file (mirrors _savingImportedPlan) — check-and-set at the very top of
 * autoGeneratePlan(), reset in its `finally`. Purely additive: no change to
 * saveImportedPlan's semantics, no change to the instant-vs-preview policy,
 * no change to any Firestore write.
 *
 * Run: node tests/t143h-autogenerate-reentrancy-guard.test.js
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

const autoGenFn = extractFunction(COACH, 'async function autoGeneratePlan()');
assert.ok(autoGenFn, 'autoGeneratePlan must exist');

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1: re-entrancy guard — check-and-set before any other logic, reset in finally.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /if\s*\(\s*_autoGenInFlight\s*\)\s*return;/.test(autoGenFn),
  'T143-H: autoGeneratePlan must bail out immediately if _autoGenInFlight is already true'
);
assert.ok(
  /_autoGenInFlight\s*=\s*true;/.test(autoGenFn),
  'T143-H: autoGeneratePlan must set _autoGenInFlight = true after validation, before any await'
);
assert.ok(
  /finally\s*\{[^}]*_autoGenInFlight\s*=\s*false;/.test(autoGenFn),
  'T143-H: autoGeneratePlan must reset _autoGenInFlight = false in its finally block'
);

// The guard check must come before the flag is set (obviously), and the flag
// must be set before the first await in the function (before any async work
// starts) so a second call arriving during that async work is blocked.
const guardCheckIdx = autoGenFn.indexOf('if (_autoGenInFlight) return;');
const guardSetIdx   = autoGenFn.indexOf('_autoGenInFlight = true;');
const firstAwaitIdx = autoGenFn.indexOf('await ');
assert.ok(guardCheckIdx !== -1 && guardCheckIdx < guardSetIdx, 'T143-H: guard check must precede the guard set');
assert.ok(guardSetIdx !== -1 && guardSetIdx < firstAwaitIdx, 'T143-H: guard must be set before the first await');

console.log('autoGeneratePlan re-entrancy guard present and correctly ordered — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — clientId still captured once (no stale-client write),
// saveImportedPlan's own contract untouched, no change to the confirm-on-
// replace / no-confirm-on-first-plan policy, no new function/endpoint added.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /const clientId = document\.getElementById\('planClientSelect'\)\.value;/.test(autoGenFn),
  'T143-H regression: clientId must still be captured once from #planClientSelect at entry'
);
assert.ok(
  /const _trainingSaved = await saveImportedPlan\(clientId\);/.test(autoGenFn) &&
  /if \(!_trainingSaved\) \{/.test(autoGenFn),
  'T143-H regression: autoGeneratePlan must still check saveImportedPlan\'s true/false return before continuing'
);

const saveImportedPlanFn = extractFunction(COACH, 'async function saveImportedPlan(clientIdArg)');
assert.ok(saveImportedPlanFn, 'saveImportedPlan must exist');
assert.ok(
  /if\s*\(\s*_savingImportedPlan\s*\)\s*return false;/.test(saveImportedPlanFn),
  'T143-H regression: saveImportedPlan must still have its own _savingImportedPlan re-entrancy guard'
);
assert.ok(
  /const confirmed = await _askConfirm\(`⚠️ Reemplazar plan activo/.test(saveImportedPlanFn),
  'T143-H regression: saveImportedPlan must still confirm before replacing an existing active plan'
);
assert.ok(
  !/const confirmed = await _askConfirm/.test(saveImportedPlanFn.split('if (prevPlanId)')[0]),
  'T143-H regression: saveImportedPlan must still NOT confirm when there is no existing active plan (first plan)'
);
assert.ok(
  saveImportedPlanFn.includes('await backupPlanIfExists(clientId);'),
  'T143-H regression: saveImportedPlan must still back up the outgoing plan before overwriting activePlanId'
);

console.log('saveImportedPlan contract (guard, confirm-on-replace, backup) unchanged — OK');

console.log('');
console.log('T143-H — instant generation safety: ALL ASSERTIONS PASSED');
