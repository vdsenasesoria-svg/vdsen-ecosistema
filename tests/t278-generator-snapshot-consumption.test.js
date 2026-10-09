'use strict';
/**
 * T278 — Generator consumption. Verifies buildGenerationRequest now
 * consumes ONE call to the real _buildClientDecisionSnapshot (T276)
 * instead of independently recomputing weeklyDecision/adaptivePrescription/
 * mesocycleDecision/executionFidelity/learnedState/prescriptionEffectiveness/
 * nutritionDecision/coachSupervision/coachInterventionContext -- while the
 * EXTERNAL request contract stays byte-identical (additive/backward
 * compatible, per the ticket's own explicit requirement).
 *
 * Run: node tests/t278-generator-snapshot-consumption.test.js
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

const buildReqSrc = extractFunction(COACH, 'function buildGenerationRequest(params)');
ok(buildReqSrc, 'buildGenerationRequest extracts cleanly');

// ── Wiring: exactly ONE snapshot call, decision blocks pulled FROM it ──────
ok((buildReqSrc.match(/_buildClientDecisionSnapshot\(/g) || []).length === 1, 'buildGenerationRequest calls _buildClientDecisionSnapshot exactly once -- one evidence cut, not N independent recomputations');
[
  'weeklyDecision            = snapshot.weeklyDecision',
  'adaptivePrescription      = snapshot.adaptivePrescription',
  'mesocycleDecision         = snapshot.mesocycleDecision',
  'executionFidelity         = snapshot.executionFidelity',
  'learnedState              = snapshot.learnedState',
  'prescriptionEffectiveness = snapshot.prescriptionEffectiveness',
  'nutritionDecision         = snapshot.nutritionDecision',
  'coachSupervision          = snapshot.coachSupervision',
  'coachInterventionContext  = snapshot.coachInterventionContext'
].forEach(function(assign) {
  ok(buildReqSrc.includes(assign), 'request field sourced from the snapshot: ' + assign.split('=')[0].trim());
});
ok(!/_computeWeeklyDecisionForRequest\(|_computeAdaptivePrescriptionForRequest\(|_computeMesocycleDecisionForRequest\(|_computeExecutionFidelityForRequest\(|_computeLearnedStateForRequest\(|_computePrescriptionEffectivenessForRequest\(|_computeNutritionDecisionForRequest\(|_computeCoachSupervisionForRequest\(|_computeCoachInterventionContextForRequest\(/.test(buildReqSrc),
  'buildGenerationRequest itself no longer calls any of the 9 individual *ForRequest helpers directly -- all routed through the one snapshot');
ok(buildReqSrc.includes("planId: (clientDoc && clientDoc.activePlanId) || null"), 'the real planId is threaded through so the snapshot\'s isLive bookkeeping (T277) is meaningful for the Generator\'s always-live use case');

// ── Functional: the external request shape is unchanged ────────────────────
const blockStart = COACH.indexOf('  function _mapLogs(logsDoc) {');
const blockEnd   = COACH.indexOf('  function buildGenerationRequest(params) {');
const snapshotBlock = COACH.slice(blockStart, blockEnd);

// buildGenerationRequest also needs its OTHER (pre-existing, untouched)
// sibling mappers -- pull the whole enclosing region from _mapClientProfile
// through the end of buildGenerationRequest as one real contiguous chunk.
// buildGenerationRequest lives inside ONE self-contained <script> tag
// (with _pick/_uuid/validateGenerationRequest/_mapClientProfile and every
// other sibling helper it needs) -- pull that whole real script body
// rather than hand-picking dependencies one at a time.
const scriptOpenIdx  = COACH.lastIndexOf('\n<script>\n', blockStart);
const scriptCloseIdx = COACH.indexOf('\n</script>', blockEnd);
ok(scriptOpenIdx !== -1 && scriptCloseIdx !== -1, 'prerequisite: buildGenerationRequest\'s enclosing <script> block locates cleanly');
const fullOuterBlock = COACH.slice(scriptOpenIdx + '\n<script>\n'.length, scriptCloseIdx);

function runBuildRequest(windowStub, params) {
  windowStub = windowStub || {};
  // The whole block is a self-invoking `(function(){ ... })();` that
  // exposes what it needs via `window.VDSEN_BUILD = {...}` (line ~1430) --
  // run the IIFE for its side effect, then read the real function off the
  // same window stub, exactly as the app's own call site does.
  new Function('window', fullOuterBlock)(windowStub);
  return windowStub.VDSEN_BUILD.buildGenerationRequest(params);
}

{
  const clientDoc = { activePlanId: 'plan-A', coachId: 'coach-1' };
  const planDoc = { days: [{ dayIndex: 0, exercises: [] }], weeks: 6 };
  const logsDoc = { entries: {}, currentWeek: 1 };
  const result = runBuildRequest({}, { clientId: 'client-1', coachId: 'coach-1', clientDoc: clientDoc, planDoc: planDoc, logsDoc: logsDoc, fichaDoc: null });
  const REQUIRED_KEYS = ['schema', 'requestId', 'clientId', 'coachId', 'requestedAt', 'mode', 'outputMode', 'clientProfile', 'restrictions',
    'musclePriorities', 'nutritionContext', 'supplementContext', 'previousPlan', 'trainingLogs', 'checkins', 'engineState', 'progressionHistory',
    'weeklyDecision', 'adaptivePrescription', 'mesocycleDecision', 'executionFidelity', 'learnedState', 'prescriptionEffectiveness',
    'nutritionDecision', 'coachSupervision', 'coachInterventionContext', 'attachments', 'options'];
  REQUIRED_KEYS.forEach(function(k) {
    ok(k in result.rawRequest, 'the external request contract still carries `' + k + '` -- unchanged, additive-only');
  });
  ok(result.rawRequest.clientId === 'client-1' && result.rawRequest.coachId === 'coach-1', 'identity fields still populate correctly end to end through the snapshot');
  ok(result.rawRequest.previousPlan === planDoc, 'previousPlan is still the exact given planDoc (PIDs preserved) -- the snapshot refactor did not touch this field');
}

console.log('');
console.log('T278 — Generator snapshot consumption: ' + pass + ' assertions PASSED');
