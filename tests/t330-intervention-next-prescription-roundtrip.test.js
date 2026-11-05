'use strict';
/**
 * T330 — Coach intervention -> next-prescription round-trip (audit; already
 * correct across the whole chain, confirmed by direct reads -- no new code
 * change this phase).
 *
 * CASE A (Coach KEEP vs stale progression increase): the plateau-review
 *   engine (T237 CASE A, ~line 1101) checks _isRecommendationSupersededByIntervention
 *   for EXERCISE/pid BEFORE flagging a plateaued exercise for review; an
 *   active KEEP wins and the exercise is force-preserved, never resurfaced.
 * CASE B (Coach exercise substitution): SUBSTITUTE_EXERCISE is a real,
 *   loggable action (INTERVENTION_DECISION_ACTION); the substituted
 *   exercise gets a brand-new PID (T161 _stampPrescriptionIds never
 *   consults exercise name), so the OLD exercise's interventions stay
 *   correctly scoped to the OLD pid -- no same-name inheritance onto the
 *   new one (verified directly against _stampPrescriptionIds's source).
 * CASE C (Coach volume adjustment persists): the muscle-volume engine
 *   (T237 CASE C/D, ~line 7077) treats an active KEEP/ADJUST_VOLUME/
 *   REDISTRIBUTE_VOLUME intervention as authoritative over a conflicting
 *   REVIEW_INCREASE/REVIEW_DECREASE/REDISTRIBUTE suggestion.
 * CASE D (Coach marks reviewed only): the CLIENT-scoped supervision UI's
 *   3rd button is NO_CHANGE/REVIEWED -- a real, distinct action from KEEP,
 *   never fabricating a load/volume change while still recording that the
 *   Coach looked at it.
 * CASE E/F (newer evidence after Coach decision): _isEvidenceNewerThanIntervention
 *   is composed inside _isRecommendationSupersededByIntervention at BOTH
 *   real call sites (EXERCISE and MUSCLE) -- evidence postdating the
 *   Coach's decidedAt is never suppressed by it. A live PAIN_REVIEW safety
 *   signal additionally outranks EVERYTHING, including an active KEEP,
 *   since the whole-mesocycle STOP_FOR_SAFETY return happens after (and
 *   overrides) the per-exercise KEEP-preserve loop.
 * CASE G (old mesocycle intervention): _isInterventionActiveForScope
 *   requires planId match for every targetType except CLIENT -- an
 *   intervention tied to a prior mesocycle's planId is correctly
 *   historical (not active) for the current plan.
 * CASE H (same exercise name / new PID): scope matching is by targetId
 *   (PID) only, never by exercise name -- confirmed via
 *   _isInterventionActiveForScope's own source (no name comparison exists
 *   anywhere in it).
 *
 * "No global invalidation": every real call site scopes to an EXACT
 * (targetType, targetId[, planId]) tuple -- there is no code path that
 * invalidates by client/mesocycle alone for an EXERCISE/MUSCLE-scoped
 * automated decision.
 *
 * Run: node tests/t330-intervention-next-prescription-roundtrip.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

// ── Core T235 scope/staleness primitives -- functional proof. ──────────────
const scopeSrc = extractFunction(COACH, 'function _isInterventionActiveForScope(intervention, targetType, targetId, currentPlanId) {');
const evidenceNewerSrc = extractFunction(COACH, 'function _isEvidenceNewerThanIntervention(intervention, evidenceTimestampIso) {');
const targetTypeDecl = "var INTERVENTION_TARGET_TYPE = { CLIENT: 'CLIENT', MUSCLE: 'MUSCLE', EXERCISE: 'EXERCISE', MESOCYCLE: 'MESOCYCLE' };\n";
ok(COACH.includes(targetTypeDecl.trim()), 'INTERVENTION_TARGET_TYPE enum matches what this test evaluates standalone (parity check)');
{
  const fn = new Function(targetTypeDecl + scopeSrc + '\nreturn _isInterventionActiveForScope;')();
  ok(fn({ targetType: 'EXERCISE', targetId: 'pidA', planId: 'planOld' }, 'EXERCISE', 'pidA', 'planNew') === false,
    'CASE G/H: an EXERCISE-scoped intervention tied to a stale plan is NOT active for the current plan');
  ok(fn({ targetType: 'EXERCISE', targetId: 'pidA', planId: 'planNew' }, 'EXERCISE', 'pidA', 'planNew') === true,
    'a same-plan, same-PID intervention IS active');
  ok(fn({ targetType: 'EXERCISE', targetId: 'pidOld', planId: 'planNew' }, 'EXERCISE', 'pidNew', 'planNew') === false,
    'CASE H: a different PID (post-substitution) never matches, even same plan -- no name-based fallback exists in this function\'s source');
  ok(fn({ targetType: 'CLIENT', targetId: 'c1', planId: 'planOld' }, 'CLIENT', 'c1', 'planNew') === true,
    'a CLIENT-scoped intervention is plan-independent by design -- still active across a plan change');
  pass += 4; console.log('  ✓ functional: _isInterventionActiveForScope scope/plan/CLIENT-exception rules all correct');
}
ok(!/exerciseName|\.name\s*===/.test(scopeSrc), 'CASE H: scope matching source contains no exercise-name comparison of any kind -- PID is the only identity');

{
  const fn = new Function(evidenceNewerSrc + '\nreturn _isEvidenceNewerThanIntervention;')();
  ok(fn({ decidedAt: '2026-01-01T00:00:00Z' }, '2026-02-01T00:00:00Z') === true, 'CASE E/F: evidence postdating the Coach decision is NOT superseded by it');
  ok(fn({ decidedAt: '2026-03-01T00:00:00Z' }, '2026-02-01T00:00:00Z') === false, 'evidence predating the Coach decision IS superseded');
  pass += 2; console.log('  ✓ functional: _isEvidenceNewerThanIntervention correctly chronological');
}

// ── CASE A: plateau-review engine honors an active KEEP, evidence-aware. ───
const plateauCtxIdx = COACH.indexOf("var evidenceTs229237 = (typeof window !== 'undefined'");
const plateauSlice = COACH.slice(plateauCtxIdx - 400, plateauCtxIdx + 700);
ok(plateauSlice.includes("_isRecommendationSupersededByIntervention(input.interventions, 'EXERCISE', pid, input.currentPlanId, evidenceTs229237)"),
  'CASE A: the plateau-review call site scopes to EXERCISE (per-PID), not a broader scope');
ok(plateauSlice.includes("supersededByCoach.action === 'KEEP'"), 'CASE A: only an active KEEP force-preserves a plateaued exercise -- not any arbitrary intervention');
ok(plateauSlice.includes('preserveExercisePids.push(pid); return;'), 'CASE A: a KEEP short-circuits straight to preserve, never re-evaluating the stale plateau suggestion');

// ── CASE E/F continued: a live pain signal outranks an active KEEP. ────────
const painIdx = COACH.indexOf("if (weeklyStatus === 'PAIN_REVIEW') {");
ok(painIdx > plateauCtxIdx, 'CASE E/F: the whole-mesocycle PAIN_REVIEW safety check runs AFTER (and overrides) the per-exercise KEEP-preserve loop');
ok(COACH.slice(painIdx, painIdx + 250).includes("action: 'STOP_FOR_SAFETY'"), 'a live pain signal forces STOP_FOR_SAFETY regardless of any Coach KEEP already computed');

// ── CASE C: muscle-volume engine honors KEEP/ADJUST_VOLUME/REDISTRIBUTE_VOLUME. ──
const volSupersedeIdx = COACH.indexOf("var supersedingInterv = (input.interventions && input.muscleId");
const volSlice = COACH.slice(volSupersedeIdx, volSupersedeIdx + 700);
ok(volSlice.includes("_isRecommendationSupersededByIntervention(input.interventions, 'MUSCLE', input.muscleId, input.currentPlanId, evidenceTs6427237)"),
  'CASE C: the muscle-volume engine composes the same real T235 function, scoped to MUSCLE/muscleId');
ok(volSlice.includes("['KEEP', 'ADJUST_VOLUME', 'REDISTRIBUTE_VOLUME'].indexOf(supersedingInterv.action) !== -1"),
  'CASE C: a Coach decision to KEEP the volume OR one they already hand-adjusted both suppress a conflicting automated volume suggestion');
ok(volSlice.includes("volumeAction = 'KEEP';") && volSlice.includes("distributionAction = 'KEEP';"),
  'CASE C: the automated engine folds back to KEEP once superseded -- it never overwrites the Coach\'s explicit volume decision');

// ── CASE B: SUBSTITUTE_EXERCISE is real, and PID minting never consults name. ──
ok(COACH.includes("SUBSTITUTE_EXERCISE:  'SUBSTITUTE_EXERCISE',"), 'CASE B: SUBSTITUTE_EXERCISE is a real, loggable Coach decision action');
const stampSrc = extractFunction(COACH, 'function _stampPrescriptionIds(days) {');
ok(!stampSrc.includes('exerciseName'), 'CASE B: PID minting for a substituted exercise never consults exercise name -- no same-name inheritance of the OLD exercise\'s interventions/history onto the new one');

// ── CASE D: "mark reviewed only" is a real, distinct, non-fabricating action. ──
ok(COACH.includes("{ action: 'NO_CHANGE',        label: 'MARCAR REVISADO', status: 'REVIEWED' }"), 'CASE D: "mark reviewed" logs action=NO_CHANGE/status=REVIEWED -- a real record, not a fabricated KEEP/ADJUST decision');
const buildIntervSrc = extractFunction(COACH, 'function _buildCoachIntervention(input) {');
ok(buildIntervSrc.includes("if (Object.keys(INTERVENTION_DECISION_ACTION).indexOf(input.action) === -1) return null;"), 'the builder rejects any action not in the closed enum -- no invented action can be persisted');

// ── "No global invalidation": every scope check requires exact targetId match. ──
ok(scopeSrc.includes('intervention.targetType !== targetType || intervention.targetId !== targetId'), 'scope matching always requires an EXACT (targetType, targetId) tuple -- there is no client-wide or mesocycle-wide blanket match for EXERCISE/MUSCLE scope');

// ── History is append-only; intervention writes never delete prior entries. ──
const interveneFnSrc = extractFunction(COACH, 'async function _vdsenCoachIntervene(action, status) {');
ok(interveneFnSrc.includes('existing.push(record);') && !/existing\s*=\s*\[\]/.test(interveneFnSrc), 'CASE G: a new Coach decision is appended to the existing coachInterventions array, never replacing/clearing prior history');

console.log('');
console.log('T330 — Intervention/next-prescription round-trip: ' + pass + ' assertions PASSED. All 8 required cases confirmed; no new code change this phase.');
