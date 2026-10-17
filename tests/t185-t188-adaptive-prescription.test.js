'use strict';
/**
 * T184 — Current volume/frequency contract map (audit, no mismatch fixed):
 *
 *   SOURCE                  CURRENT CALCULATION                    CONSUMER
 *   _POPULATION_PRIORS      mev/mav/mrv per muscle (~21 groups,     _computeMuscleTargets
 *                           "compendio VDSEN")
 *   _EXERCISE_CANONICAL_METADATA  primary/secondary/stabilizer per  auditFractionalVolume
 *                           exercise (direct×1/indirect×0.5/
 *                           stabilizer×0 — UNCHANGED, preserved)
 *   _computeMuscleTargets   volumeTarget/volumeRange/frequencyTarget/  buildPrescriptionContext
 *                           rirRange per muscle. Source hierarchy      ONLY (legacy path)
 *                           learned_state > ehrenstein_prior >
 *                           population_prior (P10.1/P10.3). Frequency
 *                           ALREADY derived from volume (P10.4) —
 *                           "not chosen independently" (pre-existing
 *                           comment, matches this ticket's Core Principle
 *                           verbatim).
 *
 *   FINDING (documented, not fixed): _computeMuscleTargets — the exact
 *   sophisticated volume+frequency-derivation engine T185-187 asks for —
 *   already existed but was wired ONLY into the legacy buildPrescriptionContext
 *   path (same recurring pattern as T166's progressionHistory and T181's
 *   weeklyDecision: real logic built for the demoted text-prompt flow,
 *   never ported to the canonical JSON request). This ticket's real work is
 *   porting/reusing it into the canonical path, not building new math.
 *
 *   KNOWN_PRIORS mismatch (documented, NOT fixed — inert, non-interacting
 *   duplication, pre-existing): a SEPARATE, simpler sets-only volume table
 *   (VDSEN_MEVMRV + VDSEN_MUSCLE_MAP/exerciseToMuscle, used only by the
 *   display-only computeWeeklyVolume/renderVolumePanel) uses a DIFFERENT
 *   muscle-naming scheme (dorsal_ancho/delt_anterior/gluteo_mayor vs
 *   dorsales/deltoides_anterior/gluteos) and different MEV/MRV numbers
 *   (e.g. pectoral MEV=10 vs _POPULATION_PRIORS' MEV=8) for the same
 *   muscle. The two systems never cross-reference each other — not a
 *   functional bug, just parallel infrastructure; reconciling which
 *   compendio table is authoritative requires domain judgment outside this
 *   codebase, so left untouched.
 *
 * T185/T186/T187 — _decideAdaptivePrescription(input): per-muscle verdict
 * (volumeAction/frequencyAction/distributionAction), gated by T177's
 * weeklyDecision.status first (safety/adherence/recovery/coach-review
 * outrank any volume read), then compares the PREVIOUS plan's real applied
 * volume (auditFractionalVolume, unchanged) against the computed target
 * range (_computeMuscleTargets, unchanged) and current frequency. The only
 * NEW threshold-adjacent concept is "sessionQualityDrop", which reuses the
 * EXISTING ICS>=7 cutoff (T177) rather than inventing a new one, and there
 * is no per-muscle technique-quality signal in this codebase to draw a
 * finer-grained REDISTRIBUTE trigger from (documented limitation, not a bug).
 *
 * T188 — _computeAdaptivePrescriptionForRequest wires the above into the
 * canonical buildGenerationRequest as `adaptivePrescription`, via the same
 * window.VDSEN_ADAPTIVE lazy cross-script-block pattern as T181's
 * window.VDSEN_WEEKLY.
 *
 * T190 E2E — CASES A-H are satisfied directly below (the classification
 * function IS what T190 asks to exercise).
 *
 * Run: node tests/t185-t188-adaptive-prescription.test.js
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

const decideSrc = extractFunction(COACH, 'function _decideAdaptivePrescription(input)');
ok(decideSrc, '_decideAdaptivePrescription extracts cleanly');
const _decideAdaptivePrescription = new Function('return ' + decideSrc)();

ok(COACH.includes('window.VDSEN_ADAPTIVE = { decide: _decideAdaptivePrescription, computeMap: _computeAdaptivePrescriptionMap };'), 'T185-188 exposed via window.VDSEN_ADAPTIVE for cross-script-block reuse (no second engine)');
ok(COACH.includes('adaptivePrescription: adaptivePrescription,'), 'buildGenerationRequest wires adaptivePrescription into the canonical request additively');

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — progressing + recovering: volume KEEP, frequency KEEP.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA_ProgressingRecovering() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'STABLE',
    target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 },
    actualVolume: { fractionalTotal: 14 },
    actualFrequency: 2
  });
  ok(d.volumeAction === 'KEEP' && d.frequencyAction === 'KEEP', 'CASE A — stable, within target range, matching frequency -> KEEP/KEEP');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — stalled but adherent/recovered: REVIEW_DECREASE (per this ticket's
// own rule: "REVIEW_DECREASE when persistent performance decline"), never an
// automatic increase.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB_StalledAdherent() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'PERFORMANCE_STALL',
    target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 },
    actualVolume: { fractionalTotal: 12 },
    actualFrequency: 2
  });
  ok(d.volumeAction === 'REVIEW_DECREASE', 'CASE B — persistent stall -> REVIEW_DECREASE, never an automatic increase just because adherence/recovery are fine');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — recovery-limited: REVIEW_DECREASE-or-FREEZE family; here FREEZE
// per the safety gate, no increase possible.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC_RecoveryLimited() {
  const d = _decideAdaptivePrescription({ weeklyStatus: 'RECOVERY_LIMITED', target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 }, actualVolume: { fractionalTotal: 10 }, actualFrequency: 2 });
  ok(d.volumeAction === 'FREEZE', 'CASE C — RECOVERY_LIMITED -> FREEZE, safety/recovery gate outranks any volume read, no increase');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — volume okay but session overloaded: REDISTRIBUTE, not necessarily
// lower weekly volume.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD_SessionOverloaded() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'PROGRESSING',
    target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 },
    actualVolume: { fractionalTotal: 7 }, // below range, would normally be REVIEW_INCREASE
    actualFrequency: 2,
    sessionQualityDrop: true
  });
  ok(d.volumeAction === 'REDISTRIBUTE', 'CASE D — a session quality drop defers an otherwise-justified increase into REDISTRIBUTE, not a lower total volume');
  ok(d.distributionAction === 'REVIEW', 'CASE D — distributionAction flags REVIEW for the session-concentration issue');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — priority muscle under-served: only reviewed if recovery supports
// it (weeklyStatus PROGRESSING + below range -> REVIEW_INCREASE; but if
// recovery does NOT support it, no increase — demonstrated via CASE C's FREEZE).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE_PriorityUnderservedWithRecoverySupport() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'PROGRESSING',
    target: { volumeTarget: 16, volumeRange: { min: 10, max: 24 }, frequencyTarget: 3 },
    actualVolume: { fractionalTotal: 8 }, // below MEV-equivalent
    actualFrequency: 2
  });
  ok(d.volumeAction === 'REVIEW_INCREASE', 'CASE E — under-served priority muscle WITH recovery support (PROGRESSING) -> REVIEW_INCREASE');
  ok(d.frequencyAction === 'REVIEW_INCREASE', 'CASE E — frequency review follows only because volume review was already justified AND target frequency exceeds current');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — one bad session: no automatic volume/frequency change. A single
// bad session does not, by itself, produce PERFORMANCE_STALL or
// RECOVERY_LIMITED at the weeklyDecision layer (T177 already requires
// multiple/majority signals) — demonstrated here as STABLE staying KEEP.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF_OneBadSession() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'STABLE', // T177: a single bad session alone does not reach PERFORMANCE_STALL (needs >50% majority) or RECOVERY_LIMITED (needs >=2 signals)
    target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 },
    actualVolume: { fractionalTotal: 14 },
    actualFrequency: 2
  });
  ok(d.volumeAction === 'KEEP' && d.frequencyAction === 'KEEP' && d.distributionAction === 'KEEP', 'CASE F — one bad session (still classified STABLE upstream) -> no automatic change');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — pain: safety/review dominates.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseG_Pain() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'PAIN_REVIEW',
    target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 },
    actualVolume: { fractionalTotal: 10 }, actualFrequency: 2
  });
  ok(d.volumeAction === 'FREEZE', 'CASE G — PAIN_REVIEW -> FREEZE, safety dominates regardless of volume numbers');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE H — low adherence: do not interpret lack of progress as insufficient
// volume (must not become REVIEW_INCREASE just because volume happens to be
// low too).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseH_LowAdherence() {
  const d = _decideAdaptivePrescription({
    weeklyStatus: 'ADHERENCE_LIMITED',
    target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 }, frequencyTarget: 2 },
    actualVolume: { fractionalTotal: 6 }, // below range — would look like "underdosed"
    actualFrequency: 1
  });
  ok(d.volumeAction === 'FREEZE', 'CASE H — low adherence -> FREEZE, low volume is NOT interpreted as evidence of underdosing when the data itself is unreliable');
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH_REVIEW gate + no-data fallback.
// ─────────────────────────────────────────────────────────────────────────────

(function testCoachReviewAndNoData() {
  const review = _decideAdaptivePrescription({ weeklyStatus: 'COACH_REVIEW', target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 } }, actualVolume: { fractionalTotal: 14 } });
  ok(review.volumeAction === 'COACH_REVIEW', 'unresolved identity conflict -> COACH_REVIEW, not a numeric volume verdict');

  const noData = _decideAdaptivePrescription({ weeklyStatus: 'PROGRESSING', target: { volumeTarget: 14, volumeRange: { min: 8, max: 22 } }, actualVolume: null });
  ok(noData.volumeAction === 'KEEP' && noData.reasons.includes('no_previous_volume_data'), 'no previous volume data -> KEEP with an honest reason, never a fabricated verdict');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural: fractional volume accounting (direct×1/indirect×0.5/
// stabilizer×0) is unchanged — regression check.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('muscleVolume[m].direct += numSets;') && COACH.includes('muscleVolume[m].fractionalTotal += numSets * 0.5;'),
  'regression: auditFractionalVolume\'s direct×1/indirect×0.5 accounting is untouched');
ok(COACH.includes('// Frequency derived from volume (P10.4) — not chosen independently'),
  'regression: _computeMuscleTargets already derives frequency from volume — unmodified, matches this ticket\'s Core Principle verbatim');

console.log('');
console.log('T185-T188/T190 — Adaptive prescription (CASES A-H): ' + pass + ' assertions PASSED');
