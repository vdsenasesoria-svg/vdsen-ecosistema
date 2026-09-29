// T513: (a) end-to-end SYNTHETIC canary: with every required fact available the candidate is READY_BUT_DISABLED and the only
// missing runtime switch is NUMERIC_APPLY_ENABLED; (b) permanent ACTIVATION GUARD: even with the flag forced on, a candidate
// fails unless each of the 18 preconditions holds. Synthetic equipment metadata lives only in this test, never in the catalog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const consumerSrc = fs.readFileSync(path.join(root, 'assets/progression-application-consumer.js'), 'utf8');
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const C = require(path.join(root, 'assets/equipment-context.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));

// flag forced ON in a sandbox copy only (never shipped that way)
function loadOn() {
  const code = consumerSrc.replace('var NUMERIC_APPLY_ENABLED = false;', 'var NUMERIC_APPLY_ENABLED = true;');
  assert.ok(code !== consumerSrc, 'flag declaration found');
  const mod = { exports: {} };
  new vm.Script('(function(module, globalThis){' + code + '\n})').runInThisContext()(mod, {});
  return mod.exports;
}
const consumerOn = loadOn();

const PID = 'pid-remo', EXID = 'legacy-remo-mancuerna-unilateral', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseId: EXID, exerciseName: 'Remo mancuerna', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
const entries = (over) => { const e = {}; [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { e['log_' + w + '_' + d + '_0_s' + s] =
  Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 3, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? over : {}); })); return e; };
const record = (over) => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entries(over), week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z',
  sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: PID, exerciseId: EXID, exerciseName: 'Remo mancuerna', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');

// SYNTHETIC coach configuration (test-only): shared equipment "Mancuernas" with an explicit list of loads.
const SYNTHETIC = { shared: { 'functional-dumbbells': { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} };
function contextFor(rec, over = {}, config = SYNTHETIC) {
  const ref = C.equipmentRefForExercise({ catalog, exerciseId: EXID, config });
  const eqRes = resolver.resolveForCandidate({ magnitude: rec.magnitude, equipment: ref });
  return Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entries({}), interventions: [], equipmentResolution: eqRes || undefined,
    existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure }, over);
}
const run = (api, rec, over, config) => api.planApplication({ record: rec, context: contextFor(rec, over, config) });

test('T513.1 CANARY: synthetic chain evidence -> candidate -> PID -> exposure -> equipment -> realizable load -> READY_BUT_DISABLED', () => {
  const rec = record({});
  assert.equal(rec.magnitude.eligible, true); assert.equal(rec.magnitude.directionConsistency, 'CONSISTENT'); assert.equal(rec.magnitude.comparableExposureCount, 2);
  const d = run(consumer, rec);
  assert.equal(d.readiness.state, 'READY_BUT_DISABLED');
  assert.deepEqual(d.readiness.gates.map(g => g.state), Array(13).fill('PASS'));
  assert.deepEqual(d.blockers, ['NUMERIC_APPLY_DISABLED'], 'the ONLY remaining blocker is the activation flag');
  assert.equal(d.wouldApply, true); assert.equal(d.canApply, false); assert.equal(d.applied, false);
  assert.deepEqual([d.overlay.dimension, d.overlay.previousValue, d.overlay.appliedValue, d.overlay.equipmentId], ['LOAD', 100, 102.5, 'functional-dumbbells']);
  assert.deepEqual([d.equipment.resolutionState, d.equipment.incrementSource], ['RESOLVED', 'COACH_CONFIGURED']);
  assert.equal(d.guard.ok, true); assert.equal(d.guard.checks.length, 18);
  assert.deepEqual([d.overlay.target.week, d.overlay.target.dayIndex], [2, 0]);
});

test('T513.2 CANARY: enabling the flag is the ONLY missing switch (same facts, sandbox copy with the flag on)', () => {
  const rec = record({});
  const off = run(consumer, rec), on = run(consumerOn, rec);
  assert.equal(off.canApply, false); assert.equal(on.canApply, true); assert.equal(on.readiness.state, 'EXECUTABLE');
  assert.deepEqual(on.blockers, []); assert.deepEqual(on.overlay, off.overlay, 'identical plan either way');
});

test('T513.3 CANARY inputs are synthetic: the shipped catalog and resolver table stay free of increments', () => {
  assert.deepEqual(Object.keys(resolver.INCREMENT_METADATA), []);
  assert.ok(!/loadIncrement|smallestPlate|barWeight/.test(fs.readFileSync(path.join(root, 'assets/exercise-visual-catalog.js'), 'utf8')));
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
  const noConfig = run(consumer, record({}), {}, null);
  assert.ok(noConfig.blockers.includes('UNRESOLVED_EQUIPMENT_INCREMENT')); assert.equal(noConfig.readiness.state, 'BLOCKED');
});

