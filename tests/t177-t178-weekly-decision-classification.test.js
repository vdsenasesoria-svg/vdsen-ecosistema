'use strict';
/**
 * T176 — Weekly data contract map (summary, no code change needed):
 *
 *   SOURCE                        FIELD                          WRITER              READER                                  RELIABILITY  SCOPE      CLASS
 *   logs/{uid}.entries.progrec_W_D {recommendations,deloadTriggers,weekNum,engineState} calculateProgression (client)  Client next-exposure, Coach Monitor, Generator  HIGH (deterministic)  week+day, current mesocycle only  F
 *   logs/{uid}.entries.engine_state {deloadTriggered,globalAction,exerciseSummary[],confidence,observationsCount} calculateProgression  Coach Monitor, legacy prompt-text path  HIGH but single-key (latest calc only)  "latest" only  F/B
 *   logs/{uid}.entries.postsession_W_D {eimd,articularPain:{present,pattern},sleepHours,rpeAverage,ts,autoClosed?} post-session modal  _computeDeloadTriggers, calculateProgression EIMD veto  HIGH (MEDIUM if autoClosed)  week+day  B/E
 *   logs/{uid}.entries.ci_sem_W   {peso,hrv,sleep,energia(legacy/inconsistent format),who5(real 5-Q calc,0-100),subj_score(0-25),subj_dolor_gral,adherencia_pct,rir_real_prom,ics_promedio} guardarCI() (client)  _computeDeloadTriggers, Resumen trends, Coach Ehrenstein semaphore  HIGH (client self-report)  week  C/D/E/A
 *   logs/{uid}.entries.done_W_D   {ts,skipped?,autoClosed?}     various completion paths  adherence calc, week-advance  HIGH  week+day  D
 *   logs/{uid}.entries.log_W_D_E_sS {carga,reps,rir_real,ics,done,autoFilled?} set-save (client)  everything upstream  HIGH unless autoFilled  set  A/F
 *
 *   MISMATCH FOUND (documented, not "fixed" — this IS what T177-179 builds):
 *   expedientes/{emailKey}/historial/sem_{W} is written by guardarCI() (a
 *   parallel "GAP 5" dual-write, comment: "El coach lee estos datos en el
 *   Motor de Decisiones Semanal") but has ZERO readers anywhere in the
 *   codebase (grep-verified across vdsen-coach.html and api/*.js) — an
 *   orphaned collection. T177-179 deliberately builds on the ALREADY-
 *   CONSUMED logs/{uid}.entries contract instead (ci_sem_/postsession_/
 *   progrec_/engine_state — all already read by the Coach Monitor), per
 *   "no new collection unless unavoidable" — it was avoidable.
 *
 * T177/T178 — deterministic weekly classification + volume decision.
 * Every threshold reused, none invented:
 *   - engine_state.confidence (none/low/medium/high) — calculateProgression's
 *     own observationsCount-based scale, reused verbatim for ADHERENCE_LIMITED.
 *   - the 0.5 "majority" split — reused verbatim from buildPrescriptionContext's
 *     existing MAJORITY_STALLED reasonCode.
 *   - ICS>=7/8 gold/green — reused verbatim from the Coach's own existing
 *     _sesICS color-coding and the Ehrenstein semaphore's icsOk gate.
 *   - articularPain.present — an existing boolean safety signal, not a new
 *     numeric pain threshold.
 *   - the Ehrenstein semaphore itself (scoreOk/icsOk/vuln, umbral) — an
 *     ALREADY-EXISTING inline block, extracted verbatim into
 *     _calcEhrensteinSemaphore (pure refactor, zero behavior change) so
 *     _classifyWeeklyStatus can reuse it instead of re-deriving it.
 *
 * Run: node tests/t177-t178-weekly-decision-classification.test.js
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

const semSrc    = extractFunction(COACH, 'function _calcEhrensteinSemaphore(subjScore, subjVulner, avgICS, umbral)');
const wsMetaSrc = COACH.slice(COACH.indexOf('var WEEKLY_STATUS = {'), COACH.indexOf('function _classifyWeeklyStatus'));
const classifySrc = extractFunction(COACH, 'function _classifyWeeklyStatus(input)');
const volumeSrc = extractFunction(COACH, 'function _decideVolumeAction(status, ciSem)');
ok(semSrc && wsMetaSrc && classifySrc && volumeSrc, 'prerequisite: all 3 new functions + the WEEKLY_STATUS enum extract cleanly');

function makeEngine() {
  const factory = new Function(wsMetaSrc + ';\n' + semSrc + ';\n' + classifySrc + ';\n' + volumeSrc + ';\n' +
    'return { calcSemaphore: _calcEhrensteinSemaphore, classify: _classifyWeeklyStatus, decideVolume: _decideVolumeAction, STATUS: WEEKLY_STATUS };');
  return factory();
}
const eng = makeEngine();

// ─────────────────────────────────────────────────────────────────────────────
// _calcEhrensteinSemaphore — pure extraction, same behavior as the original
// inline block (regression: verified against the exact original thresholds).
// ─────────────────────────────────────────────────────────────────────────────

(function testSemaphoreExtraction() {
  ok(eng.calcSemaphore(null, null, null, 12) === null, 'no subjScore -> null (matches original "if (subjScore !== null)" guard)');
  const green = eng.calcSemaphore(20, 1, 8, 12);
  ok(green.semLabel === 'Verde' && green.scoreOk && green.icsOk && !green.vuln, 'high score + high ICS + low vulnerability -> Verde');
  const red = eng.calcSemaphore(5, 1, 5, 12);
  ok(red.semLabel === 'Rojo', 'low score AND low ICS -> Rojo');
  const orange = eng.calcSemaphore(20, 5, 8, 12);
  ok(orange.semLabel === 'Naranja', 'high score/ICS but high vulnerability alone -> Naranja');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — healthy progress: good adherence, positive progression, recovery
// okay -> PROGRESSING, volume KEEP-or-REVIEW_INCREASE, no Coach alert.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseA_HealthyProgress() {
  const input = {
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [
      { action: 'increase_load' }, { action: 'increase_load' }, { action: 'maintain' }
    ]},
    ciSem: { adherencia_pct: 95, ics_promedio: 8 },
    postsessionsThisWeek: [{ articularPain: { present: false } }],
    reviewCount: 0,
    semaphore: eng.calcSemaphore(22, 1, 8, 12)
  };
  const status = eng.classify(input);
  ok(status === eng.STATUS.PROGRESSING, 'CASE A — healthy progress classifies as PROGRESSING');
  ok(eng.decideVolume(status, input.ciSem) === 'REVIEW_INCREASE', 'CASE A — good technique (ICS>=7) + PROGRESSING -> REVIEW_INCREASE (never auto-applied, only a recommendation)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — fatigue: performance declining, sleep/energy poor -> RECOVERY_LIMITED,
// no volume increase, Coach attention.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseB_Fatigue() {
  const input = {
    engineState: { confidence: 'medium', deloadTriggered: true, exerciseSummary: [{ action: 'freeze_load' }, { action: 'reduce_load' }] },
    ciSem: { adherencia_pct: 80 },
    postsessionsThisWeek: [{ articularPain: { present: false } }],
    reviewCount: 0,
    semaphore: null
  };
  const status = eng.classify(input);
  ok(status === eng.STATUS.RECOVERY_LIMITED, 'CASE B — reactive deload triggered -> RECOVERY_LIMITED');
  ok(eng.decideVolume(status, input.ciSem) === 'FREEZE', 'CASE B — RECOVERY_LIMITED -> FREEZE (never increase volume during real fatigue)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — pain: good strength progress but meaningful pain -> PAIN_REVIEW,
// safety wins over an otherwise-positive performance read.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseC_Pain() {
  const input = {
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }, { action: 'increase_load' }] },
    ciSem: { adherencia_pct: 100 },
    postsessionsThisWeek: [{ articularPain: { present: true, pattern: 'hombro' } }],
    reviewCount: 0,
    semaphore: eng.calcSemaphore(23, 1, 9, 12) // otherwise a clean "Verde" read
  };
  const status = eng.classify(input);
  ok(status === eng.STATUS.PAIN_REVIEW, 'CASE C — a real pain signal outranks an otherwise-positive progression read (safety-first)');
  ok(eng.decideVolume(status, input.ciSem) === 'FREEZE', 'CASE C — PAIN_REVIEW -> FREEZE');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — poor adherence: few sessions completed -> ADHERENCE_LIMITED, no
// confident progression/volume conclusion.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseD_PoorAdherence() {
  const input = {
    engineState: { confidence: 'low', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }] },
    ciSem: { adherencia_pct: 20 },
    postsessionsThisWeek: [],
    reviewCount: 0,
    semaphore: null
  };
  const status = eng.classify(input);
  ok(status === eng.STATUS.ADHERENCE_LIMITED, 'CASE D — low engine confidence (few real observations) -> ADHERENCE_LIMITED, even though one exercise nominally progressed');
  ok(eng.decideVolume(status, input.ciSem) === 'FREEZE', 'CASE D — ADHERENCE_LIMITED -> FREEZE (no confident volume conclusion)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — insufficient data: nothing to classify from -> DATA_INSUFFICIENT,
// no invented recommendation.
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseE_InsufficientData() {
  const input = { engineState: null, ciSem: null, postsessionsThisWeek: [], reviewCount: 0, semaphore: null };
  const status = eng.classify(input);
  ok(status === eng.STATUS.DATA_INSUFFICIENT, 'CASE E — no engine_state and no ci_sem at all -> DATA_INSUFFICIENT');
  ok(eng.decideVolume(status, null) === 'FREEZE', 'CASE E — DATA_INSUFFICIENT -> FREEZE, never a fabricated recommendation');
})();

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — deload recovery: reactive deload occurred, recovery normalizes ->
// not permanently stuck in RECOVERY_LIMITED (the classification is per-latest-
// week's engine_state, which naturally clears once deloadTriggered is false
// again — no separate "stuck" state to get trapped in).
// ─────────────────────────────────────────────────────────────────────────────

(function testCaseF_DeloadRecovery() {
  const duringDeload = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: true, exerciseSummary: [{ action: 'freeze_load' }] },
    ciSem: {}, postsessionsThisWeek: [], reviewCount: 0, semaphore: null
  });
  ok(duringDeload === eng.STATUS.RECOVERY_LIMITED, 'CASE F — during an active reactive deload, correctly RECOVERY_LIMITED');

  const afterRecovery = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }, { action: 'increase_load' }] },
    ciSem: { adherencia_pct: 90 }, postsessionsThisWeek: [], reviewCount: 0, semaphore: eng.calcSemaphore(20, 1, 8, 12)
  });
  ok(afterRecovery === eng.STATUS.PROGRESSING, 'CASE F — once engine_state.deloadTriggered clears (real recovery, next week\'s calc), classification moves on to PROGRESSING — never permanently stuck in RECOVERY_LIMITED');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Priority order regression: safety (pain) beats COACH_REVIEW beats everything
// else, matching the AUTHORITY ORDER.
// ─────────────────────────────────────────────────────────────────────────────

(function testPriorityOrder() {
  const painAndReview = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: true, exerciseSummary: [] },
    ciSem: {}, postsessionsThisWeek: [{ articularPain: { present: true } }], reviewCount: 3, semaphore: null
  });
  ok(painAndReview === eng.STATUS.PAIN_REVIEW, 'safety (pain) outranks COACH_REVIEW, RECOVERY_LIMITED, and everything else');

  const reviewOnly = eng.classify({
    engineState: { confidence: 'high', deloadTriggered: true, exerciseSummary: [] },
    ciSem: {}, postsessionsThisWeek: [], reviewCount: 2, semaphore: null
  });
  ok(reviewOnly === eng.STATUS.COACH_REVIEW, 'COACH_REVIEW outranks RECOVERY_LIMITED when there is no pain signal');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Structural: no volume state ever auto-applies (decideVolume never touches
// Firestore/plan docs — it's a pure classification function, string in/out).
// ─────────────────────────────────────────────────────────────────────────────

(function testVolumeNeverAutoApplies() {
  ok(!volumeSrc.includes('updateDoc') && !volumeSrc.includes('setDoc') && !volumeSrc.includes('t.update'),
    '_decideVolumeAction never writes to Firestore — pure recommendation, no auto-change to the active plan');
})();

console.log('');
console.log('T177/T178 — Weekly deterministic classification + volume decision support: ' + pass + ' assertions PASSED (CASES A-F)');
