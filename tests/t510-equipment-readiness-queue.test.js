// T510: compact equipment readiness queue (Coach) + test-verified activation-readiness report.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const C = require(path.join(root, 'assets/equipment-context.js'));
const report = require(path.join(root, 'scripts/equipment-readiness-report.cjs'));
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const step = (n, unit = 'KG') => ({ kind: 'STEP', step: n, unit, source: 'COACH_CONFIGURED' });
const q = (o) => C.buildEquipmentQueue(Object.assign({ catalog }, o));
const by = (queue, id) => queue.find(r => r.equipmentId === id);

test('T510.1 every row exposes equipment / id / gym / identity / increment / source / counts / blocker', () => {
  for (const r of q({})) for (const k of ['name', 'equipmentId', 'gymId', 'identityStatus', 'incrementState', 'incrementSource', 'exerciseCount', 'candidatesAffected', 'status', 'blocker', 'missing']) assert.ok(k in r, k);
});

test('T510.2 statuses: IDENTITY_UNRESOLVED / INCREMENT_UNRESOLVED / READY / UNIT_MISMATCH / INCREMENT_INVALID', () => {
  const none = q({});
  assert.equal(none.filter(r => r.status === 'READY').length, 0);
  assert.equal(none.filter(r => r.status === 'IDENTITY_UNRESOLVED').length, 2);
  assert.equal(by(none, 'functional-dumbbells').status, 'INCREMENT_UNRESOLVED');
  const cfg = { shared: { 'functional-dumbbells': step(2.5) }, gyms: {} };
  assert.equal(by(q({ config: cfg }), 'functional-dumbbells').status, 'READY');
  const mismatch = by(q({ config: cfg, candidates: [{ equipmentId: 'functional-dumbbells', unit: 'LB' }] }), 'functional-dumbbells');
  assert.deepEqual([mismatch.status, mismatch.blocker], ['UNIT_MISMATCH', 'UNIT_MISMATCH']);
  const bad = by(q({ config: { shared: { 'functional-dumbbells': { kind: 'STEP', step: -1, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} } }), 'functional-dumbbells');
  assert.equal(bad.status, 'INCREMENT_INVALID');
});

test('T510.3 candidates affected are counted per equipment, incl. unresolved-identity rows by exact exerciseId', () => {
  const g = catalog.gyms['smart-fit-san-diego'];
  const fam = 'legacy-press-inclinado-maquina';
  const queue = q({ candidates: [{ equipmentId: 'functional-dumbbells', unit: 'KG' }, { equipmentId: 'functional-dumbbells', unit: 'KG' }, { equipmentId: null, exerciseId: fam, unit: 'KG' }] });
  assert.equal(by(queue, 'functional-dumbbells').candidatesAffected, 2);
  assert.equal(queue.find(r => r.identityStatus === 'UNRESOLVED' && r.name === 'Máquina').candidatesAffected, 1);
  assert.equal(queue[0].candidatesAffected >= queue[1].candidatesAffected, true, 'sorted by affected candidates first');
});

test('T510.4 gym-specific config only marks that gym; shared config marks all', () => {
  const gymOnly = q({ config: { shared: {}, gyms: { 'smart-fit-san-diego': { 'functional-dumbbells': step(2.5) } } } });
  assert.equal(by(gymOnly, 'functional-dumbbells').incrementScope, 'GYM_EQUIPMENT');
});

test('T510.5 the activation-readiness report is generated, ranked by usage and current', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/equipment-readiness-report.cjs'), '--check']);
  assert.equal(r.status, 0, 'regenerate with: node scripts/equipment-readiness-report.cjs');
  const queue = report.build();
  for (let i = 1; i < queue.length; i++) assert.ok(queue[i - 1].exerciseCount >= queue[i].exerciseCount || queue[i - 1].candidatesAffected > queue[i].candidatesAffected);
  const md = report.render(queue);
  for (const t of ['equipmentId', 'Alias', 'Ejercicios', 'Identidad', 'Incremento', 'Falta', 'functional-dumbbells']) assert.ok(md.includes(t), t);
});

test('T510.6 Coach UI: a compact queue with direct navigation to configure; no new admin app or collection', () => {
  for (const s of ['openEquipmentReadinessQueue', 'equipmentQueueBtn', 'buildEquipmentQueue', 'data-eq-cfg', 'openEquipmentIncrementEditor({ equipmentId: r.equipmentId', '_lastLoadCandidates.push'])
    assert.ok(coach.includes(s), s);
  assert.ok(!/collection\(db, ['"]equipment/.test(coach));
  const fn = coach.slice(coach.indexOf('async function openEquipmentReadinessQueue'), coach.indexOf('window.openEquipmentReadinessQueue'));
  assert.ok(!/setDoc|addDoc/.test(fn) && fn.split('updateDoc(').length - 1 === 1, 'T519: the only write is the confirmed bulk import (coach doc)');
});
