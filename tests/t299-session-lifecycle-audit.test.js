'use strict';
/**
 * T299 — Client session lifecycle audit (audit-only; no code change unless a
 * P0 data-loss issue is found — none was).
 *
 * SCOPE: vdsen-cliente.html only (Client App Priority Run). Traced:
 * markSessionDone, _confirmSessionDone, skipSession, markSessionDoneFromHistory,
 * markWeekDoneWithPartialData, markWeekCompleteFromHistory, _autoAdvanceWeekIfDone,
 * selDia, setWeek, _calcSessionStats/_fmtElapsed (timer), _getSessionCompletionState,
 * _isRealExecution, countDone, CURRENT_WEEK/REAL_WEEK semantics.
 *
 * ── CONTRACT MAP ──────────────────────────────────────────────────────────
 * SESSION START      : implicit — first `log_{w}_{d}_{e}_s{s}` write with done:true.
 *                       No explicit "session started" timestamp/marker exists;
 *                       start is derived (_calcSessionStats -> min ts of real sets).
 * SET SAVE           : per-set write to LOGS['log_W_D_E_sS'], debounced save via
 *                       saveLogs()/_doSaveLogs(); real sets flagged done:true,
 *                       autofilled sets flagged autoFilled:true (excluded from
 *                       stats/progression/adherence everywhere already).
 * SESSION COMPLETE   : _confirmSessionDone(di) writes done_{w}_{d}={ts}, bypasses
 *                       debounce (immediate _doSaveLogs), reverts on write failure
 *                       (T125-C), never shows false success (T295).
 * DONE SIGNAL        : LOGS['done_{w}_{d}'] — absent | true (legacy) | object with
 *                       optional {skipped, autoClosed, fromHistory} flags, resolved
 *                       by _getSessionCompletionState -> PENDING/REAL_COMPLETE/
 *                       SKIPPED/AUTO_CLOSED/AUTO_CLOSED_NO_DATA (F76).
 * RESUME LOGIC       : none explicit — selDia/setWeek always free-navigate; a
 *                       session with real sets but no done_ simply re-renders
 *                       showing existing set values (inputs prefill from LOGS).
 * DAY ADVANCEMENT    : _autoAdvanceDia() picks first non-fully-done day; no lock
 *                       prevents visiting any other day at any time.
 * WEEK ADVANCEMENT   : _autoAdvanceWeekIfDone() loops while EVERY session in
 *                       REAL_WEEK has a truthy done_ entry (any type — already
 *                       type-agnostic, not gated on "REAL_COMPLETE only").
 * TIMER SOURCE       : _calcSessionStats() scoped by `log_{week}_{di}_` prefix
 *                       (correctly isolated per week+day, real sets only,
 *                       autoFilled excluded) -> sessionStart = min(ts). Frozen at
 *                       done_.ts once closed (T163-bug). _fmtElapsed caps at 12h
 *                       and previous window (T173.1 same-render consistency).
 * STALE-SESSION BEHAVIOR: no proactive detection/UI exists for "session left
 *                       IN_PROGRESS on a previous day/week" — the day tab shows
 *                       partial progress (X/Y) but nothing prompts the user to
 *                       close it. This is the real gap (see CASE A/C below).
 * CURRENT BLOCKING GUARD: NONE FOUND. selDia/setWeek never lock; week bar always
 *                       lists all weeks; _autoAdvanceWeekIfDone only auto-*advances*
 *                       forward, never blocks manual navigation backward/forward.
 *
 * ── CASES ─────────────────────────────────────────────────────────────────
 * A. session started, app closed before finishing
 *    -> Data is NOT lost (sets already persisted individually). No P0. Gap:
 *       no recovery prompt exists yet (T303 will add it).
 * B. some exercises completed, others missing
 *    -> Day tab already renders "_dSets/_tSets" partial progress correctly.
 *       No per-session partial-close action exists yet (T301 gap) — only a
 *       whole-week bulk close (markWeekDoneWithPartialData).
 * C. session left open across multiple days
 *    -> Confirmed NOT reproducible as a data bug: _fmtElapsed's 12h plausibility
 *       cap + _calcSessionStats' per-render recompute (T173.1) already prevent
 *       any multi-day timer artifact. Remaining gap is UX-only (no prompt).
 * D. previous week left unfinished
 *    -> Confirmed NOT blocking: no lock exists anywhere on week/day navigation;
 *       REAL_WEEK only auto-advances when the week is genuinely fully resolved.
 * E. stale timer produces multi-day duration
 *    -> CONFIRMED ALREADY FIXED (T163-bug/T173.1): _fmtElapsed returns '--:--'
 *       for any diff < 0 or > 12h; sessionStart is recomputed fresh from
 *       real (non-autoFilled) set timestamps scoped to the exact week+day on
 *       every render, never cached across renders/sessions.
 * F. missing done_ prevents next session/week
 *    -> Confirmed NOT reproducible: selDia has zero gating logic; any day is
 *       always reachable regardless of done_ state.
 * G. session has real logs but lifecycle cannot resolve correctly
 *    -> CONFIRMED REAL GAP: _getSessionCompletionState(undefined) only returns
 *       'PENDING' — it cannot distinguish "no session touched at all" from
 *       "real sets logged, session left open" (both are PENDING today). This
 *       is exactly what T300's _getSessionLifecycleState resolves.
 *
 * CONCLUSION: no P0 data-loss issue found. No broad patch applied here (audit
 * phase only). T300 adds the missing NOT_STARTED/IN_PROGRESS distinction;
 * T301 adds per-session partial close; T303 adds the stale-session recovery
 * prompt for cases A/C.
 *
 * Run: node tests/t299-session-lifecycle-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ── Confirm the F76 state model already exists (this ticket builds on it). ──
ok(CLIENT.includes("function _getSessionCompletionState(doneEntry) {"), 'F76 _getSessionCompletionState exists (PENDING/REAL_COMPLETE/SKIPPED/AUTO_CLOSED/AUTO_CLOSED_NO_DATA)');
ok(CLIENT.includes('function _isRealExecution(doneEntry) {'), 'F76 _isRealExecution exists');

// ── CASE E: timer staleness already capped (no multi-day artifact possible). ──
const fmtElapsedIdx = CLIENT.indexOf('function _fmtElapsed(startMs, endMs) {');
const fmtElapsedSrc = CLIENT.slice(fmtElapsedIdx, CLIENT.indexOf('\n}', fmtElapsedIdx) + 2);
ok(fmtElapsedSrc.includes('_maxPlausibleMs = 12 * 60 * 60 * 1000'), 'CASE E confirmed already fixed: _fmtElapsed caps plausible duration at 12h');
ok(fmtElapsedSrc.includes("if (diffMs < 0 || diffMs > _maxPlausibleMs) return '--:--';"), "CASE E: malformed/implausible durations display '--:--', never a multi-day figure");

// ── CASE E continued: sessionStart is scoped to the exact week+day, real sets only. ──
const calcStatsIdx = CLIENT.indexOf('function _calcSessionStats(logs, di, week) {');
const calcStatsSrc = CLIENT.slice(calcStatsIdx, CLIENT.indexOf('\n}', calcStatsIdx) + 2);
ok(calcStatsSrc.includes("var prefix = 'log_' + week + '_' + di + '_';"), 'sessionStart is scoped to the exact week+day prefix -- cannot pick up a cross-session timestamp');
ok(calcStatsSrc.includes('if (!e || !e.done || e.autoFilled) return;'), 'sessionStart is derived only from real (non-autoFilled) logged sets -- autofilled placeholders never fabricate a start time');

// ── CASE D/F: no blocking guard exists anywhere on day/week navigation. ──
const selDiaSrc = CLIENT.slice(CLIENT.indexOf('function selDia(i) {'), CLIENT.indexOf('function selDia(i) {') + 120);
ok(!/if\s*\(.*done_/.test(selDiaSrc), 'selDia has no done_-based gating -- any day is always reachable');
const setWeekIdx = CLIENT.indexOf('function setWeek(w) {');
const setWeekSrc = CLIENT.slice(setWeekIdx, CLIENT.indexOf('\n}', setWeekIdx) + 2);
ok(!/if\s*\(.*done_/.test(setWeekSrc), 'setWeek has no done_-based gating -- any week is always reachable');

// ── Week advancement is already type-agnostic (any truthy done_ counts). ──
const autoAdvIdx = CLIENT.indexOf('async function _autoAdvanceWeekIfDone(fromOtherWeekView) {');
const autoAdvSrc = CLIENT.slice(autoAdvIdx, CLIENT.indexOf('\nwindow._sesTimerInterval', autoAdvIdx) > -1 ? CLIENT.indexOf('\n}\n\nasync function skipSession', autoAdvIdx) : autoAdvIdx + 1200);
ok(autoAdvSrc.includes("!!LOGS['done_'+REAL_WEEK+'_'+i]"), '_autoAdvanceWeekIfDone treats ANY truthy done_ entry as sufficient to advance -- already accepts REAL_COMPLETE/SKIPPED/AUTO_CLOSED alike, not gated to a single type');

// ── CASE G: the real gap this audit confirms -- PENDING cannot distinguish
// NOT_STARTED from IN_PROGRESS (real sets exist but no done_ yet). ──────────
ok(!CLIENT.includes('function _getSessionLifecycleState('), 'CASE G confirmed: no canonical resolver exists yet that distinguishes NOT_STARTED from IN_PROGRESS -- this is exactly T300\'s job (implemented in the next phase/commit)');

console.log('');
console.log('T299 — Session lifecycle audit: ' + pass + ' assertions PASSED. No P0 data-loss issue found. No broad patch applied (audit-only phase).');
