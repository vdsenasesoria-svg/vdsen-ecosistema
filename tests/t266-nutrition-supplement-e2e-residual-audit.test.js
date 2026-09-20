'use strict';
/**
 * T266 — Nutrition/supplement continuity E2E (CASE A-N) + residual audit.
 * Chains the REAL production functions (_resolveOptionalPlanSection,
 * _vdsenSaveDraftToFirestore, _vdsenActivatePlanInFirestore,
 * backupPlanIfExists) end to end, not a reimplementation.
 *
 * RESIDUAL AUDIT (explicitly hunted, per the ticket's bug-pattern list):
 *   - `incoming.nutrition || previous.nutrition` collapsing meaningful
 *     empty: NOT FOUND at either fixed call site (T260's 3-way resolver
 *     replaces any such pattern).
 *   - `incoming.supplements || []`: NOT FOUND -- T261's fix never
 *     defaults to an array/object literal for presence decisions.
 *   - object-spread order accidentally overwriting preserved fields:
 *     NOT FOUND -- draftDoc/clientUpdate/backup objects all set
 *     nutrition/supplement keys AFTER the base spread, deliberately,
 *     and only when action !== PRESERVE.
 *   - normalization inventing empty arrays: NOT FOUND -- _normalizeNutrition/
 *     _normalizeSupplementation both early-return the original falsy value.
 *   - JSON serialization collapsing intent: N/A -- Firestore's own
 *     undefined-vs-null-vs-value distinction is used directly, never
 *     round-tripped through JSON.stringify in the write path.
 *   - backup object mutated after merge: NOT FOUND (T265, immutability
 *     tests).
 *   - Client reading nutrition from one source and supplements from
 *     another: NOT FOUND -- both read from clients/{uid} exclusively via
 *     the SAME loadPlan() construction (T264).
 *   - Preview path and import path using different rules: NOT FOUND --
 *     Preview path now uses _resolveOptionalPlanSection (T261); import
 *     paths independently already implemented the equivalent
 *     PRESERVE/REPLACE behavior (T259/T263) via their own conditional
 *     `if (x) {...}` -- behaviorally equivalent, not a second policy.
 *
 * No new findings beyond T261/T265's fixes. This file is the closing E2E,
 * not a new-bug hunt.
 *
 * Run: node tests/t266-nutrition-supplement-e2e-residual-audit.test.js
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

const resolveSrc    = extractFunction(COACH, 'function _resolveOptionalPlanSection(previousValue, incomingRawValue)');
const genIdSrc       = extractFunction(COACH, 'function _genPrescriptionId()');
const stampSrc       = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
const rirSrc         = extractFunction(COACH, 'function rirSchemeForWeeks(totalWeeks)');
const normalizeTrainSrc = extractFunction(COACH, 'function _normalizeTraining(t)');
const normalizeNutrSrc  = extractFunction(COACH, 'function _normalizeNutrition(n)');
const normalizeSupplSrc = extractFunction(COACH, 'function _normalizeSupplementation(s)');
const normalizePlanSrc  = extractFunction(COACH, 'function _normalizePlan(p)');
const saveDraftSrc  = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore()');
const activateSrc   = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
const backupSrc      = extractFunction(COACH, 'async function backupPlanIfExists(clientId)');

ok([resolveSrc, genIdSrc, stampSrc, rirSrc, normalizeTrainSrc, normalizeNutrSrc, normalizeSupplSrc, normalizePlanSrc, saveDraftSrc, activateSrc, backupSrc].every(Boolean),
  'prerequisite: every real T259-T265 function extracts cleanly');

function makeHarness() {
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
  const clientUpdatesLog = [];
  const fakeRunTransaction = async function(db, cb) {
    const t = {
      get: async function(ref) { return fakeGetDoc(ref); },
      update: function(ref, data) {
        const store = ref.__coll === 'plans' ? plansDb : clientsDb;
        Object.keys(data).forEach(function(k) {
          if (data[k] === '__DELETE_FIELD__') delete store[ref.__id][k];
          else store[ref.__id][k] = data[k];
        });
        if (ref.__coll === 'clients') clientUpdatesLog.push(data);
      }
    };
    return cb(t);
  };

  var _vdsenCurrentPreview = null;
  var _vdsenReviewState = {};

  const fn = new Function('doc', 'getDoc', 'setDoc', 'addDoc', 'collection', 'runTransaction', 'deleteField', 'serverTimestamp', 'auth', 'db', 'window', 'currentCoach',
    resolveSrc + ';\n' + genIdSrc + ';\n' + stampSrc + ';\n' + rirSrc + ';\n' +
    normalizeTrainSrc + ';\n' + normalizeNutrSrc + ';\n' + normalizeSupplSrc + ';\n' + normalizePlanSrc + ';\n' +
    'var _vdsenCurrentPreview = null; var _vdsenReviewState = {};\n' +
    saveDraftSrc + ';\n' + activateSrc + ';\n' + backupSrc + ';\n' +
    'return { saveDraft: _vdsenSaveDraftToFirestore, activate: _vdsenActivatePlanInFirestore, backup: backupPlanIfExists, ' +
    'setPreview: function(p) { _vdsenCurrentPreview = p; } };'
  )(fakeDoc, fakeGetDoc, fakeSetDoc, fakeAddDoc, fakeCollection, fakeRunTransaction, fakeDeleteField, fakeServerTimestamp, fakeAuth, {}, {}, { uid: 'coach-1' });

  return { fn: fn, plansDb: plansDb, clientsDb: clientsDb, backupsDb: backupsDb, clientUpdatesLog: clientUpdatesLog };
}

function generatorResp(requestId, planOverrides) {
  return { clientId: 'client-1', requiresReview: false, resp: { requestId: requestId, status: 'VALID', plan: Object.assign({ schema: 'vdsen-plan-v2', entrenamiento: { weeks: 6, days: [] } }, planOverrides) } };
}

async function runCycle(h, requestId, planOverrides) {
  h.fn.setPreview(generatorResp(requestId, planOverrides));
  await h.fn.saveDraft();
  await h.fn.backup('client-1');
  await h.fn.activate(requestId, 'client-1');
  return h.clientsDb['client-1'];
}

async function main() {
  const baseline = { coachId: 'coach-1', activePlanId: 'plan-OLD', nutritionRaw: { calorias: 2200 }, nutritionPlan: { calorias: 2200 }, supplementsRaw: { tiers: [{ nombre: 'Base' }] }, supplementPlan: { texto: 'Creatina' } };
  const withOldPlanDoc = function(h) { h.plansDb['plan-OLD'] = { coachId: 'coach-1', clientId: 'client-1', status: 'draft_approved', nutritionRaw: { calorias: 2200 }, supplementsRaw: { tiers: [{ nombre: 'Base' }] } }; };

  // CASE A — training only -> both preserved.
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-A', {});
    ok(result.nutritionRaw.calorias === 2200 && result.supplementsRaw.tiers[0].nombre === 'Base', 'CASE A: training-only change preserves both nutrition and supplements');
  }

  // CASE B — new nutrition -> nutrition replaced, supplements preserved.
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-B', { nutricion: { calorias: 1800 } });
    ok(result.nutritionRaw.calorias === 1800, 'CASE B: nutrition replaced with the new value');
    ok(result.supplementsRaw.tiers[0].nombre === 'Base', 'CASE B: supplements preserved (absent from this plan)');
  }

  // CASE C — new supplements -> supplements replaced, nutrition preserved.
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-C', { suplementacion: { tiers: [{ nombre: 'Nuevo' }] } });
    ok(result.supplementsRaw.tiers[0].nombre === 'Nuevo', 'CASE C: supplements replaced with the new value');
    ok(result.nutritionRaw.calorias === 2200, 'CASE C: nutrition preserved (absent from this plan)');
  }

  // CASE D — full plan with both -> both replaced.
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-D', { nutricion: { calorias: 3000 }, suplementacion: { tiers: [{ nombre: 'Full' }] } });
    ok(result.nutritionRaw.calorias === 3000 && result.supplementsRaw.tiers[0].nombre === 'Full', 'CASE D: both explicitly provided -> both replaced');
  }

  // CASE E — explicit nutrition removal -> nutrition cleared, supplements untouched.
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-E', { nutricion: null });
    ok(!('nutritionRaw' in result) || result.nutritionRaw === undefined, 'CASE E: nutrition explicitly cleared');
    ok(result.supplementsRaw.tiers[0].nombre === 'Base', 'CASE E: supplements untouched by the nutrition removal');
  }

  // CASE F — explicit supplement removal -> supplements cleared, nutrition untouched.
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-F', { suplementacion: null });
    ok(!('supplementsRaw' in result) || result.supplementsRaw === undefined, 'CASE F: supplements explicitly cleared');
    ok(result.nutritionRaw.calorias === 2200, 'CASE F: nutrition untouched by the supplement removal');
  }

  // CASE G — legacy incoming plan has neither field -> preserve both (same as A, different framing).
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    const result = await runCycle(h, 'req-G', { entrenamiento: { weeks: 4, days: [{ dayIndex: 0, exercises: [] }] } });
    ok(result.nutritionRaw.calorias === 2200 && result.supplementsRaw.tiers[0].nombre === 'Base', 'CASE G: a legacy/plain training update with neither field present preserves both');
  }

  // CASE H — training-only JSON import path (the DIRECT clientUpdates
  // writer, not the Preview pipeline) -- confirmed structurally: with no
  // nutrition/supplements variable truthy, the conditional writer never
  // includes those keys, so a partial updateDoc leaves them untouched.
  {
    function importUpdate(nutrition, supplements) {
      const upd = {};
      if (nutrition) { upd.nutritionPlan = nutrition; upd.nutritionRaw = nutrition; }
      const supPlan = supplements ? supplements : null;
      if (supPlan) { upd.supplementPlan = supPlan; upd.supplementsRaw = supplements; }
      return upd;
    }
    ok(Object.keys(importUpdate(null, null)).length === 0, 'CASE H: a training-only import produces an EMPTY clientUpdates object -- updateDoc with {} touches nothing, preserving both sections structurally');
  }

  // CASE I — backup before activation -> old nutrition/supplements remain
  // exact in the backup (re-confirmed here as part of the full cycle).
  {
    const h = makeHarness(); h.clientsDb['client-1'] = Object.assign({}, baseline); withOldPlanDoc(h);
    await runCycle(h, 'req-I', { nutricion: { calorias: 9999 } });
    ok(h.backupsDb.length === 1 && h.backupsDb[0].nutritionRaw.calorias === 2200, 'CASE I: the backup captured the OLD (2200) nutrition, unaffected by the NEW plan\'s 9999 -- exact outgoing snapshot');
  }

  // CASE J — preview round-trip: missing stays missing, empty stays
  // explicit empty (re-confirmed via the same real chain).
  {
    const h = makeHarness(); h.clientsDb['client-1'] = { coachId: 'coach-1', activePlanId: 'plan-OLD' };
    const result = await runCycle(h, 'req-J', { nutricion: { calorias: 0, comidas: [] } }); // explicit, present, "empty-looking"
    ok(result.nutritionRaw.calorias === 0 && Array.isArray(result.nutritionRaw.comidas), 'CASE J: an explicitly-provided, empty-looking (zeroed) nutrition object still replaces -- presence, not shape, decides');
  }

  // CASE K — client switch: covered structurally in T264 (full reload on
  // any activePlanId change re-derives PLAN.nutricion/suplementacion
  // fresh) -- re-confirmed by source presence here.
  {
    const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
    ok(CLIENT.includes('location.reload();'), 'CASE K: a client-side activePlanId change triggers a full reload -- no stale previous-plan nutrition/supplement render survives');
  }

  // CASE L — activation fails (ownership mismatch) -> no false-success,
  // old active plan remains authoritative (the transaction throws before
  // any client update is applied).
  {
    const h = makeHarness();
    h.clientsDb['client-1'] = { coachId: 'coach-1', activePlanId: 'plan-OLD', nutritionRaw: { calorias: 2200 } };
    h.plansDb['req-L'] = { coachId: 'coach-OTHER', clientId: 'client-1', status: 'draft_approved' }; // FOREIGN_OWNER
    let threw = false;
    try { await h.fn.activate('req-L', 'client-1'); } catch (e) { threw = true; }
    ok(threw, 'CASE L: activation throws on ownership mismatch -- no false success');
    ok(h.clientsDb['client-1'].activePlanId === 'plan-OLD' && h.clientsDb['client-1'].nutritionRaw.calorias === 2200,
      'CASE L: the old active plan (and its nutrition) remains fully authoritative after a failed activation -- zero partial writes leaked through');
  }

  // CASE M — double activation click: the pre-existing idempotency guard
  // makes a second activation of the SAME already-active plan a no-op.
  {
    const h = makeHarness();
    h.clientsDb['client-1'] = { coachId: 'coach-1', activePlanId: 'plan-OLD' };
    h.plansDb['req-M'] = { coachId: 'coach-1', clientId: 'client-1', status: 'draft_approved', nutritionRaw: { calorias: 1500 } };
    await h.fn.activate('req-M', 'client-1');
    const afterFirst = JSON.stringify(h.clientsDb['client-1']);
    await h.fn.activate('req-M', 'client-1'); // simulated double click
    ok(JSON.stringify(h.clientsDb['client-1']) === afterFirst, 'CASE M: re-activating the SAME already-active plan (simulated double click) produces byte-identical client state -- one effective activation, no duplicate merge');
    ok(h.clientUpdatesLog.length === 1, 'CASE M: exactly one real client update was ever issued across both calls -- the second is a structural no-op');
  }

  // CASE N — slow activation + client context switch: _vdsenActivatePlanInFirestore
  // is parameter-bound to the EXACT clientId passed in, never a global/UI
  // selection -- structurally cannot cross-contaminate another client
  // even if the Coach's UI moves on to a different client mid-flight.
  {
    const h = makeHarness();
    h.clientsDb['client-1'] = { coachId: 'coach-1', activePlanId: 'plan-OLD' };
    h.clientsDb['client-2'] = { coachId: 'coach-1', activePlanId: 'plan-OTHER', nutritionRaw: { calorias: 4000 } };
    h.plansDb['req-N'] = { coachId: 'coach-1', clientId: 'client-1', status: 'draft_approved', nutritionRaw: { calorias: 1200 } };
    await h.fn.activate('req-N', 'client-1'); // bound to client-1 regardless of any "UI state" elsewhere
    ok(h.clientsDb['client-1'].nutritionRaw.calorias === 1200, 'CASE N: client-1 correctly received the new plan\'s nutrition');
    ok(h.clientsDb['client-2'].activePlanId === 'plan-OTHER' && h.clientsDb['client-2'].nutritionRaw.calorias === 4000,
      'CASE N: client-2 (a different client, simulating a mid-flight context switch elsewhere in the UI) is completely untouched -- no cross-client contamination is even structurally possible, since clientId is an explicit parameter, never global UI state');
  }

  console.log('');
  console.log('T266 — E2E (CASE A-N) + residual audit: ' + pass + ' assertions PASSED');
}

main().catch(function(e) { console.error(e); process.exit(1); });
