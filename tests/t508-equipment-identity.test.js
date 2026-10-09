// T508: canonical equipment identity. exact equipmentId > exact normalized canonical alias > unresolved.
// No similarity matching; shared equipment resolves to ONE id; family / generic / attachment labels stay unresolved.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const I = require(path.join(root, 'assets/equipment-identity.js'));
const inv = require(path.join(root, 'scripts/equipment-increment-inventory.cjs'));
const GYM = 'smart-fit-san-diego';
const idx = I.buildIndex(catalog);
const who = (label, extra) => I.identify(idx, Object.assign({ label, gymId: GYM }, extra));

test('T508.1 exact equipmentId wins; an unknown id is UNRESOLVED (never reinterpreted by label)', () => {
  const r = who('Cualquier cosa', { equipmentId: 'functional-dumbbells' });
  assert.deepEqual([r.status, r.equipmentId], ['EXPLICIT_ID', 'functional-dumbbells']);
  const u = who('Mancuernas', { equipmentId: 'not-a-real-id' });
  assert.deepEqual([u.status, u.equipmentId, u.reason], ['UNRESOLVED', null, 'UNKNOWN_EQUIPMENT_ID']);
});

test('T508.2 exact normalized alias resolves (case / accents / spaces); similarity never does', () => {
  assert.equal(who('  BARRA   olímpica ').equipmentId, 'functional-olympic-barbell');
  assert.equal(who('barra olimpica').equipmentId, 'functional-olympic-barbell', 'explicit alias');
  assert.equal(who('Polea alta').equipmentId, who('Polea Alta').equipmentId, 'case variants are ONE identity');
  for (const near of ['Mancuerna corta', 'Barra olímpica 20kg', 'Polea', 'Belt', 'Prensa']) assert.equal(who(near).status, 'UNRESOLVED', near);
});

test('T508.3 shared equipment resolves to ONE canonical id across exercises', () => {
  const g = catalog.gyms[GYM], byEquip = {};
  g.entries.concat(g.legacyEntries).forEach(e => { const r = I.identify(idx, { equipmentId: e.equipmentId, label: e.equipment, gymId: GYM }); if (r.equipmentId) (byEquip[r.equipmentId] = byEquip[r.equipmentId] || new Set()).add(I.normalizeLabel(r.canonicalName)); });
  for (const [id, names] of Object.entries(byEquip)) assert.equal(names.size, 1, id);
  assert.equal(who('Mancuernas').equipmentId, 'functional-dumbbells');
});

test('T508.4 family / generic / attachment LABELS are not identities and keep an explicit reason (T517: family machines resolve only by exact exerciseId)', () => {
  const expected = { 'Impulse · discos': 'FAMILY_LABEL_MULTIPLE_IMPLEMENTS', 'Impulse · peso integrado': 'FAMILY_LABEL_MULTIPLE_IMPLEMENTS', 'Matrix · placas': 'FAMILY_LABEL_MULTIPLE_IMPLEMENTS',
    'Matrix · peso integrado': 'FAMILY_LABEL_MULTIPLE_IMPLEMENTS', 'Máquina': 'GENERIC_LABEL', 'Accesorio de polea': 'ATTACHMENT_NOT_LOAD_IMPLEMENT' };
  for (const [label, reason] of Object.entries(expected)) { const r = who(label); assert.deepEqual([r.status, r.equipmentId, r.reason], ['UNRESOLVED', null, reason], label); }
  assert.equal(who('Algo no catalogado').reason, 'NO_CANONICAL_DEFINITION');
  assert.equal(who('').reason, 'NO_LABEL');
});

test('T508.5 identity counts: every catalog exercise is classified; only the documented families stay unresolved', () => {
  const g = catalog.gyms[GYM], all = g.entries.concat(g.legacyEntries);
  const res = all.map(e => I.identify(idx, { equipmentId: e.equipmentId, label: e.equipment, gymId: GYM }));
  const unresolved = res.filter(r => r.status === 'UNRESOLVED');
  const res2 = all.map(e => I.identify(idx, { equipmentId: e.equipmentId, exerciseId: e.exerciseId, label: e.equipment, gymId: GYM }));
  const unresolved2 = res2.filter(r => r.status === 'UNRESOLVED');
  assert.equal(all.length, 71); assert.equal(unresolved.length, 21, 'by label alone the 19 family machines stay unresolved');
  assert.equal(unresolved2.length, 2, 'T517: only the generic label and the attachment remain');
  assert.deepEqual([...new Set(unresolved2.map(r => r.reason))].sort(), ['ATTACHMENT_NOT_LOAD_IMPLEMENT', 'GENERIC_LABEL']);
  const rows = inv.buildInventory(catalog);
  assert.equal(rows.filter(r => r.identity !== 'UNRESOLVED').length, 39);
  assert.equal(rows.filter(r => r.identity === 'UNRESOLVED').length, 2);
});

test('T508.6 identity carries NO increment: resolving identity never makes a load realizable', () => {
  const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
  for (const label of ['Mancuernas', 'Belt Squat', 'Polea alta']) {
    const id = who(label);
    const r = resolver.resolveLoad({ currentLoad: 50, desiredLoad: 52.5, direction: 'UP', unit: 'KG', equipment: { equipmentId: id.equipmentId, equipmentType: id.equipmentType, gymId: GYM } });
    assert.equal(r.resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT', label);
  }
});

test('T508.7 aliases are explicit data, not derived: the registry ids are stable strings in the catalog', () => {
  const g = catalog.gyms[GYM];
  assert.ok(Array.isArray(g.equipment) && g.equipment.every(e => /^sf-sd-/.test(e.equipmentId) && Array.isArray(e.aliases)));
  assert.equal(new Set(g.equipment.map(e => e.equipmentId)).size, g.equipment.length);
  assert.deepEqual(Object.keys(idx.ambiguous), [], 'no alias maps to two ids');
});
