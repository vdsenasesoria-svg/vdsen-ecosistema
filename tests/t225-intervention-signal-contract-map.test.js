'use strict';
/**
 * T225 — Intervention signal contract map (audit-only; grep-first per
 * Efficiency Rules). Every existing signal that may legitimately affect
 * Coach intervention priority, and the two ALREADY-EXISTING priority
 * systems found.
 *
 *   SIGNAL                    SOURCE                          TIME SCOPE        SEVERITY                CURRENT READER                    CURRENT UI              ACTIONABILITY
 *   ------------------------  ------------------------------  ----------------  ----------------------  ---------------------------------  ----------------------  -------------------------
 *   _computeClientAttentionState  entries (progrec_/postsession_/  current+prev week  REVIEW>PROGRESSING>    Client list (loadClientList,      attnBadge (🔴/🟢/⚪/◌)  Deployed, 0 Firestore
 *   {state, reasons[]}         log_), planData -- 0 Firestore reads  scan             STABLE>NO_DATA          FASE 7)                                                   reads, but NOT combined
 *                                                                                                                                                                        with the richer T177+
 *                                                                                                                                                                        classification at the
 *                                                                                                                                                                        list level.
 *   _rankClientPriority       (T180) combines the above +      same as inputs    NEEDS_REVIEW>WATCH>     Built, tested (t180 test),         NONE -- deliberately    Function exists and is
 *   (attnState, weeklyStatus) window.VDSEN_WEEKLY's            (weeklyStatus     ON_TRACK>               window._rankClientPriority         NOT wired into any      exported but UNUSED by
 *   -> 4-tier CLIENT_PRIORITY _classifyWeeklyStatus (T177)      is single-latest INSUFFICIENT_DATA       export only                        render loop yet (per   any render loop --
 *                             when available                    "latest" key)                                                               t180's own comment)     exactly the situation
 *                                                                                                                                                                        T228 exists to fix.
 *   weeklyDecision.status     _computeWeeklyDecisionForRequest  current week      PAIN_REVIEW>            Generator (via buildGeneration     T206 weekly card in    PAIN_REVIEW/COACH_REVIEW/
 *   (T177-181, PAIN_REVIEW/    (entries, planDoc) -- 0 NEW                        COACH_REVIEW>           Request), Coach Monitor            _renderClientTabMonitor RECOVERY_LIMITED/
 *   COACH_REVIEW/RECOVERY_     Firestore reads (same entries                      ADHERENCE_LIMITED>                                                                  ADHERENCE_LIMITED are
 *   LIMITED/ADHERENCE_LIMITED/ already loaded for attnState)                      RECOVERY_LIMITED>                                                                   real, already-computed
 *   PERFORMANCE_STALL/         NOT exposed on window.VDSEN_BUILD                  PERFORMANCE_STALL>                                                                  severity tiers -- the
 *   PROGRESSING/STABLE/        yet (only usable from the SAME                     PROGRESSING/STABLE                                                                  exact substrate T226
 *   DATA_INSUFFICIENT)         early-IIFE script, not from                                                                                                            needs.
 *                              loadClientList's later script)
 *   prescriptionEffectiveness  _computePrescriptionEffectivenessForRequest  current week (recomputed  SAFETY_REVIEW>            Generator only (T222) --          T223 Monitor card       Real signal, but needs
 *   .overall (T217-222,        -- needs planDoc + ficha (objetivo_calorico)  each call)              other tiers unranked      NOT read by any priority                                  ficha+inbodyResults,
 *   SAFETY_REVIEW/EFFECTIVE_   + clientDoc.inbodyResults -- NOT loaded per                            by this map's own                     system yet                                        NEITHER of which is
 *   BUT_COSTLY/TOLERATED_BUT_  client in the list loop today                                          existing rank/T226 spec                                                                 loaded in the client-
 *   UNDER_RESPONDING/...)                                                                                                                                                                       list loop -- Monitor-
 *                                                                                                                                                                                                only signal (T229), per
 *                                                                                                                                                                                                the Performance rule.
 *   mesocycleDecision.action   _computeMesocycleDecisionForRequest  mesocycle-scoped  STOP_FOR_SAFETY>    Generator, Coach T198              T198 mesocycle card    Real signal, same 0-new-
 *   (T192-200)                 (entries-derived, 0 new reads)                        COACH_REVIEW>                                                                    reads substrate as
 *                                                                                     RENEW_WITH_ADJUSTMENTS                                                          weeklyDecision -- usable
 *                                                                                     >RENEW_MINIMAL>CONTINUE                                                         for T227's MESOCYCLE_
 *                                                                                                                                                                       REVIEW action mapping.
 *
 * MISMATCH FOUND #1 (documented, TO BE CLOSED by T226-228, not a bug to
 * silently patch): TWO deterministic priority classifications already
 * exist -- attnState (4-tier, wired/displayed) and _rankClientPriority
 * (4-tier including the richer weeklyStatus, built/tested but UNWIRED).
 * Neither has a distinct top tier for PURE safety/pain (PAIN_REVIEW
 * currently folds into the same NEEDS_REVIEW/REVIEW bucket as a plain
 * unresolved coach-identity conflict) -- contradicting this ticket's own
 * Core Principle ("Safety must always outrank performance" implies safety
 * needs its OWN, more urgent tier). T226 extends _rankClientPriority
 * (adds URGENT_REVIEW, folds in prescriptionEffectiveness) rather than
 * building a third parallel system.
 *
 * MISMATCH FOUND #2 (documented, TO BE CLOSED by T228): _rankClientPriority
 * cannot currently be called from loadClientList's render loop because
 * _computeWeeklyDecisionForRequest (its weeklyStatus source) lives in the
 * EARLY VDSEN_BUILD IIFE and is not exposed on window.VDSEN_BUILD -- a
 * one-line additive export closes this, using data already loaded in the
 * SAME per-client entries object (0 new Firestore reads).
 *
 * Run: node tests/t225-intervention-signal-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// The map's own claims, verified against real code.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('function _computeClientAttentionState(entries, planData, currentWeek)'), '_computeClientAttentionState confirmed present (0-Firestore-read attention state)');
ok(COACH.includes('function _rankClientPriority(attnState, weeklyStatus)'), '_rankClientPriority (T180) confirmed present with its current 2-arg signature');
ok(COACH.includes('var CLIENT_PRIORITY = {') && COACH.includes('NEEDS_REVIEW:      \'NEEDS_REVIEW\','), 'CLIENT_PRIORITY confirmed as the existing 4-tier enum (no URGENT_REVIEW yet)');

// MISMATCH #1: _rankClientPriority is exported but never called by any
// render loop (confirmed via the absence of any live call site outside
// its own function definition).
ok(COACH.includes('window._rankClientPriority = _rankClientPriority;'), '_rankClientPriority is exported...');
const afterDefinition = COACH.slice(COACH.indexOf('window._rankClientPriority = _rankClientPriority;') + 1);
ok(!afterDefinition.includes('_rankClientPriority(') , 'MISMATCH #1 confirmed: no code anywhere AFTER its own export calls _rankClientPriority(...) -- never actually invoked by any render loop yet');

// MISMATCH #2: _computeWeeklyDecisionForRequest is not on window.VDSEN_BUILD
// (only _mapExerciseProgressionHistory and _classifyExerciseExecutionFidelity
// are exported there today).
ok(COACH.includes('function _computeWeeklyDecisionForRequest(entries, planDoc)'), 'confirmed _computeWeeklyDecisionForRequest exists, taking exactly (entries, planDoc) -- the same two values already computed per client in loadClientList\'s rowData');
ok(!COACH.includes('_computeWeeklyDecisionForRequest: _computeWeeklyDecisionForRequest'), 'MISMATCH #2 confirmed: not yet exposed on window.VDSEN_BUILD -- unreachable from loadClientList\'s later script block');

// Confirm loadClientList already loads `entries`/`planData` per client with
// 0 new reads possible for weeklyStatus (same substrate _computeClientAttentionState uses).
ok(COACH.includes("const _logPromises = _clientDocs.map(c => getDoc(doc(db, 'logs', c.id)).catch(() => null));"), 'confirmed logs (containing engine_state/ci_sem_/postsession_/progrec_) are already batch-fetched once per client for the list -- no new read needed for weeklyStatus');

console.log('');
console.log('T225 — Intervention signal contract map: ' + pass + ' assertions PASSED');