// ---- ACTIVATION GUARD -------------------------------------------------------------------------------------------------
const TAMPER = {
  exactClient: (r, c) => { c.clientId = 'other'; },
  exactActivePlan: (r, c) => { c.activePlanId = 'p2'; },
  exactPid: (r) => { r.prescriptionExerciseId = ''; },
  validSourceExposure: (r) => { r.source = Object.assign({}, r.source, { week: -1 }); },
  exactTargetExposure: (r) => { r.nextExposure = { week: 1, dayIndex: 0 }; },
  targetNotStarted: (r, c) => { c.entries = Object.assign({}, c.entries, { log_2_0_0_s0: { carga: '1', done: true } }); },
  planNotChanged: (r, c) => { c.plan = Object.assign({}, c.plan, { updatedAt: '2026-09-30T00:00:00.000Z' }); },
  noCoachOverride: (r, c) => { c.interventions = [{ targetType: 'EXERCISE', targetId: PID, planId: 'p', decidedAt: '2026-09-27T14:00:00.000Z', action: 'CHANGE' }]; },
  noSafetyConflict: (r, c) => { c.safetyConflict = true; },
  evidenceEligible: (r) => { r.magnitude = Object.assign({}, r.magnitude, { comparableExposureCount: 1 }); },
  directionConsistent: (r) => { r.magnitude = Object.assign({}, r.magnitude, { directionConsistency: 'CONFLICTING' }); },
  magnitudeResolved: (r) => { r.magnitude = Object.assign({}, r.magnitude, { unresolved: { code: 'X', rules: ['D'] } }); },
  equipmentIdentityResolved: (r, c) => { c.equipmentResolution = Object.assign({}, c.equipmentResolution, { equipmentId: '' }); },
  equipmentIncrementResolved: (r, c) => { c.equipmentResolution = Object.assign({}, c.equipmentResolution, { incrementSource: 'GUESS' }); },
  unitCompatible: (r, c) => { c.equipmentResolution = Object.assign({}, c.equipmentResolution, { unit: 'LB' }); },
  physicallyRealizable: (r, c) => { c.equipmentResolution = Object.assign({}, c.equipmentResolution, { realizableLoad: 100 }); },
  idempotencyKeyValid: (r) => { r.key = 'not-a-key'; },
  transactionContextCurrent: (r, c) => { c.transactionCurrent = false; }
};

test('T513.4 the guard has exactly the 18 required preconditions, all with a tamper test', () => {
  assert.deepEqual([...consumer.GUARD_CHECKS].sort(), Object.keys(TAMPER).sort());
  assert.equal(consumer.GUARD_CHECKS.length, 18);
});

test('T513.5 the guard re-verifies each fact directly (independent of the blocker list): one tamper -> that check fails', () => {
  for (const [check, tamper] of Object.entries(TAMPER)) {
    const rec = structuredClone(record({})), ctx = contextFor(rec), good = consumer.planApplication({ record: rec, context: ctx });
    assert.ok(good.overlay, 'baseline overlay exists');
    const r2 = structuredClone(rec), c2 = Object.assign({}, ctx, { entries: Object.assign({}, ctx.entries), equipmentResolution: Object.assign({}, ctx.equipmentResolution) });
    tamper(r2, c2);
    const g = consumer.verifyActivationPreconditions({ record: r2, overlay: good.overlay, context: c2 });
    assert.equal(g.ok, false, check); assert.ok(g.failed.includes(check), check + ' -> ' + g.failed.join(','));
  }
});

test('T513.6 (flag forced on) every tamper prevents application: canApply is false and never a write', () => {
  for (const [check, tamper] of Object.entries(TAMPER)) {
    const rec = structuredClone(record({})), ctx = contextFor(rec);
    const r2 = structuredClone(rec), c2 = Object.assign({}, ctx, { entries: Object.assign({}, ctx.entries), equipmentResolution: Object.assign({}, ctx.equipmentResolution) });
    tamper(r2, c2);
    const d = consumerOn.planApplication({ record: r2, context: c2 });
    assert.equal(d.canApply, false, check); assert.equal(d.overlay, null, check + ' produced an overlay');
  }
});

test('T513.7 a decision whose blockers were bypassed still cannot apply: canApply also requires guard.ok', () => {
  const src = consumerSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/out\.canApply = out\.wouldApply && NUMERIC_APPLY_ENABLED && blockers\.length === 0 && !!out\.guard && out\.guard\.ok === true;/.test(src));
  assert.ok(/verifyActivationPreconditions\(\{ record: record, overlay: out\.overlay, context: ctx \}\)/.test(src));
  assert.equal(consumerSrc.split('var NUMERIC_APPLY_ENABLED = false;').length - 1, 1, 'single flag declaration');
});

test('T513.8 the transaction path cannot write unless the flag is on AND the decision (with guard) can apply', async () => {
  const calls = [];
  const tx = { get: async () => { calls.push('get'); return { exists: () => false, data: () => ({}) }; }, set: () => calls.push('set') };
  const off = await consumer.applyOverlayTransaction(tx, { meso: 1, plan: 2, client: 3 }, { recordKey: 'k' });
  assert.deepEqual([off.written, off.reason, calls.length], [false, 'NUMERIC_APPLY_DISABLED', 0]);
  const on = await consumerOn.applyOverlayTransaction(tx, { meso: 1, plan: 2, client: 3 }, { recordKey: 'k' });
  assert.equal(on.written, false); assert.ok(!calls.includes('set'), 'no write for a non-existent/non-canonical context');
});

test('T513.9 the overlay write is reachable from one place only and the guard sits between planning and writing', () => {
  const src = consumerSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(src.split('tx.set(').length - 1, 1, 'a single tx.set');
  assert.ok(src.indexOf('if (!decision.canApply)') < src.indexOf('tx.set('));
  assert.ok(/transactionCurrent: guards\.isCurrent \? guards\.isCurrent\(\) : true/.test(src));
});
