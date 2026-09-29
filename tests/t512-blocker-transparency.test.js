// T512: blocker transparency + science-gap localization. Each precise fact has its own code; unsupported science only
// blocks the branches that need it (Rule A / Rule C candidates are independent of D/E).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const B = consumer.BLOCKERS;

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
function ents(spec) {
  const e = {};
  for (const [w, d, over] of spec) [0, 1, 2].forEach(s => { e['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? over : {}); });
  return e;
}
const rec = (spec) => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents(spec), week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z',
  sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
const GOOD = [[1, 0, { rir_real: 3 }], [1, 2, { rir_real: 3 }]];
const GRID = { equipmentId: 'exercise:e', loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } };
function plan1(r, over = {}, equipment = GRID) {
  const eqRes = resolver.resolveForCandidate({ magnitude: r.magnitude, equipment });
  return consumer.planApplication({ record: r, context: Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents([[1, 0, {}], [1, 2, {}]]), interventions: [],
    equipmentResolution: eqRes || undefined, existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure }, over) });
}
const real = d => d.blockers.filter(b => b !== 'NUMERIC_APPLY_DISABLED');

test('T512.1 every required precise blocker code exists', () => {
  for (const c of ['IDENTITY_UNRESOLVED', 'EVIDENCE_COUNT_INSUFFICIENT', 'DIRECTION_UNCONFIRMED', 'DIRECTION_CONFLICTING', 'SAFETY_CONFLICT', 'COACH_OVERRIDE', 'TARGET_ALREADY_STARTED',
    'MAGNITUDE_BRANCH_UNRESOLVED', 'EQUIPMENT_IDENTITY_UNRESOLVED', 'UNRESOLVED_EQUIPMENT_INCREMENT', 'UNIT_MISMATCH', 'DIRECTION_NOT_REALIZABLE', 'EQUIPMENT_OUT_OF_RANGE',
    'SCIENCE_POLICY_UNRESOLVED', 'COACH_REVIEW_REQUIRED', 'NUMERIC_APPLY_DISABLED']) assert.equal(B[c], c, c);
});

test('T512.2 each fact is reachable and reported alone (no generic NOT_ELIGIBLE)', () => {
  const cases = [
    ['IDENTITY_UNRESOLVED', () => plan1(rec(GOOD), { plan: { ...plan, days: [{ dayIndex: 0, exercises: [] }, plan.days[1]] } })],
    ['EVIDENCE_COUNT_INSUFFICIENT', () => plan1(rec([[1, 2, { rir_real: 3 }]]))],
    ['DIRECTION_UNCONFIRMED', () => plan1(rec([[1, 0, { rir_real: 2 }], [1, 2, { rir_real: 3 }]]))],
    ['DIRECTION_CONFLICTING', () => plan1(rec([[1, 0, { reps: '6', rir_real: 0 }], [1, 2, { rir_real: 3 }]]))],
    ['SAFETY_CONFLICT', () => plan1(rec(GOOD), { safetyConflict: true })],
    ['COACH_OVERRIDE', () => plan1(rec(GOOD), { interventions: [{ targetType: 'EXERCISE', targetId: PID, planId: 'p', decidedAt: '2026-09-27T14:00:00.000Z', action: 'CHANGE' }] })],
    ['TARGET_ALREADY_STARTED', () => plan1(rec(GOOD), { entries: { ...ents([[1, 0, {}], [1, 2, {}]]), log_2_0_0_s0: { carga: '100', done: true } } })],
    ['MAGNITUDE_BRANCH_UNRESOLVED', () => plan1(rec([[1, 0, { rir: 0, rir_real: 1 }], [1, 2, { rir: 0, rir_real: 1 }]]))], // Rule A with target RIR 0 (undefined by the source)
    ['COACH_REVIEW_REQUIRED', () => plan1(rec([[1, 0, { reps: '10', rir_real: 0 }], [1, 2, { reps: '10', rir_real: 0 }]]))],
    ['EQUIPMENT_IDENTITY_UNRESOLVED', () => plan1(rec(GOOD), {}, {})],
    ['UNRESOLVED_EQUIPMENT_INCREMENT', () => plan1(rec(GOOD), {}, { equipmentId: 'eq' })],
    ['UNIT_MISMATCH', () => plan1(rec(GOOD), {}, { equipmentId: 'eq', loadIncrement: { ...GRID.loadIncrement, unit: 'LB' } })],
    ['DIRECTION_NOT_REALIZABLE', () => plan1(rec(GOOD), {}, { equipmentId: 'eq', loadIncrement: { ...GRID.loadIncrement, step: 10 } })],
    ['EQUIPMENT_OUT_OF_RANGE', () => plan1(rec(GOOD), {}, { equipmentId: 'eq', loadIncrement: { ...GRID.loadIncrement, max: 100 } })]
  ];
  for (const [code, run] of cases) {
    const d = run();
    assert.ok(d.blockers.includes(code), code + ' -> ' + JSON.stringify(d.blockers));
    assert.ok(!d.blockers.includes('NOT_ELIGIBLE'), code + ' hides behind NOT_ELIGIBLE');
  }
  assert.ok(plan1(rec(GOOD)).blockers.includes('NUMERIC_APPLY_DISABLED'));
});

