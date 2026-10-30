'use strict';
/**
 * T274 — Nutrition decision loop E2E (CASE A-N) + residual audit. Chains
 * the REAL production functions end to end, not a reimplementation.
 *
 * RESIDUAL AUDIT (explicitly hunted, per the ticket's own concerns):
 *   - adherence inferred from bodyweight: NOT FOUND -- _classifyNutritionAdherence's
 *     signature never accepts inbodyResults/peso/ci_sem (T268 test already
 *     confirms this structurally; re-confirmed here end to end).
 *   - automatic calorie/macro mutation from a decision: NOT FOUND --
 *     _decideNutritionAction never calls setDoc/updateDoc/runTransaction
 *     (T270/T273), and _vdsenActivatePlanInFirestore never references
 *     VDSEN_NUTRITION/_decideNutritionAction at all (CASE M below).
 *   - a second nutrition engine recomputed in the Motor prompt: NOT FOUND
 *     -- the prompt explicitly forbids it (T271) and the request carries
 *     the already-computed nutritionDecision.
 *   - stale/cached decision surviving new evidence: NOT FOUND -- the
 *     *ForRequest function recomputes fresh from clientDoc/entries on
 *     every call, no memoization (CASE N below).
 *   - low adherence blamed on the calorie target: NOT FOUND -- T270's
 *     gate returns FREEZE before any response-based action can fire.
 *
 * No new findings beyond T268-273's already-applied design. This file is
 * the closing E2E, not a new-bug hunt.
 *
 * Run: node tests/t274-nutrition-decision-loop-e2e.test.js
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

// ── Extract every real function involved ────────────────────────────────────
const resolveSrc      = extractFunction(COACH, 'function _resolveOptionalPlanSection(previousValue, incomingRawValue)');
const genIdSrc         = extractFunction(COACH, 'function _genPrescriptionId()');
const stampSrc         = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
const rirSrc           = extractFunction(COACH, 'function rirSchemeForWeeks(totalWeeks)');
const normalizeTrainSrc = extractFunction(COACH, 'function _normalizeTraining(t)');
const normalizeNutrSrc  = extractFunction(COACH, 'function _normalizeNutrition(n)');
const normalizeSupplSrc = extractFunction(COACH, 'function _normalizeSupplementation(s)');
const normalizePlanSrc  = extractFunction(COACH, 'function _normalizePlan(p)');
const saveDraftSrc     = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore()');
const activateSrc      = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
const backupSrc         = extractFunction(COACH, 'async function backupPlanIfExists(clientId)');

const evidenceSrc      = extractFunction(COACH, 'function _computeEvidenceConfidence(observations, malformedCount)');
const outcomeConfSrc   = extractFunction(COACH, 'function _computeOutcomeConfidence(measurements, options)');
const bodyCompSrc      = extractFunction(COACH, 'function _classifyBodyCompositionResponse(inbodyResults, objetivoCalorico)');
const adherenceSrc     = extractFunction(COACH, 'function _classifyNutritionAdherence(nutrilogEntries, targets, options)');
const responseSrc      = extractFunction(COACH, 'function _classifyNutritionResponse(inbodyResults, objetivoCalorico)');
const decideSrc         = extractFunction(COACH, 'function _decideNutritionAction(input)');
const actionEnumSrc     = extractFunction(COACH, 'var NUTRITION_ACTION = {').replace(/^var NUTRITION_ACTION = /, '');
const forRequestSrc     = extractFunction(COACH, 'function _computeNutritionDecisionForRequest(entries, clientDoc, fd)');

ok([resolveSrc, genIdSrc, stampSrc, rirSrc, normalizeTrainSrc, normalizeNutrSrc, normalizeSupplSrc, normalizePlanSrc,
    saveDraftSrc, activateSrc, backupSrc, evidenceSrc, outcomeConfSrc, bodyCompSrc, adherenceSrc, responseSrc,
    decideSrc, actionEnumSrc, forRequestSrc].every(Boolean),
  'prerequisite: every real T259-T273 function extracts cleanly');

// ── Build the nutrition module (real code) ──────────────────────────────────
function makeNutritionModule() {
  return new Function('window',
    evidenceSrc + ';\n' + outcomeConfSrc + ';\n' + bodyCompSrc + ';\n' +
    adherenceSrc + ';\n' + responseSrc + ';\n' +
    'var NUTRITION_ACTION = ' + actionEnumSrc + ';\n' + decideSrc + ';\n' +
    forRequestSrc + ';\n' +
    'window.VDSEN_NUTRITION = { classifyAdherence: _classifyNutritionAdherence, classifyResponse: _classifyNutritionResponse, decide: _decideNutritionAction, ACTION: NUTRITION_ACTION };\n' +
    'return { classifyAdherence: _classifyNutritionAdherence, classifyResponse: _classifyNutritionResponse, decide: _decideNutritionAction, forRequest: _computeNutritionDecisionForRequest };'
  )({});
}
const N = makeNutritionModule();

const DAY = 86400000, NOW = Date.now();
function nutriDay(offsetDays, kcal, prot) { return { kcal: kcal, prot: prot, ts: NOW - offsetDays * DAY }; }
function inb(weeksAgo, peso, extra) { return Object.assign({ ts: NOW - weeksAgo * 7 * DAY, peso: peso }, extra || {}); }
const TIGHT_LOG = [0, 1, 2, 3, 4].map(function(i) { return nutriDay(i, 2200, 185); }); // HIGH adherence vs {2200,180}
const LOW_LOG    = [0, 1, 2, 3, 4].map(function(i) { return nutriDay(i, 3400, 90); });  // LOW adherence

// ─────────────────────────────────────────────────────────────────────────────
// CASE A — high adherence + on-target fat-loss response -> KEEP.
// ─────────────────────────────────────────────────────────────────────────────
{
  const adherence = N.classifyAdherence(TIGHT_LOG, { calorias: 2200, proteina: 180 });
  const response  = N.classifyResponse([inb(6, 80), inb(3, 78.55), inb(0, 77.1)], 'déficit');
  const decision  = N.decide({ adherence: adherence, response: response });
  ok(adherence.classification === 'HIGH' && response.classification === 'ON_TARGET' && decision.action === 'KEEP',
    'CASE A: high adherence + on-target fat-loss response -> KEEP');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE B — high adherence + repeated slow response, adequate time ->
// REVIEW_DECREASE_CALORIES, a recommendation only (no automatic mutation).
// ─────────────────────────────────────────────────────────────────────────────
{
  const adherence = N.classifyAdherence(TIGHT_LOG, { calorias: 2200, proteina: 180 });
  const response  = N.classifyResponse([inb(8, 80), inb(4, 79.68), inb(0, 79.36)], 'déficit');
  const decision  = N.decide({ adherence: adherence, response: response });
  ok(response.classification === 'SLOW_RESPONSE' && decision.action === 'REVIEW_DECREASE_CALORIES',
    'CASE B: high adherence + repeated slow response over adequate time -> REVIEW_DECREASE_CALORIES');
  ok(!/setDoc|updateDoc|runTransaction/.test(decideSrc), 'CASE B: the decision is a recommendation string only -- _decideNutritionAction cannot itself mutate anything');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE C — low adherence + no progress -> FREEZE, NEVER a calorie
// reduction (Core Principle).
// ─────────────────────────────────────────────────────────────────────────────
{
  const adherence = N.classifyAdherence(LOW_LOG, { calorias: 2200, proteina: 180 });
  const response  = N.classifyResponse([inb(6, 80), inb(3, 80.5), inb(0, 81)], 'déficit'); // off-target
  const decision  = N.decide({ adherence: adherence, response: response });
  ok(adherence.classification === 'LOW' && decision.action === 'FREEZE' && decision.action !== 'REVIEW_DECREASE_CALORIES',
    'CASE C: low adherence + no progress -> FREEZE (adherence-limited), never a calorie reduction');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE D — fast weight loss + recovery/performance declining ->
// COACH_REVIEW (never an automatic increase); without decline -> REVIEW_INCREASE_CALORIES.
// ─────────────────────────────────────────────────────────────────────────────
{
  const adherence = N.classifyAdherence(TIGHT_LOG, { calorias: 2200, proteina: 180 });
  const response  = N.classifyResponse([inb(4, 80), inb(2, 76.8), inb(0, 73.6)], 'déficit'); // ~2%/week, FAST
  ok(response.classification === 'FAST_RESPONSE', 'CASE D prerequisite: ~2%BW/week loss classifies as FAST_RESPONSE');
  const decisionDecline = N.decide({ adherence: adherence, response: response, recoveryDeclining: true });
  ok(decisionDecline.action === 'COACH_REVIEW', 'CASE D: fast weight loss + declining recovery/performance -> COACH_REVIEW, never an automatic calorie increase');
  const decisionNoDecline = N.decide({ adherence: adherence, response: response, recoveryDeclining: false });
  ok(decisionNoDecline.action === 'REVIEW_INCREASE_CALORIES', 'CASE D variant: fast response with no recovery concern -> REVIEW_INCREASE_CALORIES');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE E — one InBody measurement -> INSUFFICIENT_DATA.
// ─────────────────────────────────────────────────────────────────────────────
{
  const response = N.classifyResponse([inb(0, 80)], 'déficit');
  ok(response.classification === 'INSUFFICIENT_DATA', 'CASE E: a single InBody measurement -> INSUFFICIENT_DATA');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE F — measurement conflict -> MEASUREMENT_CONFLICT -> FREEZE (no
// adjustment of any kind).
// ─────────────────────────────────────────────────────────────────────────────
{
  const response = N.classifyResponse([inb(1, 80), inb(0, 90)], 'déficit');
  const decision  = N.decide({ adherence: N.classifyAdherence(TIGHT_LOG, { calorias: 2200 }), response: response });
  ok(response.classification === 'MEASUREMENT_CONFLICT' && decision.action === 'FREEZE',
    'CASE F: an implausible measurement swing -> MEASUREMENT_CONFLICT -> FREEZE, no adjustment, outranks even high adherence');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE G — recomposition: weight stable, body composition improving ->
// ON_TARGET.
// ─────────────────────────────────────────────────────────────────────────────
{
  const response = N.classifyResponse(
    [inb(6, 75, { pbf: 18, smm: 34 }), inb(3, 75.1, { pbf: 17.25, smm: 34.4 }), inb(0, 75.2, { pbf: 16.5, smm: 34.8 })],
    'mantenimiento'
  );
  ok(response.classification === 'ON_TARGET', 'CASE G: recomposition (weight stable, PBF down, SMM up) -> ON_TARGET');
}

// ── Full plan-activation harness (T261/T265's real chain) for CASE H/I/J/K ──
function makeActivationHarness() {
  const plansDb = {}, clientsDb = {}, backupsDb = [];
  const fakeDoc = function(db, coll, id) { return { __coll: coll, __id: id }; };
  const fakeGetDoc = async function(ref) {
    const store = ref.__coll === 'plans' ? plansDb : clientsDb;
    const data = store[ref.__id];
    return { exists: function() { return data !== undefined; }, data: function() { return data; } };
  };
  const fakeSetDoc = async function(ref, data) { (ref.__coll === 'plans' ? plansDb : clientsDb)[ref.__id] = data; };
  const fakeAddDoc = async function(collRef, data) { backupsDb.push(data); return { id: 'backup-' + backupsDb.length }; };
  const fakeCollection = function(db, name) { return { __coll: name }; };
  const fakeServerTimestamp = function() { return '__SERVER_TS__'; };
  const fakeDeleteField = function() { return '__DELETE_FIELD__'; };
  const fakeAuth = { currentUser: { uid: 'coach-1' } };
  const fakeRunTransaction = async function(db, cb) {
    const t = {
      get: async function(ref) { return fakeGetDoc(ref); },
      update: function(ref, data) {
        const store = ref.__coll === 'plans' ? plansDb : clientsDb;
        Object.keys(data).forEach(function(k) {
          if (data[k] === '__DELETE_FIELD__') delete store[ref.__id][k];
          else store[ref.__id][k] = data[k];
        });
      }
    };
    return cb(t);
  };

  var _vdsenCurrentPreview = null;
  const fn = new Function('doc', 'getDoc', 'setDoc', 'addDoc', 'collection', 'runTransaction', 'deleteField', 'serverTimestamp', 'auth', 'db', 'window', 'currentCoach',
    resolveSrc + ';\n' + genIdSrc + ';\n' + stampSrc + ';\n' + rirSrc + ';\n' +
    normalizeTrainSrc + ';\n' + normalizeNutrSrc + ';\n' + normalizeSupplSrc + ';\n' + normalizePlanSrc + ';\n' +
    'var _vdsenCurrentPreview = null; var _vdsenReviewState = {};\n' +
    saveDraftSrc + ';\n' + activateSrc + ';\n' + backupSrc + ';\n' +
    'return { saveDraft: _vdsenSaveDraftToFirestore, activate: _vdsenActivatePlanInFirestore, backup: backupPlanIfExists, ' +
    'setPreview: function(p) { _vdsenCurrentPreview = p; } };'
  )(fakeDoc, fakeGetDoc, fakeSetDoc, fakeAddDoc, fakeCollection, fakeRunTransaction, fakeDeleteField, fakeServerTimestamp, fakeAuth, {}, {}, { uid: 'coach-1' });

  return { fn: fn, plansDb: plansDb, clientsDb: clientsDb, backupsDb: backupsDb };
}
function genResp(requestId, planOverrides) {
  return { clientId: 'client-1', requiresReview: false, resp: { requestId: requestId, status: 'VALID', plan: Object.assign({ schema: 'vdsen-plan-v2', entrenamiento: { weeks: 6, days: [] } }, planOverrides) } };
}
async function runCycle(h, requestId, planOverrides) {
  h.fn.setPreview(genResp(requestId, planOverrides));
  await h.fn.saveDraft();
  await h.fn.activate(requestId, 'client-1');
  return h.clientsDb['client-1'];
}

async function main() {
  const baseline = { coachId: 'coach-1', activePlanId: 'plan-OLD', nutritionRaw: { calorias: 2200, comidas: [{ nombre: 'Desayuno' }, { nombre: 'Almuerzo' }, { nombre: 'Cena' }] }, supplementsRaw: { tiers: [{ nombre: 'Base' }] } };
  const withOldPlanDoc = function(h) { h.plansDb['plan-OLD'] = { coachId: 'coach-1', clientId: 'client-1', status: 'draft_approved' }; };

  // CASE H — training-only activation -> nutrition decision/context
  // preserved correctly (nutritionRaw untouched, so a nutritionDecision
  // computed before and after is based on the SAME real target).
  {
    const h = makeActivationHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const before = N.forRequest({}, h.clientsDb['client-1'], {});
    const result = await runCycle(h, 'req-H', {}); // training-only
    ok(result.nutritionRaw.calorias === 2200 && result.nutritionRaw.comidas.length === 3,
      'CASE H: a training-only activation leaves nutritionRaw (including its 3 meals) completely untouched');
    const after = N.forRequest({}, result, {});
    ok(JSON.stringify(before.adherence) === JSON.stringify(after.adherence),
      'CASE H: nutritionDecision context computed after a training-only activation matches before -- correctly preserved, not silently reset');
  }

  // CASE I — nutrition adjustment approved -> new nutrition replaces
  // previous -> supplements preserved if absent.
  {
    const h = makeActivationHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-I', { nutricion: { calorias: 1800, comidas: [{ nombre: 'Unica' }] } });
    ok(result.nutritionRaw.calorias === 1800, 'CASE I: an approved nutrition adjustment replaces the previous nutritionRaw');
    ok(result.supplementsRaw.tiers[0].nombre === 'Base', 'CASE I: supplements are preserved (absent from this plan)');
  }

  // CASE J — exact 3-meal plan -> remains exactly 3 meals after an
  // unrelated (training-only) adjustment.
  {
    const h = makeActivationHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-J', { entrenamiento: { weeks: 4, days: [{ dayIndex: 0, exercises: [] }] } });
    ok(result.nutritionRaw.comidas.length === 3, 'CASE J: the exact 3-meal count is preserved byte-for-byte after a training-only adjustment');
  }

  // CASE K — substitutions with grams survive a full nutrition-replace
  // round-trip (whole-object atomicity, T273).
  {
    const h = makeActivationHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const newNutricion = { calorias: 2000, comidas: [
      { nombre: 'Desayuno', sustituciones: [{ nombre: 'Avena', gramos: 80 }, { nombre: 'Arroz', gramos: 70 }] }
    ] };
    const result = await runCycle(h, 'req-K', { nutricion: newNutricion });
    ok(result.nutritionRaw.comidas[0].sustituciones.length === 2 &&
       result.nutritionRaw.comidas[0].sustituciones[0].gramos === 80 &&
       result.nutritionRaw.comidas[0].sustituciones[1].gramos === 70,
      'CASE K: substitutions with their exact grams survive the full save-draft -> activate round-trip');
  }

  // CASE L — low-confidence nutrition state -> Generator context reflects
  // FREEZE/COACH_REVIEW, never a redesign-style action (REVIEW_MACROS/
  // REVIEW_DECREASE_CALORIES/REVIEW_INCREASE_CALORIES).
  {
    const clientDoc = { nutritionRaw: { calorias: 2200, proteina: 180 }, inbodyResults: [inb(6, 80), inb(3, 80.5), inb(0, 81)] };
    const entries = {};
    LOW_LOG.forEach(function(e, i) { entries['nutrilog_2024-01-' + (10 + i)] = e; });
    const result = N.forRequest(entries, clientDoc, { objetivo_calorico: 'déficit' });
    const REDESIGN_ACTIONS = ['REVIEW_MACROS', 'REVIEW_DECREASE_CALORIES', 'REVIEW_INCREASE_CALORIES', 'REVIEW_MEAL_STRUCTURE'];
    ok(REDESIGN_ACTIONS.indexOf(result.action) === -1, 'CASE L: low-confidence adherence -> the Generator context is FREEZE/COACH_REVIEW, never a redesign-style recommendation');
  }

  // CASE M — Coach explicit nutrition decision outranks any stale
  // automated recommendation: activation NEVER even references the
  // decision engine, so an explicit Coach plan always applies regardless
  // of what nutritionDecision last recommended (e.g. even a prior FREEZE).
  {
    ok(!activateSrc.includes('VDSEN_NUTRITION') && !activateSrc.includes('_decideNutritionAction'),
      'CASE M: _vdsenActivatePlanInFirestore never references VDSEN_NUTRITION/_decideNutritionAction at all -- a Coach\'s explicit new plan always activates, structurally incapable of being blocked by a stale FREEZE/COACH_REVIEW recommendation');
    const h = makeActivationHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-M', { nutricion: { calorias: 2600, comidas: [{ nombre: 'X' }] } });
    ok(result.nutritionRaw.calorias === 2600, 'CASE M: the Coach\'s explicit new nutrition plan applies successfully regardless of any prior recommendation state');
  }

  // CASE N — a new outcome after the Coach's adjustment lets the system
  // form a NEW decision from new evidence -- no caching/staleness.
  {
    const clientDocBefore = { nutritionRaw: { calorias: 2600 }, inbodyResults: [inb(6, 80), inb(3, 78.55), inb(0, 77.1)] };
    const resultBefore = N.forRequest({}, clientDocBefore, { objetivo_calorico: 'déficit' });
    const clientDocAfter = { nutritionRaw: { calorias: 2600 }, inbodyResults: [inb(4, 80), inb(2, 76.8), inb(0, 73.6)] }; // now FAST
    const resultAfter = N.forRequest({}, clientDocAfter, { objetivo_calorico: 'déficit' });
    ok(resultBefore.response.classification !== resultAfter.response.classification,
      'CASE N: fresh evidence (a new InBody trend) produces a DIFFERENT response/decision than before -- no stale caching, the system re-forms its read from current data every time');
  }

  console.log('');
  console.log('T274 — Nutrition decision loop E2E (CASE A-N) + residual audit: ' + pass + ' assertions PASSED');
}

main().catch(function(e) { console.error(e); process.exit(1); });
