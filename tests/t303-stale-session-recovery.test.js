'use strict';
/**
 * T303 — Stale open-session recovery.
 *
 * _findStaleOpenSession detects a genuinely IN_PROGRESS session (real sets
 * logged, never closed) whose most recent real set was logged on a
 * different calendar day than "now" -- i.e. left open across a day
 * boundary. Pure, read-only, no Firestore write. The recovery UI never
 * auto-marks COMPLETE; it offers CONTINUAR (navigate there) or TERMINAR
 * COMO PARCIAL (reuses T301's _endSessionAsPartial, so the same real-sets-
 * only/no-fabrication/guarded-write safety applies).
 *
 * Also re-confirms (no new code, T299's audit already established this):
 * timer identity/immutability rules -- sessionStart scoped per week+day,
 * autoFilled excluded, 12h implausibility cap, frozen once closed.
 *
 * Run: node tests/t303-stale-session-recovery.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

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

const getCompletionStateSrc = extractFunction(CLIENT, 'function _getSessionCompletionState(doneEntry) {');
const hasRealSetsSrc        = extractFunction(CLIENT, 'function _sessionHasRealLoggedSets(logs, week, di) {');
const getLifecycleSrc       = extractFunction(CLIENT, 'function _getSessionLifecycleState(logs, week, di) {');
const lastRealSetTsSrc      = extractFunction(CLIENT, 'function _lastRealSetTs(logs, week, di) {');
const findStaleSrc          = extractFunction(CLIENT, 'function _findStaleOpenSession(logs, week, sesiones, nowMs) {');

const fn = new Function(
  getCompletionStateSrc + '\n' + hasRealSetsSrc + '\n' + getLifecycleSrc + '\n' +
  lastRealSetTsSrc + '\n' + findStaleSrc + '\n' +
  'return { _getSessionLifecycleState, _findStaleOpenSession };'
);
const { _findStaleOpenSession } = fn();

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }
function eq(actual, expected, msg) { assert.deepStrictEqual(actual, expected, msg + ' (got ' + JSON.stringify(actual) + ')'); pass++; console.log('  ✓ ' + msg); }

const W = 3;
const sesiones = [{}, {}, {}]; // 3 days, content unused by the resolver itself
const DAY_MS = 86400000;
const now = Date.parse('2026-09-21T12:00:00');
const yesterday = now - DAY_MS - 3600000; // > 24h ago, different calendar day
const today = now - 3600000; // same calendar day as `now`

// 1. No sessions touched at all -> no stale session found
eq(_findStaleOpenSession({}, W, sesiones, now), null, 'T303-1: empty LOGS -> no stale session');

// 2. Real set logged TODAY, no done_ -> IN_PROGRESS but NOT stale (still today)
eq(_findStaleOpenSession({ ['log_'+W+'_1_0_s0']: { done: true, ts: today } }, W, sesiones, now),
  null, 'T303-2: IN_PROGRESS session touched today is not stale (user may still be mid-workout)');

// 3. Real set logged YESTERDAY, no done_ -> stale, correct day/index returned
eq(_findStaleOpenSession({ ['log_'+W+'_1_0_s0']: { done: true, ts: yesterday } }, W, sesiones, now),
  { week: W, di: 1, lastTs: yesterday }, 'T303-3: IN_PROGRESS session last touched yesterday -> flagged stale with correct week/day');

// 4. A COMPLETE session (done_ present) is never flagged stale, however old
eq(_findStaleOpenSession({ ['done_'+W+'_1']: { ts: yesterday }, ['log_'+W+'_1_0_s0']: { done: true, ts: yesterday } }, W, sesiones, now),
  null, 'T303-4: a session with a done_ entry (COMPLETE/PARTIAL/SKIPPED) is never re-flagged as stale');

// 5. Only autoFilled sets, no done_ -> not IN_PROGRESS at all -> not stale (autofill != executed)
eq(_findStaleOpenSession({ ['log_'+W+'_1_0_s0']: { done: true, autoFilled: true, ts: yesterday } }, W, sesiones, now),
  null, 'T303-5: an old session with ONLY autoFilled sets is never flagged stale (AUTOFILLED != EXECUTED)');

// 6. Multiple stale candidates -> returns the first by day index, deterministic
eq(_findStaleOpenSession({ ['log_'+W+'_0_0_s0']: { done: true, ts: yesterday }, ['log_'+W+'_2_0_s0']: { done: true, ts: yesterday } }, W, sesiones, now),
  { week: W, di: 0, lastTs: yesterday }, 'T303-6: with multiple stale candidates, the resolver is deterministic (first by index)');

// 7. No sesiones (plan not loaded yet) -> never throws, returns null
eq(_findStaleOpenSession({ ['log_'+W+'_0_0_s0']: { done: true, ts: yesterday } }, W, [], now), null, 'T303-7: empty sesiones list -> null, never throws');

// ── UI wiring: never auto-marks COMPLETE; CONTINUAR navigates, TERMINAR COMO
// PARCIAL reuses the already-guarded _endSessionAsPartial. ──────────────────
const recoveryFnSrc = extractFunction(CLIENT, 'function _showStaleSessionRecovery(staleInfo) {');
ok(recoveryFnSrc.includes("selDia(staleInfo.di);"), 'CONTINUAR navigates to the stale session via the existing (already-audited, lock-free) selDia');
ok(recoveryFnSrc.includes('_endSessionAsPartial(staleInfo.di);'), 'TERMINAR COMO PARCIAL reuses T301\'s _endSessionAsPartial -- same real-sets-only / no-fabrication / guarded-write safety, no duplicated logic');
ok(!recoveryFnSrc.includes("done_") || !/LOGS\['done_/.test(recoveryFnSrc), 'the recovery modal itself never writes a done_ entry directly -- it only delegates to selDia/_endSessionAsPartial, never fabricates COMPLETE');
ok(recoveryFnSrc.includes('function dismiss()') && !recoveryFnSrc.includes('markSessionDone'), 'dismissing the modal (click-outside) never marks the session done -- the user is never permanently trapped nor auto-completed');

// ── Hook: checked once per app load, staggered after other startup modals. ──
ok(CLIENT.includes('var _stale = _findStaleOpenSession(LOGS, REAL_WEEK, getSesiones());') &&
   CLIENT.includes('if (_stale) _showStaleSessionRecovery(_stale);'),
  'loadPlan checks for a stale session once per app load and shows the recovery prompt if found');

// ── Re-confirm T299\'s timer-safety findings still hold (no regression). ────
const fmtElapsedSrc = extractFunction(CLIENT, 'function _fmtElapsed(startMs, endMs) {');
ok(fmtElapsedSrc.includes('_maxPlausibleMs = 12 * 60 * 60 * 1000'), 're-confirmed: _fmtElapsed still caps plausible duration at 12h (no multi-day timer artifact possible)');

console.log('');
console.log('T303 — Stale session recovery: ' + pass + ' assertions PASSED');
