'use strict';
/**
 * T308 — Canonical Home ("Hoy") state resolver: _getTodayHomeState.
 *
 * Pure projection of _getSessionLifecycleState -- no second state engine.
 * Finds the day the client should act on (first NOT_STARTED/IN_PROGRESS in
 * `week`, else falls back to the last day once the week is fully resolved)
 * and derives label/primaryAction/progress/flags entirely from the
 * canonical lifecycle, fixing T307's FINDING 1 (no more raw done_ checks,
 * no more a single hardcoded CTA regardless of state).
 *
 * Run: node tests/t308-today-home-state.test.js
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

const src = [
  'function _getSessionCompletionState(doneEntry) {',
  'function _sessionHasRealLoggedSets(logs, week, di) {',
  'function _getSessionLifecycleState(logs, week, di) {',
  'function _getSessionLifecycleLabel(logs, week, di) {',
  'function _calcSessionStats(logs, di, week) {',
  'function _getTodayHomeState(logs, week, sesiones) {',
].map(function(decl) { return extractFunction(CLIENT, decl); }).join('\n');
const labelsMapIdx = CLIENT.indexOf('var _SESSION_LIFECYCLE_LABELS = {');
const labelsMapSrc = CLIENT.slice(labelsMapIdx, CLIENT.indexOf('};', labelsMapIdx) + 2);

const fn = new Function(
  'function isTechniqueActive(ej, week) { return true; }\n' +
  src.replace('function _getSessionLifecycleLabel(logs, week, di) {', labelsMapSrc + '\nfunction _getSessionLifecycleLabel(logs, week, di) {') +
  '\nreturn { _getTodayHomeState, _getSessionLifecycleState };'
);
const { _getTodayHomeState } = fn();

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }
function eq(actual, expected, msg) { assert.strictEqual(actual, expected, msg + ' (got ' + JSON.stringify(actual) + ')'); pass++; console.log('  ✓ ' + msg); }

function ses(n, numSeries) {
  var exs = [];
  for (var i = 0; i < n; i++) exs.push({ nombre: 'Ej' + i, numSeries: numSeries });
  return { dia: 'DIA', exercises: exs };
}
const W = 3;
const sesiones3 = [ses(1,3), ses(1,3), ses(1,3)];

// 1. No plan / no sessions -> a safe, non-blank fallback state
{
  const st = _getTodayHomeState({}, W, []);
  eq(st.dayIndex, -1, 'T308-1: no sessions -> dayIndex -1');
  eq(st.primaryAction.code, 'VIEW_PLAN', 'T308-1: no-plan fallback action is VIEW_PLAN, never a fabricated START');
}

// 2. Everything NOT_STARTED -> day 0, START
{
  const st = _getTodayHomeState({}, W, sesiones3);
  eq(st.dayIndex, 0, 'T308-2: first day picked when nothing is touched');
  eq(st.lifecycle, 'NOT_STARTED', 'T308-2: lifecycle NOT_STARTED');
  eq(st.primaryAction.code, 'START', 'T308-2: primary action START');
  ok(st.canStart && !st.canResume && !st.canReview, 'T308-2: canStart true, canResume/canReview false');
}

// 3. Real set logged on day 0, no done_ -> IN_PROGRESS, CONTINUE
{
  var logs = {}; logs['log_'+W+'_0_0_s0'] = { done: true, ts: Date.now() };
  const st = _getTodayHomeState(logs, W, sesiones3);
  eq(st.dayIndex, 0, 'T308-3: still day 0');
  eq(st.lifecycle, 'IN_PROGRESS', 'T308-3: lifecycle IN_PROGRESS');
  eq(st.primaryAction.code, 'CONTINUE', 'T308-3: primary action CONTINUE');
  eq(st.progress.completedSets, 1, 'T308-3: progress reflects the one real logged set');
}

// 4. Day 0 PARTIAL -> Home moves to day 1 (PARTIAL is a resolved closure)
{
  var logs = { ['done_'+W+'_0']: { ts: Date.now(), partial: true } };
  const st = _getTodayHomeState(logs, W, sesiones3);
  eq(st.dayIndex, 1, 'T308-4: a PARTIAL day 0 is resolved -- Home advances to day 1, never stuck showing day 0 as still-pending');
  eq(st.lifecycle, 'NOT_STARTED', 'T308-4: day 1 itself is untouched');
}

// 5. Day 0 PARTIAL alone, asked directly -> label/action would be RESUME
// (verified via the same resolver called with that day's own index context)
{
  var logs = { ['done_'+W+'_0']: { ts: Date.now(), partial: true } };
  // Force all 3 days to appear PARTIAL so the resolver's fallback (last day) lands on one.
  logs['done_'+W+'_1'] = { ts: Date.now(), partial: true };
  logs['done_'+W+'_2'] = { ts: Date.now(), partial: true };
  const st = _getTodayHomeState(logs, W, sesiones3);
  eq(st.dayIndex, 2, 'T308-5: week fully resolved via PARTIAL -> falls back to the last day');
  eq(st.lifecycle, 'PARTIAL', 'T308-5: lifecycle PARTIAL');
  eq(st.primaryAction.code, 'RESUME', 'T308-5: primary action RESUME, never a fresh START (would discard logged work)');
  eq(st.weekFullyResolved, true, 'T308-5: weekFullyResolved true');
  eq(st.isToday, false, 'T308-5: isToday false once the week has nothing left to act on');
}

// 6. All days COMPLETE -> FINDING 1's exact repro case: never "ENTRENAR AHORA"
{
  var logs = {};
  for (var i = 0; i < 3; i++) logs['done_'+W+'_'+i] = { ts: Date.now() };
  const st = _getTodayHomeState(logs, W, sesiones3);
  eq(st.lifecycle, 'COMPLETE', 'T308-6: lifecycle COMPLETE');
  eq(st.primaryAction.code, 'VIEW', 'T308-6: primary action VIEW -- FINDING 1 fixed, no more fake "start again"');
  ok(!st.canStart && !st.canResume && st.canReview, 'T308-6: canStart/canResume false, canReview true');
}

// 7. All days SKIPPED -> honest SKIPPED state, never disguised as pending
{
  var logs = {};
  for (var i = 0; i < 3; i++) logs['done_'+W+'_'+i] = { ts: Date.now(), skipped: true };
  const st = _getTodayHomeState(logs, W, sesiones3);
  eq(st.lifecycle, 'SKIPPED', 'T308-7: lifecycle SKIPPED');
  eq(st.primaryAction.code, 'VIEW_SKIPPED', 'T308-7: primary action VIEW_SKIPPED, never ENTRENAR AHORA / START');
  eq(st.label, 'Omitida', 'T308-7: natural Spanish label, never a raw enum');
}

// 8. Mixed week: day 0 SKIPPED, day 1 COMPLETE, day 2 untouched -> lands on day 2
{
  var logs = { ['done_'+W+'_0']: { ts: Date.now(), skipped: true }, ['done_'+W+'_1']: { ts: Date.now() } };
  const st = _getTodayHomeState(logs, W, sesiones3);
  eq(st.dayIndex, 2, 'T308-8: correctly skips past resolved days (SKIPPED and COMPLETE alike) to the next actionable one');
  eq(st.lifecycle, 'NOT_STARTED', 'T308-8: day 2 is NOT_STARTED');
}

console.log('');
console.log('T308 — Today Home state: ' + pass + ' assertions PASSED');
