// T509: metadata ownership model. Precedence: exercise override > gym-specific equipment > shared canonical equipment
// > unresolved. Stored additively on the coach doc (coaches/{uid}.equipmentIncrements); no new collection.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const catalog = require(path.join(root, 'assets/exercise-visual-catalog.js'));
const C = require(path.join(root, 'assets/equipment-context.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const GYM = 'smart-fit-san-diego', DB = 'functional-dumbbells';
const step = (n, unit = 'KG') => ({ kind: 'STEP', step: n, unit, source: 'COACH_CONFIGURED' });
const cfg = (shared, gyms) => ({ shared: shared || {}, gyms: gyms || {} });
const press = 'legacy-press-banca-plano-mancuernas'; // Mancuernas

test('T509.1 precedence: exercise override > gym equipment > shared equipment > unresolved', () => {
  const all = cfg({ [DB]: step(5) }, { [GYM]: { [DB]: step(2.5) } });
  assert.deepEqual([C.resolveIncrementMetadata({ exerciseOverride: step(1), gymId: GYM, equipmentId: DB, config: all }).scope, C.resolveIncrementMetadata({ exerciseOverride: step(1), gymId: GYM, equipmentId: DB, config: all }).meta.step], ['EXERCISE', 1]);
  const g = C.resolveIncrementMetadata({ gymId: GYM, equipmentId: DB, config: all });
  assert.deepEqual([g.scope, g.meta.step], ['GYM_EQUIPMENT', 2.5]);
  const s = C.resolveIncrementMetadata({ gymId: 'other-gym', equipmentId: DB, config: all });
  assert.deepEqual([s.scope, s.meta.step], ['SHARED_EQUIPMENT', 5]);
  assert.deepEqual(C.resolveIncrementMetadata({ gymId: GYM, equipmentId: 'functional-trap-bar', config: all }), { meta: null, scope: null, invalidReason: null });
  assert.equal(C.resolveIncrementMetadata({}).meta, null);
});

test('T509.2 the highest PRESENT level wins even when invalid: no silent fall-through to a lower level', () => {
  const r = C.resolveIncrementMetadata({ exerciseOverride: { kind: 'STEP', step: -1, unit: 'KG', source: 'COACH_CONFIGURED' }, gymId: GYM, equipmentId: DB, config: cfg({ [DB]: step(5) }) });
  assert.equal(r.meta, null); assert.equal(r.scope, 'EXERCISE'); assert.ok(r.invalidReason);
});

test('T509.3 one shared configuration serves every exercise that uses the equipment (no per-exercise re-entry)', () => {
  const config = cfg({ [DB]: step(2.5) });
  const a = C.equipmentRefForExercise({ catalog, exerciseId: press, config }), b = C.equipmentRefForExercise({ catalog, exerciseId: 'legacy-goblet-squat', config });
  for (const r of [a, b]) assert.deepEqual([r.equipmentId, r.incrementScope, r.loadIncrement.step, r.identity.status], [DB, 'SHARED_EQUIPMENT', 2.5, 'ALIAS_MATCH']);
});

test('T509.4 an exercise override applies to that exercise only', () => {
  const config = cfg({ [DB]: step(2.5) });
  const over = C.equipmentRefForExercise({ catalog, exerciseId: press, exerciseDoc: { loadIncrement: step(1) }, config });
  const other = C.equipmentRefForExercise({ catalog, exerciseId: 'legacy-goblet-squat', config });
  assert.deepEqual([over.incrementScope, over.loadIncrement.step], ['EXERCISE', 1]); assert.equal(other.loadIncrement.step, 2.5);
});

test('T509.5 unresolved identity: only an exercise override makes it operable (exercise:<id>), never shared/gym config', () => {
  const family = 'sf-sd-impulse-placeholder'; void family;
  const fam = 'legacy-press-inclinado-maquina'; // generic "Máquina": no canonical identity
  const none = C.equipmentRefForExercise({ catalog, exerciseId: fam, config: cfg({ 'Matrix · placas': step(5) }) });
  assert.equal(none.equipmentId, null); assert.equal(none.loadIncrement, null); assert.equal(none.identity.status, 'UNRESOLVED');
  const over = C.equipmentRefForExercise({ catalog, exerciseId: fam, exerciseDoc: { loadIncrement: step(5) } });
  assert.deepEqual([over.equipmentId, over.incrementScope], ['exercise:' + fam, 'EXERCISE']);
});

test('T509.6 identity by exact exerciseId only: an unknown exercise id / a name never resolves equipment', () => {
  const r = C.equipmentRefForExercise({ catalog, exerciseId: 'Press banca plano mancuernas', config: cfg({ [DB]: step(5) }) });
  assert.equal(r.equipmentId, null); assert.equal(r.loadIncrement, null);
});

test('T509.7 setEquipmentIncrement is pure, validated and always COACH_CONFIGURED', () => {
  const base = cfg({ a: step(5) }); const frozen = JSON.stringify(base);
  const shared = C.setEquipmentIncrement(base, { scope: 'SHARED', equipmentId: DB, meta: step(2.5) });
  assert.equal(JSON.stringify(base), frozen, 'input not mutated'); assert.equal(shared.shared[DB].step, 2.5); assert.equal(shared.shared.a.step, 5);
  const gym = C.setEquipmentIncrement(shared, { scope: 'GYM', gymId: GYM, equipmentId: DB, meta: step(1.25) });
  assert.equal(gym.gyms[GYM][DB].step, 1.25);
  const cleared = C.setEquipmentIncrement(gym, { scope: 'GYM', gymId: GYM, equipmentId: DB, meta: null });
  assert.deepEqual(cleared.gyms, {});
  assert.throws(() => C.setEquipmentIncrement(base, { scope: 'SHARED', equipmentId: DB, meta: { kind: 'STEP', step: 5, unit: 'KG', source: 'GYM_METADATA' } }), /inválida/);
  assert.throws(() => C.setEquipmentIncrement(base, { scope: 'SHARED', equipmentId: DB, meta: { kind: 'STEP', step: 0, unit: 'KG', source: 'COACH_CONFIGURED' } }), /inválida/);
  assert.throws(() => C.setEquipmentIncrement(base, { scope: 'GYM', equipmentId: DB, meta: step(5) }), /sede/);
  assert.throws(() => C.setEquipmentIncrement(base, { scope: 'X', equipmentId: DB, meta: step(5) }), /alcance/);
  assert.throws(() => C.setEquipmentIncrement(base, { scope: 'SHARED', equipmentId: '', meta: step(5) }), /equipo/);
});

test('T509.8 normalizeConfig drops malformed branches and deep-copies', () => {
  const raw = { shared: { a: step(5), b: 'x', c: null }, gyms: { g: { d: step(2) }, h: 7 }, extra: 1 };
  const n = C.normalizeConfig(raw);
  assert.deepEqual(Object.keys(n.shared), ['a']); assert.deepEqual(Object.keys(n.gyms), ['g']); assert.notEqual(n.shared.a, raw.shared.a);
  assert.deepEqual(C.normalizeConfig(null), { shared: {}, gyms: {} });
});

test('T509.9 end to end with the resolver: configured shared equipment resolves a load; unconfigured stays unresolved with the right state', () => {
  const ref = C.equipmentRefForExercise({ catalog, exerciseId: press, config: cfg({ [DB]: { kind: 'AVAILABLE_LOADS', loads: [20, 22.5, 25], unit: 'KG', source: 'COACH_CONFIGURED' } }) });
  const ok = resolver.resolveLoad({ currentLoad: 20, desiredLoad: 21, direction: 'UP', unit: 'KG', equipment: ref, roundingMode: 'CEIL' });
  assert.deepEqual([ok.resolutionState, ok.realizableLoad, ok.incrementScope], ['RESOLVED', 22.5, 'SHARED_EQUIPMENT']);
  const unconfigured = C.equipmentRefForExercise({ catalog, exerciseId: press });
  assert.equal(resolver.resolveLoad({ currentLoad: 20, desiredLoad: 21, direction: 'UP', unit: 'KG', equipment: unconfigured }).resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT');
  const noId = C.equipmentRefForExercise({ catalog, exerciseId: 'nope' });
  assert.equal(resolver.resolveLoad({ currentLoad: 20, desiredLoad: 21, direction: 'UP', unit: 'KG', equipment: noId }).resolutionState, 'UNRESOLVED_EQUIPMENT_IDENTITY');
});

test('T509.10 Coach stores config additively on the coach doc (no new collection) and builds refs from the context module', () => {
  const coach = require('node:fs').readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
  for (const s of ['assets/equipment-identity.js', 'assets/equipment-context.js']) assert.equal(coach.split('<script src="' + s + '"></script>').length - 1, 1, s);
  assert.ok(coach.indexOf('assets/equipment-context.js') < coach.indexOf('assets/progression-application-consumer.js'));
  assert.ok(/updateDoc\(doc\(db, 'coaches', currentCoach\.uid\), \{ equipmentIncrements: next \}\)/.test(coach));
  const i = coach.indexOf('async function _equipmentRefForRecord');
  const body = coach.slice(i, coach.indexOf('\n  }\n', i));
  assert.ok(body.includes('equipmentRefForExercise') && body.includes('prescriptionExerciseId') && !/toLowerCase|_normN/.test(body));
  const editor = coach.slice(coach.indexOf('async function openEquipmentIncrementEditor'), coach.indexOf('window.openEquipmentIncrementEditor'));
  assert.ok(editor.includes('setEquipmentIncrement') && editor.includes('normalizeLoadIncrementInput') === false && !/value="\d/.test(editor));
  assert.ok(!/collection\(db, ['"]equipment/.test(coach), 'no new collection');
});
