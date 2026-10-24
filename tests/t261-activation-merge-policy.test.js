'use strict';
/**
 * T261 — Activation merge policy: the ONE canonical merge rule at
 * _vdsenActivatePlanInFirestore (the sole authoritative activation
 * boundary, T259), paired with the matching fix at _vdsenSaveDraftToFirestore
 * so a plan doc genuinely signals "nutrition not addressed" instead of
 * always writing a zeroed placeholder. Both reuse T260's
 * _resolveOptionalPlanSection -- no separate policy per path.
 *
 * Executes the REAL async production function end to end against a
 * stubbed Firestore transaction (t.get/t.update), not a reimplementation.
 *
 * Run: node tests/t261-activation-merge-policy.test.js
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

const resolveSrc  = extractFunction(COACH, 'function _resolveOptionalPlanSection(previousValue, incomingRawValue)');
const activateSrc = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId)');
const draftSrc    = extractFunction(COACH, 'async function _vdsenSaveDraftToFirestore()');

ok(resolveSrc && activateSrc, 'prerequisite: both real functions extract cleanly');
ok(activateSrc.includes('_resolveOptionalPlanSection(undefined, planData.nutritionRaw)') && activateSrc.includes('_resolveOptionalPlanSection(undefined, planData.supplementsRaw)'),
  'activation reuses the real T260 helper for BOTH nutrition and supplements -- one canonical rule, not a separate policy per section');
ok(draftSrc && draftSrc.includes('_resolveOptionalPlanSection(undefined, plan.nutricion)') && draftSrc.includes('_resolveOptionalPlanSection(undefined, plan.suplementacion)'),
  'draft save ALSO reuses the same real T260 helper -- both ends of the pipeline share one policy');
ok(!activateSrc.includes('nutritionPlan:  planData.nutritionDisplay || {},'), 'the old unconditional || {} mirror is gone from activation');

// ─────────────────────────────────────────────────────────────────────────────
// Functional harness: run the REAL _vdsenActivatePlanInFirestore against a
// stubbed Firestore transaction (t.get/t.update), not a reimplementation.
// ─────────────────────────────────────────────────────────────────────────────

function makeActivateHarness(planDataFixture, clientDataFixture) {
  const updates = [];
  const fakeDoc = function(db, coll, id) { return { __coll: coll, __id: id }; };
  const fakeDeleteField = function() { return '__DELETE_FIELD__'; };
  const fakeAuth = { currentUser: { uid: 'coach-1' } };
  const fakeRunTransaction = async function(db, cb) {
    const t = {
      get: async function(ref) {
        if (ref.__coll === 'plans') return { exists: function() { return true; }, data: function() { return planDataFixture; } };
        if (ref.__coll === 'clients') return { exists: function() { return true; }, data: function() { return clientDataFixture; } };
      },
      update: function(ref, data) { updates.push(data); }
    };
    return cb(t);
  };
  const fn = new Function('doc', 'runTransaction', 'deleteField', 'auth', 'db',
    resolveSrc + ';\n' + activateSrc + ';\nreturn _vdsenActivatePlanInFirestore;'
  )(fakeDoc, fakeRunTransaction, fakeDeleteField, fakeAuth, {});
  return { run: fn, updates: updates };
}

function planFixture(overrides) {
  return Object.assign({ coachId: 'coach-1', clientId: 'client-1', status: 'draft_approved' }, overrides);
}
function clientFixture(overrides) {
  return Object.assign({ coachId: 'coach-1', activePlanId: 'plan-OLD' }, overrides);
}

async function main() {
  // ───────────────────────────────────────────────────────────────────────
  // NEW TRAINING ONLY (no nutrition/supplement fields on the plan doc at
  // all) -> both preserved (never overwritten with {}).
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeActivateHarness(planFixture({}), clientFixture({})); // no nutritionRaw/supplementsRaw keys at all
    await h.run('plan-NEW', 'client-1');
    ok(h.updates.length === 1, 'exactly one client update issued');
    const upd = h.updates[0];
    ok(upd.activePlanId === 'plan-NEW', 'activePlanId is always updated');
    ok(!('nutritionPlan' in upd) && !('nutritionRaw' in upd), 'a training-only plan (no nutrition fields at all) NEVER touches nutritionPlan/nutritionRaw -- the client\'s existing valid nutrition survives via Firestore\'s own partial-update semantics');
    ok(!('supplementPlan' in upd) && !('supplementsRaw' in upd), 'same for supplements -- never touched');
  }

  // ───────────────────────────────────────────────────────────────────────
  // NEW NUTRITION provided -> replaced; supplements absent -> preserved.
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeActivateHarness(planFixture({ nutritionDisplay: { calorias: 1800 }, nutritionRaw: { calorias: 1800, comidas: [] } }), clientFixture({}));
    await h.run('plan-NEW', 'client-1');
    const upd = h.updates[0];
    ok(upd.nutritionRaw && upd.nutritionRaw.calorias === 1800, 'the explicitly-provided nutrition section replaces the client\'s value');
    ok(!('supplementPlan' in upd) && !('supplementsRaw' in upd), 'supplements were never addressed by this plan -> preserved, untouched');
  }

  // ───────────────────────────────────────────────────────────────────────
  // NEW FULL PLAN (both provided) -> both replaced.
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeActivateHarness(planFixture({
      nutritionDisplay: { calorias: 2200 }, nutritionRaw: { calorias: 2200 },
      supplementDisplay: { texto: 'Creatina' }, supplementsRaw: { tiers: [{ nombre: 'Base' }] }
    }), clientFixture({}));
    await h.run('plan-NEW', 'client-1');
    const upd = h.updates[0];
    ok(upd.nutritionRaw.calorias === 2200 && upd.supplementsRaw.tiers.length === 1, 'both sections explicitly provided -> both replaced');
  }

  // ───────────────────────────────────────────────────────────────────────
  // EXPLICIT REMOVE (plan doc stamped null by the draft-save fix) ->
  // cleared via deleteField, never left as a stale zeroed object.
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeActivateHarness(planFixture({ nutritionDisplay: null, nutritionRaw: null }), clientFixture({}));
    await h.run('plan-NEW', 'client-1');
    const upd = h.updates[0];
    ok(upd.nutritionPlan === '__DELETE_FIELD__' && upd.nutritionRaw === '__DELETE_FIELD__', 'an explicit null (removal signal) on the plan doc clears the client\'s nutrition via deleteField(), not a zeroed {} placeholder');
    ok(!('supplementPlan' in upd) && !('supplementsRaw' in upd), 'supplements untouched -- removal is scoped to only the targeted section');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Idempotent re-activation of the SAME plan still short-circuits with
  // zero writes (pre-existing guard, unaffected by this fix).
  // ───────────────────────────────────────────────────────────────────────
  {
    const h = makeActivateHarness(planFixture({}), clientFixture({ activePlanId: 'plan-SAME' }));
    await h.run('plan-SAME', 'client-1');
    ok(h.updates.length === 0, 'activating the ALREADY-active plan is still a complete no-op -- the pre-existing idempotency guard is unaffected by T261\'s fix');
  }

  console.log('');
  console.log('T261 — Activation merge policy: ' + pass + ' assertions PASSED');
}

main().catch(function(e) { console.error(e); process.exit(1); });
