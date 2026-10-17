'use strict';
/**
 * T252 — Canonical historical mesocycle model. _buildHistoricalMesocycleView
 * converts an already-persisted logs/{uid}/mesos/{planId} snapshot (+ the
 * immutable plans/{planId} doc, + coachInterventions[]) into a READ-ONLY
 * summary. Reuses window.VDSEN_BUILD._mapExerciseProgressionHistory
 * (T160/166) -- no second engine. Never invents dates/sessions/loads/
 * adherence/exercise-name equivalences.
 *
 * Run: node tests/t252-historical-mesocycle-model.test.js
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

const targetEnumSrc = COACH.slice(COACH.indexOf('var INTERVENTION_TARGET_TYPE = {'), COACH.indexOf('var INTERVENTION_DECISION_ACTION = {'));
const fidelitySrc    = extractFunction(COACH, 'function _classifyExerciseExecutionFidelity(setCompletionRate)');
const mapHistSrc     = extractFunction(COACH, 'function _mapExerciseProgressionHistory(progrecs)');
const viewSrc        = extractFunction(COACH, 'function _buildHistoricalMesocycleView(planId, mesoDoc, planDoc, coachInterventions)');

ok(targetEnumSrc && fidelitySrc && mapHistSrc && viewSrc, 'prerequisite: _buildHistoricalMesocycleView and its real dependencies extract cleanly');
ok(COACH.includes('window._buildHistoricalMesocycleView = _buildHistoricalMesocycleView;'), 'exposed for T253/T254 reuse');
ok(viewSrc.includes('window.VDSEN_BUILD._mapExerciseProgressionHistory(progrecs)'), 'reuses the REAL T160/166 progression mapper via the established cross-script window.VDSEN_BUILD pattern -- no second engine');
ok(!viewSrc.includes('updateDoc') && !viewSrc.includes('setDoc') && !viewSrc.includes('getDoc'), 'pure function -- no Firestore access of any kind, read or write');

function makeEngine() {
  const fakeWindow = { VDSEN_BUILD: { _mapExerciseProgressionHistory: new Function(fidelitySrc + ';\n' + mapHistSrc + '; return _mapExerciseProgressionHistory;')() } };
  return new Function('window', targetEnumSrc + ';\n' + viewSrc + ';\nreturn _buildHistoricalMesocycleView;')(fakeWindow);
}
const build = makeEngine();

// ─────────────────────────────────────────────────────────────────────────────
// No planId -> null, never a fabricated empty shell.
// ─────────────────────────────────────────────────────────────────────────────

ok(build(null, {}, {}, []) === null, 'no planId at all -> null');

// ─────────────────────────────────────────────────────────────────────────────
// Historial vacío -- mesoDoc missing/empty entirely.
// ─────────────────────────────────────────────────────────────────────────────

(function testEmptyHistory() {
  const result = build('plan-empty', null, null, []);
  ok(result !== null, 'a planId alone still produces a real (mostly-null) view, never crashes');
  ok(result.dataAvailable === false, 'dataAvailable is false when no mesos doc/entries exist');
  ok(result.planAvailable === false, 'planAvailable is false when no plan doc exists');
  ok(result.startedAt === null && result.endedAt === null, 'no fabricated timestamps when there is nothing to derive them from');
  ok(result.sessionsCompleted === 0 && result.totalSessions === null && result.adherence === null, 'no fabricated adherence when nothing is computable');
  ok(Array.isArray(result.exercises) && result.exercises.length === 0, 'no exercises listed when there is no evidence and no plan doc');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Mesociclo completo -- full data available (plan doc + entries + evidence).
// ─────────────────────────────────────────────────────────────────────────────

(function testCompleteMesocycle() {
  const planDoc = { nombre: 'Hipertrofia Fase 1', weeks: 6, days: [{ exercises: [{ exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-1' }] }] };
  const mesoDoc = {
    currentWeek: 6,
    updatedAt: Date.parse('2026-02-15T00:00:00.000Z'),
    entries: {
      'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', action: 'maintain' }] },
      'progrec_6_0': { calculatedAt: '2026-02-10T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Sentadilla', action: 'increase_load' }] },
      'postsession_1_0': { ts: Date.parse('2026-01-01T00:05:00.000Z'), articularPain: { present: false } },
      'done_1_0': true, 'done_2_0': true, 'done_3_0': true
    }
  };
  const result = build('plan-A', mesoDoc, planDoc, []);
  ok(result.planName === 'Hipertrofia Fase 1' && result.planAvailable === true, 'plan metadata resolved from the real plan doc');
  ok(result.dataAvailable === true, 'dataAvailable true when real entries exist');
  ok(result.startedAt === '2026-01-01T00:00:00.000Z', 'startedAt is the earliest REAL evidence timestamp found (not fabricated)');
  ok(result.endedAt === '2026-02-15T00:00:00.000Z', 'endedAt is the real mesoDoc.updatedAt');
  ok(result.sessionsCompleted === 3 && result.totalSessions === 6 && result.adherence === 50, 'sessions/adherence computed transparently (3 of 1 day x 6 weeks = 6 total)');
  ok(result.exercises.length === 1 && result.exercises[0].prescriptionExerciseId === 'pid-1' && result.exercises[0].hasEvidence === true, 'the one real exercise is listed by PID, with evidence flagged');
  ok(result.exercises[0].progressionSummary && result.exercises[0].progressionSummary.history.length === 2, 'progressionSummary reuses the real progression-history mapper output verbatim');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Mesociclo parcial -- some weeks/evidence, plan reached only partway.
// ─────────────────────────────────────────────────────────────────────────────

(function testPartialMesocycle() {
  const planDoc = { nombre: 'Plan corto', weeks: 6, days: [{ exercises: [] }] };
  const mesoDoc = { currentWeek: 2, updatedAt: Date.parse('2026-01-20T00:00:00.000Z'), entries: { 'done_1_0': true } };
  const result = build('plan-partial', mesoDoc, planDoc, []);
  ok(result.weeksReached === 2 && result.weeks === 6, 'a mesociclo cut short still reports the REAL reached week vs. the plan\'s intended total, never conflating the two');
  ok(result.sessionsCompleted === 1, 'partial session data is counted transparently, no assumption of full completion');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Legacy / PID ausente -- a recommendation with no PID stays unindexed,
// never guessed into a fabricated identity.
// ─────────────────────────────────────────────────────────────────────────────

(function testLegacyNoPid() {
  const mesoDoc = { currentWeek: 1, updatedAt: Date.now(), entries: {
    'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ exerciseName: 'Ejercicio legado sin PID' }] }
  } };
  const result = build('plan-legacy', mesoDoc, null, []);
  ok(result.exercises.length === 0, 'a legacy PID-less recommendation is never listed as a fabricated "exercise" entry');
  ok(result.unindexedRecommendations === 1, 'it is explicitly counted as unindexed instead -- ambiguous legacy data stays explicitly ambiguous');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Mismo nombre / PID diferente -- two exercises sharing a name are NEVER
// merged into one history entry.
// ─────────────────────────────────────────────────────────────────────────────

(function testSameNameDifferentPid() {
  const planDoc = { weeks: 6, days: [{ exercises: [
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-old' },
    { exerciseName: 'Sentadilla', prescriptionExerciseId: 'pid-new' }
  ] }] };
  const mesoDoc = { currentWeek: 1, updatedAt: Date.now(), entries: {
    'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-new', exerciseName: 'Sentadilla', action: 'maintain' }] }
  } };
  const result = build('plan-B', mesoDoc, planDoc, []);
  const byPid = {}; result.exercises.forEach(function(e) { byPid[e.prescriptionExerciseId] = e; });
  ok(byPid['pid-old'] && byPid['pid-new'] && byPid['pid-old'] !== byPid['pid-new'], 'two identically-named exercises remain two DISTINCT PID entries');
  ok(byPid['pid-new'].hasEvidence === true && byPid['pid-old'].hasEvidence === false, 'evidence is attributed to the EXACT PID that produced it, never bled to the same-named sibling');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Plan eliminado/no accesible -- degrades to planAvailable=false, keeps
// the logs-derived view fully intact (never breaks the whole view).
// ─────────────────────────────────────────────────────────────────────────────

(function testPlanDocMissing() {
  const mesoDoc = { currentWeek: 3, updatedAt: Date.now(), entries: {
    'progrec_1_0': { calculatedAt: '2026-01-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseName: 'Peso Muerto', action: 'maintain' }] }
  } };
  const result = build('plan-missing', mesoDoc, null, []);
  ok(result.planAvailable === false && result.planName === null && result.weeks === null, 'a missing plan doc degrades those specific fields to null/false, never guessed');
  ok(result.exercises.length === 1 && result.exercises[0].exerciseName === 'Peso Muerto', 'the logs-derived exercise list (from the recommendation\'s own real name) remains visible even without the plan doc');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Timestamps incompletos -- some evidence has no usable timestamp; only
// the real ones are used, never a placeholder/now() fallback.
// ─────────────────────────────────────────────────────────────────────────────

(function testIncompleteTimestamps() {
  const mesoDoc = { currentWeek: 1, updatedAt: null, entries: {
    'progrec_1_0': { recommendations: [{ prescriptionExerciseId: 'pid-1' }] }, // no calculatedAt
    'postsession_1_0': { articularPain: { present: false } } // no ts
  } };
  const result = build('plan-incomplete-ts', mesoDoc, null, []);
  ok(result.startedAt === null, 'no usable real timestamp anywhere -> startedAt stays null, never Date.now()');
  ok(result.endedAt === null, 'a missing mesoDoc.updatedAt -> endedAt stays null, never fabricated');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Coach decisions: planId-exact for EXERCISE, temporal-only for CLIENT.
// ─────────────────────────────────────────────────────────────────────────────

(function testCoachDecisionsScoping() {
  const mesoDoc = { currentWeek: 1, updatedAt: Date.parse('2026-02-01T00:00:00.000Z'), entries: {
    'postsession_1_0': { ts: Date.parse('2026-01-01T00:00:00.000Z') }
  } };
  const interventions = [
    { targetType: 'EXERCISE', targetId: 'pid-1', planId: 'plan-C', decidedAt: '2026-01-15T00:00:00.000Z', action: 'KEEP' },
    { targetType: 'EXERCISE', targetId: 'pid-2', planId: 'plan-OTHER', decidedAt: '2026-01-15T00:00:00.000Z', action: 'KEEP' },
    { targetType: 'CLIENT', targetId: 'client-1', planId: null, decidedAt: '2026-01-20T00:00:00.000Z', action: 'PAUSE_FOR_REVIEW' },
    { targetType: 'CLIENT', targetId: 'client-1', planId: null, decidedAt: '2025-01-01T00:00:00.000Z', action: 'NO_CHANGE' } // outside the window
  ];
  const result = build('plan-C', mesoDoc, null, interventions);
  const ids = result.coachDecisions.map(function(i) { return i.targetId + ':' + i.decidedAt; });
  ok(result.coachDecisions.length === 2, 'exactly 2 decisions attributed: the planId-exact EXERCISE one and the temporally-in-range CLIENT one');
  ok(ids.indexOf('pid-2:2026-01-15T00:00:00.000Z') === -1, 'an EXERCISE intervention from a DIFFERENT plan is never attributed to this mesociclo');
})();

console.log('');
console.log('T252 — Historical mesocycle model: ' + pass + ' assertions PASSED');
