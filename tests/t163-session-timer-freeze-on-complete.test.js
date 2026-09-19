'use strict';
/**
 * Bug report (Loreley García's plan): "aunque termine la sesión el tiempo
 * de la sesión sigue corriendo" — the "tiempo" stat cell in the Client
 * Entrenamiento tab kept ticking upward in real time even after the
 * session was marked complete.
 *
 * Root cause: _fmtElapsed(startMs) always computed elapsed against
 * Date.now(), and the live setInterval driving the "_sesTime" element's
 * text was started unconditionally whenever window._sesTimerStart was
 * truthy — with no awareness of LOGS['done_W_D'] at all. Once a session
 * was marked done and _confirmSessionDone()'s renderEntrenamiento() call
 * happened to leave DIA_ACTIVO on that same (now-completed) day — e.g. it
 * was the last pending session of the week, so _autoAdvanceDia() had
 * nowhere to advance to — the dashboard kept showing that day's stats,
 * including a "tiempo" cell that kept climbing forever, because nothing
 * ever told it "the session ended at time X, freeze there."
 *
 * Fix:
 *   1. _fmtElapsed(startMs, endMs) now accepts an optional endMs, using it
 *      instead of Date.now() when provided (backward compatible — existing
 *      single-arg callers, e.g. the rest timer, are unaffected).
 *   2. Both places that build the session dashboard (renderEntrenamiento's
 *      inline block and the lightweight _refreshSessionDashboard) now read
 *      LOGS['done_'+CURRENT_WEEK+'_'+DIA_ACTIVO] and, when present, set
 *      window._sesTimerEnd to its .ts and pass it into _fmtElapsed — so the
 *      initial render already shows the correct, frozen final duration.
 *   3. Both places that start the ticking setInterval now gate on
 *      `!window._sesTimerEnd` — a completed session's timer never starts
 *      ticking again after being frozen.
 *
 * Run: node tests/t163-session-timer-freeze-on-complete.test.js
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

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// _fmtElapsed: real, running function — freezes at endMs when provided.
// ─────────────────────────────────────────────────────────────────────────────

const fmtSrc = extractFunction(CLIENT, 'function _fmtElapsed(startMs, endMs)');
ok(fmtSrc, '_fmtElapsed(startMs, endMs) must exist with the new endMs param');

const _fmtElapsed = new Function('Date', 'return ' + fmtSrc)(Date);

(function testFmtElapsedFreezesAtEndMs() {
  const start = 1000000;
  const fixedEnd = start + 125 * 1000; // 2:05 elapsed
  const withEnd = _fmtElapsed(start, fixedEnd);
  ok(withEnd === '02:05', '_fmtElapsed(start, end) computes the fixed duration between the two, not against the real clock');

  // Calling it again "later" (simulate time passing) with the SAME endMs must
  // return the exact same string — this IS the freeze behavior.
  const stillFrozen = _fmtElapsed(start, fixedEnd);
  ok(stillFrozen === withEnd, '_fmtElapsed(start, end) is deterministic/frozen — repeated calls with the same end never grow');
})();

(function testFmtElapsedBackwardCompatible() {
  const start = Date.now() - 5000;
  const live = _fmtElapsed(start); // no endMs -> falls back to Date.now(), as before
  ok(/^\d{2}:0[4-6]$/.test(live), '_fmtElapsed(start) with no endMs still falls back to Date.now() (backward compatible, e.g. rest timer callers)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural: both dashboard builders compute window._sesTimerEnd from the
// done_ entry and pass it into _fmtElapsed for the initial render.
// ─────────────────────────────────────────────────────────────────────────────

(function testDoneEntryDrivesTimerEnd() {
  ok(
    CLIENT.includes("var _sesDoneEntry = LOGS['done_'+CURRENT_WEEK+'_'+DIA_ACTIVO];\n    window._sesTimerEnd = (_sesDoneEntry && _sesDoneEntry.ts) ? _sesDoneEntry.ts : null;"),
    'renderEntrenamiento: window._sesTimerEnd is derived from the done_ entry\'s timestamp'
  );
  ok(
    CLIENT.includes("_statCell('<span id=\"_sesTime\">' + _fmtElapsed(_sesStats.sessionStart, window._sesTimerEnd) + '</span>', 'tiempo', 'var(--tx)') +"),
    'renderEntrenamiento: the initial "tiempo" cell render passes window._sesTimerEnd into _fmtElapsed'
  );
  ok(
    CLIENT.includes("var _sesDoneEntry = LOGS['done_'+CURRENT_WEEK+'_'+DIA_ACTIVO];\n  window._sesTimerEnd = (_sesDoneEntry && _sesDoneEntry.ts) ? _sesDoneEntry.ts : null;"),
    '_refreshSessionDashboard: window._sesTimerEnd is derived from the done_ entry\'s timestamp too'
  );
  ok(
    CLIENT.includes("_statCell('<span id=\"_sesTime\">' + _fmtElapsed(window._sesTimerStart, window._sesTimerEnd) + '</span>', 'tiempo', 'var(--tx)') +"),
    '_refreshSessionDashboard: the "tiempo" cell render passes window._sesTimerEnd into _fmtElapsed'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural: both places that START the ticking interval are gated on
// !window._sesTimerEnd — a completed session's clock never resumes ticking.
// ─────────────────────────────────────────────────────────────────────────────

(function testIntervalNeverStartsWhenDone() {
  ok(
    CLIENT.includes('if (window._sesTimerStart && !window._sesTimerEnd) {\n    if (window._sesTimerInterval) { clearInterval(window._sesTimerInterval); window._sesTimerInterval = null; }\n    function _updateSesTimer() {'),
    'renderEntrenamiento: the live-tick setInterval is only created when the session is NOT done (!window._sesTimerEnd)'
  );
  ok(
    CLIENT.includes('if (window._sesTimerStart && !window._sesTimerEnd) {\n    window._sesTimerInterval = setInterval(function() {'),
    '_refreshSessionDashboard: the live-tick setInterval is only created when the session is NOT done (!window._sesTimerEnd)'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral, end-to-end via a minimal harness mirroring the real gating
// logic exactly (extracted conditions, not reimplemented blind).
// ─────────────────────────────────────────────────────────────────────────────

function simulateDashboardBuild(LOGS, CURRENT_WEEK, DIA_ACTIVO, sessionStart) {
  const win = {};
  win._sesTimerStart = sessionStart;
  const _sesDoneEntry = LOGS['done_'+CURRENT_WEEK+'_'+DIA_ACTIVO];
  win._sesTimerEnd = (_sesDoneEntry && _sesDoneEntry.ts) ? _sesDoneEntry.ts : null;
  const displayed = _fmtElapsed(win._sesTimerStart, win._sesTimerEnd);
  const willStartInterval = !!(win._sesTimerStart && !win._sesTimerEnd);
  return { displayed: displayed, willStartInterval: willStartInterval, timerEnd: win._sesTimerEnd };
}

(function testEndToEndActiveSession() {
  const start = Date.now() - 60000; // started 1 min ago
  const res = simulateDashboardBuild({}, 3, 0, start);
  ok(res.willStartInterval === true, 'Active (not done) session: the live interval WOULD start (correct — the stopwatch should keep ticking while training)');
})();

(function testEndToEndCompletedSession() {
  const start = Date.now() - 600000; // started 10 min ago
  const doneAt = start + 480000; // finished after 8 minutes of actual training
  const LOGS = { 'done_3_0': { ts: doneAt } };
  const res = simulateDashboardBuild(LOGS, 3, 0, start);
  ok(res.willStartInterval === false, 'Bug fix — a completed session (done_ entry present) never starts the live-ticking interval');
  ok(res.displayed === '08:00', 'Bug fix — the displayed time freezes at the REAL session duration (8:00), not whatever has elapsed since it started');
})();

console.log('');
console.log('T163-bug — session timer freezes on completion: ' + pass + ' assertions PASSED');
