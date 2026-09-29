// T501/T508-source: the real equipment/catalog architecture holds NO explicit load-increment data, so nothing is
// sourced; every real equipment stays UNRESOLVED_EQUIPMENT_INCREMENT. The inventory doc is generated and must be current.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const inv = require(path.join(root, 'scripts/equipment-increment-inventory.cjs'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));

test('T501.1 the inventory covers every gym entry, legacy entry and functional equipment', () => {
  const rows = inv.buildInventory(catalog);
  const gym = catalog.gyms['smart-fit-san-diego'];
  const total = rows.reduce((n, r) => n + r.exercises.length, 0);
  assert.equal(total, gym.entries.length + gym.legacyEntries.length);
  for (const f of catalog.functionalEquipment) assert.ok(rows.some(r => r.equipmentId === f.equipmentId), f.equipmentId);
  assert.ok(rows.length >= 20);
});

test('T501.2 no real equipment has an explicit sourced increment; the resolver table is empty', () => {
  const rows = inv.buildInventory(catalog);
  assert.deepEqual(rows.filter(r => r.incrementState !== 'NONE').map(r => r.equipment), []);
  assert.deepEqual(Object.keys(resolver.INCREMENT_METADATA), []);
  assert.ok(!/loadIncrement|smallestPlate|barWeight/.test(fs.readFileSync(path.join(root, 'assets/exercise-visual-catalog.js'), 'utf8')));
});

test('T501.3 equipment type or label alone never resolves a load', () => {
  for (const r of inv.buildInventory(catalog)) {
    const res = resolver.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG',
      equipment: { equipmentId: r.equipmentId || 'x', equipmentType: r.equipmentType, gymId: r.gymId } });
    assert.equal(res.resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT', r.equipment);
    assert.equal(res.realizableLoad, null);
  }
});

test('T501.4 identity is reported, never guessed: only explicit ids or exact functional-label matches get an equipmentId', () => {
  const rows = inv.buildInventory(catalog);
  for (const r of rows.filter(x => x.identity === 'NO_EQUIPMENT_ID')) assert.equal(r.equipmentId, null, r.equipment);
  assert.ok(rows.some(r => r.identity === 'NO_EQUIPMENT_ID'));
});

test('T501.5 docs/EQUIPMENT_INCREMENT_INVENTORY.md is generated and current', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/equipment-increment-inventory.cjs'), '--check']);
  assert.equal(r.status, 0, 'regenerate with: node scripts/equipment-increment-inventory.cjs');
});
