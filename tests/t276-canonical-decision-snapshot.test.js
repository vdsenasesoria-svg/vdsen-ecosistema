'use strict';
/**
 * T276 — Canonical client decision snapshot builder. Verifies the REAL
 * _buildClientDecisionSnapshot: composes the EXISTING T158-T274 helpers
 * (never reimplements them), is pure/read-only, deterministic, never
 * mutates its inputs, and never leaks state across clients/plans.
 *
 * Correctness of each individual decision (weeklyDecision's own rules,
 * adaptivePrescription's own rules, etc.) is already covered by their own
 * tickets' test suites -- this file verifies COMPOSITION/WIRING, not the
 * decisions themselves (per the ticket's "reuse T158-T274 helpers, no
 * second implementation of existing decisions").
 *
 * Run: node tests/t276-canonical-decision-snapshot.test.js
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

// The whole 733..1332 region is ONE contiguous closure in the real file --
// extract it as a single block (real, unmodified code) rather than
// reassembling each function by hand.
const blockStart = COACH.indexOf('  function _mapLogs(logsDoc) {');
const blockEnd   = COACH.indexOf('  function buildGenerationRequest(params) {');
ok(blockStart !== -1 && blockEnd !== -1 && blockEnd > blockStart, 'the _mapLogs..._buildClientDecisionSnapshot region extracts as one contiguous real block');
const block = COACH.slice(blockStart, blockEnd);

ok(block.includes('function _buildClientDecisionSnapshot(params)'), '_buildClientDecisionSnapshot is part of the extracted block');
ok(block.includes('window.VDSEN_SNAPSHOT = { build: _buildClientDecisionSnapshot };'), 'exposed via window.VDSEN_SNAPSHOT.build');

// ── Purity checks on the source itself ──────────────────────────────────────
const snapshotOnly = extractFunction(COACH, 'function _buildClientDecisionSnapshot(params)');
ok(!/setDoc|updateDoc|addDoc|runTransaction|deleteDoc|getDoc\(/.test(snapshotOnly), '_buildClientDecisionSnapshot performs no Firestore reads/writes -- pure compute over already-loaded docs');
ok(!/Object\.assign\(clientDoc|Object\.assign\(planDoc|clientDoc\.\w+\s*=|planDoc\.\w+\s*=/.test(snapshotOnly), 'never mutates clientDoc/planDoc by assignment');

// Every one of the 9 decision blocks + progression is composed from the
// EXACT existing helper calls (no reimplementation).
[
  '_mapLogs(logsDoc)',
  '_computeWeeklyDecisionForRequest(entries, planDoc)',
  '_computeAdaptivePrescriptionForRequest(planDoc, fd, clientDoc, logsResult.engineState, weeklyDecision, entries)',
  '_computeMesocycleDecisionForRequest(logsResult, planDoc, weeklyDecision, adaptivePrescription, clientDoc, entries)',
  '_computeExecutionFidelityForRequest(planDoc, weeklyDecision, logsResult.progressionHistory)',
  '_computeLearnedStateForRequest(entries, planDoc, logsResult.progressionHistory)',
  '_computePrescriptionEffectivenessForRequest(planDoc, fd, clientDoc, weeklyDecision, logsResult.progressionHistory, learnedState)',
  '_computeNutritionDecisionForRequest(entries, clientDoc, fd)',
  '_computeCoachSupervisionForRequest(entries, planDoc, weeklyDecision, prescriptionEffectiveness, week)', // T279 added the real week as a 5th arg
  '_computeCoachInterventionContextForRequest(clientDoc, planDoc)'
].forEach(function(callSig) {
  ok(snapshotOnly.includes(callSig), 'snapshot composes the real ' + callSig.split('(')[0] + ' call verbatim, not a reimplementation');
});

// ── Functional execution: window stubbed empty -- every cross-block
// dependency safely returns null (their own existing guards), so the
// snapshot must still assemble cleanly with no crash. ─────────────────────
function runSnapshot(windowStub, params) {
  const fn = new Function('window', block + '\nreturn _buildClientDecisionSnapshot;')(windowStub);
  return fn(params);
}

{
  const s = runSnapshot({}, { clientId: 'client-1', coachId: 'coach-1', clientDoc: { activePlanId: 'plan-A' }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 3 }, fd: {}, now: '2024-01-01T00:00:00.000Z' });
  ok(s.identity.clientId === 'client-1' && s.identity.activePlanId === 'plan-A' && s.identity.week === 3, 'identity reflects the real clientId/activePlanId/week given');
  ok(s.weeklyDecision === null && s.nutritionDecision === null, 'with no window.VDSEN_* modules loaded, every decision block safely resolves to null (existing guards), never crashes');
  ok(s.provenance.clientUpdatedAt === null && s.provenance.latestExecutionAt === null, 'provenance fields are honestly null when no real timestamp source exists -- never fabricated');
  ok(s.generatedAt === '2024-01-01T00:00:00.000Z', 'generatedAt reflects the given `now`, not a hidden Date.now()');
}

// ── No mutation of inputs ───────────────────────────────────────────────────
{
  const clientDoc = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2000 }, coachInterventions: [{ decidedAt: '2024-01-01T00:00:00.000Z' }] };
  const planDoc = { days: [{ dayIndex: 0 }] };
  const logsDoc = { entries: { 'ci_sem_1': { peso: 80 } }, currentWeek: 1 };
  const beforeClient = JSON.stringify(clientDoc), beforePlan = JSON.stringify(planDoc), beforeLogs = JSON.stringify(logsDoc);
  runSnapshot({}, { clientId: 'client-1', clientDoc: clientDoc, planDoc: planDoc, logsDoc: logsDoc, fd: {} });
  ok(JSON.stringify(clientDoc) === beforeClient && JSON.stringify(planDoc) === beforePlan && JSON.stringify(logsDoc) === beforeLogs,
    'clientDoc/planDoc/logsDoc are byte-identical after building a snapshot -- no mutation of source objects');
}

// ── Determinism: same inputs -> byte-identical snapshot ────────────────────
{
  const params = { clientId: 'client-1', clientDoc: { activePlanId: 'plan-A' }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 2 }, fd: {}, now: 'fixed' };
  const s1 = runSnapshot({}, Object.assign({}, params));
  const s2 = runSnapshot({}, Object.assign({}, params));
  ok(JSON.stringify(s1) === JSON.stringify(s2), 'the same client/plan/week/evidence always produces the same decision state (Core Principle)');
}

// ── No cross-client/cross-plan leakage ──────────────────────────────────────
{
  const sX = runSnapshot({}, { clientId: 'client-X', clientDoc: { activePlanId: 'plan-X', nutritionRaw: { calorias: 1800 } }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 5 }, fd: {} });
  const sY = runSnapshot({}, { clientId: 'client-Y', clientDoc: { activePlanId: 'plan-Y', nutritionRaw: { calorias: 3000 } }, planDoc: { days: [] }, logsDoc: { entries: {}, currentWeek: 1 }, fd: {} });
  ok(sX.identity.clientId === 'client-X' && sX.identity.activePlanId === 'plan-X' && sX.identity.week === 5, 'client X snapshot carries client X\'s own identity');
  ok(sY.identity.clientId === 'client-Y' && sY.identity.activePlanId === 'plan-Y' && sY.identity.week === 1, 'client Y snapshot carries client Y\'s own identity, completely independent of X');
}

// ── Real end-to-end wiring proof: the T268-271 nutrition module (already
// fully real and available) threads all the way through the snapshot,
// proving genuine composition, not just null-safe passthrough. ────────────
{
  const evidenceSrc     = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
  const outcomeConfSrc  = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
  const bodyCompSrc     = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
  const adherenceSrc    = extractFunction(COACH, 'function _classifyNutritionAdherence(nutrilogEntries, targets, options)');
  const responseSrc     = extractFunction(COACH, 'function _classifyNutritionResponse(inbodyResults, objetivoCalorico)');
  const decideSrc       = extractFunction(COACH, 'function _decideNutritionAction(input)');
  const actionEnumSrc   = extractFunction(COACH, 'var NUTRITION_ACTION = {').replace(/^var NUTRITION_ACTION = /, '');
  const nutritionModuleSrc = evidenceSrc + ';\n' + outcomeConfSrc + ';\n' + bodyCompSrc + ';\n' + adherenceSrc + ';\n' + responseSrc + ';\n' +
    'var NUTRITION_ACTION = ' + actionEnumSrc + ';\n' + decideSrc + ';\n' +
    'return { classifyAdherence: _classifyNutritionAdherence, classifyResponse: _classifyNutritionResponse, decide: _decideNutritionAction };';
  const VDSEN_NUTRITION = new Function(nutritionModuleSrc)();

  const NOW = Date.now();
  const entries = {};
  [0, 1, 2, 3, 4].forEach(function(i) { entries['nutrilog_d' + i] = { kcal: 2200, prot: 185, ts: NOW - i * 86400000 }; });
  const clientDoc = { activePlanId: 'plan-A', nutritionRaw: { calorias: 2200, proteina: 180 }, inbodyResults: null };
  const s = runSnapshot({ VDSEN_NUTRITION: VDSEN_NUTRITION }, { clientId: 'client-1', clientDoc: clientDoc, planDoc: { days: [] }, logsDoc: { entries: entries, currentWeek: 1 }, fd: {} });
  ok(s.nutritionDecision && s.nutritionDecision.adherence.classification === 'HIGH', 'with the real T268 nutrition module wired in via window.VDSEN_NUTRITION, the snapshot\'s nutritionDecision reflects the REAL computed adherence (HIGH), proving genuine end-to-end composition');
}

console.log('');
console.log('T276 — Canonical decision snapshot builder: ' + pass + ' assertions PASSED');
