'use strict';
/**
 * T234 — Coach intervention decision model. One deterministic
 * representation of an explicit Coach decision: {id, status, action,
 * targetType, targetId, reason, decidedAt, decidedBy, sourcePriority,
 * sourceAction, planId, planUpdatedAtSnapshot}. Pure data-shape builder --
 * no Firestore call (T236 persists it). Minimum useful states only.
 *
 * Run: node tests/t234-intervention-decision-model.test.js
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

const statusEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_STATUS = {'), COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'));
const targetEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const actionEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'), COACH.indexOf('function _buildCoachIntervention'));
const genIdSrc = extractFunction(COACH, 'function _genPrescriptionId()');
const buildSrc = extractFunction(COACH, 'function _buildCoachIntervention(input)');
ok([statusEnumSrc, targetEnumSrc, actionEnumSrc, genIdSrc, buildSrc].every(Boolean), 'prerequisite: _buildCoachIntervention and every enum/dependency extract cleanly');

const _buildCoachIntervention = new Function(
  statusEnumSrc + ';\n' + targetEnumSrc + ';\n' + actionEnumSrc + ';\n' + genIdSrc + ';\n' + buildSrc + ';\nreturn _buildCoachIntervention;'
)();

ok(COACH.includes('window._buildCoachIntervention = _buildCoachIntervention;'), 'exposed for reuse in the Monitor workflow (T236) and downstream integration (T237)');

// ─────────────────────────────────────────────────────────────────────────────
// Valid construction.
// ─────────────────────────────────────────────────────────────────────────────

(function testValidIntervention() {
  const result = _buildCoachIntervention({
    targetType: 'EXERCISE', targetId: 'pid-1', action: 'KEEP', reason: 'under_responding_despite_adherence',
    decidedBy: 'coach-uid-1', sourcePriority: 'NEEDS_REVIEW', sourceAction: 'PRESCRIPTION_REVIEW',
    planId: 'plan-1', planUpdatedAtSnapshot: '2026-01-01T00:00:00.000Z'
  });
  ok(result !== null, 'a valid input builds a real record');
  ok(typeof result.id === 'string' && result.id.length > 0, 'a real id is generated');
  ok(result.status === 'OPEN', 'status defaults to OPEN when not specified');
  ok(result.targetType === 'EXERCISE' && result.targetId === 'pid-1', 'targetType/targetId pass through unchanged');
  ok(result.action === 'KEEP', 'action passes through unchanged');
  ok(typeof result.decidedAt === 'string' && result.decidedAt.length > 0, 'decidedAt is auto-stamped when not provided');
  ok(result.decidedBy === 'coach-uid-1', 'decidedBy passes through unchanged');
  ok(result.planId === 'plan-1' && result.planUpdatedAtSnapshot === '2026-01-01T00:00:00.000Z', 'plan scoping fields pass through unchanged, for staleness comparison later');
})();

(function testExplicitStatus() {
  const result = _buildCoachIntervention({ targetType: 'MUSCLE', targetId: 'quads', action: 'ADJUST_VOLUME', status: 'RESOLVED' });
  ok(result.status === 'RESOLVED', 'an explicitly-provided valid status is respected, not forced to OPEN');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Invalid construction: never invents a targetType/action/targetId.
// ─────────────────────────────────────────────────────────────────────────────

(function testInvalidTargetType() {
  ok(_buildCoachIntervention({ targetType: 'NOT_A_REAL_TYPE', targetId: 'x', action: 'KEEP' }) === null, 'an unknown targetType -> null, never guessed');
})();

(function testInvalidAction() {
  ok(_buildCoachIntervention({ targetType: 'CLIENT', targetId: 'client-1', action: 'PRESCRIBE_MEDICATION' }) === null, 'an unrecognized action -> null, never a medical-treatment action invented');
})();

(function testMissingTargetId() {
  ok(_buildCoachIntervention({ targetType: 'CLIENT', action: 'KEEP' }) === null, 'a missing targetId -> null, never defaulted');
})();

(function testInvalidStatusFallsBackToOpen() {
  const result = _buildCoachIntervention({ targetType: 'CLIENT', targetId: 'client-1', action: 'KEEP', status: 'BOGUS' });
  ok(result.status === 'OPEN', 'an invalid status string falls back to the safe OPEN default rather than propagating garbage');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Minimum useful states only -- exactly the enums the ticket asks for, no
// medical/clinical action categories.
// ─────────────────────────────────────────────────────────────────────────────

ok(Object.keys({ OPEN: 1, REVIEWED: 1, RESOLVED: 1 }).every(k => statusEnumSrc.includes(k)), 'exactly the 3 status states the ticket asks for');
['KEEP', 'ADJUST_LOAD', 'ADJUST_REPS', 'ADJUST_VOLUME', 'REDISTRIBUTE_VOLUME', 'SUBSTITUTE_EXERCISE', 'MODIFY_FREQUENCY', 'CONTINUE_MESOCYCLE', 'RENEW_MESOCYCLE', 'PAUSE_FOR_REVIEW', 'NO_CHANGE']
  .forEach(a => ok(actionEnumSrc.includes(a), 'action category ' + a + ' is present'));
ok(!/mg|dosis|farmac|medicamento|treatment/i.test(actionEnumSrc), 'no medical/pharmacological treatment action anywhere in the enum');

// ─────────────────────────────────────────────────────────────────────────────
// Never a Firestore write here -- pure builder, persistence is T236's job.
// ─────────────────────────────────────────────────────────────────────────────

ok(!buildSrc.includes('updateDoc') && !buildSrc.includes('setDoc'), '_buildCoachIntervention never writes to Firestore -- pure data-shape builder');

console.log('');
console.log('T234 — Intervention decision model: ' + pass + ' assertions PASSED');
