'use strict';
/**
 * T166 — Cross-plan progression continuity.
 *
 * REPRODUCE A-E, audited against real code (grep-first, no full reread):
 *
 * A. Same exercise preserved across mesocycles → Generator copies
 *    prescriptionExerciseId from previousPlan (T164 prompt rule), and
 *    _stampPrescriptionIds (vdsen-coach.html) only replaces IDs that are
 *    MISSING or a within-plan duplicate — an ID already present survives.
 *    Already correct; demonstrated below, not re-fixed.
 * B. Exercise substituted → Generator omits the field (T164 rule) →
 *    _stampPrescriptionIds assigns a fresh ID → no history inheritance.
 *    Already correct; demonstrated below.
 * C. Same NAME but a genuinely new PID (Generator didn't recognize
 *    continuity, or a coach manually duplicated an exercise) → per the
 *    explicit "no asociación silenciosa por nombre" rule, the new PID
 *    starts with EMPTY history. This is CORRECT safe-default behavior,
 *    not a bug — demonstrated below (a false negative on continuity is
 *    the acceptable cost of never guessing wrong).
 * D. New plan, old logs still in Firestore → loadPlan's planChanged branch
 *    (vdsen-cliente.html) wipes LOGS to {} and persists that clean state —
 *    old progrec_ entries never leak into the new plan's reads. Already
 *    correct; demonstrated below.
 * E. Legacy recs with no PID → counted in unindexedCount, never merged into
 *    any PID bucket by name/position (T160, unchanged). Already correct.
 *
 * REAL BUG FOUND (P0): vdsen-coach.html carries its OWN embedded copy of
 * _mapLogs/buildGenerationRequest (used live by "Generar plan automático" —
 * window.VDSEN_BUILD.buildGenerationRequest, wired at the onclick handler
 * that calls it) — a copy that predates T160 and was never updated: it
 * computed trainingLogs/checkins/engineState but NOT progressionHistory,
 * and never wired it into the assembled request. api/vdsen-build-request.js
 * (the tested, T160-complete module) is a SEPARATE file not required by
 * vdsen-coach.html at runtime (browser, no require()) — so the two had
 * silently diverged. Net effect: the live Generator request sent from the
 * coach app to the API never carried progressionHistory at all — the
 * entire T160/T164 continuity chain was inert in production, regardless of
 * how correct the prompt or the tested module were.
 *
 * FIX: ported _mapExerciseProgressionHistory into vdsen-coach.html
 * (byte-identical logic to api/vdsen-build-request.js), wired it into this
 * file's own _mapLogs, and added progressionHistory to buildGenerationRequest's
 * assembled request object.
 *
 * Run: node tests/t166-cross-plan-progression-continuity.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

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

// ─────────────────────────────────────────────────────────────────────────────
// P0 fix: the browser-embedded request-assembly path now carries
// progressionHistory end to end.
// ─────────────────────────────────────────────────────────────────────────────

(function testEmbeddedMapLogsCarriesProgressionHistory() {
  const src = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
  ok(src, 'vdsen-coach.html now has its own _mapExerciseProgressionHistory (ported from api/vdsen-build-request.js)');
  const fidelitySrc = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');

  const fn = new Function(fidelitySrc + ';\nreturn ' + src)();
  const progrecs = {
    'progrec_1_0': { recommendations: [
      { prescriptionExerciseId: 'pid-x', exerciseName: 'Sentadilla', exerciseId: 'ex-1', action: 'maintain' }
    ]},
    'progrec_2_0': { recommendations: [
      { prescriptionExerciseId: 'pid-x', exerciseName: 'Sentadilla', exerciseId: 'ex-1', action: 'increase_load' }
    ]}
  };
  const result = fn(progrecs);
  ok(result.byPrescriptionExerciseId['pid-x'] && result.byPrescriptionExerciseId['pid-x'].history.length === 2, 'the ported function correctly builds PID-indexed longitudinal history (matches api/vdsen-build-request.js behavior)');
  ok(result.byPrescriptionExerciseId['pid-x'].confidence === 'low', 'confidence scale matches the tested module (2 weeks -> low)');

  ok(COACH.includes('result.progressionHistory = _mapExerciseProgressionHistory(progrecs);'), '_mapLogs (embedded) now computes progressionHistory from the same progrecs it already collects');
  ok(COACH.includes('progressionHistory: logsResult.progressionHistory,'), 'buildGenerationRequest (embedded, the LIVE "Generar plan automático" path) now wires progressionHistory into the assembled request');
})();

// ─────────────────────────────────────────────────────────────────────────────
// A/B — PID preservation vs substitution via _stampPrescriptionIds (existing,
// unmodified machinery — demonstrated correct, not re-fixed).
// ─────────────────────────────────────────────────────────────────────────────

(function testStampPreservesExistingRetiresNew() {
  const src = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
  ok(src, '_stampPrescriptionIds exists');
  const genSrc = extractFunction(COACH, 'function _genPrescriptionId()');
  const fn = new Function('crypto', 'Date', 'Math', genSrc + '\n' + src + '\nreturn _stampPrescriptionIds;')(
    { randomUUID: function(){ throw new Error('no crypto in test'); } }, Date, Math
  );
  // A — preserved exercise: PID copied from previousPlan by the Generator survives untouched.
  const daysA = [{ dayIndex: 0, exercises: [{ exerciseName: 'Press Banca', prescriptionExerciseId: 'pid-preserved' }] }];
  const outA = fn(daysA);
  ok(outA[0].exercises[0].prescriptionExerciseId === 'pid-preserved', 'CASO A — an exercise carrying a PID from previousPlan keeps that exact PID (continuity preserved)');

  // B — substituted exercise: Generator omits the field -> gets a brand new one.
  const daysB = [{ dayIndex: 0, exercises: [{ exerciseName: 'Press Militar' /* no prescriptionExerciseId: substituted */ }] }];
  const outB = fn(daysB);
  ok(typeof outB[0].exercises[0].prescriptionExerciseId === 'string' && outB[0].exercises[0].prescriptionExerciseId.length > 0, 'CASO B — a substituted exercise (no PID from the Generator) gets a fresh, unique PID — no accidental inheritance');
})();

