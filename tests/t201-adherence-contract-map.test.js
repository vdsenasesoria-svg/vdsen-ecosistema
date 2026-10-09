'use strict';
/**
 * T201 — PRESCRIBED PLAN -> ACTUAL EXECUTION -> ADHERENCE/FIDELITY contract
 * map (audit-only; T202-207 built the fixes this map's findings called for).
 *
 *   LAYER                  SOURCE                                            WRITER                        READER (pre-T202)                        RELIABILITY                 SCOPE               CLASS
 *   PRESCRIBED (session)   plans/{id}.days[d].exercises[e].sets[]            Generator/Coach editor        aggregateClientLogs, calculateProgression HIGH (deterministic)         day, current plan   F
 *   PRESCRIBED (set)       plans/{id}.days[d].exercises[e].sets[s]           Generator/Coach editor        calculateProgression's numSets            HIGH                        set                 F
 *   EXECUTED (set)         logs/{uid}.entries.log_W_D_E_sS {done,autoFilled} client set-save               calculateProgression (excludes autoFilled) HIGH unless autoFilled     set                 A/F
 *   SESSION COMPLETE       logs/{uid}.entries.done_W_D {skipped?,autoClosed?} various completion paths     _getSessionCompletionState/_isRealExecution HIGH                       week+day            D
 *   SET COMPLETE (%)       progrec_W_D.recommendations[].setMetrics.setCompletionRate  calculateProgression Coach PDF export only (pre-T202/203)      HIGH (already PID-scoped)  week+day+exercise   F
 *   EXERCISE LONGITUDINAL  progressionHistory.byPrescriptionExerciseId[pid] _mapExerciseProgressionHistory Generator (progressionHistory), Coach T198  HIGH but confidence WAS   mesocycle, per-PID  F
 *                                                                                                                                                       count-only (pre-T205)
 *
 *   MISMATCH FOUND #1 (P1, FIXED in T205): _mapExerciseProgressionHistory's
 *   per-PID `confidence` was computed PURELY from history.length (week
 *   count) -- it never looked at setCompletionRate, already sitting right
 *   there on every recommendation. A PID with several weeks of 1-of-4-sets
 *   execution could read as 'high' confidence, directly enabling the exact
 *   false-confidence failure this whole ticket exists to close. Fixed: the
 *   count-based tier is now capped/downgraded by the average
 *   setCompletionRate across weeks that have it (T205a/b).
 *
 *   MISMATCH FOUND #2 (P1, FIXED in T205c): _classifyWeeklyStatus's
 *   ADHERENCE_LIMITED gate only checked engine_state.confidence, a
 *   CUMULATIVE raw-logged-set count across the WHOLE mesocycle so far. That
 *   can read 'medium'/'high' purely from elapsed time even when every
 *   single week was poorly executed (consistent attendance, ~45% of sets
 *   done every week). Fixed: a new gate (4b) feeds a week-scoped
 *   sessionAdherence.executionRate (T202) in additively.
 *
 *   MISMATCH FOUND #3 (P2, FIXED in T205d): _decideMesocycleTransition's
 *   per-exercise plateau detection (2 static-looking weeks) had no
 *   execution-confidence check -- an under-executed exercise could read as
 *   "plateaued" and drive a false RENEW_WITH_ADJUSTMENTS. Fixed: plateau
 *   only counts when entry.confidence is not 'none'/'low'.
 *
 *   NOT A MISMATCH (documented, no change needed): aggregateClientLogs's
 *   own `adherence` field (sessionsDone/sessionsPlanned, an ALL-TIME
 *   session-count percentage used for the client-detail modal/PDF export)
 *   is a DIFFERENT, coarser metric than T202's week-scoped
 *   sessionAdherence.executionRate (a per-session SET-completion average).
 *   Both are legitimate, serve different UI purposes, and neither
 *   contradicts the other -- T202 does not replace or recompute it.
 *
 *   CURRENT CONSUMERS (post-T202-207): weeklyDecision (T202/205c),
 *   adaptivePrescription (already gated on weeklyStatus, benefits for
 *   free), mesocycleDecision (T205d + already-gated top-level status),
 *   Coach Monitor (T206), canonical Generator via `executionFidelity`
 *   (T207).
 *
 * Run: node tests/t201-adherence-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// The map's own claims, verified against real code (not just asserted).
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('function _getSessionCompletionState(doneEntry)'), 'SESSION COMPLETE signal source confirmed: F76 state machine in vdsen-cliente.html');
ok(CLIENT.includes("var _confidence = _loggedSetsCount === 0 ? 'none'"), 'engine_state.confidence source confirmed: a CUMULATIVE raw-logged-set count, exactly the MISMATCH #2 root cause');
ok(/setCompletionRate\s*=\s*sets\.length/.test(CLIENT), 'SET COMPLETE (%) source confirmed: setCompletionRate = real completed sets / prescribed sets, in calculateProgression');

// MISMATCH #1 fix confirmed present (T205).
ok(COACH.includes('var avgCompletion = rates.length ? (rates.reduce'), 'MISMATCH #1 fix present: confidence now factors in average setCompletionRate, not just week count');

// MISMATCH #2 fix confirmed present (T205c).
ok(COACH.includes("if (execRate !== null && execRate < 0.6) return WEEKLY_STATUS.ADHERENCE_LIMITED;"), 'MISMATCH #2 fix present: a week-scoped executionRate gate supplements the cumulative engine_state.confidence check');

// MISMATCH #3 fix confirmed present (T205d).
ok(COACH.includes("entry.confidence !== 'none' && entry.confidence !== 'low'"), 'MISMATCH #3 fix present: mesocycle plateau detection is gated on execution confidence');

// NOT-A-MISMATCH claim confirmed: aggregateClientLogs's adherence and T202's
// sessionAdherence are separate, coexisting metrics -- neither was removed
// or silently replaced.
ok(COACH.includes('const adherence = sessionsPlanned ? Math.min(100, Math.round((sessionsDone / sessionsPlanned) * 100)) : 0;'), 'aggregateClientLogs\'s pre-existing all-time adherence % is untouched, not replaced by T202');
ok(COACH.includes('function _computeSessionAdherenceSummary(entries, week)'), 'T202\'s week-scoped sessionAdherence coexists alongside it as a separate, additive signal');

console.log('');
console.log('T201 — Adherence contract map: ' + pass + ' assertions PASSED');
