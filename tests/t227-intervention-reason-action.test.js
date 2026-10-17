'use strict';
/**
 * T227 — Intervention reason/action classification. For a given T226
 * priority and the SAME already-computed signals, names the primary
 * reason, up to 3 supporting reasons, and ONE recommended review category
 * (SAFETY_REVIEW/RECOVERY_REVIEW/ADHERENCE_REVIEW/PROGRESSION_REVIEW/
 * PRESCRIPTION_REVIEW/MESOCYCLE_REVIEW/DATA_REVIEW/NO_ACTION). Purely
 * explanatory -- never edits the plan, never gives medical advice.
 *
 * Run: node tests/t227-intervention-reason-action.test.js
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

const priorityEnumSrc = COACH.slice(COACH.indexOf('var CLIENT_PRIORITY = {'), COACH.indexOf('function _rankClientPriority'));
const actionEnumSrc   = COACH.slice(COACH.indexOf('var INTERVENTION_ACTION = {'), COACH.indexOf('function _computeInterventionReasonAction'));
const reasonSrc        = extractFunction(COACH, 'function _computeInterventionReasonAction(priority, input)');
ok(reasonSrc, '_computeInterventionReasonAction extracts cleanly');
const _computeInterventionReasonAction = new Function(priorityEnumSrc + ';\n' + actionEnumSrc + ';\nreturn ' + reasonSrc + ';')();

ok(COACH.includes('window._computeInterventionReasonAction = _computeInterventionReasonAction;'), 'exposed for reuse elsewhere in the Coach app (Monitor, Generator)');

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY_REVIEW for URGENT_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testUrgentReviewMapsToSafety() {
  const result = _computeInterventionReasonAction('URGENT_REVIEW', { attnReasons: [{ code: 'PAIN', label: 'Dolor articular reportado' }] });
  ok(result.primaryReason === 'safety_signal', 'URGENT_REVIEW -> primaryReason safety_signal');
  ok(result.action === 'SAFETY_REVIEW', 'URGENT_REVIEW -> action SAFETY_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// NEEDS_REVIEW branches.
// ─────────────────────────────────────────────────────────────────────────────

(function testNeedsReviewCoachReview() {
  const result = _computeInterventionReasonAction('NEEDS_REVIEW', { weeklyStatus: 'COACH_REVIEW' });
  ok(result.primaryReason === 'unresolved_coach_review' && result.action === 'PRESCRIPTION_REVIEW', 'NEEDS_REVIEW from COACH_REVIEW -> unresolved_coach_review / PRESCRIPTION_REVIEW');
})();

(function testNeedsReviewUnderResponding() {
  const result = _computeInterventionReasonAction('NEEDS_REVIEW', { effectiveness: { overall: 'TOLERATED_BUT_UNDER_RESPONDING' } });
  ok(result.primaryReason === 'under_responding_despite_adherence' && result.action === 'PRESCRIPTION_REVIEW', 'NEEDS_REVIEW from TOLERATED_BUT_UNDER_RESPONDING -> PRESCRIPTION_REVIEW');
})();

(function testNeedsReviewRecoveryFromAttnReasons() {
  const result = _computeInterventionReasonAction('NEEDS_REVIEW', { attnReasons: [{ code: 'DELOAD_CANDIDATE', label: 'Señales de fatiga acumulada' }, { code: 'TOO_HARD_REPEATED', label: 'Esfuerzo demasiado alto repetido' }] });
  ok(result.primaryReason === 'recovery_limited' && result.action === 'RECOVERY_REVIEW', 'NEEDS_REVIEW example (T229 spec): recovery limited + repeated freeze-like signals -> RECOVERY_REVIEW');
  ok(result.supportingReasons.length === 2 && result.supportingReasons.indexOf('Señales de fatiga acumulada') !== -1, 'supporting reasons carry the real attnReasons labels');
})();

// ─────────────────────────────────────────────────────────────────────────────
// WATCH branches.
// ─────────────────────────────────────────────────────────────────────────────

(function testWatchAdherence() {
  const result = _computeInterventionReasonAction('WATCH', { weeklyStatus: 'ADHERENCE_LIMITED' });
  ok(result.primaryReason === 'adherence_limited' && result.action === 'ADHERENCE_REVIEW', 'CASE D-style: WATCH from ADHERENCE_LIMITED -> ADHERENCE_REVIEW, never PRESCRIPTION_REVIEW ("not a bad program")');
})();

(function testWatchRecoveryCost() {
  const result = _computeInterventionReasonAction('WATCH', { effectiveness: { overall: 'EFFECTIVE_BUT_COSTLY' } });
  ok(result.primaryReason === 'recovery_cost' && result.action === 'RECOVERY_REVIEW', 'WATCH from EFFECTIVE_BUT_COSTLY -> recovery_cost / RECOVERY_REVIEW');
})();

(function testWatchMesocycleRenewal() {
  const result = _computeInterventionReasonAction('WATCH', { mesocycleAction: 'RENEW_MINIMAL' });
  ok(result.primaryReason === 'mesocycle_renewal_pending' && result.action === 'MESOCYCLE_REVIEW', 'CASE I: mesocycle renewal pending on an otherwise-stable client -> MESOCYCLE_REVIEW, not an urgent escalation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// INSUFFICIENT_DATA and ON_TRACK.
// ─────────────────────────────────────────────────────────────────────────────

(function testInsufficientData() {
  const result = _computeInterventionReasonAction('INSUFFICIENT_DATA', {});
  ok(result.primaryReason === 'insufficient_data' && result.action === 'DATA_REVIEW', 'INSUFFICIENT_DATA -> DATA_REVIEW, never a treatment/plan action');
})();

(function testOnTrack() {
  const result = _computeInterventionReasonAction('ON_TRACK', {});
  ok(result.primaryReason === 'on_track' && result.action === 'NO_ACTION', 'ON_TRACK -> NO_ACTION');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Never edits the plan, never gives medical/treatment advice.
// ─────────────────────────────────────────────────────────────────────────────

ok(!reasonSrc.includes('updateDoc') && !reasonSrc.includes('setDoc'), '_computeInterventionReasonAction never writes to Firestore -- pure explanation, no auto-edit');
ok(!/mg|dosis|farmac|medicamento/i.test(reasonSrc), 'no medical/pharmacological treatment advice anywhere in the function');

console.log('');
console.log('T227 — Intervention reason/action classification: ' + pass + ' assertions PASSED');
