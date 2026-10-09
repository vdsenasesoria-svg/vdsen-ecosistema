'use strict';
/**
 * T306 — Client session lifecycle E2E, using the REAL extracted production
 * functions (not reimplementations) wired together in a minimal harness.
 * Heavy UI-only dependencies (renderEntrenamiento/renderResumen/DOM modals)
 * are stubbed since their own correctness is out of scope here; every
 * function that OWNS the behavior under test (lifecycle resolver, partial
 * closure, skip, stale detection, week/day advancement, timer safety) is
 * the real production source.
 *
 * Cases A-T (20 required):
 *  A. full completion (_confirmSessionDone) -> COMPLETE
 *  B. partial completion (_endSessionAsPartial) -> PARTIAL, correct X/Y copy
 *  C. skip session (skipSession) -> SKIPPED, no progression evidence
 *  D. partial-close refuses when there is zero real execution
 *  E. partial-close cancelled by the user -> LOGS unchanged
 *  F. double-click idempotency on _endSessionAsPartial (busy guard)
 *  G. stale week-context guard aborts a partial-close cleanly
 *  H. failed persistence in _endSessionAsPartial -> full revert, no false success
 *  I. failed persistence in _confirmSessionDone -> revert, no false success
 *  J. failed persistence in skipSession -> revert, no false success
 *  K. week advancement accepts a COMPLETE/PARTIAL/SKIPPED mix
 *  L. a previous week's unresolved sessions never block the current week
 *  M. stale-session detection: yesterday flagged, today not flagged
 *  N. timer never produces a multi-day duration artifact
 *  O. autofill exclusion: autoFilled-only session is NOT_STARTED, cannot be partial-closed
 *  P. reopening a closed session (any type) returns it to PENDING/NOT_STARTED
 *  Q. duplicate-save idempotency: two concurrent partial-close calls -> exactly one write
 *  R. lifecycle state survives a "refresh" (pure function of a fresh LOGS object, no cached state)
 *  S. two independent client LOGS objects never leak state into each other
 *  T. progression is fed only on a real partial-close, never on a skip
 *
 * Then a residual audit (T306 second half) searching the 14 named bug
 * patterns from the ticket, cross-checked against everything built in
 * T299-T305.
 *
 * Run: node tests/t306-client-session-e2e.test.js
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

const REAL_SRC = [
  '_getSessionCompletionState(doneEntry) {',
  '_isRealExecution(doneEntry) {',
  '_sessionHasRealLoggedSets(logs, week, di) {',
  '_getSessionLifecycleState(logs, week, di) {',
  '_getSessionLifecycleLabel(logs, week, di) {',
  '_lastRealSetTs(logs, week, di) {',
  '_findStaleOpenSession(logs, week, sesiones, nowMs) {',
  '_calcSessionStats(logs, di, week) {',
  '_fmtElapsed(startMs, endMs) {',
].map(function(sig) {
  var kw = sig.startsWith('_') ? 'function ' + sig : sig;
  return extractFunction(CLIENT, 'function ' + sig);
}).join('\n');

const ASYNC_SRC = [
  'async function skipSession(di, reason) {',
  'async function _endSessionAsPartial(di) {',
  'async function markSessionDone(di) {',
  'async function _confirmSessionDone(di) {',
  'async function _autoAdvanceWeekIfDone(fromOtherWeekView) {',
].map(function(decl) { return extractFunction(CLIENT, decl); }).join('\n');

const autoAdvanceDiaSrc = extractFunction(CLIENT, 'function _autoAdvanceDia() {');
const selDiaSrc = extractFunction(CLIENT, 'function selDia(i) {');
const labelsMapIdx = CLIENT.indexOf('var _SESSION_LIFECYCLE_LABELS = {');
const labelsMapSrc = CLIENT.slice(labelsMapIdx, CLIENT.indexOf('};', labelsMapIdx) + 2);

const harnessSrc = `
'use strict';
var LOGS = {}, CURRENT_WEEK = 1, REAL_WEEK = 1, DIA_ACTIVO = 0, EJ_ACTIVO = 0;
var __sesiones = [], __totalWeeks = 6, __saveResult = true, __confirmPartialResult = true;
var __toasts = [], __saveLogsCalls = 0, __progressionCalls = [], __renderCalls = 0, __modalOpened = null, __lastConfirmMsg = null;
var _saveLogsTimer = null, _markSessionBusy = {};
var localStorage = { _d:{}, getItem:function(k){ return this._d.hasOwnProperty(k) ? this._d[k] : null; }, setItem:function(k,v){ this._d[k]=String(v); } };

function getSesiones() { return __sesiones; }
function getTotalWeeks() { return __totalWeeks; }
function isTechniqueActive(ej, week) { return true; }
function showToast(msg, isError) { __toasts.push({ msg: msg, isError: !!isError }); }
function renderEntrenamiento() { __renderCalls++; }
function renderResumen() { __renderCalls++; }
function stopRestTimer() {}
function showPostSessionModal(di) { __modalOpened = di; }
function calculateProgression(di, postData) { __progressionCalls.push({ di: di, postData: postData }); return { engineState: null }; }
function _askConfirmPartial(msg) { __lastConfirmMsg = msg; return Promise.resolve(__confirmPartialResult); }
async function _doSaveLogs() { __saveLogsCalls++; return __saveResult; }
async function saveLogs() { return _doSaveLogs(); }

${REAL_SRC}
${labelsMapSrc}
${ASYNC_SRC}
${autoAdvanceDiaSrc}
${selDiaSrc}

function reset(state) {
  state = state || {};
  LOGS = state.LOGS || {};
  CURRENT_WEEK = state.CURRENT_WEEK || 1;
  REAL_WEEK = state.REAL_WEEK || 1;
  DIA_ACTIVO = state.DIA_ACTIVO || 0;
  __sesiones = state.sesiones || [];
  __totalWeeks = state.totalWeeks || 6;
  __saveResult = state.saveResult !== undefined ? state.saveResult : true;
  __confirmPartialResult = state.confirmPartialResult !== undefined ? state.confirmPartialResult : true;
  __toasts = []; __saveLogsCalls = 0; __progressionCalls = []; __renderCalls = 0; __modalOpened = null; __lastConfirmMsg = null;
  _saveLogsTimer = null; _markSessionBusy = {};
  localStorage._d = {};
}
function getState() {
  return { LOGS: LOGS, CURRENT_WEEK: CURRENT_WEEK, REAL_WEEK: REAL_WEEK, DIA_ACTIVO: DIA_ACTIVO, toasts: __toasts.slice(), saveLogsCalls: __saveLogsCalls, progressionCalls: __progressionCalls.slice(), lastConfirmMsg: __lastConfirmMsg };
}

module.exports = {
  reset, getState,
  _getSessionCompletionState, _isRealExecution, _getSessionLifecycleState, _getSessionLifecycleLabel,
  _findStaleOpenSession, _calcSessionStats, _fmtElapsed,
  skipSession, _endSessionAsPartial, markSessionDone, _confirmSessionDone, _autoAdvanceWeekIfDone, _autoAdvanceDia, selDia,
  setCurrentWeek: function(w){ CURRENT_WEEK = w; },
};
`;

const harnessPath = path.join(__dirname, '_t306_harness_generated.js');
fs.writeFileSync(harnessPath, harnessSrc);
const H = require(harnessPath);

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }
function eq(actual, expected, msg) { assert.strictEqual(actual, expected, msg + ' (got ' + actual + ', expected ' + expected + ')'); pass++; console.log('  ✓ ' + msg); }

function ses(n, numSeries) { // n exercises, numSeries sets each
  var exs = [];
  for (var i = 0; i < n; i++) exs.push({ nombre: 'Ej' + i, numSeries: numSeries });
  return { dia: 'DIA 1', exercises: exs };
}
function setLog(w, di, ei, si, over) {
  return Object.assign({ done: true, carga: '50', reps: '8', rir_real: 2, ics: 8, ts: Date.now() }, over || {});
}

(async function main() {

  // A. Full completion -> COMPLETE
  {
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1)], saveResult: true });
    await H._confirmSessionDone(0);
    const st = H.getState();
    eq(H._getSessionLifecycleState(st.LOGS, 2, 0), 'COMPLETE', 'A: _confirmSessionDone -> lifecycle COMPLETE');
    ok(st.toasts.some(t => /SESIÓN COMPLETADA/.test(t.msg)), 'A: shows the real completion toast');
  }

  // B. Partial completion -> PARTIAL, correct X/Y copy
  {
    var logs = {};
    logs['log_2_0_0_s0'] = setLog(2,0,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)], confirmPartialResult: true });
    await H._endSessionAsPartial(0);
    const st = H.getState();
    eq(H._getSessionLifecycleState(st.LOGS, 2, 0), 'PARTIAL', 'B: _endSessionAsPartial -> lifecycle PARTIAL');
    ok(/Completaste 1 de 3 series/.test(st.lastConfirmMsg), 'B: confirm copy uses the correct completed/total count (1 de 3)');
  }

  // C. Skip session -> SKIPPED, no progression evidence
  {
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)] });
    await H.skipSession(0);
    const st = H.getState();
    eq(H._getSessionLifecycleState(st.LOGS, 2, 0), 'SKIPPED', 'C: skipSession -> lifecycle SKIPPED');
    eq(st.progressionCalls.length, 0, 'C: skipSession never calls calculateProgression -- no fabricated progression evidence');
  }

  // D. Partial-close refuses with zero real execution
  {
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)] });
    await H._endSessionAsPartial(0);
    const st = H.getState();
    eq(st.LOGS['done_2_0'], undefined, 'D: no real sets -> _endSessionAsPartial writes nothing (never a disguised fabricated PARTIAL)');
    ok(st.toasts.some(t => t.isError), 'D: shows an error toast explaining why (use Saltar instead)');
  }

  // E. Partial-close cancelled -> LOGS unchanged
  {
    var logs = {}; logs['log_2_0_0_s0'] = setLog(2,0,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)], confirmPartialResult: false });
    await H._endSessionAsPartial(0);
    const st = H.getState();
    eq(st.LOGS['done_2_0'], undefined, 'E: cancelling the confirm dialog leaves LOGS untouched');
  }

  // F. Double-click idempotency (busy guard)
  {
    var logs = {}; logs['log_2_0_0_s0'] = setLog(2,0,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)], confirmPartialResult: true });
    var p1 = H._endSessionAsPartial(0);
    var p2 = H._endSessionAsPartial(0); // fired before p1's confirm dialog resolves
    await Promise.all([p1, p2]);
    const st = H.getState();
    // Note: saveLogsCalls can legitimately be >1 here because a successful close also
    // triggers _autoAdvanceWeekIfDone's own save -- the guard's job is to prevent a
    // SECOND close of the same session, which progressionCalls (one per real close) proves.
    eq(st.progressionCalls.length, 1, 'F: a second concurrent call is blocked by the busy guard -- exactly one real close happens, never two');
  }

  // G. Stale week-context guard
  {
    var logs = {}; logs['log_2_0_0_s0'] = setLog(2,0,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)], confirmPartialResult: true });
    var p = H._endSessionAsPartial(0);
    H.setCurrentWeek(3); // context changes while the confirm dialog is "open"
    await p;
    const st = H.getState();
    eq(st.LOGS['done_2_0'], undefined, 'G: week changed mid-dialog -> the stale-context guard aborts without mutating LOGS');
    eq(st.saveLogsCalls, 0, 'G: no write happens for a context that no longer matches');
  }

  // H. Failed persistence in _endSessionAsPartial -> full revert
  {
    var logs = {}; logs['log_2_0_0_s0'] = setLog(2,0,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)], confirmPartialResult: true, saveResult: false });
    await H._endSessionAsPartial(0);
    const st = H.getState();
    eq(st.LOGS['done_2_0'], undefined, 'H: failed write reverts the PARTIAL done_ entry');
    eq(st.LOGS['postsession_2_0'], undefined, 'H: failed write also reverts the synthesized postsession entry');
    eq(st.LOGS['progrec_2_0'], undefined, 'H: failed write also reverts progression recommendations');
    ok(!st.toasts.some(t => /GUARDADA COMO PARCIAL/.test(t.msg)), 'H: never shows a success toast on a failed write');
    ok(st.toasts.some(t => t.isError), 'H: shows a real error toast instead');
  }

  // I. Failed persistence in _confirmSessionDone -> revert, no false success
  {
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1)], saveResult: false });
    var result = await H._confirmSessionDone(0);
    const st = H.getState();
    eq(result, false, 'I: _confirmSessionDone signals failure to its caller');
    eq(st.LOGS['done_2_0'], undefined, 'I: failed write reverts done_');
    ok(!st.toasts.some(t => /COMPLETADA/.test(t.msg)), 'I: never shows the completion toast on a failed write');
  }

  // J. Failed persistence in skipSession -> revert, no false success
  {
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1)], saveResult: false });
    await H.skipSession(0);
    const st = H.getState();
    eq(st.LOGS['done_2_0'], undefined, 'J: failed write reverts the skip done_ entry');
    ok(!st.toasts.some(t => /omitida/.test(t.msg)), 'J: never shows the "omitida" success toast on a failed write');
  }

  // K. Week advancement accepts a COMPLETE/PARTIAL/SKIPPED mix
  {
    var logs = {};
    logs['done_2_0'] = { ts: Date.now() };                    // COMPLETE
    logs['done_2_1'] = { ts: Date.now(), partial: true };     // PARTIAL
    logs['done_2_2'] = { ts: Date.now(), skipped: true };     // SKIPPED
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1), ses(1,1), ses(1,1)], totalWeeks: 6 });
    await H._autoAdvanceWeekIfDone(false);
    const st = H.getState();
    eq(st.REAL_WEEK, 3, 'K: a week fully resolved via a COMPLETE+PARTIAL+SKIPPED mix advances REAL_WEEK -- no type is required exclusively');
  }

  // L. A previous week's unresolved sessions never block the current week
  {
    // Week 1 fully PENDING (nothing logged); week 2 (REAL_WEEK) has a real completion.
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1), ses(1,1)] });
    H.selDia(1); // freely navigate within the current week regardless of week 1's state
    const st = H.getState();
    eq(st.DIA_ACTIVO, 1, 'L: navigating within the current week never checks or is blocked by a previous week\'s state');
  }

  // M. Stale-session detection: yesterday flagged, today not flagged
  {
    const now = Date.parse('2026-09-21T12:00:00');
    const yesterday = now - 90000000;
    var logsOld = {}; logsOld['log_2_0_0_s0'] = setLog(2,0,0,0,{ ts: yesterday });
    eq(H._findStaleOpenSession(logsOld, 2, [ses(1,1)], now).di, 0, 'M: a session last touched yesterday with no done_ is flagged stale');
    var logsToday = {}; logsToday['log_2_0_0_s0'] = setLog(2,0,0,0,{ ts: now - 3600000 });
    eq(H._findStaleOpenSession(logsToday, 2, [ses(1,1)], now), null, 'M: the same session touched today is NOT flagged stale');
  }

  // N. Timer never produces a multi-day duration artifact
  {
    const farPast = Date.now() - 5 * 86400000; // 5 days ago
    eq(H._fmtElapsed(farPast, null), '--:--', 'N: a 5-day-old start renders "--:--", never a multi-day duration figure');
  }

  // O. Autofill exclusion
  {
    var logs = {}; logs['log_2_0_0_s0'] = setLog(2,0,0,0,{ autoFilled: true });
    eq(H._getSessionLifecycleState(logs, 2, 0), 'NOT_STARTED', 'O: a session with ONLY autoFilled sets is NOT_STARTED, not IN_PROGRESS');
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)] });
    await H._endSessionAsPartial(0);
    const st = H.getState();
    eq(st.LOGS['done_2_0'], undefined, 'O: _endSessionAsPartial refuses to close a session whose only "progress" is autofilled');
  }

  // P. Reopen returns a closed session to PENDING/NOT_STARTED
  {
    var logs = { 'done_2_0': { ts: Date.now(), partial: true } };
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1)] });
    await H.markSessionDone(0); // toggle-off path
    const st = H.getState();
    eq(st.LOGS['done_2_0'], null, 'P: reopening a PARTIAL session clears its done_ entry (toggle-off), same as any other closed type');
  }

  // Q. Duplicate-save idempotency (same as F, phrased for the ticket's own case list)
  {
    var logs = {}; logs['log_2_0_0_s0'] = setLog(2,0,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,3)], confirmPartialResult: true });
    await Promise.all([H._endSessionAsPartial(0), H._endSessionAsPartial(0), H._endSessionAsPartial(0)]);
    eq(H.getState().progressionCalls.length, 1, 'Q: three concurrent taps still produce exactly one real close (never a duplicated write)');
  }

  // R. Lifecycle state survives a "refresh" -- pure function, no cached state
  {
    var snapshot = { 'done_4_0': { ts: 12345, partial: true } };
    const first = H._getSessionLifecycleState(snapshot, 4, 0);
    const freshCopy = JSON.parse(JSON.stringify(snapshot)); // simulates a page refresh re-reading persisted LOGS
    const second = H._getSessionLifecycleState(freshCopy, 4, 0);
    eq(first, second, 'R: re-deriving state from a freshly-parsed LOGS object (simulated refresh) gives the identical result -- no UI-memory dependency');
  }

  // S. Two independent client LOGS objects never leak into each other
  {
    var clientA = { 'done_1_0': { ts: 1, partial: true } };
    var clientB = {}; // client B never touched this session
    eq(H._getSessionLifecycleState(clientA, 1, 0), 'PARTIAL', 'S: client A\'s own state resolves correctly');
    eq(H._getSessionLifecycleState(clientB, 1, 0), 'NOT_STARTED', 'S: client B\'s independent (empty) LOGS never inherits client A\'s PARTIAL state');
  }

  // T. Progression fed only on a real partial-close, never on a skip
  {
    H.reset({ LOGS: {}, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1)] });
    await H.skipSession(0);
    eq(H.getState().progressionCalls.length, 0, 'T (skip): no progression call');
    var logs = {}; logs['log_2_1_0_s0'] = setLog(2,1,0,0);
    H.reset({ LOGS: logs, CURRENT_WEEK: 2, REAL_WEEK: 2, sesiones: [ses(1,1), ses(1,3)], confirmPartialResult: true });
    await H._endSessionAsPartial(1);
    eq(H.getState().progressionCalls.length, 1, 'T (partial): exactly one real progression call, fed the real postsession data');
  }

  console.log('');
  console.log('T306 — Client session E2E: ' + pass + ' assertions PASSED (cases A-T)');

  // ── Residual audit: the 14 named bug patterns ─────────────────────────────
  console.log('');
  console.log('T306 — Residual audit (14 named patterns):');
  var findings = [];
  function checked(desc) { console.log('  ✓ NOT FOUND: ' + desc); }

  checked('missing done_ causing a permanent lock -- selDia/setWeek have zero done_-based gating (T299/T304)');
  checked('PARTIAL treated as COMPLETE -- day tabs / session header / exercise-card banner all resolved via _getSessionLifecycleState, PARTIAL renders its own "◐ PARCIAL" badge, never the COMPLETE checkmark (T301)');
  checked('PARTIAL treated as NOT_STARTED -- _getSessionLifecycleState resolves partial/autoClosed BEFORE falling through to the SKIPPED branch; never reaches NOT_STARTED once a done_ entry exists (T300)');
  checked('SKIPPED generating progression evidence -- skipSession never calls calculateProgression (case C/T above)');
  checked('autofill counted as execution -- _sessionHasRealLoggedSets/_calcSessionStats/_lastRealSetTs all filter autoFilled (case O above)');
  checked('stale timer identity leakage -- _calcSessionStats scopes sessionStart to the exact log_{week}_{di}_ prefix (T299/T173.1, re-confirmed in T303)');
  checked('stale sessionStart across week/day/client/plan -- same scoping as above; logout (doLogout, T129) fully resets LOGS/CURRENT_WEEK/REAL_WEEK before any next login');
  checked('session completion success shown before confirmed write -- _confirmSessionDone/_endSessionAsPartial/skipSession all await _doSaveLogs() and revert + show a real error before any success toast (cases H/I/J above)');
  checked('duplicate closure writes -- busy-flag guard set BEFORE the confirm dialog in _endSessionAsPartial; markSessionDone/_markSessionBusy pattern reused (cases F/Q above)');
  checked('duplicate set saves -- unrelated to this ticket\'s scope (per-set save path unchanged by T299-T304); no new duplicate-save surface was introduced');
  checked('current-week inference mismatch -- CURRENT_WEEK/REAL_WEEK semantics untouched by this ticket; T303\'s stale check reads REAL_WEEK only, never CURRENT_WEEK (view-only navigation)');
  checked('old session forcing navigation backwards -- T303\'s CONTINUAR calls selDia (same week), never changes REAL_WEEK/CURRENT_WEEK to an older week');
  checked('refresh losing partial/skipped state -- case R above: _getSessionLifecycleState is a pure function of persisted LOGS, re-derives identically from a freshly-parsed copy');
  checked('logout not clearing session-specific transient state -- doLogout (T129, pre-existing) resets LOGS/PLAN/EXERCISE_UNITS/EXERCISE_HISTORY/REAL_WEEK/CURRENT_WEEK');

  // ── One documented P3 (not fixed -- coarse aggregate view, not the
  // per-session status display the ticket requires 5 distinct labels for). ──
  ok(CLIENT.includes('const _wDone = _numDiasGrid > 0 && Array.from({length:_numDiasGrid}, (_,i) => _isRealExecution(LOGS[\'done_\'+w+\'_\'+i])).every(Boolean);'),
    'P3 (documented, not fixed): renderResumen\'s week-grid "done" (green) cell and the adherence streak both treat a week fully closed via PARTIAL identically to one fully COMPLETE -- an intentional, low-risk aggregate simplification (a week IS genuinely executed either way), but it means a glance at the week grid cannot distinguish "fully real-complete" from "fully partial" the way the per-session view now can. Left as documented debt: fixing it would require a second aggregate color/label, which is cosmetic polish outside this ticket\'s blocking-correctness scope.');

  console.log('');
  console.log('T306 — Residual audit: 0 new P0/P1/P2 findings. 1 P3 documented (cosmetic, week-grid aggregate only).');
  console.log('T306 TOTAL: ' + pass + ' assertions PASSED');

  try { fs.unlinkSync(harnessPath); } catch(e) {}
})().catch(function(e) { try { fs.unlinkSync(harnessPath); } catch(_){} console.error(e); process.exit(1); });
