'use strict';
/**
 * T300 — Canonical Client session lifecycle resolver: _getSessionLifecycleState.
 *
 * Single pure, deterministic reader for Client session state. Reuses the
 * existing F76 _getSessionCompletionState contract (PENDING/REAL_COMPLETE/
 * SKIPPED/AUTO_CLOSED/AUTO_CLOSED_NO_DATA) and extends it with a new PARTIAL
 * branch (doneEntry.partial === true, for T301's per-session close), then
 * maps everything onto the ticket's canonical 5-state model:
 *   NOT_STARTED | IN_PROGRESS | COMPLETE | PARTIAL | SKIPPED
 *
 * No Firestore write inside the resolver -- it is a pure function of a plain
 * LOGS object + week + day index. No schema migration: PARTIAL reuses the
 * same done_{w}_{d} document shape, just one more optional boolean flag,
 * exactly like skipped/autoClosed/fromHistory before it.
 *
 * Run: node tests/t300-session-lifecycle-state.test.js
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
const isRealExecutionSrc    = extractFunction(CLIENT, 'function _isRealExecution(doneEntry) {');
const hasRealSetsSrc        = extractFunction(CLIENT, 'function _sessionHasRealLoggedSets(logs, week, di) {');
const getLifecycleSrc       = extractFunction(CLIENT, 'function _getSessionLifecycleState(logs, week, di) {');
const labelSrc              = extractFunction(CLIENT, 'function _getSessionLifecycleLabel(logs, week, di) {');
const labelsMapIdx          = CLIENT.indexOf('var _SESSION_LIFECYCLE_LABELS = {');
const labelsMapSrc          = CLIENT.slice(labelsMapIdx, CLIENT.indexOf('};', labelsMapIdx) + 2);

const fn = new Function(
  getCompletionStateSrc + '\n' + isRealExecutionSrc + '\n' + hasRealSetsSrc + '\n' +
  getLifecycleSrc + '\n' + labelsMapSrc + '\n' + labelSrc + '\n' +
  'return { _getSessionCompletionState, _isRealExecution, _sessionHasRealLoggedSets, _getSessionLifecycleState, _getSessionLifecycleLabel };'
);
const { _getSessionLifecycleState, _getSessionLifecycleLabel, _isRealExecution } = fn();

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }
function eq(actual, expected, msg) { assert.strictEqual(actual, expected, msg + ' (got ' + actual + ', expected ' + expected + ')'); pass++; console.log('  ✓ ' + msg); }

const W = 2, D = 0;
function logsWithDone(doneEntry) {
  var l = {};
  if (doneEntry !== undefined) l['done_' + W + '_' + D] = doneEntry;
  return l;
}

// 1. Nothing at all -> NOT_STARTED
eq(_getSessionLifecycleState({}, W, D), 'NOT_STARTED', 'T300-1: empty LOGS -> NOT_STARTED');

// 2. Real logged set exists, no done_ -> IN_PROGRESS
eq(_getSessionLifecycleState({ ['log_'+W+'_'+D+'_0_s0']: { done: true, carga: '50', reps: '8' } }, W, D),
  'IN_PROGRESS', 'T300-2: real logged set, no done_ -> IN_PROGRESS');

// 3. ONLY an autoFilled set exists, no done_ -> still NOT_STARTED (autofill != executed)
eq(_getSessionLifecycleState({ ['log_'+W+'_'+D+'_0_s0']: { done: true, autoFilled: true, carga: '50' } }, W, D),
  'NOT_STARTED', 'T300-3: only autoFilled set, no done_ -> NOT_STARTED (AUTOFILLED != EXECUTED)');

// 4. Legacy boolean true -> COMPLETE
eq(_getSessionLifecycleState(logsWithDone(true), W, D), 'COMPLETE', 'T300-4: legacy done_=true -> COMPLETE');

// 5. Real completion object {ts} -> COMPLETE
eq(_getSessionLifecycleState(logsWithDone({ ts: Date.now() }), W, D), 'COMPLETE', 'T300-5: done_={ts} (real completion) -> COMPLETE');

// 6. Explicit skip -> SKIPPED
eq(_getSessionLifecycleState(logsWithDone({ ts: Date.now(), skipped: true }), W, D), 'SKIPPED', 'T300-6: done_={skipped:true} -> SKIPPED');

// 7. Week bulk-close, no data (AUTO_CLOSED_NO_DATA) -> SKIPPED
eq(_getSessionLifecycleState(logsWithDone({ ts: Date.now(), autoClosed: true, skipped: true }), W, D),
  'SKIPPED', 'T300-7: autoClosed+skipped (no real data) -> SKIPPED (no fabricated execution)');

// 8. Week bulk-close WITH real data (AUTO_CLOSED, legacy path) -> PARTIAL, not COMPLETE
eq(_getSessionLifecycleState(logsWithDone({ ts: Date.now(), autoClosed: true }), W, D),
  'PARTIAL', 'T300-8: autoClosed with real data -> PARTIAL (PARTIAL != COMPLETE, even via the legacy week-close path)');

// 9. T301 per-session "TERMINAR POR HOY" close -> PARTIAL
eq(_getSessionLifecycleState(logsWithDone({ ts: Date.now(), partial: true }), W, D),
  'PARTIAL', 'T300-9: done_={partial:true} (T301 close) -> PARTIAL');

// 10. Real sets logged in a DIFFERENT day/week must never bleed into this session's IN_PROGRESS check
eq(_getSessionLifecycleState({ ['log_'+W+'_'+(D+1)+'_0_s0']: { done: true }, ['log_'+(W+1)+'_'+D+'_0_s0']: { done: true } }, W, D),
  'NOT_STARTED', 'T300-10: real sets from a DIFFERENT day/week never leak into this session\'s state (correct isolation)');

// Bonus: PARTIAL counts as real execution (next session accessible, week can advance)
ok(_isRealExecution({ ts: Date.now(), partial: true }), 'PARTIAL counts as real execution -- week/day advancement is not blocked by a partial close');

// Bonus: label mapping never exposes raw enum names
eq(_getSessionLifecycleLabel({}, W, D), 'Pendiente', 'label: NOT_STARTED -> "Pendiente" (natural Spanish, not raw enum)');
eq(_getSessionLifecycleLabel(logsWithDone({ ts: Date.now(), partial: true }), W, D), 'Parcial', 'label: PARTIAL -> "Parcial"');
eq(_getSessionLifecycleLabel(logsWithDone({ ts: Date.now(), skipped: true }), W, D), 'Omitida', 'label: SKIPPED -> "Omitida"');
eq(_getSessionLifecycleLabel(logsWithDone({ ts: Date.now() }), W, D), 'Completada', 'label: COMPLETE -> "Completada"');
eq(_getSessionLifecycleLabel({ ['log_'+W+'_'+D+'_0_s0']: { done: true } }, W, D), 'En curso', 'label: IN_PROGRESS -> "En curso"');

console.log('');
console.log('T300 — Canonical session lifecycle state: ' + pass + ' assertions PASSED');
