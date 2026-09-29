// T504: deterministic application-readiness matrix. Each gate is PASS / BLOCKED / NOT_EVALUATED / NOT_APPLICABLE with
// explicit blocker codes -- no unresolved condition hides behind a generic NOT_ELIGIBLE/REVIEW.
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
  for (const [w, d, over] of spec) [0, 1, 2].forEach(s => {
    e['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? over : {});
  });
  return e;
}
const rec = (spec) => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents(spec), week: 1, dayIndex: 2,
  calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
  recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
const GOOD = [[1, 0, {}], [1, 2, { rir_real: 3 }]];
const good = () => rec([[1, 0, { rir_real: 3 }], [1, 2, { rir_real: 3 }]]);
const grid = { equipmentId: 'exercise:e', loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } };
function plan1(r, over = {}) {
  const eqRes = resolver.resolveForCandidate({ magnitude: r.magnitude, equipment: grid });
  return consumer.planApplication({ record: r, context: Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents([[1, 0, {}], [1, 2, {}]]),
    interventions: [], equipmentResolution: eqRes || undefined, existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure }, over) });
}
const gate = (d, g) => d.readiness.gates.filter(x => x.gate === g)[0];
const blocked = d => d.readiness.gates.filter(x => x.state === 'BLOCKED').map(x => x.gate + ':' + x.codes.join('+'));

test('T504.1 the matrix lists every required gate in a fixed order', () => {
  const d = plan1(good());
  assert.deepEqual(d.readiness.gates.map(g => g.gate), ['IDENTITY', 'FRESHNESS', 'TARGET_EXPOSURE', 'COACH_OVERRIDE', 'SAFETY', 'EVIDENCE_COUNT',
    'DIRECTION_CONSISTENCY', 'POLICY_REVIEW', 'MAGNITUDE_BRANCH', 'EQUIPMENT_IDENTITY', 'EQUIPMENT_INCREMENT', 'UNIT', 'TARGET_STARTED', 'ACTIVATION_GUARD']);
  assert.equal(d.readiness.executable, false, 'never executable while the flag is off');
  assert.equal(d.readiness.numericApplyEnabled, false);
});

test('T504.2 a fully ready candidate passes every gate; only the activation flag remains', () => {
  const d = plan1(good());
  assert.equal(d.wouldApply, true);
  assert.deepEqual(blocked(d), []);
  assert.deepEqual(d.readiness.gates.map(g => g.state), Array(14).fill('PASS'));
  assert.equal(d.readiness.readyExceptFlag, true);
});

test('T504.3 too few comparable exposures -> EVIDENCE_COUNT_INSUFFICIENT (not a generic NOT_ELIGIBLE)', () => {
  const d = plan1(rec([[1, 2, { rir_real: 3 }]]));
  assert.ok(d.blockers.includes(B.EVIDENCE_COUNT_INSUFFICIENT)); assert.ok(!d.blockers.includes(B.NOT_ELIGIBLE));
  assert.equal(gate(d, 'EVIDENCE_COUNT').state, 'BLOCKED');
});

test('T504.4 direction conflict / unconfirmed direction have their own codes', () => {
  const conflict = plan1(rec([[1, 0, { reps: '6', rir_real: 0 }], [1, 2, { rir_real: 3 }]]));
  assert.ok(conflict.blockers.includes(B.DIRECTION_CONFLICTING)); assert.ok(!conflict.blockers.includes(B.NOT_ELIGIBLE));
  assert.equal(gate(conflict, 'DIRECTION_CONSISTENCY').state, 'BLOCKED');
  const unconfirmed = plan1(rec([[1, 0, { rir_real: 2 }], [1, 2, { rir_real: 3 }]]));
  assert.ok(unconfirmed.blockers.includes(B.DIRECTION_UNCONFIRMED)); assert.ok(!unconfirmed.blockers.includes(B.NOT_ELIGIBLE));
});

