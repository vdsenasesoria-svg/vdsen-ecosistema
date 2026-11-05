// T491: pure equipment load resolver (desired canonical load -> physically realizable load).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const resolver = require(path.join(__dirname, '..', 'assets/progression-equipment-resolver.js'));
const catalog = require(path.join(__dirname, '..', 'assets/exercise-visual-catalog.js'));
const { resolveLoad, STATES } = resolver;

const src = 'EXERCISE_METADATA';
const meta = (m) => Object.assign({ unit: 'KG', source: src }, m);
const run = (over) => resolveLoad(Object.assign({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG',
  equipment: { equipmentId: 'eq-1', equipmentType: 'machine', gymId: 'gym-1', loadIncrement: meta({ kind: 'STEP', step: 2.5 }) } }, over));

test('T491.1 unknown increment is never guessed: type alone, missing or unsourced metadata -> UNRESOLVED', () => {
  for (const equipment of [{ equipmentId: 'x', equipmentType: 'machine' }, { equipmentId: 'x', equipmentType: 'barbell', gymId: 'g' },
    { equipmentId: 'x', equipmentType: 'free_weight', loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG' } },
    { equipmentId: 'x', equipmentType: 'machine', loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'GUESS' } },
    { equipmentId: 'x', loadIncrement: meta({ kind: 'STEP', step: 0 }) }, { equipmentId: 'x', loadIncrement: meta({ kind: 'NOPE' }) },
    { equipmentId: 'x', loadIncrement: meta({ kind: 'AVAILABLE_LOADS', loads: [] }) }]) {
    const r = run({ equipment });
    assert.equal(r.resolutionState, STATES.UNRESOLVED_EQUIPMENT_INCREMENT);
    assert.equal(r.realizableLoad, null); assert.equal(r.delta, null);
  }
  assert.deepEqual(Object.keys(resolver.INCREMENT_METADATA), [], 'no increment data is authored yet');
});

test('T491.2 STEP equipment (selectorized stack / plate machine)', () => {
  const r = run({});
  assert.equal(r.resolutionState, STATES.RESOLVED); assert.equal(r.realizableLoad, 102.5); assert.equal(r.delta, 2.5);
  assert.equal(r.requestedLoad, 102.5); assert.equal(r.roundingReason, 'EXACT'); assert.equal(r.equipmentId, 'eq-1');
  assert.equal(r.incrementSource, src);
  const stack = run({ desiredLoad: 103.7, equipment: { equipmentId: 's', gymId: 'g', loadIncrement: meta({ kind: 'STEP', step: 5, min: 5, max: 150 }) } });
  assert.equal(stack.realizableLoad, 105); assert.equal(stack.roundingReason, 'NEAREST_ABOVE'); assert.equal(stack.delta, 5);
});

test('T491.3 direction must be realizable: a sub-increment desire cannot be presented as an increase', () => {
  const r = run({ desiredLoad: 101 });
  assert.equal(r.resolutionState, STATES.DIRECTION_NOT_REALIZABLE); assert.equal(r.realizableLoad, 100); assert.equal(r.delta, 0);
  assert.ok(r.reasons.includes('NO_REALIZABLE_MOVE'));
  assert.equal(run({ desiredLoad: 101, roundingMode: 'CEIL' }).realizableLoad, 102.5);
  const down = run({ desiredLoad: 98.9, direction: 'DOWN' });
  assert.equal(down.realizableLoad, 100);
  assert.equal(down.resolutionState, STATES.DIRECTION_NOT_REALIZABLE, '98.9 rounds to 100 (no move) on a 2.5 grid');
  assert.equal(run({ desiredLoad: 97.5, direction: 'DOWN' }).realizableLoad, 97.5);
  assert.equal(run({ desiredLoad: 98, direction: 'DOWN', roundingMode: 'FLOOR' }).realizableLoad, 97.5);
});

test('T491.4 ties round toward the current load; default rounding is flagged', () => {
  const tie = run({ currentLoad: 100, desiredLoad: 101.25 });
  assert.equal(tie.roundingReason, 'NEAREST_TIE_TOWARD_CURRENT'); assert.equal(tie.realizableLoad, 100);
  assert.equal(tie.roundingModeDefaulted, true);
  assert.equal(run({ roundingMode: 'NEAREST' }).roundingModeDefaulted, false);
});

test('T491.5 plate-loaded barbell / trap bar: bar + pairs of the smallest plate', () => {
  const eq = { equipmentId: 'bar', equipmentType: 'barbell', gymId: 'g', loadIncrement: meta({ kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 1.25 }) };
  assert.equal(run({ equipment: eq, currentLoad: 100, desiredLoad: 102.5 }).realizableLoad, 102.5);
  assert.equal(run({ equipment: eq, currentLoad: 100, desiredLoad: 104, roundingMode: 'FLOOR' }).realizableLoad, 102.5);
  const big = { equipmentId: 'bar', loadIncrement: meta({ kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 2.5 }) };
  assert.equal(run({ equipment: big, currentLoad: 100, desiredLoad: 104, roundingMode: 'CEIL' }).realizableLoad, 105);
  assert.equal(run({ equipment: { equipmentId: 'bar', loadIncrement: meta({ kind: 'PLATE_LOADED_BAR', barWeight: 20 }) } }).resolutionState, STATES.UNRESOLVED_EQUIPMENT_INCREMENT);
});

