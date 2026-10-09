'use strict';
/**
 * T279 — Coach Monitor consumption. Verifies _renderClientTabMonitor's
 * three decision cards (T223 "Respuesta a la prescripción", T272 "Estado
 * nutricional", T229 "Atención del Coach") now derive from ONE call to
 * window.VDSEN_SNAPSHOT.build (T276) instead of each independently
 * recomputing performanceResponse/bodyCompositionResponse/effectiveness/
 * nutritionDecision/coachSupervision through slightly different paths.
 *
 * Also verifies the REAL divergence risk found in T275's audit and fixed
 * here: _computeCoachSupervisionForRequest used to derive its OWN week
 * from entries.engine_state.weekNum (which can differ from the client's
 * real logs/{uid}.currentWeek) instead of the real week Monitor/Generator
 * both actually use.
 *
 * Run: node tests/t279-monitor-snapshot-consumption.test.js
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

const monitorSrc = extractFunction(COACH, 'async function _renderClientTabMonitor(cont)');
ok(monitorSrc, '_renderClientTabMonitor extracts cleanly');

// ── Wiring: exactly one snapshot build call, all 3 cards source from it ────
ok((monitorSrc.match(/window\.VDSEN_SNAPSHOT\.build\(/g) || []).length === 1, 'exactly ONE window.VDSEN_SNAPSHOT.build call for the whole render -- one evidence cut for all 3 cards');
ok(monitorSrc.includes('const _outcomeEffectiveness = _monitorSnapshot.prescriptionEffectiveness;'), 'T223 card sources prescriptionEffectiveness from the shared snapshot');
ok(monitorSrc.includes('_monitorSnapshot.nutritionDecision.adherence') && monitorSrc.includes('_monitorSnapshot.nutritionDecision.response'), 'T272 card sources nutritionDecision from the shared snapshot');
ok(monitorSrc.includes('_monitorSnapshot.coachSupervision.priority'), 'T229 card sources coachSupervision (priority) from the shared snapshot');

// No more independent recomputation of any of the composed blocks inside
// this function -- every one of these calls now lives ONLY inside
// _buildClientDecisionSnapshot (a different function, not this one).
[
  'window.VDSEN_OUTCOME.computePerformanceResponse(',
  'window.VDSEN_OUTCOME.computeBodyCompositionResponse(',
  'window.VDSEN_OUTCOME.computeEffectiveness(',
  'window.VDSEN_NUTRITION.classifyAdherence(',
  'window.VDSEN_NUTRITION.classifyResponse(',
  'window.VDSEN_NUTRITION.decide(',
  '_rankClientPriority(',
  '_computeInterventionReasonAction('
].forEach(function(callSig) {
  ok(!monitorSrc.includes(callSig), '_renderClientTabMonitor no longer independently calls ' + callSig.replace(/\($/, '') + ' -- routed through the shared snapshot instead');
});

// ── The real currentWeek divergence fix ─────────────────────────────────────
const supervisionSrc = extractFunction(COACH, 'function _computeCoachSupervisionForRequest(entries, planDoc, weeklyDecision, prescriptionEffectiveness, currentWeek)');
ok(supervisionSrc, '_computeCoachSupervisionForRequest now accepts currentWeek explicitly');
ok(supervisionSrc.includes("currentWeek = currentWeek || (entries && entries.engine_state && entries.engine_state.weekNum) || 1;"), 'the OLD engine_state.weekNum guess is now only a last-resort fallback, not the primary source');
ok(COACH.includes('_computeCoachSupervisionForRequest(entries, planDoc, weeklyDecision, prescriptionEffectiveness, week);'), 'the snapshot builder passes the REAL week (T276\'s own `week` variable, sourced from logsDoc.currentWeek) through');

// ── Functional: coachSupervision now actually reflects the given real
// week, not a stale engine_state.weekNum. ──────────────────────────────────
{
  const evidenceSrc  = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
  function fakeAttn(entries, planDoc, week) { return { state: week === 5 ? 'REVIEW' : 'OK', reasons: [] }; }
  function fakeRank(state) { return state === 'REVIEW' ? 'NEEDS_REVIEW' : 'ON_TRACK'; }
  function fakeReasonAction() { return { primaryReason: 'x', action: 'NO_ACTION', supportingReasons: [] }; }

  const fn = new Function('window', evidenceSrc + ';\n' + supervisionSrc + ';\nreturn _computeCoachSupervisionForRequest;')({
    _computeClientAttentionState: fakeAttn, _rankClientPriority: fakeRank, _computeInterventionReasonAction: fakeReasonAction
  });

  // entries.engine_state.weekNum says week 2 (stale), but the REAL current
  // week (passed explicitly, as the snapshot now does) is week 5.
  const entries = { engine_state: { weekNum: 2 } };
  const resultWithRealWeek = fn(entries, {}, null, null, 5);
  ok(resultWithRealWeek.priority === 'NEEDS_REVIEW', 'when the REAL week (5) is passed explicitly, coachSupervision uses it -- not the stale engine_state.weekNum (2) -- matching what Monitor (which always has the real week) would independently compute');

  const resultWithoutRealWeek = fn(entries, {}, null, null, undefined);
  ok(resultWithoutRealWeek.priority === 'ON_TRACK', 'without an explicit week (legacy caller), it still falls back to the old engine_state.weekNum derivation -- backward compatible');
}

console.log('');
console.log('T279 — Coach Monitor snapshot consumption: ' + pass + ' assertions PASSED');
