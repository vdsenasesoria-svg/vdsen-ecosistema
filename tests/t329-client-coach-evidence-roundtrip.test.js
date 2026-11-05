'use strict';
/**
 * T329 — Client -> Coach evidence round-trip.
 *
 * REAL CROSS-APP BUG FOUND AND FIXED: the Client's "TERMINAR POR HOY" (T301,
 * a prior ticket) introduced done_{w}_{d} = {ts, partial:true}, but nothing
 * in vdsen-coach.html was ever taught to recognize it. Three independent
 * coach-side classifiers fell through to their "real complete" default for
 * a partial entry (it has a real .ts and isn't `skipped`):
 *   1. _getSessionCompletionState (feeds _sessionExecutionRatio/adherence
 *      classification) -- had no `partial` branch at all.
 *   2. The Coach Monitor's per-day heatmap grid -- rendered a partial
 *      closure as a solid green "✓ Completa" cell.
 *   3. _buildClientMirrorExecutionState -- its `sessionDone` also didn't
 *      exclude `skipped`, so an explicit SKIP was ALSO showing as
 *      "✓ COMPLETADA" in the client-detail day badge, in addition to the
 *      same PARTIAL-as-COMPLETE bug.
 * All three fixed to match the Client's own canonical classification.
 *
 * Also verified already-correct (per two research passes this run):
 *  - autoFilled sets excluded from real execution everywhere in the
 *    canonical decision path (T325 additionally closed two report/
 *    confidence-score gaps outside the canonical path).
 *  - prescribed (rir) vs observed (rir_real) RIR kept separate.
 *  - skipped sessions excluded from execution evidence (ratio forced to 0
 *    for SKIPPED/AUTO_CLOSED_NO_DATA).
 *  - adherence math (aggregateClientLogs) already correctly counts a
 *    partial/autoClosed entry as real adherence (its own exclusion list
 *    only nets out SKIPPED and AUTO_CLOSED_NO_DATA, not partial).
 *  - week/day/PID addressing is exact (log_{W}_{D}_{E}_sS, matched by
 *    prescriptionExerciseId/exerciseId/position in
 *    _buildClientMirrorExecutionState).
 *  - nutrilog date / check-in week keys are exact, per-client-doc (no
 *    duplicate-write risk -- every write is a single Firestore document
 *    field, not an appended log).
 *
 * Run: node tests/t329-client-coach-evidence-roundtrip.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
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

// ── Fix 1: _getSessionCompletionState now mirrors the Client's own branch. ──
const coachStateSrc = extractFunction(COACH, 'function _getSessionCompletionState(doneEntry) {');
ok(coachStateSrc.includes('if (doneEntry.partial) return \'PARTIAL\';'), 'Coach _getSessionCompletionState now recognizes the Client\'s partial:true flag');
// Functional proof: run the real extracted function against real inputs.
{
  const fn = new Function(coachStateSrc + '\nreturn _getSessionCompletionState;')();
  assert.strictEqual(fn({ ts: 1, partial: true }), 'PARTIAL', 'a partial entry classifies as PARTIAL, not REAL_COMPLETE');
  assert.strictEqual(fn({ ts: 1 }), 'REAL_COMPLETE', 'a genuine completion still classifies correctly');
  assert.strictEqual(fn({ ts: 1, skipped: true }), 'SKIPPED', 'a skip still classifies correctly');
  pass += 3; console.log('  ✓ functional: PARTIAL/REAL_COMPLETE/SKIPPED all classify correctly from the real extracted function');
}
// Confirm the Client's own classifier has the identical branch (parity, not just presence).
const clientStateSrc = extractFunction(CLIENT, 'function _getSessionCompletionState(doneEntry) {');
ok(clientStateSrc.includes('if (doneEntry.partial) return \'PARTIAL\';'), 'the Client\'s own classifier has the matching branch -- the two apps now agree');

// ── Fix 2: Coach Monitor heatmap no longer shows PARTIAL as a green checkmark. ──
const heatmapIdx = COACH.indexOf("const _doneEntry = entries['done_'+w+'_'+d];");
const heatmapSlice = COACH.slice(heatmapIdx, heatmapIdx + 1800);
ok(heatmapSlice.includes('const isPartialClosed = !!(_doneEntry && typeof _doneEntry === \'object\' && !_doneEntry.skipped && (_doneEntry.partial || _doneEntry.autoClosed));'),
  'the heatmap now computes isPartialClosed explicitly');
ok(heatmapSlice.includes('&& !isPartialClosed);'), 'the heatmap\'s "done" (green ✓) computation explicitly excludes a partial closure');
ok(heatmapSlice.includes('(hasAny||isPartialClosed) ? \'rgba(196,255,0,.5)\''), 'a partial closure renders in the same lime "◐ Parcial" bucket already used for in-progress sessions -- distinct from both green (complete) and grey (skipped)');

// ── Fix 3: _buildClientMirrorExecutionState splits sessionDone/sessionSkipped/sessionPartial. ──
const mirrorSrc = extractFunction(COACH, 'function _buildClientMirrorExecutionState(plan, logs, week) {');
ok(mirrorSrc.includes('var sessionSkipped = !!(_doneIsObj && doneEntry.skipped && !doneEntry.autoClosed);'), 'sessionSkipped is now a distinct, correctly-scoped flag');
ok(mirrorSrc.includes('var sessionPartial = !!(_doneIsObj && !doneEntry.skipped && (doneEntry.partial || doneEntry.autoClosed));'), 'sessionPartial is now a distinct, correctly-scoped flag');
ok(mirrorSrc.includes('var sessionDone = !!(doneEntry === true || (_doneIsObj && doneEntry.ts && !doneEntry.skipped && !sessionPartial));'),
  'sessionDone now explicitly excludes both skipped and partial -- it can only be true for a genuine full completion');
ok(mirrorSrc.includes('sessionSkipped: sessionSkipped, sessionPartial: sessionPartial'), 'both new flags are exposed on the returned dayResult for downstream renderers');

// ── The day-badge render site uses the new flags with correct priority
// (admin > skipped > partial > complete), never falling back to the old
// "any object with .ts" mislabel. ───────────────────────────────────────────
const badgeIdx = COACH.indexOf('var dayExecBadge = \'\';');
const badgeSlice = COACH.slice(badgeIdx, badgeIdx + 1500);
ok(badgeSlice.includes('execDay.sessionSkipped') && badgeSlice.includes('⏸ OMITIDA'), 'the day badge shows an explicit OMITIDA state for a skip, never COMPLETADA');
ok(badgeSlice.includes('execDay.sessionPartial') && badgeSlice.includes('◐ PARCIAL'), 'the day badge shows an explicit PARCIAL state for a partial closure, never COMPLETADA');
ok(badgeSlice.indexOf('sessionSkipped') < badgeSlice.indexOf('sessionDone') && badgeSlice.indexOf('sessionPartial') < badgeSlice.indexOf('sessionDone'),
  'both new checks are ordered BEFORE the sessionDone/COMPLETADA branch -- correct priority');

// ── Already-correct evidence contracts (audit, re-confirmed). ─────────────
const ratioSrc = extractFunction(COACH, 'function _sessionExecutionRatio(doneEntry, progrecEntry) {');
ok(ratioSrc.includes("state === 'SKIPPED' || state === 'AUTO_CLOSED_NO_DATA'") && ratioSrc.includes('return 0;'),
  'SKIPPED/AUTO_CLOSED_NO_DATA are still forced to ratio 0 -- excluded from real execution evidence, unaffected by the PARTIAL fix');
const aggSrc = extractFunction(COACH, 'function aggregateClientLogs(logs, planObj, currentWeek) {');
ok(aggSrc.includes('if (v.skipped && !v.autoClosed) return false;') && !aggSrc.includes("if (v.partial) return false;"),
  'adherence counting already correctly treats a partial/autoClosed entry as real adherence (only SKIPPED/AUTO_CLOSED_NO_DATA are excluded) -- no change needed there');

console.log('');
console.log('T329 — Client->Coach evidence round-trip: ' + pass + ' assertions PASSED. 3 real cross-app PARTIAL/SKIPPED misclassification bugs found and fixed.');