test('T491.6 dumbbells / fixed implements: only explicitly available loads', () => {
  const eq = { equipmentId: 'db', equipmentType: 'free_weight', loadIncrement: meta({ kind: 'AVAILABLE_LOADS', loads: [10, 12.5, 15, 17.5, 20, 22.5, 25] }) };
  assert.equal(run({ equipment: eq, currentLoad: 17.5, desiredLoad: 18 }).resolutionState, STATES.DIRECTION_NOT_REALIZABLE);
  const up = run({ equipment: eq, currentLoad: 17.5, desiredLoad: 18, roundingMode: 'CEIL' });
  assert.equal(up.realizableLoad, 20); assert.equal(up.delta, 2.5); assert.equal(up.resolutionState, STATES.RESOLVED);
  assert.equal(run({ equipment: eq, currentLoad: 17.5, desiredLoad: 15.2, direction: 'DOWN' }).realizableLoad, 15);
  const gap = { equipmentId: 'db', loadIncrement: meta({ kind: 'AVAILABLE_LOADS', loads: [10, 15, 30] }) };
  const nearest = run({ equipment: gap, currentLoad: 15, desiredLoad: 22, roundingMode: 'NEAREST' });
  assert.equal(nearest.realizableLoad, 15); assert.equal(nearest.resolutionState, STATES.DIRECTION_NOT_REALIZABLE);
  assert.equal(run({ equipment: gap, currentLoad: 15, desiredLoad: 22, roundingMode: 'CEIL' }).realizableLoad, 30, 'no invented intermediate weights');
});

test('T491.7 out-of-range and unit mismatch are explicit', () => {
  const stack = { equipmentId: 's', loadIncrement: meta({ kind: 'STEP', step: 5, min: 5, max: 100 }) };
  assert.equal(run({ equipment: stack, currentLoad: 100, desiredLoad: 105 }).resolutionState, STATES.OUT_OF_RANGE);
  assert.equal(run({ equipment: stack, currentLoad: 100, desiredLoad: 105 }).realizableLoad, null);
  assert.equal(run({ equipment: stack, currentLoad: 10, desiredLoad: 4, direction: 'DOWN' }).realizableLoad, 5);
  const lb = run({ unit: 'LB' });
  assert.equal(lb.resolutionState, STATES.UNIT_MISMATCH); assert.equal(lb.realizableLoad, null);
});

test('T491.8 invalid inputs never produce a load', () => {
  for (const over of [{ currentLoad: 'x' }, { desiredLoad: 0 }, { desiredLoad: -5 }, { direction: 'SIDEWAYS' }, { direction: 'UP', desiredLoad: 90 },
    { direction: 'DOWN', desiredLoad: 110 }, { currentLoad: null }]) {
    const r = run(over);
    assert.equal(r.resolutionState, STATES.INVALID_INPUT); assert.equal(r.realizableLoad, null);
  }
  assert.equal(resolveLoad(undefined).resolutionState, STATES.INVALID_INPUT);
});

test('T491.9 external increment table lookup by gym + equipment', () => {
  const table = { 'gym-1': { 'eq-1': meta({ kind: 'STEP', step: 5 }) } };
  const r = resolveLoad({ currentLoad: 100, desiredLoad: 105, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'eq-1', gymId: 'gym-1' }, incrementMetadata: table });
  assert.equal(r.resolutionState, STATES.RESOLVED); assert.equal(r.realizableLoad, 105);
  assert.equal(resolveLoad({ currentLoad: 100, desiredLoad: 105, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'eq-2', gymId: 'gym-1' }, incrementMetadata: table }).resolutionState,
    STATES.UNRESOLVED_EQUIPMENT_INCREMENT);
  assert.equal(resolveLoad({ currentLoad: 100, desiredLoad: 105, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'eq-1', gymId: 'gym-2' }, incrementMetadata: table }).resolutionState,
    STATES.UNRESOLVED_EQUIPMENT_INCREMENT, 'another gym never inherits an increment');
});

test('T491.10 real catalog entries carry no increment metadata, so every one resolves UNRESOLVED', () => {
  const entries = [];
  Object.values(catalog.gyms).forEach(g => entries.push(...g.entries, ...g.legacyEntries));
  entries.push(...catalog.functionalEquipment);
  assert.ok(entries.length > 50);
  let checked = 0;
  for (const e of entries) {
    const ref = resolver.equipmentRefFromCatalogEntry(e);
    if (ref.loadIncrement) continue; // once increments are authored this branch is exercised by T491.2-9
    const r = resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: ref });
    // T509: an entry without an equipmentId is an unresolved IDENTITY; with one it is an unresolved increment. Never RESOLVED.
    assert.equal(r.resolutionState, ref.equipmentId ? STATES.UNRESOLVED_EQUIPMENT_INCREMENT : STATES.UNRESOLVED_EQUIPMENT_IDENTITY, e.exerciseName || e.name);
    checked++;
  }
  assert.ok(checked > 50);
});

test('T491.11 the resolver is pure, never applies anything and is not wired into any app or policy', () => {
  const eqSrc = fs.readFileSync(path.join(__dirname, '..', 'assets/progression-equipment-resolver.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/updateDoc|setDoc|addDoc|firestore|firebase|fetch\(|localStorage|document\.|window\.|Date\.now|new Date\(|Math\.random/i.test(eqSrc));
  const frozen = Object.freeze({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG',
    equipment: Object.freeze({ equipmentId: 'e', gymId: 'g', loadIncrement: Object.freeze(meta({ kind: 'STEP', step: 2.5 })) }) });
  const a = resolveLoad(frozen), b = resolveLoad(frozen);
  assert.deepEqual(a, b);
  assert.equal(a.numericApplyAllowed, false); assert.equal(a.applied, false);
  // T502/T503: only the Coach (configuration editor + dry-run audit) consumes the resolver; the athlete client and
  // the policy/shadow modules never do.
  for (const app of ['vdsen-cliente.html', 'assets/progression-magnitude-policy.js', 'assets/progression-auto-apply-shadow.js'])
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', app), 'utf8').includes('VDSEN_EQUIPMENT_RESOLVER'), app + ' does not consume the resolver');
});