test('T504.5 (T523) D/E branches are Coach-review states (own gate), not unresolved policy branches', () => {
  const de = plan1(rec([[1, 0, { reps: '8', rir_real: 0 }], [1, 2, { reps: '8', rir_real: 0 }]]));
  assert.ok(de.blockers.includes(B.COACH_REVIEW_REQUIRED)); assert.ok(!de.blockers.includes(B.MAGNITUDE_BRANCH_UNRESOLVED));
  assert.equal(gate(de, 'POLICY_REVIEW').state, 'BLOCKED'); assert.equal(de.readiness.state, 'COACH_REVIEW_REQUIRED');
  assert.equal(de.readiness.preview.primary, 'COACH_REVIEW_REQUIRED'); assert.equal(de.audit.unresolvedRules, null);
  const d = plan1(rec([[1, 0, { reps: '10', rir_real: 0 }], [1, 2, { reps: '10', rir_real: 0 }]]));
  assert.equal(d.readiness.state, 'COACH_REVIEW_REQUIRED');
});

test('T504.6 safety conflict, readiness veto, Coach override and started target are separate gates', () => {
  assert.ok(gate(plan1(good(), { safetyConflict: true }), 'SAFETY').state === 'BLOCKED');
  const started = plan1(good(), { entries: Object.assign(ents([[1, 0, {}], [1, 2, {}]]), { 'log_2_0_0_s0': { carga: '100', reps: '10', done: true } }) });
  assert.equal(gate(started, 'TARGET_STARTED').state, 'BLOCKED');
  const ov = plan1(good(), { interventions: [{ targetType: 'EXERCISE', targetId: PID, planId: 'p', decidedAt: '2026-09-27T14:00:00.000Z', action: 'CHANGE' }] });
  assert.equal(gate(ov, 'COACH_OVERRIDE').state, 'BLOCKED');
});

test('T504.7 equipment and unit gates: unresolved increment, unit mismatch, not applicable for REPS/REST', () => {
  const r = good();
  const unresolved = consumer.planApplication({ record: r, context: { clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: ents([[1, 0, {}], [1, 2, {}]]),
    interventions: [], existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure } });
  assert.equal(gate(unresolved, 'EQUIPMENT_INCREMENT').state, 'BLOCKED');
  assert.deepEqual(gate(unresolved, 'EQUIPMENT_INCREMENT').codes, [B.UNRESOLVED_EQUIPMENT_INCREMENT]);
  const lb = plan1(rec([[1, 0, { rir_real: 3, unit: 'LB' }], [1, 2, { rir_real: 3, unit: 'LB' }]]));
  assert.equal(gate(lb, 'UNIT').state, 'BLOCKED');
  const rest = plan1(rec([[1, 0, {}], [1, 2, { reps: '8', rir_real: 2 }]])); // first comparable occurrence of C (T523)
  assert.equal(rest.wouldApply, true);
  assert.equal(gate(rest, 'EQUIPMENT_INCREMENT').state, 'NOT_APPLICABLE'); assert.equal(gate(rest, 'UNIT').state, 'NOT_APPLICABLE');
});

test('T504.8 non-canonical / identity failures mark later gates NOT_EVALUATED, never PASS', () => {
  const d = consumer.planApplication({ record: { key: 'k' }, context: {} });
  assert.equal(gate(d, 'IDENTITY').state, 'BLOCKED');
  assert.ok(d.readiness.gates.filter(g => g.gate !== 'IDENTITY').every(g => g.state === 'NOT_EVALUATED'));
});

test('T504.9 the matrix is deterministic and pure; every blocker maps to exactly one gate', () => {
  const a = JSON.stringify(plan1(good()).readiness), b = JSON.stringify(plan1(good()).readiness);
  assert.equal(a, b);
  const all = new Set(Object.values(B).filter(x => x !== B.NUMERIC_APPLY_DISABLED));
  const mapped = new Set([].concat(...Object.values(consumer.GATES)));
  for (const code of all) assert.ok(mapped.has(code) || ['STALE_CALLBACK', 'REVISION_CONFLICT'].includes(code), code + ' has a gate');
  const flat = [].concat(...Object.values(consumer.GATES));
  assert.equal(flat.length, new Set(flat).size, 'no blocker belongs to two gates');
});

test('T504.10 Coach labels every new blocker (no raw code shown for evidence/direction gates)', () => {
  for (const code of ['EVIDENCE_COUNT_INSUFFICIENT', 'DIRECTION_CONFLICTING', 'DIRECTION_UNCONFIRMED', 'READINESS_VETO'])
    assert.ok(coach.includes(code + ':'), code);
});
