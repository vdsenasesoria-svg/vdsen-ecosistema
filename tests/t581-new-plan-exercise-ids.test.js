'use strict';
// T581: NEW plans arrive with the canonical catalog exerciseId whenever it is verifiable, so the autonomous LOAD path does not depend on manual links.
// Authority order: (1) a KNOWN catalog id already carried by the source, (2) EXACT normalized name/alias that maps to exactly ONE catalog exerciseId,
// (3) nothing (ambiguous / unknown / similar names stay unresolved). prescriptionExerciseId is never derived from it; export keeps its T552 contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctxMod = require('../assets/equipment-context.js');
const catalog = require('../assets/exercise-visual-catalog.js');
const identity = require('../assets/equipment-identity.js');

const J = (o) => JSON.parse(JSON.stringify(o));
const synthetic = (entries) => ({ gyms: { g1: { gymId: 'g1', entries: entries.map((e) => Object.assign({ exerciseName: e.name }, e)), legacyEntries: [] } } });

test('T581-ID1 exact catalog name and explicit alias resolve to the catalog exerciseId; case / accents / spacing are normalized, nothing else', () => {
  assert.deepEqual(J(ctxMod.resolveExerciseIdByName(catalog, 'Belt Squat')), { status: 'EXACT_NAME', exerciseId: 'sf-sd-belt-squat', matches: ['sf-sd-belt-squat'] });
  assert.equal(ctxMod.resolveExerciseIdByName(catalog, '  belt   SQUAT ').exerciseId, 'sf-sd-belt-squat');
  assert.equal(ctxMod.resolveExerciseIdByName(catalog, 'Sentadilla Perfecta').exerciseId, 'sf-sd-pendulum-squat', 'an explicit catalog alias is exact data, not a guess');
});

test('T581-ID2 similar / partial / reordered names are NOT resolved (no similarity matching)', () => {
  for (const name of ['Belt Squats', 'Squat Belt', 'Belt', 'Sentadilla belt squat máquina', 'Press Convergente Inclinado', '', null, undefined, 42]) {
    const r = ctxMod.resolveExerciseIdByName(catalog, name);
    assert.equal(r.exerciseId, null, String(name)); assert.ok(r.status === 'UNKNOWN' || r.status === 'EXACT_NAME', String(name));
    if (name === 'Belt Squats') assert.equal(r.status, 'UNKNOWN');
  }
});

test('T581-ID3 a name shared by two DIFFERENT catalog ids is AMBIGUOUS: no id is chosen; the same id repeated across gyms is not ambiguous', () => {
  const amb = synthetic([{ exerciseId: 'a-1', name: 'Press Pecho', aliases: ['Press'] }, { exerciseId: 'b-2', name: 'Press Plano', aliases: ['press pecho'] }]);
  const r = ctxMod.resolveExerciseIdByName(amb, 'press pecho');
  assert.equal(r.status, 'AMBIGUOUS'); assert.equal(r.exerciseId, null); assert.deepEqual(r.matches, ['a-1', 'b-2']);
  const dup = { gyms: { g1: { entries: [{ exerciseId: 'a-1', exerciseName: 'Remo' }] }, g2: { entries: [{ exerciseId: 'a-1', exerciseName: 'Remo' }] } } };
  assert.equal(ctxMod.resolveExerciseIdByName(dup, 'remo').status, 'EXACT_NAME');
});

test('T581-ID4 identifyPlanExercise: a KNOWN source id wins; an UNKNOWN source id is dropped (not trusted, not replaced by a name guess); knownIds extends validity', () => {
  assert.deepEqual(J(ctxMod.identifyPlanExercise({ exerciseName: 'cualquier cosa', exerciseId: 'sf-sd-belt-squat' }, { catalog })), { status: 'SOURCE', exerciseId: 'sf-sd-belt-squat' });
  assert.deepEqual(J(ctxMod.identifyPlanExercise({ exerciseName: 'Belt Squat', exerciseId: 'fabricado' }, { catalog })), { status: 'SOURCE_UNKNOWN', exerciseId: null }, 'a bad id is not "fixed" by the name');
  assert.deepEqual(J(ctxMod.identifyPlanExercise({ exerciseName: 'X', exerciseId: 'coach-doc-1' }, { catalog, knownIds: ['coach-doc-1'] })), { status: 'SOURCE', exerciseId: 'coach-doc-1' });
  assert.deepEqual(J(ctxMod.identifyPlanExercise({ exerciseName: 'Belt Squat' }, { catalog })), { status: 'EXACT_NAME', exerciseId: 'sf-sd-belt-squat' });
  assert.equal(ctxMod.identifyPlanExercise({ exerciseName: 'Belt Squat', exerciseId: 7 }, { catalog }).exerciseId, 'sf-sd-belt-squat', 'a non-string source id is ignored, not trusted');
  assert.equal(ctxMod.identifyPlanExercise(null, { catalog }).exerciseId, null);
});

