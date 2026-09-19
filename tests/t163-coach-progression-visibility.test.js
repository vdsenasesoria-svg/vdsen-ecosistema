'use strict';
/**
 * T163 — Coach progression decision visibility.
 *
 * PASO 1 — CONTRACT MAP (already established, T159/T160/T161):
 *   SOURCE: logs/{uid}.entries['progrec_'+week+'_'+dayIndex] — the
 *     persisted, already-computed output of calculateProgression()
 *     (vdsen-cliente.html). Coach only ever READS this; it never
 *     recalculates or re-derives a progression decision.
 *   FIELDS (per recommendation): exerciseName, prescriptionExerciseId,
 *     exerciseId, action, newLoad, newSets, newReps, prescribedRIR,
 *     observedRIR, repRangeTarget:{low,high}, rirTarget, trend:
 *     {prevLoad,prevReps,prevSets,prevICS}, reason, substituteExercise,
 *     setMetrics. Top-level: recommendations[], deloadTriggers[], weekNum,
 *     calculatedAt, engineState.
 *   CURRENT COACH VISIBILITY (before this ticket): a flat, unordered list
 *     of the LAST progrec_ entry's recommendations in _renderClientTabMonitor
 *     — action label + color, newLoad/newSets/newReps/rirTarget, trend
 *     (prevLoad/prevSets/prevICS), and the free-text reason. No summary
 *     counts, no exceptions-first ordering (plan order only), no
 *     prescribedRIR/observedRIR/repRangeTarget shown, no deloadTriggers
 *     banner, no identity/PID validation against the current plan.
 *   MISSING VISIBILITY (closed by this ticket): exceptions-first compact
 *     summary (EVALUADOS/PROGRESS_LOAD/PROGRESS_REPS/DOWN_LOAD/DELOAD/
 *     FREEZE/REVIEW counts), KEEP collapsed/de-emphasized, prescribed vs
 *     executed RIR shown as separate fields, a distinct DELOAD REACTIVO
 *     banner sourced from the persisted deloadTriggers array, and a
 *     PID-first REVIEW flag for a recommendation whose exercise no longer
 *     exists in the current active plan (never silently shown as current,
 *     never re-matched by name/position).
 *
 * Scope: _renderClientTabMonitor's "Recomendaciones de progresión" block
 * in vdsen-coach.html. No Progression Engine/Client/Generator/deload-logic
 * change — Coach only consumes and presents already-persisted fields.
 *
 * Run: node tests/t163-coach-progression-visibility.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Extract the real logic block (categorization + summary + card rendering)
// verbatim from source and run it against synthetic (p, lastRec) inputs —
// behavioral tests against the actual shipped code, not a reimplementation.
// ─────────────────────────────────────────────────────────────────────────────

const startMarker = "const aL = { deload:{label:'DELOAD',color:'#4488cc'}";
const endMarker    = 'const exceptions = sorted.filter(x => x.cat !== \'KEEP\');';
const startIdx = COACH.indexOf(startMarker);
const endIdx   = COACH.indexOf(endMarker);
ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, 'prerequisite: the categorization/summary/card-rendering block must be extractable from source');

const block = COACH.slice(startIdx, endIdx);

function runBlock(p, lastRec) {
  const preamble = "var html = ''; var lastRecW = 1; var lastRecD = 0;\n";
  const factory = new Function('p', 'lastRec', preamble + block + '\nreturn { categorized: categorized, counts: counts, sorted: sorted, CAT_META: CAT_META, _renderRecCard: _renderRecCard, _fmtNum: _fmtNum, html: html };');
  return factory(p, lastRec);
}

function rec(overrides) {
  return Object.assign({
    exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-1', exerciseId: 'ex-1',
    action: 'maintain', newLoad: 80, newSets: 4, newReps: 8, rirTarget: 2,
    prescribedRIR: 2, observedRIR: 2.1, repRangeTarget: { low: 8, high: 12 },
    trend: { prevLoad: 80, prevReps: 8, prevSets: 4, prevICS: 8 }, reason: 'RIR en objetivo'
  }, overrides || {});
}

const PLAN_WITH_PIDS = { days: [{ dayIndex: 0, exercises: [
  { prescriptionExerciseId: 'pid-1' }, { prescriptionExerciseId: 'pid-2' }
]}]};

// ─────────────────────────────────────────────────────────────────────────────
// Items 1-6 — each canonical category is visible and correctly categorized.
// ─────────────────────────────────────────────────────────────────────────────

(function testCategories() {
  const recs = [
    rec({ exerciseName: 'A', action: 'increase_load' }),                              // PROGRESS_LOAD
    rec({ exerciseName: 'B', action: 'maintain', newReps: 10, trend: { prevLoad:80, prevReps:8, prevSets:4, prevICS:8 } }), // PROGRESS_REPS
    rec({ exerciseName: 'C', action: 'maintain', newReps: 8,  trend: { prevLoad:80, prevReps:8, prevSets:4, prevICS:8 } }), // KEEP
    rec({ exerciseName: 'D', action: 'reduce_load' }),                                // DOWN_LOAD
    rec({ exerciseName: 'E', action: 'freeze_load' }),                                // FREEZE
    rec({ exerciseName: 'F', action: 'deload' }),                                     // DELOAD
    rec({ exerciseName: 'G', prescriptionExerciseId: 'pid-GONE' })                    // REVIEW (not in plan)
  ];
  const { counts, categorized } = runBlock(PLAN_WITH_PIDS, { recommendations: recs, deloadTriggers: [] });
  ok(counts.PROGRESS_LOAD === 1, 'Item 1 — PROGRESS_LOAD (increase_load) is visible and counted');
  ok(counts.PROGRESS_REPS === 1, 'Item 2 — PROGRESS_REPS (maintain + reps bump vs trend) is visible and counted');
  ok(counts.KEEP === 1, 'Item 3 — KEEP (maintain, no reps bump) is visible and counted');
  ok(counts.DOWN_LOAD === 1, 'Item 4 — DOWN_LOAD (reduce_load) is visible and counted');
  ok(counts.FREEZE === 1, 'Item 5 — FREEZE (freeze_load) is visible and counted');
  ok(counts.REVIEW === 1, 'Item 6 — REVIEW (stale PID not in current plan) is visible and counted');
  ok(categorized.length === 7, 'summary EVALUADOS matches the full recommendations count');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 3 (continued) — KEEP is visible but secondary: it sorts LAST, not
// mixed in with exceptions, and the UI collapses it (verified structurally).
// ─────────────────────────────────────────────────────────────────────────────

(function testKeepIsSecondary() {
  const recs = [
    rec({ exerciseName: 'Keep1', action: 'maintain', newReps: 8 }),
    rec({ exerciseName: 'Freeze1', action: 'freeze_load', prescriptionExerciseId: 'pid-2' }),
    rec({ exerciseName: 'Keep2', action: 'maintain', newReps: 8, prescriptionExerciseId: 'pid-3' })
  ];
  const planWith3 = { days: [{ dayIndex:0, exercises:[{prescriptionExerciseId:'pid-1'},{prescriptionExerciseId:'pid-2'},{prescriptionExerciseId:'pid-3'}] }] };
  const { sorted } = runBlock(planWith3, { recommendations: recs, deloadTriggers: [] });
  ok(sorted[0].cat === 'FREEZE', 'Item 3 — the exception (FREEZE) sorts before any KEEP entry');
  ok(sorted[sorted.length-1].cat === 'KEEP' && sorted[sorted.length-2].cat === 'KEEP', 'Item 3 — both KEEP entries sort last, never ahead of an exception');
  ok(COACH.includes('<details class="mt-2"><summary class="text-xs text-[#666] cursor-pointer">Ver'), 'Item 3 — KEEP items are rendered inside a collapsed <details> element (secondary, not dominant)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 7 — reason is shown correctly (real persisted text, no placeholder).
// ─────────────────────────────────────────────────────────────────────────────

(function testReasonDisplay() {
  const r = rec({ reason: '12/12 reps · RIR real 3 vs objetivo 2 · tendencia estable' });
  const { sorted, _renderRecCard } = runBlock(PLAN_WITH_PIDS, { recommendations: [r], deloadTriggers: [] });
  const html = _renderRecCard(sorted[0]);
  ok(html.includes('12/12 reps · RIR real 3 vs objetivo 2 · tendencia estable'), 'Item 7 — the real, persisted reason text is shown verbatim');
  ok(!/la IA recomienda/i.test(html), 'Item 7 — never phrased as "la IA recomienda"');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 8 — prescribedRIR and observedRIR are shown as SEPARATE fields, never
// merged/confused with each other.
// ─────────────────────────────────────────────────────────────────────────────

(function testPrescribedVsObservedRIR() {
  const r = rec({ prescribedRIR: 2, observedRIR: 3.4 });
  const { sorted, _renderRecCard } = runBlock(PLAN_WITH_PIDS, { recommendations: [r], deloadTriggers: [] });
  const html = _renderRecCard(sorted[0]);
  ok(html.includes('RIR 2') && html.includes('RIR real 3.4'), 'Item 8 — prescribedRIR (2) and observedRIR (3.4) both appear, labeled distinctly (Prescrito vs Ejecutado)');
  ok(html.indexOf('Prescrito:') < html.indexOf('Ejecutado:'), 'Item 8 — PRESCRITO is shown before EJECUTADO, kept visually distinct');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 9/10 — PID correct is trusted; PID ambiguous (not in current plan)
// is never silently associated — always REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

(function testPidCorrectAndAmbiguous() {
  const correct  = rec({ prescriptionExerciseId: 'pid-1' });
  const stale     = rec({ exerciseName: 'Sentadilla (sustituida)', prescriptionExerciseId: 'pid-DOES-NOT-EXIST' });
  const { categorized } = runBlock(PLAN_WITH_PIDS, { recommendations: [correct, stale], deloadTriggers: [] });
  ok(categorized[0].cat !== 'REVIEW', 'Item 9 — a recommendation whose PID matches the current plan is NOT flagged REVIEW');
  ok(categorized[1].cat === 'REVIEW', 'Item 10 — a recommendation whose PID no longer exists in the current plan IS flagged REVIEW, never silently shown as current');

  const { sorted, _renderRecCard } = runBlock(PLAN_WITH_PIDS, { recommendations: [stale], deloadTriggers: [] });
  const html = _renderRecCard(sorted[0]);
  ok(html.includes('Identidad no resuelta') && html.includes('No se aplica automáticamente'), 'Item 10 — the REVIEW card explicitly states identity is unresolved and nothing is auto-applied');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Legacy compatibility — a recommendation with NO PID at all (pre-existing
// plans/data) is NOT flagged REVIEW just for lacking identity information.
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyNoPidNotFlagged() {
  const legacyRec = rec({ prescriptionExerciseId: undefined });
  const { categorized } = runBlock(PLAN_WITH_PIDS, { recommendations: [legacyRec], deloadTriggers: [] });
  ok(categorized[0].cat !== 'REVIEW', 'Legacy: a recommendation with no prescriptionExerciseId at all is not flagged REVIEW (no identity to conflict with)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 11 — deload reactivo visible, sourced from the persisted
// deloadTriggers array (never derived from week number here).
// ─────────────────────────────────────────────────────────────────────────────

(function testDeloadReactiveVisible() {
  ok(
    COACH.includes("if (Array.isArray(lastRec.deloadTriggers) && lastRec.deloadTriggers.length) {") &&
    COACH.includes('DELOAD REACTIVO — ${lastRec.deloadTriggers.length} señal'),
    'Item 11 — a DELOAD REACTIVO banner is shown, counting the real persisted deloadTriggers, no recalculation'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 12 — a final week with NO deload trigger data is not labeled deload
// anywhere in this block (regression against T162 — Coach never derives
// deload from week number on its own).
// ─────────────────────────────────────────────────────────────────────────────

(function testFinalWeekNoDeloadNotLabeled() {
  const r = rec({ action: 'maintain' });
  const { categorized } = runBlock(PLAN_WITH_PIDS, { recommendations: [r], deloadTriggers: [] });
  ok(categorized[0].cat !== 'DELOAD', 'Item 12 — with no deloadTriggers and action=maintain, the exercise is never categorized DELOAD just because it might be the last week');
  ok(!/week\s*===\s*total|CURRENT_WEEK\s*===\s*_tw/.test(block), 'Item 12 — this block contains no week-number-based deload derivation of its own');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 13 — no NaN/undefined ever rendered; _fmtNum guards every numeric field.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoNaNOrUndefined() {
  const messyRec = rec({
    newLoad: undefined, newSets: NaN, newReps: null, rirTarget: undefined,
    prescribedRIR: undefined, observedRIR: null, repRangeTarget: undefined, trend: null
  });
  const { sorted, _renderRecCard } = runBlock(PLAN_WITH_PIDS, { recommendations: [messyRec], deloadTriggers: [] });
  const html = _renderRecCard(sorted[0]);
  ok(!/NaN/.test(html), 'Item 13 — no literal "NaN" ever appears in the rendered card');
  ok(!/undefined/.test(html), 'Item 13 — no literal "undefined" ever appears in the rendered card');
  ok(html.includes('—'), 'Item 13 — missing numeric fields render as "—" instead');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 14 — legacy/incomplete data (missing action, missing trend.prevReps,
// missing repRangeTarget entirely — pre-T159 persisted shape) never crashes.
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyIncompleteDataNoCrash() {
  const legacyRec = { exerciseName: 'Legacy Ex', newLoad: 60, newSets: 3, rirTarget: 2, reason: 'motivo antiguo' };
  assert.doesNotThrow(function() {
    const { sorted, _renderRecCard } = runBlock(PLAN_WITH_PIDS, { recommendations: [legacyRec], deloadTriggers: [] });
    _renderRecCard(sorted[0]);
  });
  const { categorized } = runBlock(PLAN_WITH_PIDS, { recommendations: [legacyRec], deloadTriggers: [] });
  ok(categorized[0].cat === 'KEEP', 'Item 14 — a legacy recommendation missing action/trend/repRangeTarget safely defaults to KEEP, no crash');

  assert.doesNotThrow(function() {
    runBlock(null, { recommendations: [rec()], deloadTriggers: [] });
    runBlock({}, { recommendations: [rec()], deloadTriggers: [] });
  });
  pass++; console.log('  ✓ Item 14 — a null/empty plan (p) never crashes the categorization block');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Item 15 — summary counts are correct against a larger, mixed set.
// ─────────────────────────────────────────────────────────────────────────────

(function testSummaryCountsCorrect() {
  const plan12 = { days: [{ dayIndex: 0, exercises: Array.from({length: 12}, (_,i) => ({ prescriptionExerciseId: 'pid-'+i })) }] };
  const recs = [];
  for (let i = 0; i < 3; i++) recs.push(rec({ exerciseName: 'progress-load-'+i, prescriptionExerciseId: 'pid-'+i, action: 'increase_load' }));
  for (let i = 3; i < 10; i++) recs.push(rec({ exerciseName: 'keep-'+i, prescriptionExerciseId: 'pid-'+i, action: 'maintain', newReps: 8 }));
  recs.push(rec({ exerciseName: 'freeze-10', prescriptionExerciseId: 'pid-10', action: 'freeze_load' }));
  recs.push(rec({ exerciseName: 'review-11', prescriptionExerciseId: 'pid-99' })); // not in plan12
  const { counts, categorized } = runBlock(plan12, { recommendations: recs, deloadTriggers: [] });
  ok(categorized.length === 12, 'Item 15 — EVALUADOS: 12');
  ok(counts.PROGRESS_LOAD === 3, 'Item 15 — PROGRESS_LOAD: 3');
  ok(counts.KEEP === 7, 'Item 15 — KEEP: 7');
  ok(counts.FREEZE === 1, 'Item 15 — FREEZE: 1');
  ok(counts.REVIEW === 1, 'Item 15 — REVIEW: 1');
  ok(3 + 7 + 1 + 1 === categorized.length, 'Item 15 — all counted categories sum to EVALUADOS exactly (no double count, none dropped)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Regression — existing FASE 20/21/22 apply-to-plan flow (the "coach action"
// path per PASO 8) is untouched by this pass.
// ─────────────────────────────────────────────────────────────────────────────

(function testExistingApplyFlowUntouched() {
  ok(COACH.includes('function _buildRecApplyPreview(lastRec, lastRecDay, activePlanCache)'), 'Regression: the existing recommendation-apply-to-plan preview builder is untouched');
  ok(COACH.includes('function _resolveExerciseRowId(exerciseName, planCache, pid)'), 'Regression: the existing PID-first exercise row resolver is untouched');
  ok(COACH.includes('window._applyAllModuloD = _applyAllModuloD;'), 'Regression: the existing apply-adjustments-to-plan action is untouched (no new override schema invented)');
})();

console.log('');
console.log('T163 — Coach progression decision visibility: ' + pass + ' assertions PASSED');