test('T512.3 (T523) no known science gap remains: D/E are Coach review; SCIENCE_POLICY_UNRESOLVED stays usable for a FUTURE unknown branch', () => {
  const d = plan1(rec([[1, 0, { reps: '8', rir_real: 0 }], [1, 2, { reps: '8', rir_real: 0 }]]));
  assert.ok(d.blockers.includes('COACH_REVIEW_REQUIRED')); assert.ok(!d.blockers.includes('SCIENCE_POLICY_UNRESOLVED')); assert.deepEqual(d.audit.scienceGaps, []);
  const r = rec(GOOD);
  const future = JSON.parse(JSON.stringify(r)); future.magnitude.eligible = false; future.magnitude.candidates = [];
  future.magnitude.unresolved = { code: 'POLICY_BRANCH_REQUIRES_RESOLUTION', rules: ['X'], scienceGap: 'FUTURE_UNKNOWN_BRANCH' };
  const f = plan1(future);
  assert.ok(f.blockers.includes('SCIENCE_POLICY_UNRESOLVED') && f.blockers.includes('MAGNITUDE_BRANCH_UNRESOLVED')); assert.deepEqual(f.audit.scienceGaps, ['FUTURE_UNKNOWN_BRANCH']);
});

test('T512.4 Rule A (load / reps) and Rule C first occurrence (rest) are independent of the review branches', () => {
  const a = plan1(rec(GOOD));
  assert.deepEqual(real(a), []); assert.ok(!a.blockers.includes('SCIENCE_POLICY_UNRESOLVED')); assert.deepEqual(a.readiness.localizedScienceGaps, []); assert.equal(a.audit.scienceGaps.length, 0);
  const c = plan1(rec([[1, 0, {}], [1, 2, { reps: '8', rir_real: 2 }]]));
  assert.deepEqual(real(c), []); assert.equal(c.overlay.dimension, 'REST'); assert.deepEqual(c.audit.collision, { rules: ['C', 'E'], classification: 'EXPLICIT_VDSEN_PRECEDENCE' });
  assert.deepEqual(c.readiness.localizedScienceGaps, []);
  const persists = plan1(rec([[1, 0, { reps: '8', rir_real: 2 }], [1, 2, { reps: '8', rir_real: 2 }]]));
  assert.equal(persists.readiness.state, 'COACH_REVIEW_REQUIRED'); assert.equal(persists.overlay, null);
  const reps = plan1(rec([[1, 0, { reps: '10', rir_real: 1, rir: 1 }], [1, 2, { reps: '10', rir_real: 2, rir: 1 }]]));
  assert.ok(!reps.blockers.includes('SCIENCE_POLICY_UNRESOLVED'));
});

test('T512.5 (T523) the representative set is closed product policy: provenance, no provisional/global blocker', () => {
  const d = plan1(rec(GOOD));
  assert.deepEqual(d.readiness.globalProvisional, []); assert.ok(d.readiness.productPolicies.includes('REPRESENTATIVE_SET_LAST_STANDARD_WORKING_SET'));
  assert.ok(!d.blockers.includes('SCIENCE_POLICY_UNRESOLVED'));
});

test('T512.6 readiness.state distinguishes BLOCKED / READY_BUT_DISABLED / EXECUTABLE', () => {
  assert.equal(plan1(rec(GOOD)).readiness.state, 'READY_BUT_DISABLED');
  assert.equal(plan1(rec([[1, 2, { rir_real: 3 }]])).readiness.state, 'BLOCKED');
});

test('T512.7 the EQUIPMENT_IDENTITY gate exists before EQUIPMENT_INCREMENT and owns its own codes', () => {
  const d = plan1(rec(GOOD), {}, {});
  const g = n => d.readiness.gates.find(x => x.gate === n);
  assert.equal(g('EQUIPMENT_IDENTITY').state, 'BLOCKED'); assert.deepEqual(g('EQUIPMENT_IDENTITY').codes, ['EQUIPMENT_IDENTITY_UNRESOLVED']);
  assert.notEqual(g('EQUIPMENT_INCREMENT').state, 'BLOCKED');
  const names = d.readiness.gates.map(x => x.gate);
  assert.ok(names.indexOf('EQUIPMENT_IDENTITY') === names.indexOf('EQUIPMENT_INCREMENT') - 1);
});

test('T512.8 Coach labels every blocker (no raw code reaches the Coach)', () => {
  const codes = Object.values(B).filter(c => !['STALE_CALLBACK', 'REVISION_CONFLICT', 'NOT_CANONICAL_RECORD'].includes(c));
  for (const c of codes) assert.ok(new RegExp('\\b' + c + ':').test(coach.slice(coach.indexOf('function _dryRunLine'), coach.indexOf('function _renderShadowAutoFeed'))), c + ' has a Coach label');
});