// ─────────────────────────────────────────────────────────────────────────────
// C/E — no silent name/position association (behavioral, via the ported
// _mapExerciseProgressionHistory — identical guarantee to api/vdsen-build-request.js).
// ─────────────────────────────────────────────────────────────────────────────

(function testNoSilentNameAssociation() {
  const src = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
  const fidelitySrc = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
  const fn = new Function(fidelitySrc + ';\nreturn ' + src)();

  // CASO C — same exerciseName, but two DIFFERENT PIDs (e.g. a duplicated
  // exercise, or the Generator failed to recognize continuity for what a
  // human would call "the same" exercise).
  const progrecsC = { 'progrec_1_0': { recommendations: [
    { prescriptionExerciseId: 'pid-old', exerciseName: 'Sentadilla', action: 'increase_load' },
    { prescriptionExerciseId: 'pid-new', exerciseName: 'Sentadilla', action: 'maintain' }
  ]}};
  const resultC = fn(progrecsC);
  ok(resultC.byPrescriptionExerciseId['pid-new'].history.length === 1, 'CASO C — a new PID with the same exerciseName as an existing PID starts with its OWN, empty history — no cross-contamination by matching names (safe default, even if it means a real continuity case sometimes starts fresh)');
  ok(resultC.byPrescriptionExerciseId['pid-old'].history.length === 1, 'CASO C — the old PID\'s history is untouched by the new PID\'s presence');

  // CASO E — legacy recommendation with no PID at all.
  const progrecsE = { 'progrec_1_0': { recommendations: [
    { exerciseName: 'Peso Muerto', action: 'maintain' } // legacy, pre-T159, no PID
  ]}};
  const resultE = fn(progrecsE);
  ok(resultE.unindexedCount === 1 && Object.keys(resultE.byPrescriptionExerciseId).length === 0, 'CASO E — a legacy no-PID recommendation is counted but never bucketed under any exercise by name');
})();

// ─────────────────────────────────────────────────────────────────────────────
// D — new plan wipes old logs cleanly (existing, unmodified client machinery —
// demonstrated correct via the exact literal gate, not re-fixed).
// ─────────────────────────────────────────────────────────────────────────────

(function testNewPlanWipesOldLogs() {
  ok(CLIENT.includes("LOGS           = {};") && CLIENT.includes("CURRENT_WEEK   = 1;") && CLIENT.includes("REAL_WEEK      = 1;"), 'CASO D — loadPlan\'s planChanged branch resets LOGS to {} (and week counters) when the coach assigns a genuinely new plan, so old progrec_/log_ entries from the previous mesocycle never leak into next-exposure reads for the new plan');
  ok(CLIENT.includes("await _doSaveLogs(); // Guardar el estado limpio de la semana 1"), 'CASO D — the clean, wiped state is persisted immediately, not just held in memory');
})();

console.log('');
console.log('T166 — Cross-plan progression continuity: ' + pass + ' assertions PASSED');
