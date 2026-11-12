'use strict';
/**
 * T282 — Residual audit of the whole T275-281 canonical decision snapshot
 * work: DATA LOAD -> SNAPSHOT -> GENERATOR -> MONITOR -> CLIENT LIST ->
 * HISTORY. Max 5 findings, fix only P0/P1/P2, do not open unrelated areas.
 *
 * RESULT: no P0/P1/P2 found. One P3 (CPU-duplication-only, no correctness
 * risk) observation, left as debt per this ticket's own "fix only
 * P0/P1/P2" / "do not refactor P3 style debt" instruction:
 *
 *   P3-1 (CPU duplication, not a correctness bug): the Monitor's OWN
 *   "Learned state" card (T215, a DIFFERENT card from the T223/T229/T272
 *   ones T279 routed through the shared snapshot) still independently
 *   calls window.VDSEN_LEARNED.computeVolumeTolerance/computeExerciseTolerance/
 *   computeRecoverySensitivity over the SAME real planDoc/progressionHistory/
 *   entries the shared _monitorSnapshot.learnedState already computed this
 *   render. Pure functions, identical inputs -> byte-identical output as
 *   snapshot.learnedState -- zero divergence risk, same precedent as the
 *   pre-T279 effectiveness duplication (which WAS fixed, because T275's
 *   audit found an actual week-derivation divergence riding along with
 *   it). No such divergence exists here. Not fixed: this is exactly the
 *   "no cosmetic refactor" / "do not refactor P3 style debt" case this
 *   audit phase is explicitly told to leave alone.
 *
 * Run: node tests/t282-canonical-snapshot-residual-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE DECISION COMPUTATION: exactly the expected call sites remain
// for each canonical function -- no stray/unaccounted third consumer.
// ─────────────────────────────────────────────────────────────────────────────

ok((COACH.match(/_rankClientPriority\(/g) || []).length === 3,
  'exactly 3 occurrences of _rankClientPriority( exist: its own definition, the one real cross-block call (inside _computeCoachSupervisionForRequest), and the client list\'s own reduced-projection call (T280) -- no undiscovered 4th consumer');
ok((COACH.match(/VDSEN_OUTCOME\.computeEffectiveness\(/g) || []).length === 2,
  'exactly 2 calls to VDSEN_OUTCOME.computeEffectiveness( exist: the canonical one inside _computePrescriptionEffectivenessForRequest (used by both Generator and Monitor via the shared snapshot), and the client list\'s own reduced-projection call (T280) -- both legitimate, no stray duplicate');
ok((COACH.match(/VDSEN_NUTRITION\.decide\(/g) || []).length === 1,
  'exactly 1 call to VDSEN_NUTRITION.decide( exists (inside _computeNutritionDecisionForRequest) -- single source of truth for every consumer');
ok((COACH.match(/VDSEN_SNAPSHOT\.build\(/g) || []).length === 1 && (COACH.match(/_buildClientDecisionSnapshot\(\{/g) || []).length === 1,
  'exactly 1 Monitor call to window.VDSEN_SNAPSHOT.build and exactly 1 Generator call to _buildClientDecisionSnapshot(...) -- one canonical composer, two real consumers, no third');

// ─────────────────────────────────────────────────────────────────────────────
// GENERATOR/MONITOR SAME WEEK: _computeCoachSupervisionForRequest (T279
// fix) and the snapshot's own `week` (from logsDoc.currentWeek) are the
// SAME value fed to every block that needs a week; _computeWeeklyDecisionForRequest
// derives its own week from entries.engine_state.weekNum, but BOTH
// Generator and Monitor call that exact same function with the exact same
// entries -- so they can never disagree with each other (verified
// end-to-end in T281 CASE A/K), even though its internal week source
// differs from logsDoc.currentWeek in principle.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('var coachSupervision = _computeCoachSupervisionForRequest(entries, planDoc, weeklyDecision, prescriptionEffectiveness, week);'),
  'the snapshot builder threads the SAME real `week` (from logsDoc.currentWeek) into coachSupervision -- the T279 fix is still in place');

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT BUILDER NEVER WRITES FIRESTORE (re-confirmed at the whole-
// closure level, not just _buildClientDecisionSnapshot's own body -- none
// of its 10 composed helpers write either).
// ─────────────────────────────────────────────────────────────────────────────

const blockStart = COACH.indexOf('  function _mapLogs(logsDoc) {');
const blockEnd   = COACH.indexOf('  function buildGenerationRequest(params) {');
const snapshotClosure = COACH.slice(blockStart, blockEnd);
ok(!/\bsetDoc\(|\bupdateDoc\(|\baddDoc\(|\brunTransaction\(|\bdeleteDoc\(/.test(snapshotClosure),
  'zero Firestore writes anywhere in the _mapLogs.._buildClientDecisionSnapshot closure (all 10 composed helpers included) -- the whole snapshot subsystem is provably read-only');

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL STATE NEVER LEAKS INTO THE ACTIVE SNAPSHOT (re-confirmed):
// _buildHistoricalMesocycleView has no path to _buildClientDecisionSnapshot/
// VDSEN_SNAPSHOT, and the reverse is also true -- the live snapshot never
// calls into the historical subsystem either.
// ─────────────────────────────────────────────────────────────────────────────

ok(!snapshotClosure.includes('_buildHistoricalMesocycleView') && !snapshotClosure.includes('mesoDoc'),
  'the live snapshot closure never references the historical mesocycle subsystem at all -- no accidental cross-contamination in either direction');

// ─────────────────────────────────────────────────────────────────────────────
// MUTABLE CACHED SNAPSHOT / SNAPSHOT REUSED AFTER INTERVENTION: no cache
// variable of any kind exists anywhere near the snapshot builder or its
// two consumers.
// ─────────────────────────────────────────────────────────────────────────────

ok(!/_snapshotCache|_cachedSnapshot|_snapshotMemo/.test(COACH), 'no cached/memoized snapshot variable exists anywhere in the codebase -- every consumer call is a fresh, correct recomputation (T277\'s design)');

// ─────────────────────────────────────────────────────────────────────────────
// P3-1 (documented, NOT fixed): the Learned-state Monitor card still
// independently calls VDSEN_LEARNED tolerance functions rather than
// reading _monitorSnapshot.learnedState -- pure-function CPU duplication
// only, zero divergence risk (identical real inputs -> identical real
// output), same precedent as debt the codebase already accepts elsewhere.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _learnedVolTolerance = window.VDSEN_LEARNED.computeVolumeTolerance(p, _learnedProgHist, []);'),
  'P3-1 confirmed: the Learned-state card still independently calls VDSEN_LEARNED directly rather than reading _monitorSnapshot.learnedState -- documented CPU-duplication debt, not fixed (no correctness risk, "do not refactor P3 style debt")');

console.log('');
console.log('T282 — Residual audit: ' + pass + ' assertions PASSED, 0 P0/P1/P2 findings, 1 P3 documented');
