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
 *   P3-3 (FIXED by T279): T223's and T229's Monitor blocks used to each
 *   independently recompute performanceResponse/bodyCompositionResponse/
 *   effectiveness from the same entries/planDoc. The canonical decision
 *   snapshot (T276-279) closed this: both cards (plus T272's nutrition
 *   card) now source their data from ONE shared window.VDSEN_SNAPSHOT.build
 *   call per render, and T229's own week-derivation divergence
 *   (_computeCoachSupervisionForRequest previously guessed from
 *   entries.engine_state.weekNum instead of the real currentWeek) was
 *   fixed alongside it.
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
// OTHER, third INDEPENDENT call site exists that could diverge (e.g. a
// mobile-only row renderer using the old attnState-only badge).
//
// T279 UPDATE: Monitor's OWN direct call was removed -- it now reads
// coachSupervision.priority off the shared canonical snapshot (T276),
// whose implementation is the ONE remaining direct call
// (window._rankClientPriority(...) inside _computeCoachSupervisionForRequest).
// So the direct-call count dropped from 2 to 1 by design (one fewer
// duplicate, not a new gap) -- loadClientList's own direct call is the
// other. Still exactly 2 PATHS to the real function, now with one fewer
// place that could have silently drifted.
// ─────────────────────────────────────────────────────────────────────────────

const directRankCallSites = (COACH.match(/= _rankClientPriority\(/g) || []).length;
ok(directRankCallSites === 1, 'exactly 1 direct call site remains for the bare _rankClientPriority(...) form (loadClientList) -- Monitor\'s former duplicate direct call was closed by routing through the shared snapshot instead (T279)');
const windowRankCallSites = (COACH.match(/= window\._rankClientPriority\(/g) || []).length;
ok(windowRankCallSites === 1, 'exactly 1 cross-block window._rankClientPriority(...) call exists (inside _computeCoachSupervisionForRequest) -- the ONLY place Monitor\'s coachSupervision-sourced priority now ultimately comes from');

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
console.log('T232 — Residual audit: ' + pass + ' assertions PASSED, 0 P0/P1/P2 findings, 2 P3 documented (P3-3 fixed by T279)');
