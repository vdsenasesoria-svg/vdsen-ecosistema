// T505 (superseded by T523): the repository never settled Rule D/E, Rule C vs E precedence or the representative set.
// They were closed by DIRECTOR PRODUCT POLICY (not science). The historical gap ids are preserved as `resolves` provenance;
// nothing remains as an activation science prerequisite. Behaviour tests: t523-product-policy.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));

const PID = 'pid-A', T0 = Date.parse('2026-09-27T12:00:00.000Z');
const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
  { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 2, restSeconds: 90 })) }] })) };
const ents = (over) => { const e = {}; [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { e['log_' + w + '_' + d + '_0_s' + s] =
  Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? over : {}); })); return e; };
const rec = (over) => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents(over), week: 1, dayIndex: 2,
  calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
  recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
const plan1 = (r) => consumer.planApplication({ record: r, context: { clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents({}),
  interventions: [], existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure } });

test('T505.1 (T523) the three historical gaps are closed product policy, kept only as provenance', () => {
  assert.deepEqual(policy.PRODUCT_POLICIES.map(p => p.resolves), ['RULE_D_E_ALTERNATIVE_NOT_DEFINED', 'RULE_C_E_PRECEDENCE_NOT_DEFINED', 'REPRESENTATIVE_SET_NOT_DEFINED']);
  assert.deepEqual(policy.PRODUCT_POLICIES.map(p => p.id), ['RULE_D_E_COACH_REVIEW_ONLY', 'RULE_C_THEN_E_COACH_REVIEW', 'REPRESENTATIVE_SET_LAST_STANDARD_WORKING_SET']);
  assert.ok(Object.isFrozen(policy.PRODUCT_POLICIES) && policy.PRODUCT_POLICIES.every(p => Object.isFrozen(p) && p.source === 'VDSEN_PRODUCT_POLICY' && p.scientificClaim === false));
  assert.deepEqual([...policy.SCIENCE_GAPS], [], 'no genuinely unknown science branch remains');
  assert.deepEqual([...consumer.ACTIVATION_PREREQUISITES], []);
});

test('T505.2 D/E: Coach review, no numeric candidate, no unresolved branch, not a science blocker', () => {
  const r = rec({ reps: '8', rir_real: 0 });
  const m = r.magnitude;
  assert.equal(m.eligible, false); assert.equal(m.unresolved, null); assert.deepEqual(m.candidates, []);
  assert.equal(m.coachReviewRequired.branch, 'D+E');
  const d = plan1(r);
  assert.ok(d.blockers.includes('COACH_REVIEW_REQUIRED')); assert.ok(!d.blockers.includes('SCIENCE_POLICY_UNRESOLVED')); assert.equal(d.overlay, null);
});

test('T505.3 C then E: first comparable C -> REST only with explicit product precedence', () => {
  const first = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: (() => { const e = ents({}); [0, 1, 2].forEach(s => { delete e['log_1_2_0_s' + s].reps; e['log_1_2_0_s' + s].reps = s === 2 ? '8' : '10'; }); return e; })(), week: 1, dayIndex: 2,
    calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
  assert.equal(first.magnitude.collision.classification, 'EXPLICIT_VDSEN_PRECEDENCE'); assert.equal(first.magnitude.collision.deferredRule, 'E');
  assert.deepEqual(first.magnitude.candidates.map(c => c.dimension), ['REST']);
  assert.deepEqual(plan1(first).audit.collision, { rules: ['C', 'E'], classification: 'EXPLICIT_VDSEN_PRECEDENCE' });
});

test('T505.4 the representative set is the last WORKING set with product-policy provenance', () => {
  const r = rec({ rir_real: 3 });
  assert.equal(r.magnitude.evidence.basis, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET');
  assert.equal(policy.EVIDENCE_BASIS, 'VDSEN_PRODUCT_POLICY_LAST_STANDARD_WORKING_SET');
});

test('T505.5 readiness lists product policies, no science prerequisites; nothing is executable while the flag is off', () => {
  const d = plan1(rec({ rir_real: 3 }));
  assert.deepEqual(d.readiness.activationPrerequisites, []); assert.deepEqual(d.readiness.globalProvisional, []);
  assert.deepEqual(d.readiness.productPolicies, ['RULE_D_E_COACH_REVIEW_ONLY', 'RULE_C_THEN_E_COACH_REVIEW', 'REPRESENTATIVE_SET_LAST_STANDARD_WORKING_SET']);
  assert.equal(d.readiness.executable, false); assert.equal(consumer.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
});

test('T505.6 the historical search documents are kept (why the gaps existed) and now point to the closed policy', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/PROGRESSION_SCIENCE_SOURCE_SEARCH.md'), 'utf8');
  assert.ok(doc.includes('RULE_D_E_ALTERNATIVE') && doc.includes('FUENTE ENCONTRADA'));
});
