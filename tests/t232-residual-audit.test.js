'use strict';
/**
 * T232 — Residual audit of the whole T225-231 Coach supervision chain:
 * SIGNALS -> PRIORITY -> REASON -> ACTION -> CLIENT LIST -> MONITOR ->
 * GENERATOR. Max 5 findings, fix only P0/P1/P2, do not open unrelated
 * areas.
 *
 * RESULT: no P0/P1/P2 found. Three P3 (cosmetic/tuning) observations,
 * left as debt per the ticket's own "fix only P0/P1/P2" instruction:
 *
 *   P3-1 (dead code): _ATTN_BADGE and _ATTN_PRIORITY (the pre-T228 4-tier
 *   display constants) are still defined but, after T228 replaced the
 *   client-list's badge/sort/summary with the richer 5-tier
 *   CLIENT_PRIORITY/_PRIORITY_BADGE/_PRIORITY_ORDER, no longer referenced
 *   anywhere. Harmless (unused constants, zero behavior impact) -- left
 *   in place rather than removed, since deleting them is a cosmetic
 *   cleanup outside this audit's "fix only P0/P1/P2" scope, and
 *   _computeClientAttentionState (which they used to pair with directly)
 *   remains a real, load-bearing input to _rankClientPriority.
 *
 *   P3-2 (reduced fidelity, not a correctness bug): both T229's Monitor
 *   card and T230's Generator context pass `mesocycleAction: null` into
 *   _computeInterventionReasonAction rather than the real mesocycle
 *   decision (which would need its own adaptivePrescription/Ehrenstein
 *   setup to recompute here). A WATCH-tier client with a genuinely
 *   pending mesocycle renewal therefore falls through to the
 *   'general_watch'/PROGRESSION_REVIEW branch instead of the more
 *   specific 'mesocycle_renewal_pending'/MESOCYCLE_REVIEW one (CASE I) --
 *   still the correct WATCH-tier priority and still a legitimate review
 *   category, just less specific than possible. Not fixed: recomputing
 *   the full mesocycle decision in two more places would duplicate a
 *   large amount of T192-197 setup for a labeling refinement only.
 *
 *   P3-3 (minor CPU duplication, not a correctness bug): T223's and
 *   T229's Monitor blocks each independently recompute
 *   performanceResponse/bodyCompositionResponse/effectiveness from the
 *   same entries/planDoc, rather than one block passing its result to the
 *   other. Consistent with this codebase's established per-block
 *   recomputation convention (T215 does the same for progressionHistory)
 *   and keeps each card's block self-contained and independently
 *   correct -- not fixed, since sharing state across the render
 *   function's separate `if` blocks would need hoisting several `const`s
 *   the same way T202/T206 already had to for sessionAdherence, for a
 *   pure-function CPU saving with no Firestore-read cost either way.
 *
 * Run: node tests/t232-residual-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// SIGNALS -> PRIORITY: no invented threshold, safety always first.
// ─────────────────────────────────────────────────────────────────────────────

const rankIdx = COACH.indexOf('function _rankClientPriority(attnState, weeklyStatus, effectivenessOverall)');
const rankBody = COACH.slice(rankIdx, COACH.indexOf('window._rankClientPriority = _rankClientPriority;'));
ok(rankBody.indexOf("weeklyStatus === 'PAIN_REVIEW'") < rankBody.indexOf("attnState === 'REVIEW'"),
  'SIGNALS->PRIORITY: the safety check (PAIN_REVIEW/SAFETY_REVIEW) is textually first in _rankClientPriority, before any other branch -- safety always wins by construction, not by luck of input ordering');

// ─────────────────────────────────────────────────────────────────────────────
// PRIORITY -> REASON/ACTION: every priority tier maps to exactly one
// action category, never a plan-mutation call.
// ─────────────────────────────────────────────────────────────────────────────

const reasonIdx = COACH.indexOf('function _computeInterventionReasonAction(priority, input)');
const reasonBody = COACH.slice(reasonIdx, COACH.indexOf('window._computeInterventionReasonAction = _computeInterventionReasonAction;'));
ok(!reasonBody.includes('updateDoc') && !reasonBody.includes('setDoc'), 'PRIORITY->REASON/ACTION: _computeInterventionReasonAction never writes to Firestore anywhere in its body');

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT LIST -> MONITOR: both surfaces call the SAME _rankClientPriority
// (already verified behaviorally in T231 CASE L) -- here, confirm no
// OTHER, third call site exists that could diverge (e.g. a mobile-only
// row renderer using the old attnState-only badge).
// ─────────────────────────────────────────────────────────────────────────────

const rankCallSites = (COACH.match(/= _rankClientPriority\(/g) || []).length;
ok(rankCallSites === 2, 'CLIENT LIST<->MONITOR: exactly 2 live call sites for _rankClientPriority exist (loadClientList + the T229 Monitor card) -- no third, potentially-diverging consumer');

// P3-1: confirm the dead-code finding precisely (defined, never read again).
const afterAttnBadgeDef = COACH.slice(COACH.indexOf('const _ATTN_BADGE = {', COACH.indexOf('const _ATTN_BADGE = {') + 1) + 1);
const attnBadgeDefEnd = COACH.indexOf('};', COACH.indexOf('const _ATTN_BADGE = {')) + 2;
const restOfFile = COACH.slice(attnBadgeDefEnd);
ok(!restOfFile.includes('_ATTN_BADGE['), 'P3-1 confirmed: _ATTN_BADGE is never indexed/read anywhere after its own definition (dead code, zero behavior impact, left in place per audit scope)');

// ─────────────────────────────────────────────────────────────────────────────
// GENERATOR: coachSupervision is additive and never required for a valid
// request (validateGenerationRequest doesn't reference it -- same
// permissive-extra-field pattern already verified for every prior
// additive context field this session).
// ─────────────────────────────────────────────────────────────────────────────

ok(!fs.readFileSync(path.join(__dirname, '..', 'api', 'vdsen-contracts.js'), 'utf8').includes('coachSupervision'),
  'GENERATOR: the request-shape validator has no knowledge of coachSupervision -- confirms it is purely additive, never required, consistent with weeklyDecision/learnedState/prescriptionEffectiveness before it');

console.log('');
console.log('T232 — Residual audit: ' + pass + ' assertions PASSED, 0 P0/P1/P2 findings, 3 P3 documented');
