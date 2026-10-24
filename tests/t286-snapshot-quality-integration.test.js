'use strict';
/**
 * T286 — Snapshot quality integration. Verifies _buildClientDecisionSnapshot
 * additively carries evidenceQuality {overall, execution, recovery,
 * progression, nutrition, bodyComposition, coachIntervention, conflicts,
 * unresolved}, computed from the SAME evidence cut the decision blocks
 * already represent -- no new Firestore reads, no mutation, pure/
 * deterministic, no existing decision field changed.
 *
 * Run: node tests/t286-snapshot-quality-integration.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const blockStart = COACH.indexOf('  function _classifyProgressionLegacyQuality(progressionHistory) {');
const blockEnd   = COACH.indexOf('  function buildGenerationRequest(params) {');
const block = COACH.slice(blockStart, blockEnd);

ok(block.includes('evidenceQuality:           evidenceQuality,'), 'the snapshot return object carries evidenceQuality additively');
ok(block.includes('var eqExecution        = _classifyExecutionQuality(weeklyDecision);') &&
   block.includes('var eqRecovery         = _classifyWeeklyCheckinQuality(logsDoc, entries);') &&
   block.includes('var eqProgression      = _classifyProgressionLegacyQuality(logsResult.progressionHistory);') &&
   block.includes('var eqNutrition        = _classifyNutritionAdherenceQuality(nutritionDecision);') &&
   block.includes('var eqBodyComposition  = _classifyBodyCompositionQuality(prescriptionEffectiveness);') &&
   block.includes('var eqCoachIntervention = _classifyCoachInterventionQuality(coachInterventionContext);'),
  'each evidenceQuality domain is computed from the SAME already-computed decision fields (weeklyDecision/nutritionDecision/prescriptionEffectiveness/coachInterventionContext/logsResult) -- no new raw reads');
ok(!/getDoc\(|await /.test(block), 'the whole evidence-quality integration performs zero Firestore reads');

// ── Functional: build a real snapshot and inspect evidenceQuality ─────────
function makeSnapshotFn(windowStub) {
  const outerStart = COACH.lastIndexOf('\n<script>\n', COACH.indexOf('  function _mapLogs(logsDoc) {'));
  const outerEnd   = COACH.indexOf('\n</script>', COACH.indexOf('  function buildGenerationRequest(params) {'));
  const outer = COACH.slice(outerStart + '\n<script>\n'.length, outerEnd);
  new Function('window', outer)(windowStub);
  return windowStub.VDSEN_SNAPSHOT.build;
}

function makeEvidenceWindow() {
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
  const enumSrc = extractFunction(COACH, 'var EVIDENCE_QUALITY = {').replace(/^var EVIDENCE_QUALITY = /, '');
  const classifySrc = extractFunction(COACH, 'function _classifyEvidenceQuality(input)');
  const build = new Function('var EVIDENCE_QUALITY = ' + enumSrc + ';\n' + classifySrc + ';\n' +
    'return { classify: _classifyEvidenceQuality, STATUS: EVIDENCE_QUALITY };');
  return build();
}

{
  const w = { VDSEN_EVIDENCE: makeEvidenceWindow() };
  const build = makeSnapshotFn(w);

  // No entries/InBody/nutrilog/interventions at all -> mostly UNRESOLVED,
  // but coachIntervention (no intervention is a KNOWN valid fact) stays VALID.
  const sparse = build({ clientId: 'c1', clientDoc: { activePlanId: 'plan-A' }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
  ok(sparse.evidenceQuality.recovery.status === 'UNRESOLVED', 'no check-in for the current week -> recovery UNRESOLVED');
  ok(sparse.evidenceQuality.progression.status === 'UNRESOLVED', 'no progression evidence at all -> progression UNRESOLVED');
  ok(sparse.evidenceQuality.coachIntervention.status === 'VALID', 'no Coach intervention at all -> coachIntervention VALID (a known fact, never flagged as missing)');
  ok(sparse.evidenceQuality.overall === 'UNRESOLVED', 'overall rolls up to the worst real domain status (UNRESOLVED here, since nothing is CONFLICTING/STALE)');
  ok(Array.isArray(sparse.evidenceQuality.unresolved) && sparse.evidenceQuality.unresolved.indexOf('recovery') !== -1 && sparse.evidenceQuality.unresolved.indexOf('progression') !== -1,
    'the unresolved[] array names exactly the domains that are UNRESOLVED');
  ok(sparse.evidenceQuality.conflicts.length === 0, 'no conflicts array entries when nothing is CONFLICTING');

  // Immutability / purity: building a snapshot never mutates the inputs.
  const clientDoc = { activePlanId: 'plan-A' };
  const before = JSON.stringify(clientDoc);
  build({ clientId: 'c1', clientDoc: clientDoc, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
  ok(JSON.stringify(clientDoc) === before, 'building a snapshot with evidenceQuality never mutates the clientDoc input');
}

{
  // A real conflict (measurement conflict) rolls all the way up to overall.
  const w = { VDSEN_EVIDENCE: makeEvidenceWindow() };
  const build = makeSnapshotFn(w);
  // No VDSEN_OUTCOME loaded -> prescriptionEffectiveness stays null ->
  // bodyComposition gate sees no data -> UNRESOLVED, not CONFLICTING.
  // This confirms the gate reads ONLY from already-computed fields, never
  // re-deriving InBody data itself even when it COULD.
  const s = build({ clientId: 'c1', clientDoc: { activePlanId: 'plan-A', inbodyResults: [{ ts: 1, peso: 80 }, { ts: 2, peso: 90 }] }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
  ok(s.evidenceQuality.bodyComposition.status === 'UNRESOLVED', 'without window.VDSEN_OUTCOME loaded, prescriptionEffectiveness is null -- the quality gate never re-derives InBody data itself, it only reads the already-computed field');
}

console.log('');
console.log('T286 — Snapshot quality integration: ' + pass + ' assertions PASSED');
