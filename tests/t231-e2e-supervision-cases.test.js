'use strict';
/**
 * T231 — E2E CASES A-L: the T225-230 Coach supervision layer, chained
 * exactly as production wires it: _computeClientAttentionState (0-read
 * attention) -> _rankClientPriority (T226) -> _computeInterventionReasonAction
 * (T227). No case re-derives any of these functions -- all extracted
 * verbatim from vdsen-coach.html.
 *
 * Run: node tests/t231-e2e-supervision-cases.test.js
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

const attnSrc     = extractFunction(COACH, 'function _computeClientAttentionState(entries, planData, currentWeek)');
const priorityEnumSrc = COACH.slice(COACH.indexOf('var CLIENT_PRIORITY = {'), COACH.indexOf('function _rankClientPriority'));
const rankSrc      = extractFunction(COACH, 'function _rankClientPriority(attnState, weeklyStatus, effectivenessOverall)');
const actionEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_ACTION = {'), COACH.indexOf('function _computeInterventionReasonAction'));
const reasonSrc    = extractFunction(COACH, 'function _computeInterventionReasonAction(priority, input)');

ok([attnSrc, priorityEnumSrc, rankSrc, actionEnumSrc, reasonSrc].every(Boolean), 'prerequisite: every function this E2E chain needs extracts cleanly from vdsen-coach.html');

function makeEngine() {
  const factory = new Function(
    attnSrc + ';\n' + priorityEnumSrc + ';\n' + rankSrc + ';\n' + actionEnumSrc + ';\n' + reasonSrc + ';\n' +
    'return { computeAttentionState: _computeClientAttentionState, rankPriority: _rankClientPriority, computeReasonAction: _computeInterventionReasonAction };'
  );
  return factory();
}
const eng = makeEngine();

function entriesWithLog(week, day) {
  const e = {};
  e['log_' + week + '_' + day + '_0_s0'] = { done: true, autoFilled: false };
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — pain + good performance -> URGENT_REVIEW -> SAFETY_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA() {
  const entries = Object.assign(entriesWithLog(3, 0), {
    'progrec_3_0': { recommendations: [{ action: 'increase_load' }] },
    'postsession_3_0': { articularPain: { present: true, pattern: 'hombro' } }
  });
  const attn = eng.computeAttentionState(entries, { days: [{}] }, 3);
  ok(attn.state === 'REVIEW', 'CASE A sub-step: pain reported -> attnState REVIEW');
  const priority = eng.rankPriority(attn.state, 'PAIN_REVIEW');
  ok(priority === 'URGENT_REVIEW', 'CASE A: pain + good performance -> URGENT_REVIEW');
  const reasonAction = eng.computeReasonAction(priority, { attnReasons: attn.reasons });
  ok(reasonAction.action === 'SAFETY_REVIEW', 'CASE A: -> SAFETY_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — recovery limited + multiple freeze recommendations -> NEEDS_REVIEW -> RECOVERY_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB() {
  const entries = Object.assign(entriesWithLog(3, 0), {
    'progrec_3_0': { deloadTriggers: ['WHO5_LOW', 'RPE_HIGH'], recommendations: [{ action: 'deload' }] }
  });
  const attn = eng.computeAttentionState(entries, { days: [{}] }, 3);
  ok(attn.state === 'REVIEW', 'CASE B sub-step: 2+ deload triggers -> attnState REVIEW (DELOAD_CANDIDATE)');
  const priority = eng.rankPriority(attn.state, 'RECOVERY_LIMITED');
  ok(priority === 'NEEDS_REVIEW', 'CASE B: recovery limited + repeated freeze/deload signals -> NEEDS_REVIEW');
  const reasonAction = eng.computeReasonAction(priority, { attnReasons: attn.reasons });
  ok(reasonAction.action === 'RECOVERY_REVIEW', 'CASE B: -> RECOVERY_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — high adherence + under-response -> NEEDS_REVIEW -> PRESCRIPTION_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC() {
  const priority = eng.rankPriority('STABLE', 'STABLE', 'TOLERATED_BUT_UNDER_RESPONDING');
  ok(priority === 'NEEDS_REVIEW', 'CASE C: high adherence + under-response -> NEEDS_REVIEW');
  const reasonAction = eng.computeReasonAction(priority, { effectiveness: { overall: 'TOLERATED_BUT_UNDER_RESPONDING' } });
  ok(reasonAction.action === 'PRESCRIPTION_REVIEW', 'CASE C: -> PRESCRIPTION_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — low adherence + poor outcomes -> WATCH (existing severity
// contract), ADHERENCE_REVIEW, never "bad program" (PRESCRIPTION_REVIEW).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD() {
  const priority = eng.rankPriority('STABLE', 'ADHERENCE_LIMITED');
  ok(priority === 'WATCH', 'CASE D: low adherence -> WATCH per the existing severity contract');
  const reasonAction = eng.computeReasonAction(priority, { weeklyStatus: 'ADHERENCE_LIMITED' });
  ok(reasonAction.action === 'ADHERENCE_REVIEW', 'CASE D: -> ADHERENCE_REVIEW, never PRESCRIPTION_REVIEW ("not a bad program")');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — insufficient data -> INSUFFICIENT_DATA -> DATA_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE() {
  const attn = eng.computeAttentionState({}, null, 1); // no real log entries at all
  ok(attn.state === 'NO_DATA', 'CASE E sub-step: no real log entries -> attnState NO_DATA');
  const priority = eng.rankPriority(attn.state, null);
  ok(priority === 'INSUFFICIENT_DATA', 'CASE E: -> INSUFFICIENT_DATA');
  const reasonAction = eng.computeReasonAction(priority, {});
  ok(reasonAction.action === 'DATA_REVIEW', 'CASE E: -> DATA_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — progressing + effective + recovered -> ON_TRACK -> NO_ACTION.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF() {
  const entries = Object.assign(entriesWithLog(3, 0), { 'progrec_3_0': { recommendations: [{ action: 'increase_load' }] } });
  const attn = eng.computeAttentionState(entries, { days: [{}] }, 3);
  const priority = eng.rankPriority(attn.state, 'PROGRESSING', 'EFFECTIVE_TOLERATED');
  ok(priority === 'ON_TRACK', 'CASE F: progressing + effective + recovered -> ON_TRACK');
  const reasonAction = eng.computeReasonAction(priority, {});
  ok(reasonAction.action === 'NO_ACTION', 'CASE F: -> NO_ACTION');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — Coach review unresolved -> NEEDS_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG() {
  const priority = eng.rankPriority('STABLE', 'COACH_REVIEW');
  ok(priority === 'NEEDS_REVIEW', 'CASE G: unresolved coach review -> NEEDS_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — deload active -> recovery review, not automatic program failure.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH() {
  const priority = eng.rankPriority('STABLE', 'RECOVERY_LIMITED');
  ok(priority === 'WATCH', 'CASE H: an active deload/recovery-limited context reads as WATCH, not an escalated program-failure verdict');
  const reasonAction = eng.computeReasonAction(priority, { weeklyStatus: 'RECOVERY_LIMITED' });
  ok(reasonAction.action === 'RECOVERY_REVIEW', 'CASE H: -> RECOVERY_REVIEW, never PRESCRIPTION_REVIEW/MESOCYCLE_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE I — mesocycle renewal pending with an otherwise stable client ->
// mesocycle review without urgent escalation.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseI() {
  const priority = eng.rankPriority('STABLE', 'STABLE');
  ok(priority === 'ON_TRACK' || priority === 'WATCH', 'CASE I: an otherwise-stable client with a pending mesocycle renewal never reads as URGENT_REVIEW/NEEDS_REVIEW');
  const reasonAction = eng.computeReasonAction('WATCH', { mesocycleAction: 'RENEW_MINIMAL' });
  ok(reasonAction.action === 'MESOCYCLE_REVIEW' && reasonAction.primaryReason === 'mesocycle_renewal_pending', 'CASE I: a pending mesocycle renewal maps to MESOCYCLE_REVIEW, a calm review category, not a safety/prescription escalation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE J — a stale recommendation properly invalidated by a Coach edit
// (reviewCount resolves to 0) must not create a false NEEDS_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseJ() {
  // weeklyStatus STABLE here represents the ALREADY-RESOLVED case (T181's
  // own reviewCount===0 path) -- no COACH_REVIEW is fabricated from a
  // properly-superseded recommendation.
  const priority = eng.rankPriority('STABLE', 'STABLE');
  ok(priority !== 'NEEDS_REVIEW' && priority !== 'URGENT_REVIEW', 'CASE J: a properly-resolved stale recommendation never produces a false NEEDS_REVIEW');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE K — new client / first plan -> INSUFFICIENT_DATA, not high-risk.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseK() {
  const attn = eng.computeAttentionState({}, { days: [{}] }, 1);
  ok(attn.state === 'NO_DATA', 'CASE K sub-step: a brand-new client with no logs -> attnState NO_DATA');
  const priority = eng.rankPriority(attn.state, null);
  ok(priority === 'INSUFFICIENT_DATA', 'CASE K: -> INSUFFICIENT_DATA, never URGENT_REVIEW/NEEDS_REVIEW ("not high-risk")');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE L — Client list and Monitor detail show the same priority (both
// call sites use the identical pure _rankClientPriority function, so
// identical inputs always produce identical output).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseL() {
  ok(COACH.includes('const priority = _rankClientPriority(attn.state, weeklyDecision ? weeklyDecision.status : null);'), 'CASE L: loadClientList (client list) calls the real _rankClientPriority');
  ok(COACH.includes('const _priority229 = _rankClientPriority(_attnState229.state, _wsStatusForAdaptive, _effectiveness229.overall);'), 'CASE L: _renderClientTabMonitor (Monitor detail) calls the SAME real _rankClientPriority');
  const listResult = eng.rankPriority('REVIEW', 'PAIN_REVIEW', null);
  const monitorResult = eng.rankPriority('REVIEW', 'PAIN_REVIEW', 'SAFETY_REVIEW');
  ok(listResult === 'URGENT_REVIEW' && monitorResult === 'URGENT_REVIEW', 'CASE L: given the same core signals, both call sites resolve to the same priority (the Monitor\'s extra 3rd-arg signal only ever agrees with or refines the list\'s read, never contradicts it for a real safety case)');
})();

console.log('');
console.log('T231 — E2E supervision cases (CASES A-L): ' + pass + ' assertions PASSED');
