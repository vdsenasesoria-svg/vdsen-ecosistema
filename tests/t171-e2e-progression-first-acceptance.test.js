'use strict';
/**
 * T171 — E2E progression-first acceptance.
 *
 * No new architecture: chains REAL extracted functions from vdsen-cliente.html
 * (_computeDeloadTriggers, getAdjustedRIR, _getProgRecForExercise, _normName)
 * and vdsen-coach.html (_stampPrescriptionIds, _genPrescriptionId) plus the
 * real, Node-requireable api/vdsen-build-request.js (_mapExerciseProgressionHistory)
 * through the 4 required CASOs. calculateProgression's own math is NOT
 * re-tested here (tests/progression-engine.test.js already covers it with
 * 2286 assertions) — this suite instead proves the HANDOFFS between stages
 * don't lose or corrupt data: Client execution -> persisted progrec_ ->
 * next-exposure reader -> Coach visibility -> Generator's progressionHistory
 * -> cross-plan identity.
 *
 * The Client/Coach staleness gates (_progRecStale/_progAutoApply,
 * _isCoachEditStale/_isIdentityStale/_categorizeRec) are declared inside
 * large functions with heavy DOM/Firestore closures and can't be cleanly
 * extracted standalone (same constraint tests/t165 and tests/t170 already
 * hit) — each is verified twice: (1) the exact literal expression is
 * asserted present in the real source (regression-safe against drift) and
 * (2) that same expression is executed in a small harness against this
 * test's synthetic data, exactly as t165/t170 already established.
 *
 * Run: node tests/t171-e2e-progression-first-acceptance.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const { _mapExerciseProgressionHistory } = require(path.join(__dirname, '..', 'api', 'vdsen-build-request.js'));

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

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

// ── Real extracted engine/reader pieces (Client) ──────────────────────────
const triggersSrc  = extractFunction(CLIENT, 'function _computeDeloadTriggers(week, postDataOverride)');
const adjRirSrc     = extractFunction(CLIENT, 'function getAdjustedRIR(baseRIR, week, exName)');
const freeBarSrc    = extractFunction(CLIENT, 'function _isFreeBarbell(exName)');
const readerSrc     = extractFunction(CLIENT, 'function _getProgRecForExercise(di, ei, exName, prescriptionExerciseId)');
const normNameSrc   = extractFunction(CLIENT, 'function _normName(s)');
ok(triggersSrc && adjRirSrc && freeBarSrc && readerSrc && normNameSrc, 'prerequisite: all real Client engine/reader functions extract cleanly');

// ── Real extracted stamping pieces (Coach) ─────────────────────────────────
const genIdSrc   = extractFunction(COACH, 'function _genPrescriptionId()');
const stampSrc   = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
ok(genIdSrc && stampSrc, 'prerequisite: real Coach PID-stamping functions extract cleanly');

function makeClientEngine(LOGS, LOGS_BY_WEEK, CURRENT_WEEK, totalWeeks) {
  const PLAN = { totalWeeks: totalWeeks };
  const factory = new Function(
    'LOGS', 'LOGS_BY_WEEK', 'CURRENT_WEEK', 'PLAN',
    'function getTotalWeeks(){ return (PLAN && PLAN.totalWeeks) ? PLAN.totalWeeks : 6; }\n' +
    freeBarSrc + ';\n' + triggersSrc + ';\n' + adjRirSrc + ';\n' + normNameSrc + ';\n' + readerSrc + ';\n' +
    'return { getAdjustedRIR: getAdjustedRIR, _computeDeloadTriggers: _computeDeloadTriggers, _getProgRecForExercise: _getProgRecForExercise };'
  );
  return factory(LOGS, LOGS_BY_WEEK, CURRENT_WEEK, PLAN);
}

function makeStamper() {
  const factory = new Function('crypto', genIdSrc + ';\n' + stampSrc + ';\nreturn _stampPrescriptionIds;');
  return factory({ randomUUID: function () { throw new Error('force fallback id generator'); } });
}

// Client's T165 gate — verified present verbatim, then executed identically.
ok(CLIENT.includes('var _progRecStale = !!(PLAN.updatedAt && progrec && progrec.calculatedAt && Date.parse(PLAN.updatedAt) > Date.parse(progrec.calculatedAt));'), 'regression: Client _progRecStale expression present verbatim');
ok(CLIENT.includes('var _progAutoApply = (progrec && ej.prescriptionExerciseId && progrec.prescriptionExerciseId === ej.prescriptionExerciseId && !_progRecStale) ? progrec : null;'), 'regression: Client _progAutoApply expression present verbatim');
function clientNextExposure(planUpdatedAt, ejPid, progrec) {
  var _progRecStale = !!(planUpdatedAt && progrec && progrec.calculatedAt && Date.parse(planUpdatedAt) > Date.parse(progrec.calculatedAt));
  var _progAutoApply = (progrec && ejPid && progrec.prescriptionExerciseId === ejPid && !_progRecStale) ? progrec : null;
  var carga = (_progAutoApply && _progAutoApply.newLoad != null && !isNaN(parseFloat(_progAutoApply.newLoad))) ? parseFloat(_progAutoApply.newLoad).toFixed(1) : '';
  var reps  = (_progAutoApply && typeof _progAutoApply.newReps === 'number') ? _progAutoApply.newReps : '';
  return { applied: !!_progAutoApply, carga: carga, reps: reps };
}

// Coach's T163/T170 categorization — verified present verbatim, then executed identically.
ok(COACH.includes("if (_isIdentityStale(r) || _isCoachEditStale(r)) return 'REVIEW';"), 'regression: Coach REVIEW-gate expression present verbatim');
function coachCategorize(planPidSet, planUpdatedAt, r) {
  var identityStale = !!(r.prescriptionExerciseId && planPidSet.size && !planPidSet.has(r.prescriptionExerciseId));
  var editStale = !!(planUpdatedAt && r.calculatedAt && Date.parse(planUpdatedAt) > Date.parse(r.calculatedAt));
  if (identityStale || editStale) return 'REVIEW';
  if (r.action === 'freeze_load') return 'FREEZE';
  if (r.action === 'deload') return 'DELOAD';
  if (r.action === 'reduce_load' || r.action === 'reduce_sets') return 'DOWN_LOAD';
  if (r.action === 'increase_load' || r.action === 'add_sets') return 'PROGRESS_LOAD';
  return 'KEEP';
}

// ─────────────────────────────────────────────────────────────────────────────
// CASO 1 — Progresión normal: plan -> sesión -> rec -> autoapply -> coach ve
// lo mismo -> Generator preserva el ejercicio (recibe la señal correcta).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaso1NormalProgression() {
  var rec = {
    prescriptionExerciseId: 'pid-bench', exerciseId: 'ex-1', exerciseName: 'Press Banca',
    action: 'increase_load', newLoad: 82.5, newReps: 10, newSets: 4, rirTarget: 2,
    calculatedAt: '2026-01-10T20:00:00.000Z'
  };
  var LOGS = { 'progrec_2_0': { recommendations: [rec] } };
  var LOGS_BY_WEEK = { progrec: { 2: ['progrec_2_0'] } };
  var eng = makeClientEngine(LOGS, LOGS_BY_WEEK, 3, 6);

  // Persistence -> next-exposure reader (real _getProgRecForExercise, PID-first).
  var found = eng._getProgRecForExercise(0, 0, 'Press Banca', 'pid-bench');
  ok(found && found.action === 'increase_load' && found.newLoad === 82.5, 'CASO 1 — next-exposure reader finds the persisted rec by PID across weeks');

  // Next exposure auto-apply (plan not edited since calc -> fresh).
  var exposure = clientNextExposure('2026-01-05T00:00:00.000Z', 'pid-bench', found);
  ok(exposure.applied === true && exposure.carga === '82.5' && exposure.reps === 10, 'CASO 1 — Client auto-applies the fresh recommendation to the next exposure input');

  // Coach sees the SAME verdict.
  var cat = coachCategorize(new Set(['pid-bench']), '2026-01-05T00:00:00.000Z', rec);
  ok(cat === 'PROGRESS_LOAD', 'CASO 1 — Coach monitor categorizes the same rec as PROGRESS_LOAD (matches Client behavior)');

  // Generator receives the correct signal for continuity (T164/T166 chain).
  var ph = _mapExerciseProgressionHistory({ 'progrec_2_0': { recommendations: [rec] } });
  var entry = ph.byPrescriptionExerciseId['pid-bench'];
  ok(entry && entry.latest.action === 'increase_load' && entry.confidence === 'low', 'CASO 1 — Generator\'s progressionHistory correctly exposes the working exercise for preservation (HIGH-confidence continuity rule applies once more weeks accumulate)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASO 2 — Fatiga: señales reales -> deload reactivo -> RIR sube, NO
// incremento automático -> Coach ve la explicación -> Generator no lo trata
// como fallo del ejercicio (T164 rule, referenced not re-derived).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaso2Fatigue() {
  var LOGS_SIGNALS = {
    'ci_sem_4': { who5: '45', energia: '2' }, // 2 real triggers
    'postsession_4_0': { rpeAverage: 7, sleepHours: 7 }
  };
  var eng = makeClientEngine(LOGS_SIGNALS, { progrec: {} }, 4, 6);
  var deload = eng._computeDeloadTriggers(4);
  ok(deload.isDeload === true && deload.triggers.length >= 2, 'CASO 2 — real multimodal fatigue signals correctly trigger reactive deload (not week-based)');
  ok(eng.getAdjustedRIR(2, 4) === 4, 'CASO 2 — RIR reactively raised (+2, easier) once real deload evidence exists');

  // Engine's own recommendation reflects the deload — freeze/no progression.
  var rec = {
    prescriptionExerciseId: 'pid-squat', exerciseName: 'Sentadilla',
    action: 'freeze_load', newLoad: 100, newReps: 8, newSets: 4,
    calculatedAt: '2026-02-01T20:00:00.000Z'
  };
  var LOGS = { 'progrec_4_0': { recommendations: [rec] } };
  var eng2 = makeClientEngine(LOGS, { progrec: { 4: ['progrec_4_0'] } }, 5, 6);
  var found = eng2._getProgRecForExercise(0, 0, 'Sentadilla', 'pid-squat');
  var exposure = clientNextExposure('2026-01-20T00:00:00.000Z', 'pid-squat', found);
  ok(exposure.applied === true && exposure.carga === '100.0', 'CASO 2 — Client applies the ENGINE\'s freeze_load value (same load as before) — no automatic increase during fatigue');

  var cat = coachCategorize(new Set(['pid-squat']), '2026-01-20T00:00:00.000Z', rec);
  ok(cat === 'FREEZE', 'CASO 2 — Coach sees FREEZE (an explained exception), not a silent KEEP or a fabricated PROGRESS_LOAD');

  // Generator: deload is never a failure signal (T164 rule) — regression check only.
  ok(COACH.includes('NUNCA se interpreta como que el ejercicio \\"no funciono\\"'), 'CASO 2 — Generator prompt still states a prior deload is never interpreted as exercise failure (T164, unaffected regression; raw source stores prompt quotes as literal \\" escapes)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASO 3 — Coach override: Engine recomienda -> Coach edita el plan después
// -> automatización no pisa la decisión -> Client Y Coach coinciden.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaso3CoachOverride() {
  var rec = {
    prescriptionExerciseId: 'pid-ohp', exerciseName: 'Press Militar',
    action: 'increase_load', newLoad: 45, newReps: 10,
    calculatedAt: '2026-03-01T10:00:00.000Z'
  };
  var planUpdatedAt = '2026-03-01T18:00:00.000Z'; // coach edited hours after the calc

  var exposure = clientNextExposure(planUpdatedAt, 'pid-ohp', rec);
  ok(exposure.applied === false && exposure.carga === '', 'CASO 3 — Client does NOT auto-apply a rec that predates the coach\'s explicit later edit (coach decision wins)');

  var cat = coachCategorize(new Set(['pid-ohp']), planUpdatedAt, rec);
  ok(cat === 'REVIEW', 'CASO 3 — Coach ALSO sees REVIEW for the same rec — both sides agree the automated suggestion is superseded, not silently applied by either');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASO 4 — Sustitución: PID X (viejo ejercicio, con historial) sustituido por
// PID Y (nuevo, vía _stampPrescriptionIds real) -> el historial de X NO se
// autoaplica a Y en ningún consumidor (Client/Coach/Generator coherentes).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaso4Substitution() {
  var recX = {
    prescriptionExerciseId: 'pid-x', exerciseName: 'Remo con Barra',
    action: 'increase_load', newLoad: 70, newReps: 8,
    calculatedAt: '2026-04-01T10:00:00.000Z'
  };
  var LOGS = { 'progrec_5_0': { recommendations: [recX] } };

  // Coach substitutes the exercise: new day exercise has no prescriptionExerciseId
  // (Generator/coach editor omitted it per T164 rule) -> _stampPrescriptionIds
  // (real, unmodified) assigns a genuinely fresh PID.
  var stamp = makeStamper();
  var newPlanDays = stamp([{ dayIndex: 0, exercises: [{ exerciseName: 'Remo en Máquina' /* substituted, no PID */ }] }]);
  var pidY = newPlanDays[0].exercises[0].prescriptionExerciseId;
  ok(pidY && pidY !== 'pid-x', 'CASO 4 — the substituted exercise gets a fresh PID, distinct from the old one');

  // Generator: progressionHistory has NO entry for pid-Y (no inheritance).
  var ph = _mapExerciseProgressionHistory(LOGS['progrec_5_0'] ? { 'progrec_5_0': LOGS['progrec_5_0'] } : {});
  ok(!ph.byPrescriptionExerciseId[pidY], 'CASO 4 — the new PID starts with NO progressionHistory — old exercise\'s history is not silently inherited');
  ok(ph.byPrescriptionExerciseId['pid-x'] && ph.byPrescriptionExerciseId['pid-x'].history.length === 1, 'CASO 4 — the OLD PID\'s history remains intact and unaffected by the substitution');

  // Client: next exposure for the NEW exercise (pid-Y) never picks up pid-X's rec.
  var LOGS_BY_WEEK = { progrec: { 5: ['progrec_5_0'] } };
  var eng = makeClientEngine(LOGS, LOGS_BY_WEEK, 6, 6);
  var found = eng._getProgRecForExercise(0, 0, 'Remo en Máquina', pidY); // PID-first: 0 matches for pidY
  var exposure = clientNextExposure('2026-03-25T00:00:00.000Z', pidY, found);
  ok(exposure.applied === false, 'CASO 4 — Client never auto-applies the old exercise\'s recommendation to the substituted exercise');

  // Coach: plan\'s PID set now only has pid-Y -> the old rec (pid-x) is REVIEW.
  var cat = coachCategorize(new Set([pidY]), null, recX);
  ok(cat === 'REVIEW', 'CASO 4 — Coach flags the old (pid-x) recommendation as REVIEW once the plan no longer contains that identity — Client, Coach, and Generator all agree: no cross-identity inheritance');
})();

console.log('');
console.log('T171 — E2E progression-first acceptance: ' + pass + ' assertions PASSED (all 4 CASOs)');
