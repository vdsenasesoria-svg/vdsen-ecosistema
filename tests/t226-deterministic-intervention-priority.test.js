'use strict';
/**
 * T226 — Deterministic intervention priority: extends T180's
 * _rankClientPriority (not a parallel system) with a 5th tier
 * (URGENT_REVIEW, safety/pain split out of NEEDS_REVIEW) and an optional
 * 3rd param (prescriptionEffectiveness.overall, T221) -- fully backward
 * compatible with every existing 2-arg call site and test (see
 * tests/t180-client-priority-ranking.test.js, unmodified except for the
 * one PAIN_REVIEW assertion this ticket intentionally changes).
 *
 * Core Principle: SAFETY MUST ALWAYS OUTRANK PERFORMANCE. No numeric
 * score, no new clinical threshold -- purely a combination of existing
 * deterministic states.
 *
 * Run: node tests/t226-deterministic-intervention-priority.test.js
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
const rankSrc = extractFunction(COACH, 'function _rankClientPriority(attnState, weeklyStatus, effectivenessOverall)');
ok(rankSrc, '_rankClientPriority (extended) extracts cleanly');
const _rankClientPriority = new Function(priorityEnumSrc + ';\nreturn ' + rankSrc + ';')();

// ─────────────────────────────────────────────────────────────────────────────
// URGENT_REVIEW — pure safety/pain, outranks everything.
// ─────────────────────────────────────────────────────────────────────────────

(function testUrgentReview() {
  ok(_rankClientPriority('STABLE', 'PAIN_REVIEW') === 'URGENT_REVIEW', 'weeklyStatus PAIN_REVIEW -> URGENT_REVIEW');
  ok(_rankClientPriority('STABLE', null, 'SAFETY_REVIEW') === 'URGENT_REVIEW', 'prescriptionEffectiveness.overall SAFETY_REVIEW -> URGENT_REVIEW');
  ok(_rankClientPriority('REVIEW', 'PAIN_REVIEW') === 'URGENT_REVIEW', 'PAIN_REVIEW outranks even an unresolved coach-review attnState -- safety always wins');
  ok(_rankClientPriority('PROGRESSING', 'COACH_REVIEW', 'SAFETY_REVIEW') === 'URGENT_REVIEW', 'SAFETY_REVIEW outranks an otherwise-clean COACH_REVIEW read');
})();

// ─────────────────────────────────────────────────────────────────────────────
// NEEDS_REVIEW — unresolved coach review, or repeated under-response under
// adequate adherence/confidence (T221).
// ─────────────────────────────────────────────────────────────────────────────

(function testNeedsReview() {
  ok(_rankClientPriority('STABLE', 'COACH_REVIEW') === 'NEEDS_REVIEW', 'COACH_REVIEW (no pain) -> NEEDS_REVIEW, not URGENT_REVIEW');
  ok(_rankClientPriority('STABLE', 'STABLE', 'TOLERATED_BUT_UNDER_RESPONDING') === 'NEEDS_REVIEW', 'TOLERATED_BUT_UNDER_RESPONDING -> NEEDS_REVIEW even when attnState/weeklyStatus both look clean');
})();

// ─────────────────────────────────────────────────────────────────────────────
// WATCH — recovery/adherence/performance limitation, or a recovery cost
// alongside an otherwise-positive response.
// ─────────────────────────────────────────────────────────────────────────────

(function testWatch() {
  ok(_rankClientPriority('STABLE', 'RECOVERY_LIMITED') === 'WATCH', 'RECOVERY_LIMITED (not severe enough to be REVIEW) -> WATCH');
  ok(_rankClientPriority('STABLE', 'STABLE', 'EFFECTIVE_BUT_COSTLY') === 'WATCH', 'EFFECTIVE_BUT_COSTLY -> WATCH, a positive response still merits a watchful eye given the recovery cost');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CORE PRINCIPLE — safety always outranks performance, checked exhaustively:
// no combination of a positive/effective signal can ever suppress a safety
// signal.
// ─────────────────────────────────────────────────────────────────────────────

(function testSafetyAlwaysOutranksPerformance() {
  const positiveContexts = ['REVIEW', 'PROGRESSING', 'STABLE', 'NO_DATA'];
  const positiveWeekly = [null, 'PROGRESSING', 'STABLE', 'COACH_REVIEW', 'RECOVERY_LIMITED'];
  const positiveEffectiveness = [null, 'EFFECTIVE_TOLERATED', 'TOLERATED_BUT_UNDER_RESPONDING'];
  let checked = 0;
  positiveContexts.forEach(a => positiveWeekly.forEach(w => positiveEffectiveness.forEach(e => {
    checked++;
    ok(_rankClientPriority(a, 'PAIN_REVIEW', e) === 'URGENT_REVIEW', 'PAIN_REVIEW always wins regardless of attnState=' + a + '/effectiveness=' + e);
  })));
  ok(checked === positiveContexts.length * positiveWeekly.length * positiveEffectiveness.length, 'exhaustive safety-precedence sweep ran every combination');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Backward compatibility: every existing 2-arg call site behaves unchanged
// (verified by re-running T180's own suite, which asserts this directly).
// ─────────────────────────────────────────────────────────────────────────────

(function testBackwardCompatible2ArgCalls() {
  ok(_rankClientPriority('PROGRESSING', 'PROGRESSING') === 'ON_TRACK', '2-arg call (no effectiveness) still resolves exactly as before');
  ok(_rankClientPriority('NO_DATA', null) === 'INSUFFICIENT_DATA', '2-arg call for insufficient data still resolves exactly as before');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No numeric score, no invented threshold.
// ─────────────────────────────────────────────────────────────────────────────

ok(!rankSrc.includes('score') && !/\d\.\d/.test(rankSrc), 'no numeric precision score anywhere in the extended function');
ok(priorityEnumSrc.includes('URGENT_REVIEW') && priorityEnumSrc.includes('NEEDS_REVIEW') && priorityEnumSrc.includes('WATCH') && priorityEnumSrc.includes('ON_TRACK') && priorityEnumSrc.includes('INSUFFICIENT_DATA'),
  'CLIENT_PRIORITY now carries exactly the 5 categorical states this ticket asks for');

console.log('');
console.log('T226 — Deterministic intervention priority: ' + pass + ' assertions PASSED');
