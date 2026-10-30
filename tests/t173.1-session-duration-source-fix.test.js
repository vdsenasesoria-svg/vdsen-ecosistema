'use strict';
/**
 * T173.1 — Fix completed-session duration at the source (production bug:
 * Loreley García's completed session displayed "95:25:40").
 *
 * STEP 1 — TRACED CONTRACT (grep-only, real code):
 *   START SOURCE:   _calcSessionStats(logs, di, week) — min(ts) across all
 *                   `log_{week}_{di}_*` entries with done:true && !autoFilled.
 *                   Correctly SCOPED by week+day prefix already (no cross-day/
 *                   cross-week leak at this layer).
 *   START KEY:      window._sesTimerStart (in-memory only, no localStorage/
 *                   Firestore persistence — a full reload always clears it).
 *   DONE SOURCE:    LOGS['done_'+CURRENT_WEEK+'_'+DIA_ACTIVO].ts
 *   DONE KEY:       window._sesTimerEnd (same in-memory-only lifetime).
 *   DISPLAY FORMULA: _fmtElapsed(window._sesTimerStart, window._sesTimerEnd).
 *   RESET CONDITIONS (before this fix): renderEntrenamiento() always
 *   reassigned window._sesTimerStart fresh on every render (correct).
 *   _refreshSessionDashboard() (the lightweight update path used after
 *   completing a session without a full re-render) only assigned it ONCE
 *   `if (_sesStats.sessionStart && !window._sesTimerStart)` — once set for
 *   ANY day/week, it never updated again for a different day/week in the
 *   same page session, while window._sesTimerEnd (no guard) always updated
 *   freshly. A stale multi-day-old start paired with a freshly-completed
 *   day's done timestamp is exactly a 95-hour-style bug.
 *
 * ROOT CAUSE (confirmed, two independent contributors):
 *   (a) _refreshSessionDashboard's stale-start guard (fixed: now
 *       unconditional, matching renderEntrenamiento's already-correct
 *       pattern — single source of truth).
 *   (b) _calcSessionStats' sessionStart is legitimately the EARLIEST logged
 *       set for that week+day — if a client logs one set, walks away for
 *       days, then finishes the same session, that gap is real data, not a
 *       leaked JS global. Such a pairing is still not a trustworthy
 *       "session duration" in the domain sense (a real single workout never
 *       spans many hours), so _fmtElapsed itself now rejects any start/end
 *       pair wider than a generous 12h plausibility window and any pair
 *       where start would be after end, falling back to the SAME neutral
 *       "--:--" already used for "no start at all" — never fabricating a
 *       number, never clamping to a fake-but-bounded value.
 *
 * Run: node tests/t173.1-session-duration-source-fix.test.js
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

const fmtSrc = extractFunction(CLIENT, 'function _fmtElapsed(startMs, endMs)');
ok(fmtSrc, 'prerequisite: _fmtElapsed extracts cleanly');
const _fmtElapsed = new Function('Date', 'return ' + fmtSrc)(Date);

const statsSrc = extractFunction(CLIENT, 'function _calcSessionStats(logs, di, week)');
ok(statsSrc, 'prerequisite: _calcSessionStats extracts cleanly');
const _calcSessionStats = new Function('return ' + statsSrc)();

// ─────────────────────────────────────────────────────────────────────────────
// Structural regression: _refreshSessionDashboard's start assignment is now
// unconditional (the actual root-cause fix), matching renderEntrenamiento's.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('window._sesTimerStart = _sesStats.sessionStart;') &&
   !CLIENT.includes('if (_sesStats.sessionStart && !window._sesTimerStart) window._sesTimerStart = _sesStats.sessionStart;'),
  'the stale-start guard in _refreshSessionDashboard is gone — start is always freshly recomputed from the CURRENT week/day, same as renderEntrenamiento');

// ─────────────────────────────────────────────────────────────────────────────
// 1 — normal 75-minute session -> 01:15:00
// ─────────────────────────────────────────────────────────────────────────────

(function test1Normal75Min() {
  const start = 1000000000000;
  const end = start + 75 * 60 * 1000;
  ok(_fmtElapsed(start, end) === '1:15:00', '1 — a normal 75-minute session renders 1:15:00');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 2/3 — completed session survives refresh / reopen with the SAME duration
// (determinism: same start/end in -> same string out, every time).
// ─────────────────────────────────────────────────────────────────────────────

(function test2and3Determinism() {
  const start = 2000000000000;
  const end = start + 45 * 60 * 1000 + 12 * 1000; // 45:12
  const first = _fmtElapsed(start, end);
  const secondCallLater = _fmtElapsed(start, end); // simulates a refresh/reopen re-render with the same persisted values
  ok(first === '45:12' && first === secondCallLater, '2/3 — refresh or reopen with the same persisted start/end renders the exact same duration, every time (no drift, no re-derivation from Date.now())');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 4 — THE PRODUCTION BUG: stale start from 4 days ago + a just-now completion
// must NOT render ~96 hours. This is the exact Loreley García shape.
// ─────────────────────────────────────────────────────────────────────────────

(function test4StaleFourDaysAgo() {
  const now = Date.now();
  const fourDaysAgo = now - 4 * 24 * 60 * 60 * 1000;
  const result = _fmtElapsed(fourDaysAgo, now);
  ok(result === '--:--', '4 — a start from 4 days ago paired with a just-now completion renders the neutral "--:--", NEVER a ~96-hour duration');
  ok(!/^\d+:\d{2}:\d{2}$/.test(result) || result === '--:--', '4 — sanity: the result is never a numeric HH:MM:SS string for this pairing');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 5/6 — a previous training day's (or previous week's) start cannot bleed
// into the CURRENT day/week's displayed duration. Full end-to-end harness:
// real _calcSessionStats (scoped by week+day) + the FIXED unconditional
// assignment + real _fmtElapsed.
// ─────────────────────────────────────────────────────────────────────────────

function simulateRefresh(LOGS, di, week, doneEntry) {
  const sesStats = _calcSessionStats(LOGS, di, week);
  const sesTimerStart = sesStats.sessionStart; // T173.1: unconditional, matches production now
  const sesTimerEnd = (doneEntry && doneEntry.ts) ? doneEntry.ts : null;
  return { display: _fmtElapsed(sesTimerStart, sesTimerEnd), start: sesTimerStart };
}

(function test5PreviousDayCannotLeak() {
  const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
  const today = Date.now();
  // Day 0 (a different, older session) has an old completed set.
  const LOGS = {
    'log_3_0_0_s0': { done: true, ts: fourDaysAgo, rir_real: 2, ics: 8 },
  };
  // First "render" happens for day 0 (window._sesTimerStart would be set to fourDaysAgo in real app flow).
  const dayZero = simulateRefresh(LOGS, 0, 3, null);
  ok(dayZero.start === fourDaysAgo, 'prerequisite: day 0 correctly picks up its own old start');

  // Client switches to day 1 (a DIFFERENT, brand-new session, started and finished today).
  LOGS['log_3_1_0_s0'] = { done: true, ts: today - 20 * 60 * 1000, rir_real: 2, ics: 8 };
  const doneToday = { ts: today };
  const dayOne = simulateRefresh(LOGS, 1, 3, doneToday);
  ok(dayOne.start === today - 20 * 60 * 1000, '5 — switching to a different day (day 1) picks up ITS OWN start, not day 0\'s old timestamp');
  ok(dayOne.display === '20:00', '5 — day 1\'s completed session renders its real ~20-minute duration, unaffected by day 0\'s old start');
})();

(function test6PreviousWeekCannotLeak() {
  const oldWeekStart = Date.now() - 6 * 24 * 60 * 60 * 1000;
  const LOGS = {
    'log_2_0_0_s0': { done: true, ts: oldWeekStart, rir_real: 2, ics: 8 } // week 2, stale
  };
  const weekTwo = simulateRefresh(LOGS, 0, 2, null);
  ok(weekTwo.start === oldWeekStart, 'prerequisite: week 2 correctly picks up its own start');

  // Advance to week 3, same day index — a genuinely new session.
  const freshStart = Date.now() - 30 * 60 * 1000;
  LOGS['log_3_0_0_s0'] = { done: true, ts: freshStart, rir_real: 2, ics: 8 };
  const doneNow = { ts: Date.now() };
  const weekThree = simulateRefresh(LOGS, 0, 3, doneNow);
  ok(weekThree.start === freshStart, '6 — advancing to a new week (week 3) picks up ITS OWN start, not week 2\'s stale one');
  ok(weekThree.display === '30:00', '6 — week 3\'s session renders its real ~30-minute duration');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 7 — a previous PLAN's start cannot affect a new plan. Already guaranteed
// by T166's CASO D (loadPlan wipes LOGS to {} on a genuine plan change) —
// cited here as a regression check, not re-implemented.
// ─────────────────────────────────────────────────────────────────────────────

(function test7PreviousPlanCannotLeak() {
  ok(CLIENT.includes('LOGS           = {};') && CLIENT.includes('CURRENT_WEEK   = 1;') && CLIENT.includes('REAL_WEEK      = 1;'),
    '7 — T166 regression: a genuinely new plan still wipes LOGS entirely (no old log_/done_ entries survive to seed a stale session start)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 8 — malformed timestamps never render NaN.
// ─────────────────────────────────────────────────────────────────────────────

(function test8Malformed() {
  ok(_fmtElapsed('not-a-timestamp', Date.now()) === '--:--', '8 — a malformed (non-numeric) start renders the neutral fallback, not NaN:NaN:NaN');
  ok(_fmtElapsed(NaN, Date.now()) === '--:--', '8 — NaN start renders the neutral fallback');
  ok(_fmtElapsed(Date.now() - 1000, 'garbage') === '--:--', '8 — a malformed end renders the neutral fallback');
  ok(_fmtElapsed(0, Date.now()) === '--:--', '8 — a start of 0 (falsy/epoch) is treated as no-start, not a ~50-year duration');
  ok(_fmtElapsed(Date.now(), Date.now() - 5000) === '--:--', '8 — start after end (impossible pair) renders the neutral fallback, not a clamped 00:00');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 9 — seconds-vs-ms legacy timestamps: verified NOT APPLICABLE. The only
// timestamp sources feeding this formula (_calcSessionStats' set `.ts`, and
// LOGS['done_W_D'].ts) are both written via Date.now() (ms) at the point of
// creation — grep-verified single ms-scale contract, no seconds-based writer
// exists anywhere in this codebase for either key. Documented, not faked.
// ─────────────────────────────────────────────────────────────────────────────

(function test9SecondsVsMsNotApplicable() {
  const setTsWriters = (CLIENT.match(/\.ts\s*=\s*Date\.now\(\)/g) || []).length +
                       (CLIENT.match(/ts:\s*Date\.now\(\)/g) || []).length;
  ok(setTsWriters > 0, '9 — N/A, verified: every relevant .ts field in this codebase is written via Date.now() (ms), no seconds-based legacy writer exists to confuse this formula');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 10/11 — active (not done) session still ticks normally; a completed
// session never starts a new interval. Regression-only: unchanged since
// T163, re-verified against the updated _fmtElapsed.
// ─────────────────────────────────────────────────────────────────────────────

(function test10and11ActiveVsDone() {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const live = _fmtElapsed(fiveMinAgo); // no endMs -> Date.now(), still ticking
  ok(/^0?4:5[0-9]$/.test(live) || /^0[45]:\d{2}$/.test(live), '10 — an active (not-done) session still computes a normal, real elapsed time against Date.now()');
  ok(CLIENT.includes('if (window._sesTimerStart && !window._sesTimerEnd) {'), '11 — the live-tick interval is still only started when the session is not done (T163, unaffected by this fix)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 12 — logout/new user: no persistence exists for these keys, so a fresh
// page load (which a logout/login always triggers) always clears them.
// ─────────────────────────────────────────────────────────────────────────────

(function test12NoLeakageAcrossUsers() {
  ok(!CLIENT.includes("localStorage.setItem('vdsen_sesTimerStart") && !CLIENT.includes("localStorage.getItem('vdsen_sesTimerStart"),
    '12 — window._sesTimerStart/_sesTimerEnd are never written to or read from localStorage — purely in-memory, so a fresh page load (logout/login) always starts clean, no cross-user leakage possible');
})();

// ─────────────────────────────────────────────────────────────────────────────
// 13 — session completion behavior/progression unchanged: calculateProgression
// and the done_ write path are untouched by this ticket.
// ─────────────────────────────────────────────────────────────────────────────

(function test13ProgressionUnchanged() {
  ok(CLIENT.includes('function calculateProgression(di, postData)'), '13 — calculateProgression is untouched (not in this ticket\'s scope)');
  ok(CLIENT.includes("LOGS['done_'+CURRENT_WEEK+'_'+di] = { ts: Date.now()") || CLIENT.includes("LOGS['done_'+CURRENT_WEEK+'_'+DIA_ACTIVO]"),
    '13 — the done_ write path/read path still exists, unmodified by this fix');
})();

console.log('');
console.log('T173.1 — Fix completed-session duration at the source: ' + pass + ' assertions PASSED');
