'use strict';
/**
 * T130 — User-scoped storage audit (localStorage/sessionStorage leak check).
 *
 * Full inventory of every localStorage/sessionStorage key read or written by
 * vdsen-cliente.html and vdsen-coach.html, classified as:
 *   device-global      — a device/browser preference, must survive logout
 *   user/plan-scoped   — operational data tied to a specific user/client/plan,
 *                        must be cleared (or already is) on logout
 *
 * CLIENT keys (all already handled, verified here as a regression guard):
 *   vdsen_uid              user-scoped  — set/removed by onAuthStateChanged directly
 *   vdsen_active_plan_id   user-scoped  — cleared in doLogout (R8-GAP-01)
 *   vdsen_logs_backup      user-scoped  — cleared in doLogout (T129)
 *   vdsen_menu_custom      user-scoped  — cleared in doLogout (T129)
 *   vdsen_restEnd/Total    session-scoped — cleared via stopRestTimer() in doLogout (T129)
 *   vdsen_light_mode       device-global — theme preference, must NOT be cleared
 *   vdsen_timer_off        device-global — feature toggle, must NOT be cleared
 *   vdsen_express_off      device-global — feature toggle, must NOT be cleared
 *   vdsen_last_tab/dia     UI position memory (day/tab index), not sensitive data;
 *                          left as-is (no leak of operational content)
 *   vdsen_plan_changed / vdsen_plan_updated_info (sessionStorage) — self-consuming
 *                          one-shot flags (removed immediately on read); a stale
 *                          flag only forces an extra safe reset, never a data leak
 *   vdsen_wn_v6            device-global — "what's new" dismiss flag, versioned by
 *                          release, not user data
 *
 * COACH key found leaking (fixed by this round):
 *   vdsen_apikey  (P1, NEW FIX) — the coach's personal AI API key (Motor VDSEN
 *     generation). Was set once via settings and never cleared on logout. A
 *     second coach logging in on the same device would silently reuse the first
 *     coach's key — both a credential leak and a billing/quota leak. Fixed by
 *     clearing it in the onAuthStateChanged(user === null) branch alongside the
 *     other T129 resets.
 *
 * Run: node tests/t130-storage-key-audit.test.js
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
// COACH — vdsen_apikey (P1 NEW FIX): coach API key must be cleared on logout
// ─────────────────────────────────────────────────────────────────────────────

const authChangedFn = extractFunction(COACH, 'onAuthStateChanged(auth, async (user) => {');
assert.ok(authChangedFn, 'onAuthStateChanged handler must exist in COACH');

const elseIdx = authChangedFn.indexOf('} else {');
assert.ok(elseIdx !== -1, 'onAuthStateChanged must have an else (logged-out) branch');
const elseBranch = authChangedFn.slice(elseIdx);

assert.ok(
  /removeItem\s*\(\s*['"]vdsen_apikey['"]/.test(elseBranch),
  'T130: COACH logout branch must clear vdsen_apikey — a per-coach API credential ' +
  'that must not survive to the next coach session on the same device'
);

console.log('COACH vdsen_apikey cleared on logout — OK');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — regression guard: all previously-fixed user-scoped keys stay cleared
// ─────────────────────────────────────────────────────────────────────────────

const doLogoutFn = extractFunction(CLIENT, 'async function doLogout()');
assert.ok(doLogoutFn, 'doLogout must exist in CLIENT');

for (const key of ['vdsen_active_plan_id', 'vdsen_logs_backup', 'vdsen_menu_custom']) {
  assert.ok(
    new RegExp("removeItem\\s*\\(\\s*['\"]" + key + "['\"]").test(doLogoutFn),
    'T130 regression: doLogout must still clear ' + key
  );
}
assert.ok(/stopRestTimer\s*\(\s*\)/.test(doLogoutFn), 'T130 regression: doLogout must still call stopRestTimer()');

console.log('CLIENT previously-fixed keys still cleared — OK');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — device-global preferences must NEVER be touched by doLogout
// ─────────────────────────────────────────────────────────────────────────────

for (const key of ['vdsen_light_mode', 'vdsen_timer_off', 'vdsen_express_off']) {
  assert.ok(
    !new RegExp("removeItem\\s*\\(\\s*['\"]" + key + "['\"]").test(doLogoutFn),
    'T130: doLogout must NOT clear device-global preference ' + key
  );
}

console.log('CLIENT device-global prefs confirmed untouched — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Full key inventory — fail loudly if a brand-new, unclassified storage key
// appears in either file (forces the next audit round to classify it).
// ─────────────────────────────────────────────────────────────────────────────

function collectKeys(src) {
  const re = /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

const knownClientKeys = new Set([
  'vdsen_uid', 'vdsen_active_plan_id', 'vdsen_logs_backup', 'vdsen_menu_custom',
  'vdsen_restEnd', 'vdsen_restTotal', 'vdsen_light_mode', 'vdsen_timer_off',
  'vdsen_express_off', 'vdsen_last_tab', 'vdsen_last_dia',
  'vdsen_plan_changed', 'vdsen_plan_updated_info',
]);
const knownCoachKeys = new Set(['vdsen_apikey']);

const clientKeys = collectKeys(CLIENT);
const coachKeys  = collectKeys(COACH);

const unknownClient = [...clientKeys].filter(k => !knownClientKeys.has(k));
const unknownCoach  = [...coachKeys].filter(k => !knownCoachKeys.has(k));

assert.deepStrictEqual(
  unknownClient, [],
  'T130: unclassified CLIENT storage key(s) found — audit and classify: ' + JSON.stringify(unknownClient)
);
assert.deepStrictEqual(
  unknownCoach, [],
  'T130: unclassified COACH storage key(s) found — audit and classify: ' + JSON.stringify(unknownCoach)
);

console.log('Full storage key inventory matches known/classified set — OK');
console.log('  CLIENT keys (' + clientKeys.size + '):', [...clientKeys].sort().join(', '));
console.log('  COACH  keys (' + coachKeys.size + '):', [...coachKeys].sort().join(', '));

console.log('');
console.log('T130 — user-scoped storage audit: ALL ASSERTIONS PASSED');
