'use strict';
// T589: cardio is logged separately from strength (duration + ONE of RPE / quality; no sets, reps, load, RIR or rest), is excluded from the strength
// statistics and progression, shows in the final recap, and travels in the Expediente TXT. Helpers are extracted from the real HTML and run in a vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name + ' exists');
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
function sandbox(names, extra) {
  const ctx = Object.assign({ _exCatIdx: { src: null, at: 0, map: {} }, console, Date, Math, parseInt, parseFloat, isFinite, isNaN, String, Number, Array, Object, JSON }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(names.map((n) => fnSrc(html, n)).join('\n') + '\nthis.__x={' + names.map((n) => n + ':' + n).join(',') + '};', ctx);
  return ctx.__x;
}
const J = (o) => JSON.parse(JSON.stringify(o));

test('T589-1 classification: explicit type wins; the Coach catalog pattern Cardio (exact id / exact name) classifies; fuzzy or word-based guesses never do', () => {
  const CAT = { 'cinta de correr': { motorPattern: 'Cardio' }, 'press banca': { motorPattern: 'Empuje' }, 'remo': { motorPattern: 'Tirón' } };
  const BY_ID = { x1: { motorPattern: 'Cardio' } };
  const R = sandbox(['_getExType', '_exNormKey', '_exHasCardioPattern', '_exCatPatternIndex'], { EXERCISE_CATALOG: CAT, EXERCISE_CATALOG_BY_ID: BY_ID });
  assert.equal(R._getExType({ exerciseType: 'cardio' }), 'cardio');
  assert.equal(R._getExType({ tipo: 'cardio' }), 'cardio');
  assert.equal(R._getExType({ exerciseName: 'Press banca' }), 'fuerza');
  assert.equal(R._getExType({ exerciseName: 'Cinta de correr' }), 'cardio', 'exact catalog name with motorPattern Cardio');
  assert.equal(R._getExType({ nombre: 'CINTA DE CORRER' }), 'cardio', 'case / accents do not matter');
  assert.equal(R._getExType({ exerciseName: 'x', exerciseId: 'x1' }), 'cardio', 'exact catalog id');
  assert.equal(R._getExType({ exerciseName: 'Cinta de correr', exerciseType: 'fuerza' }), 'fuerza', 'a declared type always wins over the catalog');
  assert.equal(R._getExType({ exerciseName: 'Correr en cinta suave' }), 'fuerza', 'no fuzzy / substring match: a name that merely contains cardio-like words is strength');
  assert.equal(R._getExType({ exerciseName: 'Cardio de hombros' }), 'fuerza', 'never inferred from the words of the name');
  assert.equal(R._getExType({ exerciseName: 'Remo' }), 'fuerza');
  assert.equal(R._getExType({ motorPattern: 'Cardio', exerciseName: 'Lo que sea' }), 'cardio', 'the exercise carries its own pattern');
  assert.equal(R._getExType(null), 'fuerza');
  assert.equal(R._getExType({ exerciseType: 'circuito' }), 'circuito', 'other performance types unchanged');
});

test('T589-2 the cardio entry: real duration is required and exactly one of RPE / quality (1-10); nothing about sets / reps / load / RIR / rest', () => {
  const R = sandbox(['_cardioEntry']);
  assert.ok(R._cardioEntry({ dur: '', metric: 'rpe', eff: '6' }).error, 'duration missing');
  assert.ok(R._cardioEntry({ dur: '0', metric: 'rpe', eff: '6' }).error, 'duration 0');
  assert.ok(R._cardioEntry({ dur: '30', metric: 'rpe', eff: '' }).error, 'effort missing');
  assert.ok(R._cardioEntry({ dur: '30', metric: 'rpe', eff: '11' }).error, 'effort > 10');
  assert.ok(R._cardioEntry({ dur: '30', metric: 'calidad', eff: '0' }).error, 'effort < 1');
  const a = J(R._cardioEntry({ dur: '32.5', metric: 'rpe', eff: '7' }).value);
  assert.deepEqual(a, { duracionMin: 32.5, metrica: 'rpe', rpe: 7 }, 'RPE chosen: no quality is stored');
  const b = J(R._cardioEntry({ dur: '45', metric: 'calidad', eff: '8' }).value);
  assert.deepEqual(b, { duracionMin: 45, metrica: 'calidad', calidad: 8 }, 'quality chosen: no RPE is stored');
  for (const v of [a, b]) for (const k of ['carga', 'reps', 'rir', 'rir_real', 'restSeconds', 'ics', 'pump', 'sets']) assert.ok(!(k in v), k + ' is never part of a cardio entry');
});

test('T589-3 the cardio card asks for duration and one effort measure, and never for series / reps / load / RIR / rest', () => {
  const card = fnSrc(html, '_buildCardioCard');
  assert.match(card, /DURACIÓN REAL \(min\)/); assert.match(card, /RPE/); assert.match(card, /CALIDAD/); assert.match(card, /setCardioMetric/);
  assert.ok(!/rir|carga|descanso|restSeconds/i.test(card.slice(card.indexOf('var inputsHtml'))), 'no strength INPUT in the cardio log form (the interval work/rest blocks above are Coach prescription, not inputs)');
  const done = fnSrc(html, 'completeCardio');
  assert.match(done, /_cardioEntry/); assert.match(done, /exType:'cardio'/);
  assert.match(fnSrc(html, '_buildExCard'), /if \(_ejType === 'cardio'\)\s+return _buildCardioCard/);
});

test('T589-4 a cardio-only session completes (done marker needs no sets) and a cardio exercise is complete with its single log', () => {
  const R = sandbox(['_isExerciseFullyDone', '_getExType', '_exHasCardioPattern', '_exNormKey', 'getEffectiveSets'].filter((n) => html.includes('function ' + n + '(')), {
    LOGS: { log_1_0_0: { exType: 'cardio', done: true, duracionMin: 30, rpe: 6 } }, CURRENT_WEEK: 1, EXERCISE_CATALOG: {}, EXERCISE_CATALOG_BY_ID: {}, getTotalWeeks: () => 4 });
  assert.equal(R._isExerciseFullyDone(0, 0, { exerciseType: 'cardio', nombre: 'Cinta' }), true);
  assert.equal(R._isExerciseFullyDone(0, 1, { exerciseType: 'cardio', nombre: 'Bici' }), false, 'not logged yet');
  const mark = fnSrc(html, 'markSessionDone');
  assert.ok(!/numSeries|_isExerciseFullyDone|[.]sets/.test(mark), 'finishing a session is not gated by sets');
});

test('T589-5 recap: cardio row = real duration + the chosen effort measure; it is never a set; mixed and cardio-only sessions', () => {
  const names = ['_recapNum', '_recapFmtNum', '_recapJoin', '_recapRestFmt', '_recapDate', '_recapCardioRow', '_recapBuild', '_recapRowHtml'];
  const R = sandbox(names, { _escHTml: (s) => String(s) });
  const only = J(R._recapBuild({ sessionName: 'Cardio', exercises: [{ name: 'Cinta', sets: [], cardio: { exType: 'cardio', done: true, duracionMin: 32.5, metrica: 'rpe', rpe: 7 } }] }));
  assert.equal(only.rows.length, 1); assert.equal(only.totals.sets, 0); assert.equal(only.totals.cardio, 1);
  assert.equal(only.rows[0].cardioText, '32,5 min'); assert.equal(only.rows[0].effortText, 'RPE 7/10');
  const q = J(R._recapBuild({ exercises: [{ name: 'Bici', sets: [], cardio: { duracionMin: 45, metrica: 'calidad', calidad: 8 } }] }));
  assert.equal(q.rows[0].effortText, 'Calidad 8/10');
  const mix = J(R._recapBuild({ exercises: [{ name: 'Press', sets: [{ done: true, reps: '10', carga: '100', unit: 'KG', rir_real: 2, ics: 8 }, { done: true, reps: '10', carga: '100', unit: 'KG' }] }, { name: 'Cinta', sets: [], cardio: { duracionMin: 20, metrica: 'rpe', rpe: 5 } }] }));
  assert.equal(mix.totals.sets, 2, 'cardio never inflates the strength set count'); assert.equal(mix.totals.cardio, 1); assert.equal(mix.rows.length, 2);
  assert.equal(mix.rows[1].sets, 0); assert.equal(mix.rows[1].repsText, ''); assert.equal(mix.rows[1].loadText, '');
  const none = J(R._recapBuild({ exercises: [{ name: 'Cinta', sets: [], cardio: { duracionMin: null } }] }));
  assert.equal(none.rows.length, 0, 'a cardio entry with no data is not listed');
  const h = R._recapRowHtml(only.rows[0]); assert.match(h, /32,5 min/); assert.match(h, /RPE 7\/10/); assert.ok(!/serie/.test(h), 'no "series" wording on a cardio row');
});

test('T589-6 recap collection: the single cardio log is read; legacy set-shaped records of a cardio exercise are preserved in LOGS but not shown as strength sets', () => {
  const LOGS = { log_2_0_0: { exType: 'cardio', done: true, duracionMin: 30, metrica: 'rpe', rpe: 6, ts: 5000 }, log_2_0_1_s0: { done: true, reps: '10', carga: '50', unit: 'KG', ts: 6000 },
    log_2_0_2_s0: { done: true, reps: '30', carga: '0', ts: 7000 }, postsession_2_0: { ts: 9000 } };
  const ses = [{ dia: 'DÍA 1 — Mixto', exercises: [{ nombre: 'Cinta', exerciseType: 'cardio' }, { nombre: 'Press', sets: [{}] }, { nombre: 'Bici vieja', exerciseType: 'cardio', sets: [{}] }] }];
  const R = sandbox(['_getExType', '_exNormKey', '_exHasCardioPattern', '_exCatPatternIndex', '_recapCollect'], { LOGS, EXERCISE_CATALOG: {}, EXERCISE_CATALOG_BY_ID: {}, getSesiones: () => ses, isTechniqueActive: () => true, _stripDayNo: (x) => x });
  const d = J(R._recapCollect(0, 2));
  assert.equal(d.exercises[0].cardio.duracionMin, 30); assert.deepEqual(d.exercises[0].sets, []);
  assert.equal(d.exercises.length, 2, 'a cardio exercise with no single cardio log (only legacy set-shaped records) is not listed');
  assert.equal(d.exercises[1].sets.length, 1);
  assert.ok(!d.exercises.some((x) => x.name === 'Bici vieja'), 'minutes saved as reps by an older version are not presented as strength sets');
  assert.ok(LOGS.log_2_0_2_s0.done === true && LOGS.log_2_0_2_s0.reps === '30', 'historical record untouched');
});

test('T589-7 progression and weekly statistics exclude cardio (source contracts) and the shadow never materializes a candidate for a declared-cardio PID', () => {
  assert.match(fnSrc(html, 'calculateProgression'), /if \(_getExType\(ej\) === 'cardio'\) return null;/);
  assert.match(fnSrc(html, '_buildWeekPerfSummary'), /_isCardioLogKey\(k\)\) return;/);
  const R = sandbox(['_isCardioLogKey', '_getExType', '_exNormKey', '_exHasCardioPattern', '_exCatPatternIndex'], { EXERCISE_CATALOG: {}, EXERCISE_CATALOG_BY_ID: {}, getSesiones: () => [{ exercises: [{ nombre: 'Cinta', exerciseType: 'cardio' }, { nombre: 'Press' }] }] });
  assert.equal(R._isCardioLogKey('log_1_0_0_s0'), true); assert.equal(R._isCardioLogKey('log_1_0_1_s0'), false); assert.equal(R._isCardioLogKey('log_1_0_0'), true);
  const shadow = require('../assets/progression-auto-apply-shadow.js');
  const plan = { days: [{ exercises: [{ prescriptionExerciseId: 'c1', exerciseType: 'cardio' }, { prescriptionExerciseId: 's1' }] }] };
  const out = shadow.materializeRecords({ clientId: 'u', planId: 'p', activePlanId: 'p', plan, interventions: null, entries: { progrec_1_0: { calculatedAt: '2026-10-01T00:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'c1', action: 'increase_load' }] } }, records: {}, overlays: {}, structural: true, at: '2026-10-02T00:00:00.000Z' });
  assert.deepEqual(out.created, [], 'no progression record for a cardio PID');
});

test('T589-8 Coach: a type selector (FUERZA / CARDIO) per exercise; cardio saves exerciseType + duration and NO sets; an import honours the catalog Cardio pattern', () => {
  assert.match(coach, /data-field="extype"/); assert.match(coach, /data-field="cardioDur"/);
  assert.match(coach, /_typeSel === 'cardio'/); assert.match(coach, /noSets: true/);
  assert.match(coach, /_exCatalogIsCardio\(normEx\.exerciseName\)\) normEx\.exerciseType = 'cardio'/);
  const catFn = fnSrc(coach, '_exCatalogIsCardio');
  const R = vm.createContext({ _allExercises: [{ name: 'Cinta de correr', motorPattern: 'Cardio' }, { name: 'Remo', motorPattern: 'Tirón' }], String, Array });
  vm.runInContext(catFn + '\nthis.f=_exCatalogIsCardio;', R);
  assert.equal(R.f('cinta de CORRER'), true); assert.equal(R.f('Remo'), false); assert.equal(R.f('Cinta'), false, 'exact name only');
});

test('T589-9 Expediente TXT: a cardio entry is its own record (duration, RPE or quality), not a set; strength statistics ignore it; a cardio-only day appears', async () => {
  const fx = require('./helpers/client-export-fixture.js');
  const Collect = require('../assets/client-export/collect.js');
  const TXT = require('../assets/client-export/expediente-txt.js');
  const NORM = require('../assets/client-export/normalize.js');
  const db = fx.build();
  const e = db.logs[fx.A1].entries;
  e.log_1_1_5 = { exType: 'cardio', done: true, duracionMin: 28, metrica: 'rpe', rpe: 6, ts: Date.parse('2026-02-05T10:00:00Z') };
  e.log_3_0_9 = { exType: 'cardio', done: true, duracionMin: 40, metrica: 'calidad', calidad: 8, ts: Date.parse('2026-02-20T10:00:00Z') };
  e.done_3_0 = true;
  const raw = await Collect.collect(fx.makeIo(db, fx.COACH_A), { clientId: fx.A1, coachUid: fx.COACH_A });
  const model = NORM.normalize(raw, {});
  const logs = model.training.cardio_logs;
  const rpe = logs.find((r) => r.entry_key === 'log_1_1_5'), qual = logs.find((r) => r.entry_key === 'log_3_0_9');
  assert.equal(rpe.duration_min, 28); assert.equal(rpe.effort_metric, 'rpe'); assert.equal(rpe.rpe, 6); assert.equal(rpe.quality, null);
  assert.equal(qual.duration_min, 40); assert.equal(qual.effort_metric, 'quality'); assert.equal(qual.quality, 8); assert.equal(qual.rpe, null);
  assert.ok(!model.training.exercise_logs.some((r) => /^log_1_1_5$|^log_3_0_9$/.test(r.entry_key)), 'cardio is not an exercise (set) log');
  assert.equal(model.unclassified, undefined);
  const sess = model.training.sessions.find((s) => s.week === 3 && s.day_index === 0);
  assert.ok(sess, 'a cardio-only day produces a session'); assert.deepEqual(sess.cardio_log_ids.length, 1);
  const out = TXT.build(raw, { now: new Date('2026-10-20T12:00:00.000Z') });
  assert.match(out.text, /cardio_registrado/); assert.match(out.text, /"duration_min": 28|duration_min.{0,6}28/);
});
