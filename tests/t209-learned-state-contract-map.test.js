'use strict';
/**
 * T209 — Learned-state contract map (audit-only; grep-first per Efficiency
 * Rules). Every place currently acting as learned_state or a longitudinal
 * prior, found BEFORE this ticket touches anything.
 *
 *   SOURCE                          KEY                              TIME HORIZON          CONFIDENCE                      WRITER                         READERS                                        CURRENT AUTHORITY
 *   ------------------------------  -------------------------------  --------------------  ------------------------------  -----------------------------  ---------------------------------------------  -----------------------------------------
 *   _computeMuscleTargets (P10.1)   source:'learned_state' +         ONE PREVIOUS PLAN     engine_state.confidence         calculateProgression (client)  _computeMuscleTargets (volume target calc)     Outranks ehrenstein_prior/population_prior
 *   (LIVE, vdsen-coach.html)        prevVolumes[muscle].fractional    (single snapshot,      (medium/high/low/none) --      writes engine_state;           for THIS muscle's volumeTarget/Range           at medium/high engine_state.confidence.
 *                                   Total (copies last plan's         NOT repeated evidence) same CUMULATIVE raw-set-      auditFractionalVolume writes                                                    engine_state.confidence is a CUMULATIVE
 *                                   volume ± spread)                                        count metric flagged in T205  previousPlanVolumes                                                            raw-logged-set count (T205's own finding),
 *                                                                                                                                                                                                          NOT adherence/repetition-of-outcome aware.
 *   progressionHistory (T160/166,   byPrescriptionExerciseId[pid]     MULTI-WEEK,           entry.confidence              _mapExerciseProgressionHistory  Generator (progressionHistory),               Gates mesocycle plateau verdict (T205d),
 *   T205 fix)                       {history[], confidence,           mesocycle-scoped,      (none/low/medium/high,        (T160/166/T205)                Coach T198, mesocycleDecision, adaptive-       feeds executionFidelity (T207). Already
 *   (LIVE)                          executionCompleteness, latest}    PID-first              execution-completeness-gated                                 Prescription plateau logic                    "repeated evidence", not one-shot.
 *                                                                                             since T205)
 *   executionFidelity (T202-207)    sessionAdherence,                 WEEK-scoped (session)  per-field (executionRate     _computeSessionAdherenceSummary Generator (`executionFidelity`), Coach T206    Additive context only; explicitly forbidden
 *   (LIVE)                          exerciseConfidenceByPid,          + PID-scoped (exercise) number; per-PID confidence)  / T204/T205/T207                                                               from directly justifying a plan change.
 *                                   muscleExecution
 *   trainingTopologyState /         currentTopology, confidence,      Unspecified            confidence (none/low/        NONE -- no writer anywhere.     Only its own tests                              N/A -- disconnected from the live
 *   learnedState                    sessionPerformanceTrend,                                  medium/high)                api/vdsen-topology.js is not                                                    generation pipeline entirely.
 *   (api/vdsen-topology.js)         lateSequencePerformanceTrend,                                                         required by vdsen-coach.html or
 *                                   recoveryTrend                                                                         any wired api/*.js file.
 *   clientData.learnedState         {status:'ACTIVE'/'STALE'/         Unspecified            record.confidence, string    NONE -- no writer anywhere.      _getActivePersistedLearnedState /            Would outrank heuristic score for
 *   "Learned State Activation v1"   'INVALID', topologyState:         (persisted per-client,                              No `.learnedState =` or          _applyLearnedTopologyAdjustment /            candidate exercise/topology/spacing
 *   (FASE 45/46, vdsen-coach.html,  {preferredPatterns[],             cumulative across       tiers 'none'/'low'/          `learnedState:` write exists      _applyLearnedDistributionFeedback /          RANKING during generation IF it were
 *   fully built, DORMANT)           rejectedPatterns[]},              mesocycles, intended)   'moderate'/'high' --         anywhere in vdsen-coach.html.     _applyLearnedExerciseAdjustment,             ever populated -- confidence gate
 *                                   slotState:{preferredSpacing[]},                           NOTE inconsistent tier                                       called from the pre-generation                already correctly written (NONE/LOW ->
 *                                   exerciseState:{exercises:{...}}}                          name 'moderate' vs the                                       ranking flow (~L7880/11654/12541)            neutral, per L11585-87).
 *                                                                                              rest of the codebase's
 *                                                                                              'medium')
 *
 * MISMATCH FOUND #1 (documented, NOT fixed -- different domain/scope, no
 * live behavior conflict): _computeMuscleTargets's "learned_state" is a
 * ONE-SHOT "copy last plan's volume" heuristic gated on a CUMULATIVE,
 * non-adherence-aware confidence metric -- exactly "what happened once"
 * rather than "what this client has repeatedly tolerated" (this ticket's
 * own Core Principle). It answers a DIFFERENT, narrower question (this
 * week's synchronous volumeTarget number for the live plan editor) than
 * T211's genuine repeated-evidence volume tolerance. T211-214 build the
 * new, real learned_state as an ADDITIVE parallel signal (surfaced to the
 * Generator only) -- _computeMuscleTargets itself is out of scope for this
 * ticket (touching it risks the live manual-plan-editing volume calc, and
 * the ticket's own Invariants forbid recomputing/replacing the adherence/
 * weekly/adaptive/mesocycle axes already built).
 *
 * MISMATCH FOUND #2 (documented, NOT fixed -- confirmed dead code, zero
 * live-behavior risk either way): TWO fully-built "learned_state" consumer
 * systems exist with NO producer at all -- api/vdsen-topology.js's
 * `learnedState`/`trainingTopologyState` (unreferenced outside its own
 * tests) and vdsen-coach.html's FASE 45/46 "Learned State Activation v1"
 * (`clientData.learnedState`, wired into exercise/topology/distribution
 * candidate ranking at generation time, but `clientData.learnedState` is
 * NEVER written anywhere -- grep-verified, zero `.learnedState =` or
 * `learnedState:` assignments outside the consumer functions themselves).
 * Both are permanently inert in production today. Not fixed: building a
 * writer for FASE 45/46's exercise/topology/distribution SELECTION-RANKING
 * shape is a different feature (WHICH exercise/topology to pick) than this
 * ticket's VOLUME/PATTERN/RECOVERY TOLERANCE shape (HOW MUCH to prescribe),
 * and wiring an unrelated dormant system is out of this ticket's scope
 * ("do not change code unless mismatch is real" -- dead code with no
 * writer is not a live mismatch to repair).
 *
 * NAMING NOTE for T214: the Generator-request field this ticket introduces
 * is named `learnedState` (per the ticket's own T214 sketch), which is the
 * SAME property name as `clientData.learnedState` (FASE 45/46) but a
 * DIFFERENT object entirely (one lives on the generation REQUEST, freshly
 * computed per call from progressionHistory/executionFidelity; the other
 * would live on the CLIENT DOCUMENT in Firestore, for exercise-ranking).
 * No code collision (different containers), but documented here explicitly
 * so a future reader does not conflate the two.
 *
 * Run: node tests/t209-learned-state-contract-map.test.js
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

ok(COACH.includes("source = 'learned_state';") && COACH.includes('var prevFrac = prevVolumes[muscle].fractionalTotal;'),
  '_computeMuscleTargets\'s learned_state confirmed: copies a SINGLE previous plan\'s volume, not repeated evidence');
ok(COACH.includes("if ((esConf === 'high' || esConf === 'medium') && prevVolumes && prevVolumes[muscle])"),
  'confirmed gated on engine_state.confidence (T205\'s own documented cumulative-count metric), not adherence/executionRate');

ok(COACH.includes('function _getActivePersistedLearnedState(clientData)'), 'FASE 45/46 Learned State Activation v1 consumer infrastructure confirmed present');
// Dead-code check: no assignment of the form `.learnedState = {...}` (as
// opposed to the consumer functions merely READING clientData.learnedState).
const learnedStateWrites = (COACH.match(/\.learnedState\s*=\s*\{/g) || []).length;
ok(learnedStateWrites === 0, 'MISMATCH #2 confirmed: zero `.learnedState = {...}` writes anywhere in vdsen-coach.html -- FASE 45/46 is permanently dormant (no producer)');

const fs2 = require('fs');
const TOPOLOGY = fs2.readFileSync(path.join(__dirname, '..', 'api', 'vdsen-topology.js'), 'utf8');
ok(TOPOLOGY.includes('function _learnedStateScore'), 'api/vdsen-topology.js\'s own separate learnedState concept confirmed present');
ok(!COACH.includes('vdsen-topology'), 'confirmed api/vdsen-topology.js is not required/referenced by vdsen-coach.html -- disconnected from the live pipeline');

ok(COACH.includes("var conf = String(record.confidence || 'none').toLowerCase();") && COACH.includes("if (conf === 'none' || conf === 'low') return enriched;"),
  'FASE 46\'s confidence gate (NONE/LOW -> neutral) confirmed -- useful precedent for T210\'s own confidence rule, even though this system is dormant');

console.log('');
console.log('T209 — Learned-state contract map: ' + pass + ' assertions PASSED');
