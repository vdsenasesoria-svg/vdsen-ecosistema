// T502: strict Coach configuration path for load-increment metadata. Configuration data, not progression
// policy: unknown/empty stays unresolved; the equipment TYPE never fills a value; source is always COACH_CONFIGURED.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const N = resolver.normalizeLoadIncrementInput;

test('T502.1 empty / NONE clears the configuration (null); nothing is defaulted', () => {
  for (const v of [null, undefined, {}, { kind: '' }, { kind: 'NONE' }]) assert.equal(N(v), null);
});

test('T502.2 STEP: valid input becomes sourced COACH_CONFIGURED metadata that resolves a load', () => {
  const m = N({ kind: 'STEP', unit: 'kg', step: '5', min: '5', max: '100' });
  assert.deepEqual(m, { kind: 'STEP', step: 5, min: 5, max: 100, unit: 'KG', source: 'COACH_CONFIGURED' });
  const r = resolver.resolveLoad({ currentLoad: 50, desiredLoad: 55, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'e', loadIncrement: m } });
  assert.equal(r.resolutionState, 'RESOLVED'); assert.equal(r.realizableLoad, 55); assert.equal(r.incrementSource, 'COACH_CONFIGURED');
  assert.equal(N({ kind: 'STEP', unit: 'LB', step: '2,5' }).step, 2.5, 'decimal comma');
});

test('T502.3 PLATE_LOADED_BAR and AVAILABLE_LOADS are validated and normalised', () => {
  assert.deepEqual(N({ kind: 'PLATE_LOADED_BAR', unit: 'KG', barWeight: '20', smallestPlate: '1.25' }),
    { kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 1.25, unit: 'KG', source: 'COACH_CONFIGURED' });
  const d = N({ kind: 'AVAILABLE_LOADS', unit: 'KG', loads: '10 12,5; 15\n20' });
  assert.deepEqual(d.loads, [10, 12.5, 15, 20]);
  assert.deepEqual(N({ kind: 'AVAILABLE_LOADS', unit: 'KG', loads: [20, 10, 10] }).loads, [10, 20]);
});

test('T502.4 invalid configuration is rejected with an explicit error (never silently coerced)', () => {
  const bad = [
    { kind: 'STEP', unit: 'KG', step: '0' }, { kind: 'STEP', unit: 'KG', step: '-2' }, { kind: 'STEP', unit: 'KG', step: 'abc' },
    { kind: 'STEP', unit: 'KG', step: '' }, { kind: 'STEP', unit: 'KG', step: '5', min: '10', max: '5' },
    { kind: 'STEP', unit: 'XX', step: '5' }, { kind: 'STEP', step: '5' },
    { kind: 'STEP', unit: 'KG', step: '99999' },
    { kind: 'PLATE_LOADED_BAR', unit: 'KG', barWeight: '-1', smallestPlate: '2' }, { kind: 'PLATE_LOADED_BAR', unit: 'KG', barWeight: '20', smallestPlate: '0' },
    { kind: 'AVAILABLE_LOADS', unit: 'KG', loads: '' }, { kind: 'AVAILABLE_LOADS', unit: 'KG', loads: '10 x 20' }, { kind: 'AVAILABLE_LOADS', unit: 'KG', loads: '-5 10' },
    { kind: 'MACHINE_DEFAULT', unit: 'KG', step: '5' }, { kind: 'machine', unit: 'KG', step: '5' }
  ];
  for (const b of bad) assert.throws(() => N(b), /Incremento|incremento/, JSON.stringify(b));
});

test('T502.5 the source cannot be chosen by the input (always COACH_CONFIGURED)', () => {
  assert.equal(N({ kind: 'STEP', unit: 'KG', step: '5', source: 'GYM_METADATA' }).source, 'COACH_CONFIGURED');
});

test('T502.6 Coach exposes one small editor writing ONLY loadIncrement on the coach-owned exercise doc', () => {
  assert.ok(coach.includes('<script src="assets/progression-equipment-resolver.js"></script>'));
  assert.ok(coach.includes('function openLoadIncrementEditor('));
  const i = coach.indexOf('function openLoadIncrementEditor(');
  const body = coach.slice(i, coach.indexOf('window.openLoadIncrementEditor', i));
  assert.ok(body.includes('normalizeLoadIncrementInput'));
  assert.ok(/updateDoc\(doc\(db, 'exercises', [^)]*\), \{ loadIncrement: /.test(body), 'patch is exactly { loadIncrement }');
  assert.ok(body.includes('coachId') && body.includes('currentCoach.uid'));
  assert.ok(!/updateDoc\(doc\(db, 'plans'|progressionApplications|nextExposureOverlays/.test(body));
});

test('T502.7 no defaults derived from equipment type in the editor', () => {
  const i = coach.indexOf('function openLoadIncrementEditor(');
  const body = coach.slice(i, coach.indexOf('window.openLoadIncrementEditor', i));
  assert.ok(!/value="2\.5"|value="5"|value="20"|equipmentType\s*===|\.equipment\s*===/.test(body));
});
