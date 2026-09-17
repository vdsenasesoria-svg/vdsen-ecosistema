'use strict';
/**
 * T129 — Session state isolation (logout A -> login B must not inherit state).
 *
 * Bugs found and fixed:
 *
 * CLIENT (vdsen-cliente.html):
 *   doLogout() reset only PLAN and LOGS. It left EXERCISE_UNITS, EXERCISE_HISTORY,
 *   REAL_WEEK and CURRENT_WEEK untouched. loadPlan() only overwrites these from
 *   Firestore when logSnap.exists() is true (see the `if (logData.exerciseHistory)`
 *   guard) — a brand-new client B with no logs doc yet would inherit user A's
 *   in-memory exercise units/history and week counters (P1: wrong-user data bleed).
 *   It also left 'vdsen_logs_backup' (contains LOGS/exerciseUnits/exerciseHistory)
 *   and 'vdsen_menu_custom' (custom nutrition entries) in localStorage — both are
 *   read back into the app on the next session (loadBackupLogs / MENU_CUSTOM init)
 *   regardless of which user is now logged in.
 *
 * COACH (vdsen-coach.html):
 *   The onAuthStateChanged(user === null) branch (fired on signOut) rewrote
 *   document.body.innerHTML to show the login screen but never reset the
 *   module-level client-detail state (_detailClientId, _detailClientData,
 *   _detailPlanData, _detailPrevPlanData, _detailFichaData, _detailRenovacionData,
 *   _detailLogsData, window._importedPlan, currentCoach). Since the coach app
 *   never does a full page reload on logout, a second coach logging in on the
 *   same tab would have this stale state sitting in memory until they opened a
 *   client themselves (P2: stale cross-coach state).
 *
 * Run: node tests/t129-session-isolation.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'),   'utf8');

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

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — doLogout resets all user/plan/session-scoped in-memory state
// ─────────────────────────────────────────────────────────────────────────────

const doLogoutFn = extractFunction(CLIENT, 'async function doLogout()');
assert.ok(doLogoutFn, 'doLogout function must exist in CLIENT');

assert.ok(/PLAN\s*=\s*null/.test(doLogoutFn), 'doLogout must null PLAN');
assert.ok(/LOGS\s*=\s*\{\s*\}/.test(doLogoutFn), 'doLogout must reset LOGS to {}');
assert.ok(/EXERCISE_UNITS\s*=\s*\{\s*\}/.test(doLogoutFn),
  'T129: doLogout must reset EXERCISE_UNITS to {} (prevents bleed to a next user with no logs doc)');
assert.ok(/EXERCISE_HISTORY\s*=\s*\{\s*\}/.test(doLogoutFn),
  'T129: doLogout must reset EXERCISE_HISTORY to {} (prevents bleed to a next user with no logs doc)');
assert.ok(/REAL_WEEK\s*=\s*1/.test(doLogoutFn),
  'T129: doLogout must reset REAL_WEEK to 1');
assert.ok(/CURRENT_WEEK\s*=\s*1/.test(doLogoutFn),
  'T129: doLogout must reset CURRENT_WEEK to 1');
assert.ok(/MENU_CUSTOM\s*=\s*\{\s*\}/.test(doLogoutFn),
  'T129: doLogout must reset MENU_CUSTOM to {} (prevents next user seeing custom nutrition entries)');

console.log('CLIENT doLogout in-memory reset — OK');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — doLogout clears user-scoped localStorage keys
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /removeItem\s*\(\s*['"]vdsen_active_plan_id['"]/.test(doLogoutFn),
  'doLogout must clear vdsen_active_plan_id (R8-GAP-01)'
);
assert.ok(
  /removeItem\s*\(\s*['"]vdsen_logs_backup['"]/.test(doLogoutFn),
  'T129: doLogout must clear vdsen_logs_backup — contains previous user LOGS/exercise data'
);
assert.ok(
  /removeItem\s*\(\s*['"]vdsen_menu_custom['"]/.test(doLogoutFn),
  'T129: doLogout must clear vdsen_menu_custom — contains previous user nutrition customizations'
);

console.log('CLIENT doLogout localStorage cleanup — OK');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — doLogout stops the rest timer (device-global localStorage keys
// vdsen_restEnd / vdsen_restTotal must not carry a running countdown across users)
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /stopRestTimer\s*\(\s*\)/.test(doLogoutFn),
  'T129: doLogout must call stopRestTimer() to clear any in-progress countdown'
);

console.log('CLIENT doLogout rest-timer cleanup — OK');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — device-truly-global prefs must NOT be touched by doLogout
// (light mode, timer-off, express-off are device preferences, not user state)
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  !/removeItem\s*\(\s*['"]vdsen_light_mode['"]/.test(doLogoutFn),
  'doLogout must NOT clear vdsen_light_mode — it is a device preference, not user state'
);
assert.ok(
  !/removeItem\s*\(\s*['"]vdsen_timer_off['"]/.test(doLogoutFn),
  'doLogout must NOT clear vdsen_timer_off — it is a device preference, not user state'
);

console.log('CLIENT device-global prefs preserved — OK');

// ─────────────────────────────────────────────────────────────────────────────
// COACH — onAuthStateChanged(null) branch resets client-detail module state
// ─────────────────────────────────────────────────────────────────────────────

const authChangedFn = extractFunction(COACH, 'onAuthStateChanged(auth, async (user) => {');
assert.ok(authChangedFn, 'onAuthStateChanged handler must exist in COACH');

// Isolate the else branch (user === null / logout path)
const elseIdx = authChangedFn.indexOf('} else {');
assert.ok(elseIdx !== -1, 'onAuthStateChanged must have an else branch for the logged-out case');
const elseBranch = authChangedFn.slice(elseIdx);

const requiredResets = [
  '_detailClientId = null',
  '_detailClientData = null',
  '_detailPlanData = null',
  '_detailFichaData = null',
  '_detailRenovacionData = null',
  '_detailLogsData = null',
  'window._importedPlan = null',
  'currentCoach = null',
];
for (const reset of requiredResets) {
  assert.ok(
    elseBranch.includes(reset),
    'T129: COACH logout branch must reset "' + reset + '" — stale cross-coach state on same tab'
  );
}

console.log('COACH logout branch client-detail reset — OK');

console.log('');
console.log('T129 — session state isolation: ALL ASSERTIONS PASSED');
