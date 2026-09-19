'use strict';
/**
 * T181 — Generator/next-plan decision context.
 *
 * Exposes the SAME deterministic weekly classification (T177/T178) to the
 * canonical Generator request as an additive `weeklyDecision` field. No
 * second engine: buildGenerationRequest (the EARLY VDSEN_BUILD IIFE) calls
 * window.VDSEN_WEEKLY.classify/decideVolume — the exact functions the Coach
 * Monitor (T179, defined later in the same page's main app script) renders
 * from — via the same lazy cross-script-block lookup pattern already used
 * by window._runPreWritePlanGate etc. (safe: buildGenerationRequest is only
 * ever CALLED at runtime, after the whole page has finished loading both
 * script blocks, regardless of their definition order in the file).
 *
 * The Generator prompt was also updated with a short section explaining
 * weeklyDecision's shape and explicit "never override safety / never
 * recompute / never auto-escalate volume" constraints — mirroring exactly
 * what T181 requires and how T160/T164 already introduced progressionHistory.
 *
 * Run: node tests/t181-weekly-decision-generator-context.test.js
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

// ─────────────────────────────────────────────────────────────────────────────
// Structural: weeklyDecision is wired into the assembled request additively.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('weeklyDecision:    _computeWeeklyDecisionForRequest(logsDoc && logsDoc.entries, planDoc),'), 'buildGenerationRequest wires weeklyDecision into the assembled request');
ok(COACH.includes('window.VDSEN_WEEKLY = { classify: _classifyWeeklyStatus, decideVolume: _decideVolumeAction, STATUS: WEEKLY_STATUS };'), 'the T177/T178 classifier is exposed via window.VDSEN_WEEKLY for cross-script-block reuse (no second engine)');

const computeSrc = extractFunction(COACH, 'function _computeWeeklyDecisionForRequest(entries, planDoc)');
ok(computeSrc, '_computeWeeklyDecisionForRequest extracts cleanly');
ok(computeSrc.includes("typeof window.VDSEN_WEEKLY === 'undefined'"), 'safely returns null rather than guessing if the classifier is unavailable for any reason');

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral: exercise the real function against a stubbed window.VDSEN_WEEKLY
// (same functions from T177/T178, extracted and wired exactly as production
// does — not reimplemented).
// ─────────────────────────────────────────────────────────────────────────────

const semSrc = extractFunction(COACH, 'function _calcEhrensteinSemaphore(subjScore, subjVulner, avgICS, umbral)');
const wsMetaSrc = COACH.slice(COACH.indexOf('var WEEKLY_STATUS = {'), COACH.indexOf('function _classifyWeeklyStatus'));
const classifySrc = extractFunction(COACH, 'function _classifyWeeklyStatus(input)');
const volumeSrc = extractFunction(COACH, 'function _decideVolumeAction(status, ciSem)');

function makeComputeFn() {
  const src = wsMetaSrc + ';\n' + semSrc + ';\n' + classifySrc + ';\n' + volumeSrc + ';\n' + computeSrc + ';\nreturn _computeWeeklyDecisionForRequest;';
  const factory = new Function('window', 'Set', src);
  const win = {};
  win.VDSEN_WEEKLY = null; // filled below after classify/decideVolume are defined inside the factory scope — simplest: re-derive via a second factory that also assigns window.VDSEN_WEEKLY
  const factory2 = new Function('window', 'Set',
    wsMetaSrc + ';\n' + semSrc + ';\n' + classifySrc + ';\n' + volumeSrc + ';\n' +
    "window.VDSEN_WEEKLY = { classify: _classifyWeeklyStatus, decideVolume: _decideVolumeAction, STATUS: WEEKLY_STATUS };\n" +
    computeSrc + ';\nreturn _computeWeeklyDecisionForRequest;'
  );
  return factory2(win, Set);
}
const computeWeeklyDecision = makeComputeFn();

(function testProgressingContext() {
  const entries = {
    engine_state: { weekNum: 3, confidence: 'high', deloadTriggered: false, exerciseSummary: [{ action: 'increase_load' }, { action: 'increase_load' }] },
    'ci_sem_3': { adherencia_pct: 90, ics_promedio: 8 },
    'progrec_3_0': { recommendations: [{ prescriptionExerciseId: 'pid-a', exerciseName: 'Press Banca', action: 'increase_load' }] }
  };
  const planDoc = { updatedAt: '2026-01-01T00:00:00.000Z', days: [{ exercises: [{ prescriptionExerciseId: 'pid-a' }] }] };
  const decision = computeWeeklyDecision(entries, planDoc);
  ok(decision.status === 'PROGRESSING', 'a healthy week produces weeklyDecision.status = PROGRESSING');
  ok(decision.recovery === 'ADEQUATE', 'recovery reads ADEQUATE when status is not RECOVERY_LIMITED');
  ok(decision.volumeDecision === 'REVIEW_INCREASE', 'volumeDecision is a recommendation string, matching T178');
  ok(Array.isArray(decision.reviewItems) && decision.reviewItems.length === 0, 'no reviewItems when the plan PID matches the recommendation PID (no identity conflict)');
})();

(function testCoachEditStaleReviewItem() {
  const entries = {
    engine_state: { weekNum: 5, confidence: 'medium', deloadTriggered: false, exerciseSummary: [] },
    'progrec_5_0': { recommendations: [{ prescriptionExerciseId: 'pid-x', exerciseName: 'Sentadilla', action: 'increase_load', calculatedAt: '2026-02-01T10:00:00.000Z' }] }
  };
  const planDoc = { updatedAt: '2026-02-01T12:00:00.000Z', days: [{ exercises: [{ prescriptionExerciseId: 'pid-x' }] }] }; // coach edited AFTER the calc
  const decision = computeWeeklyDecision(entries, planDoc);
  ok(decision.status === 'COACH_REVIEW', 'a coach-edit-stale recommendation rolls up into weeklyDecision.status = COACH_REVIEW');
  ok(decision.reviewItems.includes('Sentadilla'), 'reviewItems names the specific exercise needing coach attention');
  ok(decision.volumeDecision === 'FREEZE', 'COACH_REVIEW -> FREEZE, no volume recommendation while identity is unresolved');
})();

(function testMissingClassifierReturnsNullSafely() {
  const src = computeSrc + ';\nreturn _computeWeeklyDecisionForRequest;';
  const factory = new Function('window', src);
  const fn = factory({}); // window.VDSEN_WEEKLY undefined
  ok(fn({ engine_state: { weekNum: 1 } }, null) === null, 'if the classifier is unavailable, returns null rather than fabricating a decision');
  ok(fn(null, null) === null, 'no entries at all -> null, no throw');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Prompt regression: the Generator is explicitly told never to treat
// weeklyDecision as an authority override or a license to auto-escalate volume.
// ─────────────────────────────────────────────────────────────────────────────

(function testPromptGuidance() {
  const idx = COACH.indexOf('const _MOTOR_PROMPT_EMBEDDED');
  const strStart = COACH.indexOf('"', idx);
  const endIdx = COACH.indexOf('";', strStart);
  const jsStr = COACH.slice(strStart, endIdx + 1);
  const promptText = eval(jsStr); // eslint-disable-line no-eval -- test-only, reads the real embedded prompt string

  ok(promptText.includes('CONTEXTO DE DECISION SEMANAL (weeklyDecision)'), 'the prompt documents the new weeklyDecision field');
  ok(promptText.includes('NUNCA lo trates como autoridad sobre seguridad'), 'the prompt explicitly forbids treating weeklyDecision as safety authority');
  ok(promptText.includes('NUNCA uses `volumeDecision: REVIEW_INCREASE` como licencia para escalar volumen automaticamente'), 'the prompt explicitly forbids using a REVIEW_INCREASE recommendation as automatic license to add volume');
  ok(promptText.includes('NUNCA recalcules tu propia clasificacion semanal a partir de logs crudos'), 'the prompt forbids the Generator from re-deriving a second weekly classification from raw logs');
})();

console.log('');
console.log('T181 — Generator weekly decision context: ' + pass + ' assertions PASSED');
