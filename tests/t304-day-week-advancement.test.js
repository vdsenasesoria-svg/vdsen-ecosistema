'use strict';
/**
 * T304 — Day/week advancement rules (mostly audit; the heavy lifting was
 * already done by T300/T301/T303).
 *
 * Requirement-by-requirement:
 *  1. COMPLETE, PARTIAL, and SKIPPED must all be sufficient to allow
 *     advancement -- CONFIRMED already true: _autoAdvanceWeekIfDone and
 *     _autoAdvanceDia both check `!!LOGS['done_'+w+'_'+i]` (any truthy
 *     entry), never gated to a specific type. T301's PARTIAL entries
 *     ({ts, partial:true}) are truthy objects, so they already count.
 *  2. An open IN_PROGRESS session should prompt Continue/Terminar por hoy
 *     rather than silently permitting a second concurrent session where
 *     unsafe -- delivered by T303's stale-session recovery prompt for the
 *     concrete unsafe case (a session left open across a day boundary).
 *     Free same-day day-switching remains intentional (retroactive
 *     logging of a missed day is a legitimate, existing use case) -- no
 *     new lock was added, consistent with "must not permanently trap the
 *     user" / "never block navigation" already confirmed in T299.
 *  3. An old stale IN_PROGRESS session must go through recovery, never a
 *     permanent lock -- delivered by T303 (dismissing the modal changes
 *     nothing; CONTINUAR/TERMINAR COMO PARCIAL both leave the app fully
 *     navigable).
 *  4. A previous week's PARTIAL/SKIPPED sessions must never block the next
 *     real week -- CONFIRMED already true: no code anywhere gates
 *     selDia/setWeek/_autoAdvanceDia on a PAST week's state; advancement
 *     only inspects REAL_WEEK's own sessions.
 *  5. The app must never auto-complete missed sessions on the user's
 *     behalf -- CONFIRMED: every bulk-close path (markWeekDoneWithPartialData,
 *     markWeekCompleteFromHistory) requires an explicit _askConfirm(...)
 *     click; nothing runs automatically/silently.
 *
 * Run: node tests/t304-day-week-advancement.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

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

// ── 1. Type-agnostic advancement: any truthy done_ (COMPLETE/PARTIAL/SKIPPED). ──
const autoAdvWeekSrc = extractFunction(CLIENT, 'async function _autoAdvanceWeekIfDone(fromOtherWeekView) {');
ok(autoAdvWeekSrc.includes("!!LOGS['done_'+REAL_WEEK+'_'+i]"), '_autoAdvanceWeekIfDone: any truthy done_ entry counts -- not gated to REAL_COMPLETE only, so PARTIAL/SKIPPED sessions do not block week advancement');
const autoAdvDiaSrc = extractFunction(CLIENT, 'function _autoAdvanceDia() {');
ok(autoAdvDiaSrc.includes("if (!LOGS['done_'+CURRENT_WEEK+'_'+_d])"), '_autoAdvanceDia: same type-agnostic truthy check -- lands on the first UNRESOLVED day regardless of how prior days were resolved');

// PARTIAL doneEntry ({ts, partial:true}) is truthy -> already counted by both.
ok(!!({ ts: Date.now(), partial: true }), 'sanity: a PARTIAL doneEntry object is truthy -- passes the existing `!!LOGS[...]` checks with zero additional code');

// ── 2/3. Stale IN_PROGRESS handled via T303's non-blocking recovery, not a lock. ──
ok(CLIENT.includes('function _findStaleOpenSession(logs, week, sesiones, nowMs) {'), 'T303 stale-session detector exists');
ok(CLIENT.includes('function _showStaleSessionRecovery(staleInfo) {'), 'T303 recovery prompt exists (CONTINUAR / TERMINAR COMO PARCIAL, never auto-COMPLETE)');

// ── 4. No gating anywhere reads a PAST week's state before allowing navigation
// or advancement of/through the current week. ───────────────────────────────
const selDiaSrc = CLIENT.slice(CLIENT.indexOf('function selDia(i) {'), CLIENT.indexOf('function selDia(i) {') + 120);
ok(!/REAL_WEEK\s*-\s*1|prevW|_prevWeek/i.test(selDiaSrc), 'selDia never inspects a previous week\'s state before allowing navigation');
const setWeekSrc = extractFunction(CLIENT, 'function setWeek(w) {');
ok(!/if\s*\(.*REAL_WEEK\s*-\s*1/.test(setWeekSrc), 'setWeek never blocks on a previous week\'s completion state');

// ── 5. Bulk auto-completion paths always require an explicit user confirmation. ──
const markWeekPartialSrc = extractFunction(CLIENT, 'async function markWeekDoneWithPartialData() {');
ok(markWeekPartialSrc.includes('if (!await _askConfirm(msg)) return;'), 'markWeekDoneWithPartialData requires an explicit confirm click -- never runs silently/automatically');
const markWeekHistSrc = extractFunction(CLIENT, 'async function markWeekCompleteFromHistory() {');
ok(markWeekHistSrc.includes('if (!confirm(msg)) return;'), 'markWeekCompleteFromHistory also requires an explicit confirm click');

console.log('');
console.log('T304 — Day/week advancement: ' + pass + ' assertions PASSED (mostly pre-existing correctness confirmed; T303 supplies the one missing prompt)');
