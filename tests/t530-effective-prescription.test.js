// T530: one pure authority for the effective prescription: base + eligible canonical overlay. Precedence SAFETY > Coach override > overlay > base.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/lifecycle-fixture.js');
const shipped = require('../assets/progression-effective-prescription.js');
const eff = F.on.effective;

const freeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };
const A = (o) => F.applied(F.scenario(), o);
const R = (a, extra) => eff.resolveEffective(F.effectiveInput(a, extra));

test('T530.1 shipped flag false: base plan is ALWAYS effective (no overlay can be consumed)', () => {
  assert.equal(shipped.NUMERIC_APPLY_ENABLED, false);
  const a = A(); const r = shipped.resolveEffective(F.effectiveInput(a));
  assert.deepEqual([r.provenance, r.reason, r.overlayKey], ['BASE_PLAN', 'NUMERIC_APPLY_DISABLED', null]);
  assert.deepEqual(r.sets.map(s => s.effective), F.baseSets());
});
test('T530.2 an APPLIED overlay for the exact client/plan/PID/week/day is consumed (LOAD)', () => {
  const a = A(), r = R(a);
  assert.equal(r.provenance, 'CANONICAL_OVERLAY'); assert.equal(r.dimension, 'LOAD'); assert.equal(r.overlayKey, a.overlay.key);
  assert.ok(r.sets.every(s => s.effective.load === a.overlay.appliedValue && s.base.load === 0));
  assert.deepEqual(r.presentation, { label: 'Autoajuste VDSEN', text: '100 → 102.5 kg' });
});
test('T530.3 REST overlay adjusts restSeconds only; REPS-less base untouched', () => {
  const a = F.applied(F.scenario({ prior: F.OK, latest: F.C9 }), { config: null }), r = R(a);
  assert.equal(r.dimension, 'REST'); assert.ok(r.sets.every(s => s.effective.restSeconds === 120 && s.base.restSeconds === 90 && s.effective.repsTarget === 10 && s.effective.load === 0));
  assert.equal(r.presentation.text, '90 → 120 s');
});
test('T530.4 pure: inputs are never mutated (deep-frozen inputs work)', () => {
  const a = A(); const input = freeze(F.effectiveInput(a)); assert.doesNotThrow(() => eff.resolveEffective(input));
});
test('T530.5 every non-APPLIED overlay state falls back to the base plan with an explicit reason', () => {
  for (const [state, reason] of [['REVERTED', 'OVERLAY_REVERTED'], ['OVERRIDDEN', 'OVERLAY_OVERRIDDEN'], ['STALE', 'OVERLAY_STALE']]) {
    const r = R(A({ state })); assert.deepEqual([r.provenance, r.reason], ['BASE_PLAN', reason], state);
    assert.ok(r.sets.every(s => s.effective.load === 0));
  }
});
test('T530.6 wrong identity -> base: client, plan, active plan, PID, week, day', () => {
  const a = A();
  for (const [extra, why] of [[{ clientId: 'other' }, 'client'], [{ planId: 'p2' }, 'plan'], [{ activePlanId: 'p2' }, 'active plan'], [{ pid: 'pid-x' }, 'pid'], [{ week: 3 }, 'week'], [{ dayIndex: 2 }, 'day']]) {
    const r = R(a, extra); assert.equal(r.provenance, 'BASE_PLAN', why); assert.ok(r.reason, why);
  }
});
test('T530.7 target invalidated before start (plan changed / PID removed from target day / target moved) -> base', () => {
  const a = A();
  assert.equal(R(a, { plan: Object.assign({}, a.plan, { updatedAt: '2026-09-29T00:00:00.000Z' }) }).reason, 'TARGET_INVALIDATED');
  const noPid = Object.assign({}, a.plan, { days: a.plan.days.map(d => d.dayIndex === 0 ? { dayIndex: 0, exercises: [] } : d) });
  assert.equal(R(a, { plan: noPid }).reason, 'TARGET_INVALIDATED');
  const dup = Object.assign({}, a.plan, { days: a.plan.days.map(d => d.dayIndex === 0 ? { dayIndex: 0, exercises: d.exercises.concat(d.exercises) } : d) });
  assert.equal(R(a, { plan: dup }).reason, 'TARGET_INVALIDATED');
});
test('T530.8 exact Coach override after APPLIED -> COACH_OVERRIDE provenance, base values', () => {
  const a = A(), iv = { targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'REDUCE_SETS', decidedAt: '2026-09-28T03:00:00.000Z' };
  const r = R(a, { interventions: [iv] }); assert.deepEqual([r.provenance, r.reason], ['COACH_OVERRIDE', 'COACH_OVERRIDE']); assert.ok(r.sets.every(s => s.effective.load === 0));
  assert.equal(R(a, { interventions: [Object.assign({}, iv, { action: 'NO_CHANGE' })] }).provenance, 'CANONICAL_OVERLAY');
  assert.equal(R(a, { interventions: [Object.assign({}, iv, { targetId: 'other-pid' })] }).provenance, 'CANONICAL_OVERLAY');
  assert.equal(R(a, { interventions: [Object.assign({}, iv, { decidedAt: '2026-09-27T11:00:00.000Z' })] }).provenance, 'CANONICAL_OVERLAY', 'a decision BEFORE the source calculation is not an override');
  assert.equal(R(a, { interventions: [Object.assign({}, iv, { decidedAt: '2026-09-28T00:30:00.000Z' })] }).provenance, 'COACH_OVERRIDE', 'any decision since the calculation counts (the apply gate refuses the visible ones)');
});
test('T530.9 SAFETY outranks a Coach override and an eligible overlay', () => {
  const a = A(), iv = { targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'X', decidedAt: '2026-09-28T03:00:00.000Z' };
  const r = R(a, { safetyConflict: true, interventions: [iv] }); assert.deepEqual([r.provenance, r.reason], ['SAFETY_FALLBACK', 'SAFETY_CONFLICT']);
});
test('T530.10 started exposure keeps its prescription: no retroactive override / stale (CONSUMED or first set persisted)', () => {
  const a = A(), iv = { targetType: 'EXERCISE', targetId: 'pid-1', planId: 'p', action: 'X', decidedAt: '2026-09-28T03:00:00.000Z' };
  const started = Object.assign({}, a.entries, { log_1_2_0_s0: undefined });   // placeholder replaced below
  void started;
  const tgt = a.overlay.target, entries = Object.assign({}, a.entries, { ['log_' + tgt.week + '_' + tgt.dayIndex + '_0_s0']: { carga: '102.5', reps: '10', unit: 'KG', done: true, prescriptionExerciseId: 'pid-1', ts: 1 } });
  assert.equal(R(a, { entries, interventions: [iv] }).provenance, 'CANONICAL_OVERLAY');
  const c = A({ state: 'CONSUMED' }); assert.equal(R(c, { interventions: [iv] }).provenance, 'CANONICAL_OVERLAY');
});
test('T530.11 exposure start = first PERSISTED working set of the exact PID; render/other PID/warm-up/autofill/express/undone never count', () => {
  const S = (o) => Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, prescriptionExerciseId: 'pid-1' }, o);
  const at = e => eff.pidExposureStarted(e, 'pid-1', 2, 0);
  assert.equal(at({}), false);
  assert.equal(at({ log_2_0_0_s0: S({ done: false }) }), false);
  assert.equal(at({ log_2_0_0_s0: S({ prescriptionExerciseId: 'other' }) }), false);
  assert.equal(at({ log_2_0_0_s0: S({ warmup: true }) }), false);
  assert.equal(at({ log_2_0_0_s0: S({ drop: true }) }), false);
  assert.equal(at({ log_2_0_0_s0: S({ autoFilled: true }) }), false);
  assert.equal(at({ log_2_0_0_s0: S({ express: true }) }), false);
  assert.equal(at({ log_2_1_0_s0: S() }), false, 'other day');
  assert.equal(at({ log_2_0_0_s0: S() }), true);
  assert.equal(at({ log_2_0_3_s2: S() }), true, 'exercise position is irrelevant: identity is the PID');
});
test('T530.12 inconsistent record/overlay pairs never apply (mismatched status/key/lifecycle link, ambiguity, missing record)', () => {
  const a = A();
  assert.equal(R(Object.assign({}, a, { overlays: { [a.overlay.key]: Object.assign({}, a.overlay, { status: 'CONSUMED' }) } })).reason, 'RECORD_OVERLAY_INCONSISTENT');
  assert.equal(R(Object.assign({}, a, { records: {} })).reason, 'RECORD_MISSING');
  const rec2 = Object.assign({}, a.record, { lifecycle: {} });
  assert.equal(R(Object.assign({}, a, { records: { [a.record.key]: rec2 } })).reason, 'RECORD_OVERLAY_INCONSISTENT');
  const dup = Object.assign({}, a.overlay, { key: 'ovl_dup' });
  assert.equal(R(Object.assign({}, a, { overlays: { [a.overlay.key]: a.overlay, ovl_dup: dup } })).reason, 'AMBIGUOUS_OVERLAYS');
});
test('T530.13 LOAD overlay in a different display unit is not applied (no silent conversion)', () => {
  assert.equal(R(A(), { unit: 'LB' }).reason, 'UNIT_MISMATCH'); assert.equal(R(A(), { unit: 'KG' }).provenance, 'CANONICAL_OVERLAY');
});
test('T530.14 explicitly tagged warm-up / drop sets keep their base values; standard sets are adjusted', () => {
  const a = A(), bs = F.baseSets(); bs[0].warmup = true; bs[2].drop = true;
  const r = R(a, { baseSets: bs });
  assert.deepEqual(r.sets.map(s => s.adjusted), [false, true, false]); assert.equal(r.sets[0].effective.load, 0); assert.equal(r.sets[1].effective.load, 102.5);
});
test('T530.15 no legacy progrec, no name-based identity in the module', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../assets/progression-effective-prescription.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/progrec|exerciseName|toLowerCase|localeCompare/.test(src));
});
