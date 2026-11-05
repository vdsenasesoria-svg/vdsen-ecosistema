// T511: resolver hardening -- edge cases only; no physical values are invented (all grids are test fixtures).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const R = require(path.join(__dirname, '..', 'assets/progression-equipment-resolver.js'));

const eq = (loadIncrement) => ({ equipmentId: 'e', loadIncrement });
const go = (cur, des, dir, li, unit = 'KG', mode) => R.resolveLoad({ currentLoad: cur, desiredLoad: des, direction: dir, unit, equipment: eq(li), roundingMode: mode });
const step = (o) => Object.assign({ kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const bar = (o) => Object.assign({ kind: 'PLATE_LOADED_BAR', barWeight: 20, smallestPlate: 1.25, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const loads = (l, o) => Object.assign({ kind: 'AVAILABLE_LOADS', loads: l, unit: 'KG', source: 'COACH_CONFIGURED' }, o);
const val = r => [r.resolutionState, r.realizableLoad];

test('T511.1 units: same unit resolves; different unit is UNIT_MISMATCH (never converted); unit case is normalised', () => {
  assert.deepEqual(val(go(100, 102.5, 'UP', step(), 'KG')), ['RESOLVED', 102.5]);
  assert.equal(go(100, 102.5, 'UP', step(), 'LB').resolutionState, 'UNIT_MISMATCH');
  assert.deepEqual(val(go(100, 102.5, 'UP', step({ unit: 'kg' }), 'KG')), ['RESOLVED', 102.5]);
  assert.deepEqual(val(go(100, 105, 'UP', step({ step: 5, unit: 'LB' }), 'lb')), ['RESOLVED', 105]);
});

test('T511.2 exact step, no float drift on decimal grids', () => {
  assert.deepEqual(val(go(100, 101.25, 'UP', step({ step: 1.25 }))), ['RESOLVED', 101.25]);
  assert.deepEqual(val(go(100.1, 100.3, 'UP', step({ step: 0.1 }))), ['RESOLVED', 100.3]);
  assert.deepEqual(val(go(0.3, 0.6, 'UP', step({ step: 0.1 }))), ['RESOLVED', 0.6]);
});

test('T511.3 ties round toward the CURRENT load; explicit modes are honoured', () => {
  assert.deepEqual(val(go(100, 102.5, 'UP', step({ step: 5 }))), ['DIRECTION_NOT_REALIZABLE', 100]); // tie -> current (no move)
  assert.deepEqual(val(go(100, 102.5, 'UP', step({ step: 5 }), 'KG', 'CEIL')), ['RESOLVED', 105]);
  assert.deepEqual(val(go(105, 102.5, 'DOWN', step({ step: 5 }))), ['DIRECTION_NOT_REALIZABLE', 105]);
  assert.deepEqual(val(go(105, 102.5, 'DOWN', step({ step: 5 }), 'KG', 'FLOOR')), ['RESOLVED', 100]);
});

test('T511.4 minimum / maximum bounds', () => {
  assert.equal(go(100, 112, 'UP', step({ max: 105 })).resolutionState, 'OUT_OF_RANGE');
  assert.deepEqual(val(go(100, 105, 'UP', step({ max: 105 }))), ['RESOLVED', 105]);
  assert.deepEqual(val(go(102.5, 104, 'UP', step({ max: 105 }), 'KG', 'CEIL')), ['RESOLVED', 105]);
  const below = go(25, 12, 'DOWN', step({ min: 20 }), 'KG', 'FLOOR');
  assert.equal(below.resolutionState, 'OUT_OF_RANGE');
  assert.deepEqual(val(go(25, 21, 'DOWN', step({ min: 20 }))), ['RESOLVED', 20]);
});

test('T511.5 bar + bilateral plates: the grid step is 2 x smallestPlate above the bar weight', () => {
  assert.deepEqual(val(go(60, 62.5, 'UP', bar())), ['RESOLVED', 62.5]);   // 20 + k*2.5
  assert.deepEqual(val(go(60, 61, 'UP', bar(), 'KG', 'CEIL')), ['RESOLVED', 62.5]);
  assert.deepEqual(val(go(60, 61, 'UP', bar())), ['DIRECTION_NOT_REALIZABLE', 60]);
  assert.deepEqual(val(go(22.5, 21, 'DOWN', bar(), 'KG', 'FLOOR')), ['RESOLVED', 20]);
  assert.equal(go(25, 15, 'DOWN', bar(), 'KG', 'FLOOR').resolutionState, 'OUT_OF_RANGE', 'below the empty bar');
  assert.equal(go(100, 130, 'UP', bar({ max: 120 })).resolutionState, 'OUT_OF_RANGE');
});

test('T511.6 available-load lists: gaps, sorting, duplicates, ends', () => {
  const L = loads([25, 10, 15, 10, 20, 40]);
  assert.deepEqual(val(go(20, 22, 'UP', L, 'KG', 'CEIL')), ['RESOLVED', 25]);
  assert.deepEqual(val(go(25, 33, 'UP', L, 'KG', 'CEIL')), ['RESOLVED', 40], 'gap 25 -> 40');
  assert.deepEqual(val(go(25, 33, 'UP', L)), ['RESOLVED', 40], 'nearest: 40 is closer than 25');
  assert.deepEqual(val(go(25, 27, 'UP', L)), ['DIRECTION_NOT_REALIZABLE', 25]);
  assert.equal(go(40, 45, 'UP', L).resolutionState, 'OUT_OF_RANGE');
  assert.deepEqual(val(go(15, 12, 'DOWN', L)), ['RESOLVED', 10]);
  assert.equal(go(10, 5, 'DOWN', L, 'KG', 'FLOOR').resolutionState, 'OUT_OF_RANGE');
});

test('T511.7 direction is enforced: a realizable load must move in the requested direction', () => {
  const r = go(100, 102.5, 'UP', loads([90, 100, 110]), 'KG', 'FLOOR');
  assert.deepEqual([r.resolutionState, r.reasons.includes('NO_REALIZABLE_MOVE')], ['DIRECTION_NOT_REALIZABLE', true]);
  assert.equal(go(100, 97.5, 'UP', step()).reasons[0], 'DIRECTION_CONTRADICTS_TARGET');
  assert.equal(go(100, 102.5, 'DOWN', step()).resolutionState, 'INVALID_INPUT');
  assert.equal(go(100, 100, 'UP', step()).resolutionState, 'DIRECTION_NOT_REALIZABLE');
});

test('T511.7b beyond either end of the grid is OUT_OF_RANGE, never a silent clamp (all rounding modes)', () => {
  for (const mode of [undefined, 'NEAREST', 'FLOOR', 'CEIL']) {
    assert.equal(go(100, 130, 'UP', step({ max: 105 }), 'KG', mode).resolutionState, 'OUT_OF_RANGE', 'far above ' + mode);
    assert.equal(go(30, 12, 'DOWN', step({ min: 20 }), 'KG', mode).resolutionState, 'OUT_OF_RANGE', 'far below ' + mode);
    assert.equal(go(20, 130, 'UP', loads([10, 20, 40]), 'KG', mode).resolutionState, 'OUT_OF_RANGE', 'list end ' + mode);
  }
  // overshoot within half a step is ordinary nearest rounding to the end of the grid
  assert.deepEqual(val(go(100, 106, 'UP', step({ max: 105 }))), ['RESOLVED', 105]);
  assert.deepEqual(val(go(10, 4, 'DOWN', step({ step: 5, min: 5, max: 100 }))), ['RESOLVED', 5]);
  assert.equal(go(100, 106.5, 'UP', step({ max: 105 })).resolutionState, 'OUT_OF_RANGE');
});

test('T511.8 invalid metadata never resolves: bad kind / negative / missing source / NaN', () => {
  for (const li of [step({ step: 0 }), step({ step: -1 }), step({ source: 'GUESS' }), step({ source: undefined }), { kind: 'MACHINE', unit: 'KG', source: 'COACH_CONFIGURED' },
    loads([]), loads([-5, 10]), bar({ barWeight: -1 }), bar({ smallestPlate: 0 }), step({ min: 10, max: 5 })])
    assert.notEqual(go(100, 105, 'UP', li).resolutionState, 'RESOLVED', JSON.stringify(li));
});

test('T511.9 input validation: missing / non-numeric loads and directions are INVALID_INPUT, never a guess', () => {
  for (const a of [[null, 105, 'UP'], [100, null, 'UP'], [100, 'x', 'UP'], [100, 0, 'DOWN'], [100, 105, 'SIDEWAYS'], [-1, 5, 'UP']])
    assert.equal(go(a[0], a[1], a[2], step()).resolutionState, 'INVALID_INPUT', JSON.stringify(a));
});

test('T511.10 without equipment identity AND without metadata: UNRESOLVED_EQUIPMENT_IDENTITY; with id only: UNRESOLVED_EQUIPMENT_INCREMENT', () => {
  assert.equal(R.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: {} }).resolutionState, 'UNRESOLVED_EQUIPMENT_IDENTITY');
  assert.equal(R.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG' }).resolutionState, 'UNRESOLVED_EQUIPMENT_IDENTITY');
  assert.equal(R.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'x' } }).resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT');
});

test('T511.11 the resolver output is deterministic, never applies and never mutates its input', () => {
  const input = Object.freeze({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: Object.freeze({ equipmentId: 'e', loadIncrement: Object.freeze(step()) }) });
  const a = R.resolveLoad(input), b = R.resolveLoad(input);
  assert.deepEqual(a, b); assert.equal(a.applied, false); assert.equal(a.numericApplyAllowed, false);
});
