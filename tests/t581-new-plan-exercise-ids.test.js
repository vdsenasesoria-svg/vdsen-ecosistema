'use strict';
// T581: NEW plans arrive with the canonical catalog exerciseId whenever it is verifiable, so the autonomous LOAD path does not depend on manual links.
// Authority order (implemented in the Coach, the plan-import authority): (1) a KNOWN catalog id already carried by the source, (2) EXACT normalized name/alias that
// maps to exactly ONE catalog exerciseId, (3) nothing (ambiguous / unknown / similar names stay unresolved). prescriptionExerciseId is never derived from it;
// the export keeps its T552 contract. The equipment modules (T516.2) stay name-free: this logic lives in vdsen-coach.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const catalog = require('../assets/exercise-visual-catalog.js');
const identity = require('../assets/equipment-identity.js');
const { coachSandbox } = require('./helpers/coach-plan-import.js');

const J = (o) => JSON.parse(JSON.stringify(o));
const synthetic = (entries) => ({ gyms: { g1: { gymId: 'g1', entries: entries.map((e) => Object.assign({ exerciseName: e.name }, e)), legacyEntries: [] } } });
const carry = (ex, o) => { o = o || {}; const extra = { window: { VDSEN_EQUIPMENT_IDENTITY: o.noModules ? undefined : identity, VDSEN_EXERCISE_VISUAL_CATALOG: o.noModules ? undefined : (o.catalog || catalog) } }; if (o.allExercises) extra._allExercises = o.allExercises; return J(coachSandbox('t', extra)._carryExerciseIdentity(ex)); };

test('T581-ID1 exact catalog name and explicit alias resolve to the catalog exerciseId; case / accents / spacing are normalized, nothing else', () => {
  assert.deepEqual(carry({ exerciseName: 'Belt Squat' }), { exerciseId: 'sf-sd-belt-squat', exerciseIdSource: 'CATALOG_EXACT_NAME' });
  assert.equal(carry({ exerciseName: '  belt   SQUAT ' }).exerciseId, 'sf-sd-belt-squat');
  assert.equal(carry({ exerciseName: 'Sentadilla Perfecta' }).exerciseId, 'sf-sd-pendulum-squat', 'an explicit catalog alias is exact data, not a guess');
});

test('T581-ID2 similar / partial / reordered names are NOT resolved (no similarity matching)', () => {
  for (const name of ['Belt Squats', 'Squat Belt', 'Belt', 'Sentadilla belt squat máquina', 'Press Convergente Inclinado', '', null, undefined, 42]) assert.deepEqual(carry({ exerciseName: name }), {}, String(name));
  assert.deepEqual(carry(null), {}); assert.deepEqual(carry('x'), {});
});

test('T581-ID3 a name shared by two DIFFERENT catalog ids is AMBIGUOUS: no id is chosen; the same id repeated across gyms is not ambiguous', () => {
  const amb = synthetic([{ exerciseId: 'a-1', name: 'Press Pecho', aliases: ['Press'] }, { exerciseId: 'b-2', name: 'Press Plano', aliases: ['press pecho'] }]);
  assert.deepEqual(carry({ exerciseName: 'press pecho' }, { catalog: amb }), {});
  const dup = { gyms: { g1: { entries: [{ exerciseId: 'a-1', exerciseName: 'Remo' }] }, g2: { entries: [{ exerciseId: 'a-1', exerciseName: 'Remo' }] } } };
  assert.equal(carry({ exerciseName: 'remo' }, { catalog: dup }).exerciseId, 'a-1');
});

test('T581-ID4 a KNOWN source id wins; an UNKNOWN source id is dropped (not trusted, not replaced by a name guess); the Coach own catalog docs extend validity', () => {
  assert.deepEqual(carry({ exerciseName: 'cualquier cosa', exerciseId: 'sf-sd-belt-squat' }), { exerciseId: 'sf-sd-belt-squat', exerciseIdSource: 'SOURCE' });
  assert.deepEqual(carry({ exerciseName: 'Belt Squat', exerciseId: 'fabricado' }), {}, 'a bad id is not "fixed" by the name');
  assert.deepEqual(carry({ exerciseName: 'X', exerciseId: 'coach-doc-1' }, { allExercises: [{ id: 'coach-doc-1' }] }), { exerciseId: 'coach-doc-1', exerciseIdSource: 'SOURCE' });
  assert.deepEqual(carry({ exerciseName: 'X', exerciseId: 'coach-doc-1' }), {}, 'without the Coach catalog loaded only the shipped catalog counts');
  assert.equal(carry({ exerciseName: 'Belt Squat', exerciseId: 7 }).exerciseId, 'sf-sd-belt-squat', 'a non-string source id is ignored, not trusted');
});

