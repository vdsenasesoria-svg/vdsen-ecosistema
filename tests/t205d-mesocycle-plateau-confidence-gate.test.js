'use strict';
/**
 * T205(d) — Mesocycle plateau detection must not fire from low-confidence
 * (under-executed) history.
 *
 * _decideMesocycleTransition's per-exercise PRESERVE/REVIEW split already
 * flagged an exercise as "plateaued" purely from 2 static-looking weeks
 * (action === maintain/freeze_load), with no check on whether those weeks
 * were actually well executed. Combined with T205's confidence fix
 * (_mapExerciseProgressionHistory), a PID with 'none'/'low' confidence
 * (barely-executed sets, or too little history) could still get flagged
 * REVIEW and drive a false RENEW_WITH_ADJUSTMENTS -- exactly the failure
 * mode the ticket exists to close: a plateau conclusion drawn from
 * insufficient execution evidence, not from the exercise having genuinely
 * stopped responding.
 *
 * Fix: plateau only counts toward reviewExercisePids when entry.confidence
 * is NOT 'none'/'low'. Legacy/test fixtures with no confidence field at all
 * keep the original count-only behavior (verified: T192-197's own CASE B
 * still passes unmodified).
 *
 * Run: node tests/t205d-mesocycle-plateau-confidence-gate.test.js
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
ok(decideSrc.includes("entry.confidence !== 'none' && entry.confidence !== 'low'"), 'the plateau gate checks execution confidence, not just week count');
const _decideMesocycleTransition = new Function('return ' + decideSrc)();

function pidHistoryWithConfidence(actions, confidence) {
  return { history: actions.map(function(a, i) { return { week: i + 1, action: a }; }), confidence: confidence };
}

(function testLowConfidencePlateauIsPreservedNotReviewed() {
  // Two "static" weeks, but confidence is 'low' -- e.g. 1-of-4 sets executed
  // each week (T205's own worked example scenario). Must NOT be flagged for
  // review/adjustment.
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-underexecuted': pidHistoryWithConfidence(['maintain', 'freeze_load'], 'low')
  }};
  const d = _decideMesocycleTransition({
    weeklyDecision: { status: 'PROGRESSING' },
    adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    isCheckpointWeek: true
  });
  ok(d.reviewExercisePids.indexOf('pid-underexecuted') === -1, 'a plateau-looking exercise with low confidence is NOT flagged for review');
  ok(d.preserveExercisePids.indexOf('pid-underexecuted') !== -1, 'it is preserved instead -- insufficient evidence, not proof of a real plateau');
  ok(d.action === 'CONTINUE' || d.action === 'RENEW_MINIMAL', 'no adjustment is triggered from this exercise alone (got: ' + d.action + ')');
})();

(function testNoneConfidencePlateauIsPreserved() {
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-nodata': pidHistoryWithConfidence(['maintain', 'maintain'], 'none')
  }};
  const d = _decideMesocycleTransition({
    weeklyDecision: { status: 'PROGRESSING' },
    adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    isCheckpointWeek: false
  });
  ok(d.reviewExercisePids.indexOf('pid-nodata') === -1, "'none' confidence also blocks a false plateau verdict");
})();

(function testHighConfidencePlateauStillFlagged() {
  // A genuinely well-executed, real plateau must still be caught -- the
  // gate must not become a blanket suppressor.
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-real-plateau': pidHistoryWithConfidence(['maintain', 'freeze_load'], 'high')
  }};
  const d = _decideMesocycleTransition({
    weeklyDecision: { status: 'PROGRESSING' },
    adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    isCheckpointWeek: true
  });
  ok(d.reviewExercisePids.indexOf('pid-real-plateau') !== -1, 'a genuinely well-executed (high confidence) plateau is still flagged for review');
  ok(d.action === 'RENEW_WITH_ADJUSTMENTS', 'a real, well-evidenced plateau still justifies RENEW_WITH_ADJUSTMENTS (got: ' + d.action + ')');
})();

(function testMediumConfidenceStillFlagged() {
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-medium': pidHistoryWithConfidence(['maintain', 'freeze_load'], 'medium')
  }};
  const d = _decideMesocycleTransition({
    weeklyDecision: { status: 'PROGRESSING' },
    adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    isCheckpointWeek: true
  });
  ok(d.reviewExercisePids.indexOf('pid-medium') !== -1, 'medium confidence is reliable enough -- only none/low block the plateau verdict');
})();

(function testMissingConfidenceFieldFallsBackToOriginalBehavior() {
  // No confidence field at all (e.g. a fixture built before T205, or a
  // history entry from some other caller) -- must behave exactly as before
  // the T205(d) fix (count-only), never silently start suppressing.
  const progressionHistory = { byPrescriptionExerciseId: {
    'pid-legacy': { history: [{ week: 1, action: 'maintain' }, { week: 2, action: 'freeze_load' }] }
  }};
  const d = _decideMesocycleTransition({
    weeklyDecision: { status: 'PROGRESSING' },
    adaptivePrescription: { muscleDecisions: {} },
    progressionHistory: progressionHistory,
    isCheckpointWeek: true
  });
  ok(d.reviewExercisePids.indexOf('pid-legacy') !== -1, 'a legacy fixture with no confidence field at all keeps the original count-only plateau behavior');
})();

console.log('');
console.log('T205(d) — Mesocycle plateau confidence gate: ' + pass + ' assertions PASSED');