// ---------- the real Coach import normalizers ----------
const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
function fnSrc(src, name) {
  let i = src.indexOf('async function ' + name + '('); if (i < 0) i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const consts = () => (coach.match(/const _PERF_[A-Z_]+\b[\s\S]*?;\n/g) || []).join('\n') + '\n' + (coach.match(/const _NIVEL_MEDIO_ENUM\b[\s\S]*?;\n/g) || []).join('\n');
function load(opts) {
  opts = opts || {};
  const win = { VDSEN_EQUIPMENT_CONTEXT: opts.noModules ? undefined : ctxMod, VDSEN_EXERCISE_VISUAL_CATALOG: opts.noModules ? undefined : catalog };
  const c = { console, JSON, Object, Array, String, Number, Math, parseInt, parseFloat, isNaN, Date, window: win, crypto: { randomUUID: (() => { let n = 0; return () => 'gen-' + (++n); })() } };
  if (opts.allExercises) c._allExercises = opts.allExercises;
  vm.createContext(c);
  const helpers = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk', '_perfCarryEx', '_perfCarrySet', '_genPrescriptionId', '_stampPrescriptionIds', '_normRestSeconds',
    '_carryPrescriptionId', '_normNivelMedio', '_normVariacionVertical', '_carryClassification', '_carryExerciseIdentity'].map((n) => fnSrc(coach, n)).join('\n');
  vm.runInContext(consts() + '\n' + helpers + '\n' + fnSrc(coach, '_normalizeTrainingPlan') + '\nthis._normalizeTrainingPlan = _normalizeTrainingPlan; this._stampPrescriptionIds = _stampPrescriptionIds;', c);
  return c;
}
const S = [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90 }));
const plan = (exs) => ({ weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D1', exercises: exs.map((e) => Object.assign({ sets: S }, e)) }] });

test('T581-ID5 Coach import: exact catalog name => exerciseId + provenance; unknown / similar / ambiguous => no exerciseId; PID is untouched', () => {
  const c = load();
  const out = J(c._normalizeTrainingPlan(plan([{ exerciseName: 'Belt Squat', prescriptionExerciseId: 'pid-1' }, { exerciseName: 'Sentadilla Perfecta' }, { exerciseName: 'Press Convergente Inclinado' }, { exerciseName: 'Belt Squats' }])));
  const e = out.days[0].exercises;
  assert.equal(e[0].exerciseId, 'sf-sd-belt-squat'); assert.equal(e[0].exerciseIdSource, 'CATALOG_EXACT_NAME'); assert.equal(e[0].prescriptionExerciseId, 'pid-1', 'PID carried byte for byte');
  assert.equal(e[1].exerciseId, 'sf-sd-pendulum-squat'); assert.ok(!('prescriptionExerciseId' in e[1]), 'no PID is minted or derived from the exerciseId');
  assert.ok(!('exerciseId' in e[2]) && !('exerciseIdSource' in e[2]), 'unknown name: nothing written');
  assert.ok(!('exerciseId' in e[3]), 'near-miss name: nothing written');
  const saved = c._stampPrescriptionIds(out.days);
  assert.ok(saved[0].exercises.every((x) => x.prescriptionExerciseId !== x.exerciseId), 'exerciseId is never used as the PID');
});

test('T581-ID6 Coach import: a source exerciseId is kept only when KNOWN (catalog or the Coach own catalog docs); an invented one is dropped', () => {
  const c = load({ allExercises: [{ id: 'coach-doc-9', name: 'Mi ejercicio' }] });
  const e = J(c._normalizeTrainingPlan(plan([{ exerciseName: 'Lo que sea', exerciseId: 'sf-sd-belt-squat' }, { exerciseName: 'Mi ejercicio', exerciseId: 'coach-doc-9' }, { exerciseName: 'Belt Squat', exerciseId: 'inventado' }]))).days[0].exercises;
  assert.deepEqual([e[0].exerciseId, e[0].exerciseIdSource], ['sf-sd-belt-squat', 'SOURCE']);
  assert.deepEqual([e[1].exerciseId, e[1].exerciseIdSource], ['coach-doc-9', 'SOURCE']);
  assert.ok(!('exerciseId' in e[2]), 'an invented id is neither trusted nor silently replaced by the name match');
});

test('T581-ID7 Coach import fails closed: without the equipment modules the plan imports exactly as before (no exerciseId, no error)', () => {
  const c = load({ noModules: true });
  const e = J(c._normalizeTrainingPlan(plan([{ exerciseName: 'Belt Squat' }]))).days[0].exercises[0];
  assert.ok(!('exerciseId' in e)); assert.equal(e.exerciseName, 'Belt Squat'); assert.equal(e.sets.length, 3);
});

test('T581-ID8 all three Coach import paths use the same helper, and the export contract (no exerciseId leak) is untouched', () => {
  assert.equal((coach.match(/typeof _carryExerciseIdentity === 'function' \? _carryExerciseIdentity\(ex\)/g) || []).length, 3, 'parsePlanFromJSON + _normalizeTrainingPlan + update-plan modal');
  const exp = fnSrc(coach, 'exportActivePlanJSON');
  assert.ok(!/exerciseId|_carryExerciseIdentity/.test(exp), 'T552.P4: the export does not leak catalog ids');
});

test('T581-ID9 the normalization used for matching is the equipment-identity one (single source of truth)', () => {
  assert.equal(identity.normalizeLabel('  Belt   Squat '), identity.normalizeLabel('belt squat'));
  assert.ok(ctxMod.resolveExerciseIdByName(catalog, 'BELT SQUAT').exerciseId);
});
