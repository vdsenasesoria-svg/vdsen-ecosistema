'use strict';
/**
 * T262 — Preview/activation round-trip. Verifies presence semantics
 * survive: buildGenerationRequest's response -> preview state
 * (_vdsenCurrentPreview) -> _vdsenSaveDraftToFirestore (draft plan doc)
 * -> _vdsenActivatePlanInFirestore (persisted active plan), chained as
 * ONE real execution, not two isolated harnesses.
 *
 * Explicitly hunts the bug patterns this ticket calls out: JSON
 * normalization (_normalizePlan), destructuring defaults, `|| []`/`|| ""`,
 * missing-vs-empty collapse, preview sanitization. Confirmed clean at the
 * server/dead-code layer too (api/vdsen-plan-normalizer.js already uses
 * the correct `if (x) obj.x = x` pattern, though unused by the live
 * /api/vdsen-generate response path -- audited, not modified, no bug).
 *
 * Run: node tests/t262-preview-activation-roundtrip.test.js
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
// _normalizePlan (the shared normalizer feeding BOTH preview render and
// draft save) never collapses undefined/null into {} for the optional
// sections -- confirmed at the source everything else depends on.
// ─────────────────────────────────────────────────────────────────────────────

const normalizePlanSrc  = extractFunction(COACH, 'function _normalizePlan(p)');
const normalizeTrainSrc = extractFunction(COACH, 'function _normalizeTraining(t)');
const normalizeNutrSrc  = extractFunction(COACH, 'function _normalizeNutrition(n)');
const normalizeSupplSrc = extractFunction(COACH, 'function _normalizeSupplementation(s)');
ok([normalizePlanSrc, normalizeTrainSrc, normalizeNutrSrc, normalizeSupplSrc].every(Boolean), 'prerequisite: _normalizePlan and its 3 dependencies extract cleanly');

const normalizePlan = new Function(normalizeTrainSrc + ';\n' + normalizeNutrSrc + ';\n' + normalizeSupplSrc + ';\n' + normalizePlanSrc + ';\nreturn _normalizePlan;')();

(function testNormalizePlanPreservesPresence() {
  const trainingOnly = normalizePlan({ schema: 'vdsen-plan-v2', entrenamiento: { weeks: 6, days: [] } });
  ok(trainingOnly.nutricion === undefined && trainingOnly.suplementacion === undefined, '_normalizePlan: a training-only raw response -> nutricion/suplementacion stay genuinely undefined, never collapsed to {}');

  const explicitNull = normalizePlan({ schema: 'vdsen-plan-v2', entrenamiento: {}, nutricion: null });
  ok(explicitNull.nutricion === null, '_normalizePlan: an explicit null nutricion survives as null, distinguishable from undefined');

  const withContent = normalizePlan({ schema: 'vdsen-plan-v2', entrenamiento: {}, nutricion: { calorias: 2000, comidas: [] } });
  ok(withContent.nutricion && withContent.nutricion.calorias === 2000, '_normalizePlan: real content passes through unmodified');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Full chained round-trip: a realistic Generator response (as
// _vdsenAIShowPreview would receive and store in _vdsenCurrentPreview) ->
// _vdsenSaveDraftToFirestore -> the resulting draft plan doc ->
// _vdsenActivatePlanInFirestore -> the final client update. ONE
// continuous real execution, not independently-fixtured halves.
// ─────────────────────────────────────────────────────────────────────────────

const resolveSrc  = extractFunction(COACH, 'function _resolveOptionalPlanSection(previousValue, incomingRawValue)');
const genIdSrc     = extractFunction(COACH, 'function _genPrescriptionId()');
const stampSrc     = extractFunction(COACH, 'function _stampPrescriptionIds(days)');
const rirSrc       = extractFunction(COACH, 'function rirSchemeForWeeks(totalWeeks)');
const saveDraftSrc = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore()');
const activateSrc  = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');

ok([resolveSrc, genIdSrc, stampSrc, rirSrc, saveDraftSrc, activateSrc].every(Boolean), 'prerequisite: every real function in the full round-trip extracts cleanly');

function makeRoundTripHarness() {
  const plansDb = {};   // planId -> doc data
  const clientsDb = {}; // clientId -> doc data
  const clientUpdates = [];

  const fakeDoc = function(db, coll, id) { return { __coll: coll, __id: id }; };
  const fakeGetDoc = async function(ref) {
    const store = ref.__coll === 'plans' ? plansDb : clientsDb;
    const data = store[ref.__id];
    return { exists: function() { return data !== undefined; }, data: function() { return data; } };
  };
  const fakeSetDoc = async function(ref, data) { (ref.__coll === 'plans' ? plansDb : clientsDb)[ref.__id] = data; };
  const fakeServerTimestamp = function() { return '__SERVER_TS__'; };
  const fakeDeleteField = function() { return '__DELETE_FIELD__'; };
  const fakeAuth = { currentUser: { uid: 'coach-1' } };
  const fakeRunTransaction = async function(db, cb) {
    const t = {
      get: async function(ref) { return fakeGetDoc(ref); },
      update: function(ref, data) {
        const store = ref.__coll === 'plans' ? plansDb : clientsDb;
        Object.assign(store[ref.__id], data);
        if (ref.__coll === 'clients') clientUpdates.push(data);
      }
    };
    return cb(t);
  };

  var _vdsenCurrentPreview = null;
  var _vdsenReviewState = {};

  const fn = new Function('doc', 'getDoc', 'setDoc', 'runTransaction', 'deleteField', 'serverTimestamp', 'auth', 'db', 'window',
    resolveSrc + ';\n' + genIdSrc + ';\n' + stampSrc + ';\n' + rirSrc + ';\n' +
    normalizeTrainSrc + ';\n' + normalizeNutrSrc + ';\n' + normalizeSupplSrc + ';\n' + normalizePlanSrc + ';\n' +
    'var _vdsenCurrentPreview = null; var _vdsenReviewState = {};\n' +
    saveDraftSrc + ';\n' + activateSrc + ';\n' +
    'return { saveDraft: _vdsenSaveDraftToFirestore, activate: _vdsenActivatePlanInFirestore, ' +
    'setPreview: function(p) { _vdsenCurrentPreview = p; } };'
  )(fakeDoc, fakeGetDoc, fakeSetDoc, fakeRunTransaction, fakeDeleteField, fakeServerTimestamp, fakeAuth, {}, {});

  return { fn: fn, plansDb: plansDb, clientsDb: clientsDb, clientUpdates: clientUpdates };
}

async function main() {
  // ───────────────────────────────────────────────────────────────────────
  // Training-only Generator response -> full round trip -> client's
  // pre-existing valid nutrition/supplements survive activation intact.
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeRoundTripHarness();
    h.clientsDb['client-1'] = { coachId: 'coach-1', activePlanId: 'plan-OLD', nutritionRaw: { calorias: 2400, comidas: ['pollo y arroz'] }, nutritionPlan: { calorias: 2400 }, supplementsRaw: { tiers: [{ nombre: 'Base' }] }, supplementPlan: { texto: 'Creatina' } };

    h.fn.setPreview({
      clientId: 'client-1', requiresReview: false,
      resp: {
        requestId: 'req-1', status: 'VALID',
        plan: { schema: 'vdsen-plan-v2', entrenamiento: { weeks: 6, daysPerWeek: 3, days: [{ dayIndex: 0, exercises: [] }] } }
        // NO nutricion/suplementacion key at all -- training-only response
      }
    });
    const saveResult = await h.fn.saveDraft();
    ok(!saveResult.idempotent, 'draft saved as a new plan doc');
    const draftDoc = h.plansDb['req-1'];
    ok(!('nutritionRaw' in draftDoc) && !('nutritionDisplay' in draftDoc), 'the draft plan doc genuinely OMITS nutrition fields for a training-only response -- not a zeroed placeholder');
    ok(!('supplementsRaw' in draftDoc) && !('supplementDisplay' in draftDoc), 'same for supplements');

    await h.fn.activate('req-1', 'client-1');
    const finalClient = h.clientsDb['client-1'];
    ok(finalClient.activePlanId === 'req-1', 'activation flips activePlanId to the new plan');
    ok(finalClient.nutritionRaw.calorias === 2400 && finalClient.nutritionRaw.comidas[0] === 'pollo y arroz', 'ROUND TRIP: the client\'s pre-existing valid nutrition survived a training-only Preview->Draft->Activate cycle completely intact');
    ok(finalClient.supplementsRaw.tiers[0].nombre === 'Base', 'ROUND TRIP: the client\'s pre-existing valid supplements also survived intact');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Full plan WITH nutrition -> round trip -> nutrition replaced with the
  // Generator's real (not destructured-away) content, including a
  // deliberately empty comidas array (a real, present, "empty-looking"
  // value must still replace, never re-collapsed by a `|| []` along the way).
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeRoundTripHarness();
    h.clientsDb['client-2'] = { coachId: 'coach-1', activePlanId: 'plan-OLD', nutritionRaw: { calorias: 1000 } };

    h.fn.setPreview({
      clientId: 'client-2', requiresReview: false,
      resp: {
        requestId: 'req-2', status: 'VALID',
        plan: { schema: 'vdsen-plan-v2', entrenamiento: { weeks: 4, days: [] }, nutricion: { calorias: 3000, comidas: [] } }
      }
    });
    await h.fn.saveDraft();
    await h.fn.activate('req-2', 'client-2');
    const finalClient = h.clientsDb['client-2'];
    ok(finalClient.nutritionRaw.calorias === 3000 && Array.isArray(finalClient.nutritionRaw.comidas) && finalClient.nutritionRaw.comidas.length === 0,
      'ROUND TRIP: a genuinely present-but-empty comidas[] array is preserved as explicit content through the whole pipeline -- never silently defaulted/re-collapsed by an intermediate `|| []`');
  }

  console.log('');
  console.log('T262 — Preview/activation round-trip: ' + pass + ' assertions PASSED');
}

main().catch(function(e) { console.error(e); process.exit(1); });
