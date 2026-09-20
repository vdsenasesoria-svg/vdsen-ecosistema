'use strict';
/**
 * T200 — Residual audit of CURRENT MESOCYCLE -> CHECKPOINT -> DECISION ->
 * GENERATOR -> NEXT MESOCYCLE -> LEARNED STATE.
 *
 * FINDING #1 (P2, fixed): _computeMesocycleDecisionForRequest had no guard
 * for planDoc being absent. A brand-new client's very first plan generation
 * (no previous plan, no logs) would get mesocycleDecision.action ===
 * COACH_REVIEW (falling through weeklyStatus DATA_INSUFFICIENT) — but
 * that's wrong: there is no mesocycle to transition FROM yet, this is a
 * first-ever generation, not "insufficient evidence for a renewal
 * decision". The prompt's own COACH_REVIEW rule ("limitate a mantener lo
 * ya prescrito") makes no sense with nothing ever prescribed. Fixed:
 * returns null (the prompt already anticipates this — "si esta presente").
 *
 * FINDING #2 (P2, fixed): the Coach Monitor's T198 card had no equivalent
 * guard — it would render a "Decisión de mesociclo" verdict even for a
 * client with logs but no active plan (p === null), same root issue as
 * Finding #1. Fixed: the whole block is now gated on `p` (the active plan)
 * being present, mirroring the Generator-side fix.
 *
 * No other P0/P1/P2 found:
 *   - CHECKPOINT detection (getClientAlert's mesoEnd, _isMesocycleCheckpoint)
 *     already correctly non-authoritative (pure notification/label).
 *   - DECISION priority order (safety > coach > recovery > adjustments >
 *     continue/renew-tie-break) verified correct via T192-197's own 21-item
 *     CASE A-H suite, unaffected by this fix.
 *   - GENERATOR: mesocycleDecision remains purely additive; prompt already
 *     phrases it as "si esta presente", so null is a valid, anticipated state.
 *   - LEARNED STATE: progressionHistory/PID identity unchanged, reused as-is.
 *
 * Run: node tests/t200-mesocycle-residual-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

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
// Finding #1 — structural + behavioral.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('if (!planDoc) return null;'), 'Finding #1: _computeMesocycleDecisionForRequest returns null when no previous plan exists (no mesocycle to transition from)');

const computeSrc = extractFunction(COACH, 'function _computeMesocycleDecisionForRequest(logsResult, planDoc, weeklyDecision, adaptivePrescription)');
ok(computeSrc, '_computeMesocycleDecisionForRequest extracts cleanly');
const decideSrc = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
const _computeMesocycleDecisionForRequest = new Function(decideSrc + ';\n' + computeSrc + ';\nreturn _computeMesocycleDecisionForRequest;')();

(function testFirstEverGenerationReturnsNull() {
  const result = _computeMesocycleDecisionForRequest({ progressionHistory: { byPrescriptionExerciseId: {} } }, null, null, null);
  ok(result === null, 'a brand-new client with no previous plan gets mesocycleDecision === null, never a fabricated COACH_REVIEW verdict');
})();

(function testRenewalWithPlanStillWorks() {
  const logsResult = { trainingLogs: { currentWeek: 3 }, progressionHistory: { byPrescriptionExerciseId: {
    'pid-1': { history: [{ week: 1, action: 'increase_load' }, { week: 2, action: 'increase_load' }] }
  }}};
  const planDoc = { weeks: 6, days: [] };
  const result = _computeMesocycleDecisionForRequest(logsResult, planDoc, { status: 'PROGRESSING' }, { muscleDecisions: {} });
  ok(result !== null && result.action === 'CONTINUE', 'a genuine renewal (planDoc present) still produces a real verdict, unaffected by the new guard');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Finding #2 — structural.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("if (p && typeof window.VDSEN_MESOCYCLE !== 'undefined' && typeof window.VDSEN_BUILD !== 'undefined') {"),
  "Finding #2: the Coach Monitor's mesocycle-decision card is gated on the active plan (p) being present, not just the classifier being loaded");

console.log('');
console.log('T200 — Mesocycle lifecycle residual audit: ' + pass + ' assertions PASSED');