// ---------- the real Coach import normalizers ----------
const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
const S = [0, 1, 2].map((i) => ({ setIndex: i, repsTarget: 10, rirTarget: 2, load: 0, restSeconds: 90 }));
const plan = (exs) => ({ weeks: 4, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D1', exercises: exs.map((e) => Object.assign({ sets: S }, e)) }] });
const sandbox = (o) => { o = o || {}; const extra = { window: { VDSEN_EQUIPMENT_IDENTITY: o.noModules ? undefined : identity, VDSEN_EXERCISE_VISUAL_CATALOG: o.noModules ? undefined : catalog } }; if (o.allExercises) extra._allExercises = o.allExercises; return coachSandbox('t', extra); };

test('T581-ID5 Coach import: exact catalog name => exerciseId + provenance; unknown / similar => no exerciseId; PID is untouched', () => {
  const c = sandbox();
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
  const c = sandbox({ allExercises: [{ id: 'coach-doc-9', name: 'Mi ejercicio' }] });
  const e = J(c._normalizeTrainingPlan(plan([{ exerciseName: 'Lo que sea', exerciseId: 'sf-sd-belt-squat' }, { exerciseName: 'Mi ejercicio', exerciseId: 'coach-doc-9' }, { exerciseName: 'Belt Squat', exerciseId: 'inventado' }]))).days[0].exercises;
  assert.deepEqual([e[0].exerciseId, e[0].exerciseIdSource], ['sf-sd-belt-squat', 'SOURCE']);
  assert.deepEqual([e[1].exerciseId, e[1].exerciseIdSource], ['coach-doc-9', 'SOURCE']);
  assert.ok(!('exerciseId' in e[2]), 'an invented id is neither trusted nor silently replaced by the name match');
});

test('T581-ID7 Coach import fails closed: without the catalog / identity modules the plan imports exactly as before (no exerciseId, no error)', () => {
  const c = sandbox({ noModules: true });
  const e = J(c._normalizeTrainingPlan(plan([{ exerciseName: 'Belt Squat' }]))).days[0].exercises[0];
  assert.ok(!('exerciseId' in e)); assert.equal(e.exerciseName, 'Belt Squat'); assert.equal(e.sets.length, 3);
});

test('T581-ID8 all three Coach import paths use the same helper, and the export contract (no exerciseId leak) is untouched', () => {
  assert.equal((coach.match(/typeof _carryExerciseIdentity === 'function' \? _carryExerciseIdentity\(ex\)/g) || []).length, 3, 'parsePlanFromJSON + _normalizeTrainingPlan + update-plan modal');
  let i = coach.indexOf('async function exportActivePlanJSON('), d = 0, end = -1;
  for (let k = coach.indexOf('{', i); k < coach.length; k++) { if (coach[k] === '{') d++; else if (coach[k] === '}' && --d === 0) { end = k; break; } }
  const exp = coach.slice(i, end + 1);
  assert.ok(!/ex\.exerciseId|exerciseId\s*:|_carryExerciseIdentity/.test(exp), 'T552.P4: the export does not leak catalog ids (a comment may mention the word)');
});

test('T581-ID9 the equipment / progression modules stay name-free (T516.2): the name resolution lives only in the Coach import', () => {
  for (const f of ['assets/equipment-context.js', 'assets/progression-equipment-resolver.js', 'assets/progression-application-consumer.js']) assert.ok(!/_carryExerciseIdentity|resolveExerciseIdByName|identifyPlanExercise/.test(fs.readFileSync(f, 'utf8')), f);
  assert.ok(!/_carryExerciseIdentity|resolveExerciseIdByName/.test(fs.readFileSync('api/_autonomousProgression.js', 'utf8')), 'the server never resolves identity from a name');
});
