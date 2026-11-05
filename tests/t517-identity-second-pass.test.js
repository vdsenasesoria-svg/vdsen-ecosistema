// T517: identity second pass. Each Impulse / Matrix catalog entry names ONE machine -> exercise-level canonical id by EXACT
// exerciseId; brand/family labels never merge machines; attachments are not load implements; cable pulleys stay as catalogued.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const I = require(path.join(root, 'assets/equipment-identity.js'));
const C = require(path.join(root, 'assets/equipment-context.js'));
const G = 'smart-fit-san-diego', g = catalog.gyms[G], all = g.entries.concat(g.legacyEntries), idx = I.buildIndex(catalog);
const idOf = e => I.identify(idx, { equipmentId: e.equipmentId, exerciseId: e.exerciseId, label: e.equipment, gymId: G });
const family = all.filter(e => /^(Impulse|Matrix) ·/.test(e.equipment) && !e.equipmentId);

test('T517.1 all 19 family entries resolve to a DISTINCT machine id, by exerciseId mapping', () => {
  assert.equal(family.length, 19);
  const ids = family.map(e => { const r = idOf(e); assert.equal(r.status, 'EXERCISE_MAPPING', e.exerciseId); return r.equipmentId; });
  assert.equal(new Set(ids).size, 19, 'no two exercises share a machine merely by brand/family');
  assert.ok(ids.every(x => /^sf-sd-eq-(impulse|matrix)-/.test(x)));
});

test('T517.2 the family LABEL alone still resolves nothing (no brand-based merging)', () => {
  for (const label of ['Matrix · placas', 'Impulse · discos', 'Matrix · peso integrado', 'Impulse · peso integrado'])
    assert.equal(I.identify(idx, { label, gymId: G }).status, 'UNRESOLVED', label);
  assert.equal(I.identify(idx, { exerciseId: 'sf-sd-does-not-exist', label: 'Matrix · placas', gymId: G }).status, 'UNRESOLVED');
});

test('T517.3 similar machines are NOT merged: catalog Matrix knee extension != generic "Extensión de rodilla" entry', () => {
  const matrix = idOf(all.find(e => e.exerciseId === 'sf-sd-matrix-knee-extension')).equipmentId;
  const plain = idOf(all.find(e => e.equipment === 'Extensión de rodilla')).equipmentId;
  assert.ok(matrix && plain && matrix !== plain);
});

test('T517.4 an attachment is not a load implement: no identity, explicit role, and no invented link to a cable station', () => {
  const strap = all.find(e => e.exerciseId === 'sf-sd-cable-ankle-straps'), r = idOf(strap);
  assert.deepEqual([r.status, r.reason, r.implementRole, r.equipmentId], ['UNRESOLVED', 'ATTACHMENT_NOT_LOAD_IMPLEMENT', 'ATTACHMENT', null]);
  const q = C.buildEquipmentQueue({ catalog }).find(x => x.implementRole === 'ATTACHMENT');
  assert.ok(q && /accesorio sin carga propia/.test(q.missing[0]));
  const ref = C.equipmentRefForExercise({ catalog, exerciseId: 'sf-sd-cable-ankle-straps', config: { shared: { 'functional-cable-station': { kind: 'STEP', step: 5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} } });
  assert.equal(ref.loadIncrement, null, 'a cable-station increment is never inherited by an attachment');
});

test('T517.5 cable model: catalogued pulleys keep their own ids; loading implement of crossover = the cable station', () => {
  const by = id => all.filter(e => idOf(e).equipmentId === id).map(e => e.exerciseId);
  assert.ok(by('functional-cable-station').length >= 4);
  for (const id of ['sf-sd-eq-polea-alta', 'sf-sd-eq-polea-baja', 'sf-sd-eq-polea-ajustable']) assert.ok(by(id).length >= 1, id);
  assert.notEqual(idOf(all.find(e => e.exerciseId === 'legacy-crossover-polea-alta')).equipmentId, idOf(all.find(e => e.exerciseId === 'sf-sd-high-pulley')).equipmentId,
    'the repository does not prove the crossover station and the "Polea alta" pulley share a stack');
});

test('T517.6 only the generic "Máquina" and the attachment remain unresolved (2 groups)', () => {
  const q = C.buildEquipmentQueue({ catalog }).filter(r => r.identityStatus === 'UNRESOLVED');
  assert.deepEqual(q.map(r => r.name).sort(), ['Accesorio de polea', 'Máquina']);
  assert.deepEqual(q.map(r => r.identityReason).sort(), ['ATTACHMENT_NOT_LOAD_IMPLEMENT', 'GENERIC_LABEL']);
});

test('T517.7 registry integrity: exerciseIds are unique, exist in the catalog and no id maps two machines', () => {
  const ids = new Set(all.map(e => e.exerciseId)), seen = new Set();
  for (const eq of g.equipment) for (const x of eq.exerciseIds || []) { assert.ok(ids.has(x), x); assert.ok(!seen.has(x), x); seen.add(x); }
  assert.deepEqual(Object.keys(idx.ambiguous), []);
});
