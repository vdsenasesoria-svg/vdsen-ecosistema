'use strict';
// T591: Coach audit fixes. The import path is exercised through the REAL Coach functions (vm); wiring is checked as static contracts and, separately, in the real browser
// against emulators (docs/T591_COACH_AUDIT.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { jsonTabImport, coachSandbox } = require('./helpers/coach-plan-import.js');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function fnSrc(name) {
  let i = coach.indexOf('async function ' + name + '('); if (i < 0) i = coach.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = coach.indexOf('{', i); k < coach.length; k++) {
    const c = coach[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && coach[k + 1] === '/') { k = coach.indexOf('\n', k); continue; }
    if (c === '/' && coach[k + 1] === '*') { k = coach.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return coach.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const S = (n, r, rir) => Array.from({ length: n }, (_, i) => ({ setIndex: i, repsTarget: r, rirTarget: rir, load: 0, restSeconds: 90 }));
const mixed = () => ({ schema: 'vdsen-plan-v2', entrenamiento: { weeks: 4, daysPerWeek: 2, days: [
  { dayIndex: 0, label: 'Día 1', exercises: [
    { exerciseName: 'Press banca', sets: S(3, 8, 2), muscleGroup: 'pectoral', coachNote: 'Pausa 1s', repsRange: { min: 6, max: 10 } },
    { exerciseName: 'Cinta zona 2', exerciseType: 'cardio', duracionMin: 30, modo: 'z2' },
    { exerciseName: 'Bici', tipo: 'cardio', duracionMin: 20 },
    { exerciseName: 'Remo cardio', exerciseType: 'fuerza', sets: S(3, 12, 2) },
    { exerciseName: 'Cinta de correr suave', sets: S(1, 30, 2) },
    { exerciseName: 'Cinta con series', exerciseType: 'cardio', duracionMin: 15, sets: S(3, 10, 2) }] },
  { dayIndex: 1, label: 'Día 2 solo cardio', exercises: [{ exerciseName: 'Caminata', exerciseType: 'cardio', duracionMin: 45 }] }] } });

test('T591-1 mixed import keeps the meaning of every exercise: cardio stays cardio (no strength sets), declared strength stays strength, a name that merely sounds like cardio stays strength', () => {
  const r = jsonTabImport(mixed()); assert.ok(r.plan, 'imported');
  const ex = (n) => r.plan.days.flatMap((d) => d.exercises).find((e) => e.exerciseName === n);
  assert.equal(ex('Cinta zona 2').exerciseType, 'cardio'); assert.equal(ex('Cinta zona 2').sets.length, 0); assert.equal(ex('Cinta zona 2').duracionMin, 30);
  assert.equal(ex('Bici').tipo, 'cardio'); assert.equal(ex('Bici').sets.length, 0);
  assert.equal(ex('Remo cardio').exerciseType, 'fuerza', 'an explicit strength declaration is preserved'); assert.equal(ex('Remo cardio').sets.length, 3);
  assert.equal(ex('Cinta de correr suave').exerciseType, undefined, 'no inference from a partial / word match of the name'); assert.equal(ex('Cinta de correr suave').sets.length, 1);
  assert.equal(ex('Press banca').sets.length, 3); assert.equal(ex('Press banca').muscleGroup, 'pectoral'); assert.deepEqual(ex('Press banca').repsRange, { min: 6, max: 10 });
  assert.equal(r.plan.days[1].exercises.length, 1, 'a cardio-only day is kept');
  for (const e of r.plan.days.flatMap((d) => d.exercises).filter((e) => e.exerciseType === 'cardio' || e.tipo === 'cardio')) for (const k of ['load', 'rirTarget', 'repsTarget', 'restSeconds']) assert.ok(!(k in e), 'no ' + k + ' invented for cardio');
});

test('T591-2 nothing is dropped or altered silently: unknown types, strength without sets, nameless entries and ignored cardio sets are reported', () => {
  const plan = mixed(); const d0 = plan.entrenamiento.days[0].exercises;
  d0.push({ exerciseName: 'Trote', exerciseType: 'aerobic', duracionMin: 25 }, { exerciseName: 'Sentadilla' }, { exerciseName: 'Curl', series: 3, reps: '10-12' }, { exerciseName: '', sets: S(3, 8, 2) });
  const r = jsonTabImport(plan); const w = r.warnings.join('\n');
  assert.match(w, /Trote: NO se importó — tipo "aerobic" no reconocido/); assert.match(w, /Sentadilla: NO se importó — ejercicio de fuerza sin series/); assert.match(w, /Curl: NO se importó/);
  assert.match(w, /\(sin nombre\): NO se importó — falta el nombre/); assert.match(w, /Cinta con series: es cardio; sus 3 serie\(s\) de fuerza se ignoraron/);
  assert.equal(r.warnings.length, 5, 'exactly the five problems, nothing else');
  assert.equal(jsonTabImport(mixed()).warnings.length, 1, 'a clean plan only reports the cardio sets that were ignored');
  const only = jsonTabImport({ days: [{ label: 'd', exercises: [{ exerciseName: 'Trote', exerciseType: 'aerobic' }] }] });
  assert.equal(only.plan, null); assert.match(only.statusHtml, /Ningún día con ejercicios válidos[^<]*:<br>Trote: NO se importó/, 'when everything is lost the reason is on screen');
});

test('T591-3 the preview describes cardio as cardio (duration), never as "0 series × reps", and shows the warnings box', () => {
  const sb = coachSandbox('pv', { _escH: (x) => String(x), validateTrainingPlan: () => [], renderVolumePanel: () => '', _setsRepsLabel: () => '8', document: { getElementById: () => ctx.el }, saveImportedPlan() {} });
  const ctx = sb; ctx.el = { innerHTML: '' };
  vm.runInContext(fnSrc('showParsedPreview') + '\nthis.showParsedPreview = showParsedPreview;', ctx);
  const plan = JSON.parse(JSON.stringify(jsonTabImport(mixed()).plan)); ctx.showParsedPreview(plan, ['Trote: NO se importó — x']);
  const html = ctx.el.innerHTML;
  assert.match(html, /Cinta zona 2 — <strong>CARDIO<\/strong> · 30 min/); assert.match(html, /Bici — <strong>CARDIO<\/strong> · 20 min/); assert.ok(!/Cinta zona 2[^<]*serie\(s\)/.test(html), 'no series wording on a cardio line');
  assert.match(html, /1 aviso\(s\) de importación/); assert.match(html, /Press banca[^<]*3 serie\(s\)/);
});

test('T591-4 a repeated import-save and a repeated editor-save after the editor closed are guarded; the assignment keeps its ownership check', () => {
  const save = fnSrc('saveImportedPlan');
  assert.match(save, /if \(_savingImportedPlan\) return false;/); assert.match(save, /prevClientSnap\.data\(\)\.coachId !== currentCoach\.uid/, 'ownership check kept');
  assert.match(fnSrc('saveTrainingPlan').split('\n').slice(0, 5).join('\n'), /dayblock_[^\n]*\n?[^\n]*return;|querySelector\('\[id\^="dayblock_"\]'\)\)\s*return;/);
});

test('T591-5 a cardio exercise declared in a plan is catalogued as Cardio (explicit plan type -> catalog); undeclared ones are not', async () => {
  const added = [];
  const ctx = coachSandbox('cat', { currentCoach: { uid: 'c1' }, _allExercises: [], addDoc: async (_c, d) => { added.push(d); }, collection: () => 'exercises', db: {}, loadExerciseCatalog: async () => {}, showToast() {} });
  vm.runInContext(fnSrc('_autoAddExercisesToCatalog') + '\nthis._autoAddExercisesToCatalog = _autoAddExercisesToCatalog;', ctx);
  await ctx._autoAddExercisesToCatalog([{ exercises: [{ exerciseName: 'Cinta zona 2', exerciseType: 'cardio' }, { exerciseName: 'Bici', tipo: 'cardio' }, { exerciseName: 'Press banca', sets: [{}] }, { exerciseName: 'Remo cardio', exerciseType: 'fuerza', sets: [{}] }] }]);
  const by = Object.fromEntries(added.map((d) => [d.name, d.motorPattern]));
  assert.deepEqual(by, { 'Cinta zona 2': 'Cardio', 'Bici': 'Cardio', 'Press banca': '', 'Remo cardio': '' });
});

test('T591-6 the outgoing plan IS backed up even when the client has no nutrition / supplements (Firestore rejects undefined: it used to throw and the backup was silently skipped)', async () => {
  const written = [];
  const store = { 'clients/c1': { activePlanId: 'p1' }, 'plans/p1': { coachId: 'coach', clientId: 'c1', days: [{ exercises: [] }] } };
  const snap = (p) => ({ exists: () => !!store[p], data: () => store[p] });
  const ctx = coachSandbox('bk', { currentCoach: { uid: 'coach' }, db: {}, doc: (_db, c, id) => c + '/' + id, collection: (_db, c) => c, getDoc: async (p) => { if (p.startsWith('plans_backup/')) { if (store[p]) return snap(p); throw new Error('permission-denied'); } return snap(p); },
    setDoc: async (p, d) => { for (const [k, v] of Object.entries(d)) if (v === undefined) throw new Error('Unsupported field value: undefined (' + k + ')'); store[p] = d; written.push({ c: p, d }); } });
  vm.runInContext(fnSrc('backupPlanIfExists') + '\nthis.backupPlanIfExists = backupPlanIfExists;', ctx);
  assert.equal(await ctx.backupPlanIfExists('c1'), 'p1__replaced', 'backup written with a deterministic id'); assert.equal(written.length, 1);
  assert.equal(await ctx.backupPlanIfExists('c1'), 'p1__replaced', 'a retry returns the same backup'); assert.equal(written.length, 1, 'and never writes a second one');
  assert.equal(written[0].d.originalPlanId, 'p1'); assert.deepEqual(written[0].d.days, [{ exercises: [] }]); assert.ok(!('nutritionDisplay' in written[0].d), 'absent values are omitted, not undefined');
});
