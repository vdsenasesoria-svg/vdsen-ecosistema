'use strict';
/**
 * T283 — Evidence source/freshness contract map (audit-only).
 *
 * Maps every evidence source feeding the canonical snapshot (T276-282).
 * Compact map (SOURCE / IDENTITY SCOPE / TIME SCOPE / TIMESTAMP / EXPECTED
 * RECENCY / QUALITY SIGNAL / CURRENT CONSUMERS / LEGACY FALLBACK):
 *
 * 1. logs/{uid}.entries.progrec_{W}_{D}
 *    IDENTITY: prescriptionExerciseId (PID-exact, per recommendation)
 *    TIME: week-scoped (W in the key)      TIMESTAMP: entry.calculatedAt
 *    RECENCY: must not predate a Coach plan edit (planDoc.updatedAt)
 *    QUALITY SIGNAL: already computed inline in _computeWeeklyDecisionForRequest
 *      (idStale = PID not in current plan; editStale = calculatedAt < planDoc.updatedAt)
 *      -> both roll into reviewCount, but the PER-RECOMMENDATION quality
 *      label itself is discarded after computing the count.
 *    CONSUMERS: weeklyDecision (reviewCount only), progressionHistory
 *      (via _mapExerciseProgressionHistory, unindexedCount for PID-less)
 *    LEGACY FALLBACK: a recommendation with NO prescriptionExerciseId is
 *      counted in progressionHistory.unindexedCount -- computed, and
 *      already surfaced in the READ-ONLY HISTORICAL mesocycle view
 *      (_buildHistoricalMesocycleView's unindexedRecommendations), but
 *      NEVER surfaced anywhere in the LIVE canonical snapshot/Generator/
 *      Monitor path today (FINDING 1).
 *
 * 2. logs/{uid}.entries.ci_sem_{W}
 *    IDENTITY: client (one per client)     TIME: week-scoped (W in the key)
 *    TIMESTAMP: ci.fecha (when present)    RECENCY: keyed exactly by week,
 *      so a lookup for the WRONG week structurally returns undefined/null,
 *      never a stale value silently substituted -- scope-exact by
 *      construction, not a real gap.
 *    CONSUMERS: weeklyDecision (ciSem), Monitor's Ehrenstein card, list
 *      row badges.
 *
 * 3. logs/{uid}.entries.engine_state
 *    IDENTITY: client (single overwritten doc field, no history)
 *    TIME SCOPE: CUMULATIVE (confidence is an observationsCount-based
 *      scale across the WHOLE mesocycle so far -- T205's own documented
 *      rule), but engine_state.weekNum is read by
 *      _computeWeeklyDecisionForRequest AS IF it were the canonical
 *      "current week" (FINDING 2) -- a DIFFERENT source from
 *      logsDoc.currentWeek (which the snapshot's own identity.week, the
 *      nutrilog decision window, and the comidas/plan-display all use).
 *      In practice both are written by the same client-side progression
 *      calculation and should track together, but nothing GUARANTEES it
 *      structurally if a coach manually advances currentWeek before a
 *      new session's progression runs.
 *    CONSUMERS: weeklyDecision's internal week (engine_state.weekNum),
 *      snapshot identity.week / nutrition window / provenance
 *      (logsDoc.currentWeek) -- two different sources for "current week".
 *
 * 4. clients/{uid}.inbodyResults[]
 *    IDENTITY: client   TIME: per-measurement .ts   TIMESTAMP: real (.ts)
 *    QUALITY SIGNAL: already computed (T220): MEASUREMENT_CONFLICT
 *      (implausible swing), INSUFFICIENT_DATA (evidence-confidence gate:
 *      method-mixing + <14-day span), COACH_REVIEW (no stated goal).
 *    CONSUMERS: prescriptionEffectiveness.bodyCompositionResponse,
 *      nutritionDecision.response.
 *
 * 5. logs/{uid}.entries.nutrilog_{date}
 *    IDENTITY: client   TIME: daily, real per-day self-report
 *    QUALITY SIGNAL: already computed (T268): INSUFFICIENT_DATA (<3 valid
 *      days in the 7-day window) vs HIGH/MEDIUM/LOW.
 *    CONSUMERS: nutritionDecision.adherence.
 *
 * 6. clients/{uid}.coachInterventions[]
 *    IDENTITY: targetType+targetId+planId (T234-238)   TIMESTAMP: decidedAt
 *    QUALITY SIGNAL: already computed (T235-243):
 *      _isInterventionActiveForScope (plan/scope match),
 *      _isRecommendationSupersededByIntervention (evidence-timestamp gate).
 *    CONSUMERS: coachInterventionContext, adaptivePrescription,
 *      _decideMesocycleTransition.
 *
 * 7. clients/{uid}.activePlanId / plans/{id}.updatedAt
 *    IDENTITY: client->plan pointer   QUALITY SIGNAL: T277's isLive flag
 *      (a planId matching clientDoc.activePlanId is live; otherwise
 *      historical -- already computed, no gap found).
 *
 * CONCLUSION: 2 real findings, both additive (no existing engine touched):
 *   FINDING 1 -- progressionHistory.unindexedCount (legacy PID-less
 *     evidence) is computed and already surfaced in the read-only
 *     historical view, but never surfaced in the LIVE snapshot/Generator/
 *     Monitor path.
 *   FINDING 2 -- weeklyDecision's internal "current week"
 *     (entries.engine_state.weekNum) is a DIFFERENT source from the
 *     snapshot's own canonical week (logsDoc.currentWeek). Not fixed here
 *     (T283 is audit-only) -- T285's weekly-checkin staleness gate
 *     compares them explicitly instead.
 *
 * Run: node tests/t283-evidence-freshness-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 1: unindexedCount is computed...
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('return { byPrescriptionExerciseId: byPID, unindexedCount: unindexedCount };'),
  '_mapExerciseProgressionHistory already computes unindexedCount (legacy PID-less recommendations)');

// ─────────────────────────────────────────────────────────────────────────────
// ...and IS surfaced in the read-only HISTORICAL view, but that is the
// ONLY consumer -- the LIVE snapshot/Generator/Monitor path never reads it.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('unindexedRecommendations: progressionHistory.unindexedCount'),
  '.unindexedCount IS read, but only by the read-only historical mesocycle view');
const snapshotFnIdx = COACH.indexOf('function _buildClientDecisionSnapshot(params)');
const snapshotFnEnd  = COACH.indexOf('window.VDSEN_SNAPSHOT = { build: _buildClientDecisionSnapshot };');
const snapshotFnBody = COACH.slice(snapshotFnIdx, snapshotFnEnd);
ok(!snapshotFnBody.includes('unindexedCount'),
  'FINDING 1 confirmed: _buildClientDecisionSnapshot itself never reads/propagates .unindexedCount -- a real, already-computed legacy-evidence signal is silently discarded from the live decision path today (its logsResult carries it, but the snapshot never surfaces it)');

// ─────────────────────────────────────────────────────────────────────────────
// FINDING 2: two different "current week" sources exist.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('var week = es && es.weekNum;'),
  'weeklyDecision (_computeWeeklyDecisionForRequest) derives its internal week from entries.engine_state.weekNum');
ok(COACH.includes('var week = (logsDoc && logsDoc.currentWeek) || null;'),
  'FINDING 2 confirmed: the canonical snapshot identity/provenance/nutrition-window instead uses logsDoc.currentWeek -- a genuinely DIFFERENT source for "current week"');

// ─────────────────────────────────────────────────────────────────────────────
// Confirmed NOT a bug: ci_sem_{W} is scope-exact by construction (keyed by
// week number), so a wrong-week lookup structurally returns null/undefined,
// never a silently-substituted stale value.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("var ciSem = week ? (entries['ci_sem_' + week] || null) : null;"),
  'ci_sem_{W} lookup is keyed by the SAME week variable used for the classification -- structurally scope-exact, not a real gap');

// ─────────────────────────────────────────────────────────────────────────────
// Confirmed NOT a bug: legacy PID-less recommendations already cannot
// enter byPrescriptionExerciseId at all (they only increment the counter).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("if (!rec || !rec.prescriptionExerciseId) { unindexedCount++; return; }"),
  'legacy PID-less recommendations are excluded from byPrescriptionExerciseId entirely -- structurally cannot override current PID-exact evidence (CASE F is already safe by construction)');

console.log('');
console.log('T283 — Evidence freshness contract map: ' + pass + ' assertions PASSED');
console.log('CONCLUSION: 2 real findings (both additive) -- unindexedCount unsurfaced; two "current week" sources exist.');
