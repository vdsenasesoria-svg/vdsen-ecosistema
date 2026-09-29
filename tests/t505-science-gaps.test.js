// T505: the repository does not settle Rule D/E (reps vs load), Rule C vs E precedence or which set represents an
// exposure. None is invented: each stays explicit (blocker code / provenance) and is listed as an activation prerequisite.
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

test('T505.1 the three science gaps are registered, frozen and mirrored as activation prerequisites', () => {
  assert.deepEqual(policy.SCIENCE_GAPS.map(g => g.id), ['RULE_D_E_ALTERNATIVE_NOT_DEFINED', 'RULE_C_E_PRECEDENCE_NOT_DEFINED', 'REPRESENTATIVE_SET_NOT_DEFINED']);
  assert.ok(Object.isFrozen(policy.SCIENCE_GAPS) && policy.SCIENCE_GAPS.every(g => Object.isFrozen(g) && g.question.endsWith('?')));
  assert.deepEqual([...consumer.ACTIVATION_PREREQUISITES], policy.SCIENCE_GAPS.map(g => g.id));
});

test('T505.2 D/E stays a named unresolved branch with both alternatives and no chosen one', () => {
  const r = rec({ reps: '8', rir_real: 0 });
  const m = r.magnitude;
  assert.equal(m.eligible, false); assert.deepEqual(m.unresolved.rules, ['D', 'E']);
  assert.deepEqual(m.candidates.map(c => c.dimension), ['REPS', 'LOAD', 'REPS', 'LOAD'], 'alternatives kept, none selected');
  assert.ok(m.candidates.every(c => c.finalCandidate === null), 'no final numeric candidate for an unresolved branch');
  const d = plan1(r);
  assert.ok(d.blockers.includes('MAGNITUDE_BRANCH_UNRESOLVED')); assert.deepEqual(d.audit.unresolvedRules, ['D', 'E']); assert.equal(d.overlay, null);
});

test('T505.3 C vs E stays AMBIGUOUS: rest is recorded, E is deferred and never combined', () => {
  const r = rec({ reps: '8', rir_real: 2 });
  assert.equal(r.magnitude.collision.classification, 'AMBIGUOUS'); assert.equal(r.magnitude.collision.deferredRule, 'E');
  assert.deepEqual(r.magnitude.candidates.map(c => c.dimension), ['REST']);
  assert.deepEqual(plan1(r).audit.collision, { rules: ['C', 'E'], classification: 'AMBIGUOUS' });
});

test('T505.4 the representative set stays an explicit provisional basis in every decision', () => {
  const r = rec({ rir_real: 3 });
  assert.equal(r.magnitude.evidence.basis, 'LAST_SET_CURRENT_RUNTIME_HEURISTIC');
  assert.equal(policy.SCIENCE_GAPS.filter(g => g.id === 'REPRESENTATIVE_SET_NOT_DEFINED')[0].surfacesAs, 'evidence.basis=LAST_SET_CURRENT_RUNTIME_HEURISTIC');
});

test('T505.5 every readiness result lists the activation prerequisites; nothing is executable', () => {
  const d = plan1(rec({ rir_real: 3 }));
  assert.deepEqual(d.readiness.activationPrerequisites, policy.SCIENCE_GAPS.map(g => g.id));
  assert.equal(d.readiness.executable, false); assert.equal(consumer.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
});

test('T505.6 no invented rule: the documented search finds no explicit source (double progression covers UP only)', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/CONTEXTO_GENERADOR.md'), 'utf8');
  assert.ok(/## 8\. DOUBLE PROGRESSION/.test(doc));
  const src = fs.readFileSync(path.join(root, 'assets/progression-magnitude-policy.js'), 'utf8');
  assert.ok(/does not select between reps and load for the D\/E adjustments/.test(src));
});
