// T503: canonical magnitude candidate -> desired load -> equipment identity -> explicit increment metadata ->
// resolveLoad() -> realizable load OR a specific blocker -> dry-run audit. Still NUMERIC_APPLY_ENABLED=false,
// nothing written, no APPLIED state.
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
function entriesFor(last, unit = 'KG') {
  const e = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => {
    e['log_' + w + '_' + d + '_0_s' + s] = Object.assign({ carga: '100', reps: '10', unit, done: true, rir: 2, rir_real: 2,
      prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }, s === 2 ? last : {});
  }));
  return e;
}
const record = (unit) => shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entriesFor({ rir_real: 3 }, unit), week: 1, dayIndex: 2,
  calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
  recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'Remo', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
const inc = (o) => Object.assign({ kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const eq = (loadIncrement) => ({ equipmentId: 'exercise:e', equipmentType: 'machine', gymId: null, loadIncrement });
function plan1(rec, equipment, roundingMode) {
  const resolution = resolver.resolveForCandidate({ magnitude: rec.magnitude, equipment, roundingMode });
  return consumer.planApplication({ record: rec, context: { clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entriesFor({ rir_real: 3 }),
    interventions: [], equipmentResolution: resolution || undefined, existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure } });
}
const real = d => d.blockers.filter(b => b !== B.NUMERIC_APPLY_DISABLED);

test('T503.1 resolveForCandidate derives current/desired/direction/unit from the canonical candidate', () => {
  const rec = record('KG');
  const r = resolver.resolveForCandidate({ magnitude: rec.magnitude, equipment: eq(inc()) });
  assert.equal(r.currentLoad, 100); assert.equal(r.requestedLoad, 102.5); assert.equal(r.unit, 'KG');
  assert.equal(r.resolutionState, 'RESOLVED'); assert.equal(r.realizableLoad, 102.5); assert.equal(r.incrementSource, 'COACH_CONFIGURED');
  assert.equal(resolver.resolveForCandidate({ magnitude: { candidates: [{ dimension: 'REPS' }] }, equipment: eq(inc()) }), null, 'only LOAD candidates');
});

test('T503.2 resolved equipment -> overlay plan with the realizable load and audit fields; still dry-run', () => {
  const d = plan1(record('KG'), eq(inc()));
  assert.deepEqual(real(d), []); assert.equal(d.wouldApply, true); assert.equal(d.canApply, false); assert.equal(d.applied, false);
  assert.equal(d.overlay.appliedValue, 102.5); assert.equal(d.overlay.equipmentId, 'exercise:e');
  assert.deepEqual(d.equipment && [d.equipment.resolutionState, d.equipment.incrementSource, d.equipment.requestedLoad, d.equipment.realizableLoad, d.equipment.equipmentId],
    ['RESOLVED', 'COACH_CONFIGURED', 102.5, 102.5, 'exercise:e']);
  assert.ok(d.blockers.includes(B.NUMERIC_APPLY_DISABLED));
});

test('T503.3 no increment metadata -> UNRESOLVED_EQUIPMENT_INCREMENT (no guess from equipment type)', () => {
  const d = plan1(record('KG'), eq(null));
  assert.deepEqual(real(d), [B.UNRESOLVED_EQUIPMENT_INCREMENT]); assert.equal(d.wouldApply, false); assert.equal(d.overlay, null);
  assert.equal(d.equipment.resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT'); assert.equal(d.equipment.realizableLoad, null);
});

test('T503.4 unit mismatch -> UNIT_MISMATCH', () => {
  const d = plan1(record('LB'), eq(inc({ unit: 'KG' })));
  assert.deepEqual(real(d), [B.UNIT_MISMATCH]); assert.equal(d.wouldApply, false);
});

test('T503.5 direction not realizable (grid step swallows the move) -> DIRECTION_NOT_REALIZABLE', () => {
  const d = plan1(record('KG'), eq(inc({ step: 10 })));
  assert.deepEqual(real(d), [B.DIRECTION_NOT_REALIZABLE]); assert.equal(d.overlay, null);
  assert.equal(d.equipment.resolutionState, 'DIRECTION_NOT_REALIZABLE');
});

test('T503.6 above the equipment maximum -> EQUIPMENT_OUT_OF_RANGE', () => {
  const d = plan1(record('KG'), eq(inc({ min: 0, max: 100 })));
  assert.deepEqual(real(d), [B.EQUIPMENT_OUT_OF_RANGE]);
});

test('T503.7 AVAILABLE_LOADS / PLATE_LOADED_BAR grids resolve or block with explicit reasons', () => {
  const dumb = plan1(record('KG'), eq({ kind: 'AVAILABLE_LOADS', loads: [90, 100, 105, 110], unit: 'KG', source: 'COACH_CONFIGURED' }), 'CEIL');
  assert.deepEqual(real(dumb), []); assert.equal(dumb.overlay.appliedValue, 105);
  const bar = plan1(record('KG'), eq({ kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 1.25, unit: 'KG', source: 'COACH_CONFIGURED' }));
  assert.deepEqual(real(bar), []); assert.equal(bar.overlay.appliedValue, 102.5);
});

test('T503.8 REPS/REST candidates never need equipment; invalid equipment input is explicit', () => {
  const bad = consumer.planApplication({ record: record('KG'), context: { clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries: entriesFor({ rir_real: 3 }),
    interventions: [], equipmentResolution: { resolutionState: 'INVALID_INPUT' }, existingOverlays: {}, now: '2026-09-28T00:00:00.000Z', resolveNextExposure: shadow.resolveNextExposure } });
  assert.deepEqual(real(bad), [B.EQUIPMENT_INPUT_INVALID]);
});

test('T503.9 flag stays off, no APPLIED state, nothing written by the wiring', () => {
  assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
  assert.ok(!('APPLIED' in shadow.STATES));
  const src = fs.readFileSync(path.join(root, 'assets/progression-equipment-resolver.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/updateDoc|setDoc|addDoc|fetch\(|localStorage|document\.|window\./i.test(src));
});

test('T503.10 Coach builds the equipment reference from the exact plan exercise id (no name matching) and passes the resolution', () => {
  assert.ok(coach.includes('resolveForCandidate('));
  const i = coach.indexOf('function _equipmentRefForRecord');
  assert.ok(i > 0);
  const body = coach.slice(i, coach.indexOf('\n  }\n', i));
  assert.ok(body.includes('prescriptionExerciseId') && body.includes('exerciseId') && body.includes("'exercises'"));
  assert.ok(!/toLowerCase|_normN|includes\(.*name/i.test(body), 'identity is never name based');
  assert.ok(body.includes('coachId') && body.includes('currentCoach.uid'));
  assert.ok(coach.includes('equipmentResolution:'));
});
