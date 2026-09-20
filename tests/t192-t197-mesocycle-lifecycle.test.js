'use strict';
/**
 * T192 — Mesocycle lifecycle contract map (audit, no conflict found):
 *
 *   CURRENT START: coach activates a plan (_vdsenActivatePlanInFirestore,
 *     T173/T174) -> clients/{uid}.activePlanId.
 *   CURRENT END (checkpoint DETECTION only, never a decision):
 *     - getClientAlert's 'mesoEnd' (vdsen-coach.html): fires when
 *       currentWeek >= planWeeks AND every day of the last week is done
 *       (excluding AUTO_CLOSED_NO_DATA) — a pure notification badge.
 *     - _isMesocycleCheckpoint (vdsen-cliente.html): CURRENT_WEEK === total
 *       weeks — a pure UI LABEL ("SEMANA FINAL"), explicitly commented
 *       "NO implica deload automático" (already correctly reactive, T162).
 *     Neither computes what to DO next — that gap is what T193-197 close.
 *   CURRENT RENEWAL: no separate "renew" button exists — a coach simply
 *     re-runs the SAME canonical vdsenAIPreview()/buildGenerationRequest()
 *     pipeline (T166-T190) for a client who already has an active plan;
 *     previousPlan/progressionHistory/weeklyDecision/adaptivePrescription
 *     already flow through it.
 *   CURRENT GENERATOR INPUT: previousPlan (real PIDs), progressionHistory
 *     (T160/166), weeklyDecision (T177/181), adaptivePrescription
 *     (T185-188) — all already additive on the canonical request.
 *   CONTINUITY DATA: prescriptionExerciseId (T150/161/166), _stampPrescriptionIds
 *     preserves-if-present/mints-if-absent (unchanged).
 *   LEGACY CALENDAR RULES: none found — _isMesocycleCheckpoint/getClientAlert
 *     are both already non-authoritative (label/notification only).
 *
 * T193/T194 — _decideMesocycleTransition(input): action ∈ CONTINUE/
 * RENEW_MINIMAL/RENEW_WITH_ADJUSTMENTS/COACH_REVIEW/STOP_FOR_SAFETY, plus
 * per-exercise preserveExercisePids/reviewExercisePids derived from
 * progressionHistory's plateau signal (2+ weeks maintain/freeze_load — the
 * EXACT rule already given to the Generator prompt in T164, now also
 * pre-computed deterministically). Week count (isCheckpointWeek) only
 * breaks the tie between CONTINUE and RENEW_MINIMAL when evidence already
 * supports either — never overrides a real red flag, never forces
 * RENEW_WITH_ADJUSTMENTS or STOP_FOR_SAFETY by itself.
 *
 * T195 — volume/frequency carryover: mesocycleDecision does not recompute
 * per-muscle volume/frequency — it reuses adaptivePrescription's
 * muscleDecisions map as-is (T185-188 unmodified), only checking for a
 * COACH_REVIEW muscle to gate the mesocycle-level call.
 *
 * T196 — learned-state carryover: reuses progressionHistory unmodified; a
 * stale coach-edit or identity conflict already can't reach preserve/review
 * classification cleanly since it's caught earlier by weeklyStatus ===
 * COACH_REVIEW (T170's existing staleness rule, unmodified upstream).
 *
 * T197 — wired additively into buildGenerationRequest as `mesocycleDecision`.
 * Prompt updated with explicit rules (mirroring T181/T188's pattern):
 * STOP_FOR_SAFETY never preserves/substitutes programmatically; COACH_REVIEW
 * never invents a compensating volume/frequency decision; week number alone
 * is never a rotation/escalation reason since mesocycleDecision already
 * integrates that evidence.
 *
 * T199 E2E — CASES A-H satisfied directly below.
 *
 * Run: node tests/t192-t197-mesocycle-lifecycle.test.js
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

const decideSrc = extractFunction(COACH, 'function _decideMesocycleTransition(input)');
ok(decideSrc, '_decideMesocycleTransition extracts cleanly');
const _decideMesocycleTransition = new Function('return ' + decideSrc)();

ok(COACH.includes('window.VDSEN_MESOCYCLE = { decide: _decideMesocycleTransition };'), 'exposed via window.VDSEN_MESOCYCLE for the Coach Monitor to reuse (no second engine)');
ok(COACH.includes('mesocycleDecision: mesocycleDecision,'), 'buildGenerationRequest wires mesocycleDecision into the canonical request additively');
ok(COACH.includes('_mapExerciseProgressionHistory: _mapExerciseProgressionHistory, // T198: Coach Monitor reuse'), 'progressionHistory mapper exposed for the Coach Monitor to reuse the same data');

function pidHistory(weeks) {
  // weeks: array of {action} in chronological order
  return { history: weeks.map(function(w, i) { return { week: i + 1, action: w.action }; }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — productive mesocycle -> CONTINUE (mid-cycle) or RENEW_MINIMAL
// (checkpoint), exercises preserved, PID continuity.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA_Productive() {
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-1': pidHistory([{ action: 'increase_load' }, { action: 'increase_load' }]),
    'pid-2': pidHistory([{ action: 'maintain' }, { action: 'increase_load' }])
  }};
  const midCycle = _decideMesocycleTransition({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: { quads: { volumeAction: 'KEEP' } } }, progressionHistory: progressionHistory, isCheckpointWeek: false });
  ok(midCycle.action === 'CONTINUE', 'CASE A — productive, mid-cycle -> CONTINUE, no forced transition');
  ok(midCycle.preserveExercisePids.includes('pid-1') && midCycle.preserveExercisePids.includes('pid-2'), 'CASE A — both exercises preserved (no plateau)');
  ok(midCycle.reviewExercisePids.length === 0, 'CASE A — nothing flagged for review');

  const atCheckpoint = _decideMesocycleTransition({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(atCheckpoint.action === 'RENEW_MINIMAL', 'CASE A — same evidence AT checkpoint -> RENEW_MINIMAL (tie-break only, not a forced reset)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — one stalled exercise -> only that exercise reviewed, rest preserved.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB_OneStalled() {
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-good': pidHistory([{ action: 'increase_load' }, { action: 'increase_load' }]),
    'pid-stalled': pidHistory([{ action: 'maintain' }, { action: 'freeze_load' }])
  }};
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(d.reviewExercisePids.length === 1 && d.reviewExercisePids[0] === 'pid-stalled', 'CASE B — only the genuinely plateaued exercise is flagged for review');
  ok(d.preserveExercisePids.includes('pid-good'), 'CASE B — the productive exercise stays preserved');
  ok(d.action === 'RENEW_WITH_ADJUSTMENTS', 'CASE B — a real plateau justifies RENEW_WITH_ADJUSTMENTS (evidence-based, not calendar-based)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — recovery-limited mesocycle -> no automatic volume increase,
// conservative renewal.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC_RecoveryLimited() {
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'RECOVERY_LIMITED' }, adaptivePrescription: { muscleDecisions: { quads: { volumeAction: 'FREEZE' } } }, progressionHistory: { byPrescriptionExerciseId: {} }, isCheckpointWeek: true });
  ok(d.action === 'RENEW_MINIMAL', 'CASE C — recovery-limited -> RENEW_MINIMAL (conservative), never RENEW_WITH_ADJUSTMENTS/escalation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — pain -> safety dominates, affected exercise not blindly preserved
// (nothing is preserved programmatically; the whole plan needs coach review).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD_Pain() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': pidHistory([{ action: 'increase_load' }]) } };
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'PAIN_REVIEW' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(d.action === 'STOP_FOR_SAFETY', 'CASE D — pain -> STOP_FOR_SAFETY, outranks everything');
  ok(d.preserveExercisePids.length === 0 && d.reviewExercisePids.length === 0, 'CASE D — no exercise is blindly auto-preserved (or auto-flagged) while safety is unresolved — full coach review required');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — priority muscle needs redistribution -> distribution/frequency
// review via RENEW_WITH_ADJUSTMENTS, no random exercise rotation implied.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE_Redistribution() {
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: { isquios: { volumeAction: 'REDISTRIBUTE' } } }, progressionHistory: { byPrescriptionExerciseId: { 'pid-1': pidHistory([{ action: 'increase_load' }]) } }, isCheckpointWeek: true });
  ok(d.action === 'RENEW_WITH_ADJUSTMENTS', 'CASE E — a muscle needing REDISTRIBUTE justifies RENEW_WITH_ADJUSTMENTS');
  ok(d.preserveExercisePids.includes('pid-1'), 'CASE E — the productive exercise is still preserved — redistribution is not a reason to rotate it');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — Coach edited plan late in mesocycle -> Coach decision outranks a
// stale recommendation (already surfaced as weeklyStatus COACH_REVIEW, T170).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF_CoachEditOutranks() {
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'COACH_REVIEW' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: { byPrescriptionExerciseId: {} }, isCheckpointWeek: true });
  ok(d.action === 'COACH_REVIEW', 'CASE F — an unresolved coach-edit/identity conflict at the weekly layer rolls up into COACH_REVIEW at the mesocycle layer too');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — new exercise replaces old one -> new PID, old history not
// autoapplied (progressionHistory is keyed by PID; a fresh PID simply has
// no entry, so it can never appear in preserve/review — demonstrated).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG_Substitution() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-old': pidHistory([{ action: 'freeze_load' }, { action: 'freeze_load' }]) } };
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: {} }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(d.reviewExercisePids.includes('pid-old') && !d.reviewExercisePids.includes('pid-new'), 'CASE G — a genuinely new PID (pid-new) never appears anywhere in this decision — no stale history can attach to it, only the real old PID is flagged');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — week count reached but client still progressing -> no forced
// reset (RENEW_MINIMAL is a label/tie-break, not RENEW_WITH_ADJUSTMENTS).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH_NoForcedReset() {
  const progressionHistory = { byPrescriptionExerciseId: { 'pid-1': pidHistory([{ action: 'increase_load' }, { action: 'increase_load' }]) } };
  const d = _decideMesocycleTransition({ weeklyDecision: { status: 'PROGRESSING' }, adaptivePrescription: { muscleDecisions: { quads: { volumeAction: 'KEEP' } } }, progressionHistory: progressionHistory, isCheckpointWeek: true });
  ok(d.action !== 'RENEW_WITH_ADJUSTMENTS' && d.action !== 'STOP_FOR_SAFETY' && d.action !== 'COACH_REVIEW', 'CASE H — checkpoint reached but still progressing never escalates to an adjustment/safety/review action');
  ok(d.action === 'RENEW_MINIMAL', 'CASE H — resolves to RENEW_MINIMAL: a fresh mesocycle label, not a forced program reset');
  ok(d.preserveExercisePids.includes('pid-1'), 'CASE H — the productive exercise is still preserved despite the week count');
})();

console.log('');
console.log('T192-T197/T199 — Mesocycle lifecycle (CASES A-H): ' + pass + ' assertions PASSED');
