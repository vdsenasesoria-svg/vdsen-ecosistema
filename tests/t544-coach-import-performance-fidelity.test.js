// T544: the Coach import path is semantically transparent for the supported performance-type fields (T543 client contract).
// Loss points traced in vdsen-coach.html: parsePlanFromJSON (JSON tab), _normalizeTrainingPlan (paste / PDF / AI apply, 5 callers),
// showUpdatePlanModal (update active plan), saveTrainingPlan (editor DOM rebuild), exportActivePlanJSON (export -> re-import).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');

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
function load() {
  const ctx = { console };
  vm.createContext(ctx);
  const helpers = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk', '_perfCarryEx', '_perfCarrySet', '_perfRowState', '_normRestSeconds', '_carryPrescriptionId', '_normNivelMedio', '_normVariacionVertical', '_carryClassification'].filter(n => coach.includes('function ' + n + '(')).map(n => fnSrc(coach, n)).join('\n');
  vm.runInContext(consts() + '\n' + helpers + '\n' + fnSrc(coach, '_normalizeTrainingPlan') + '\nthis._normalizeTrainingPlan = _normalizeTrainingPlan;' + (helpers ? '\nthis._perfCarryEx = _perfCarryEx; this._perfCarrySet = _perfCarrySet; this._perfRowState = _perfRowState;' : ''), ctx);
  return ctx;
}
const S = (n, extra) => Array.from({ length: n }, (_, i) => Object.assign({ setIndex: i, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }, extra || {}));
function fixture() {
  return { schema: 'vdsen-plan-v2', entrenamiento: { weeks: 6, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Mixto', exercises: [
    { exerciseName: 'Press banca', technique: 'straight', sets: S(3) },
    { exerciseName: 'Bicicleta zona 2', exerciseType: 'cardio', modo: 'z2', duracionMin: 30, distanciaKm: 8, fcZonaMin: 120, fcZonaMax: 140, ritmoObjetivo: '5:30', repeticiones: 4, bloqueTrabajo: '4:00', bloqueDescanso: '2:00', sets: [] },
    { exerciseName: 'Dominadas estrictas', exerciseType: 'calistenia', rpeTarget: 8, sets: S(3, { rpeTarget: 8 }) },
    { exerciseName: 'Farmer carry', exerciseType: 'estacion', dosis: 50, dosisUnit: 'm', tiempoObjetivoSeg: 60, sets: S(3, { dosis: 50, repsTarget: 1 }) },
    { exerciseName: 'Finisher metabólico', exerciseType: 'circuito', estructura: 'AMRAP', roundsObjetivo: 4, timeCapMin: 10, movimientos: [{ nombre: 'Burpee', dosis: 10 }, 'Remo kettlebell'], sets: [] }
  ] }] } };
}
const rawDay = () => fixture().entrenamiento;

test('T544.1 _normalizeTrainingPlan keeps every supported performance exercise with its type and Coach prescription', () => {
  const ctx = load();
  const out = ctx._normalizeTrainingPlan(rawDay());
  assert.ok(out, 'plan normalizes');
  const ex = out.days[0].exercises;
  assert.equal(ex.length, 5, 'no exercise is dropped (cardio / circuito legitimately carry no sets)');
  assert.deepEqual(ex.map(e => e.exerciseType), [undefined, 'cardio', 'calistenia', 'estacion', 'circuito']);
  assert.deepEqual([ex[1].modo, ex[1].duracionMin, ex[1].distanciaKm, ex[1].fcZonaMin, ex[1].fcZonaMax, ex[1].ritmoObjetivo, ex[1].repeticiones, ex[1].bloqueTrabajo, ex[1].bloqueDescanso], ['z2', 30, 8, 120, 140, '5:30', 4, '4:00', '2:00']);
  assert.equal(ex[2].rpeTarget, 8); assert.equal(ex[2].sets[0].rpeTarget, 8);
  assert.deepEqual([ex[3].dosis, ex[3].dosisUnit, ex[3].tiempoObjetivoSeg, ex[3].sets[0].dosis], [50, 'm', 60, 50]);
  assert.deepEqual([ex[4].estructura, ex[4].roundsObjetivo, ex[4].timeCapMin], ['AMRAP', 4, 10]);
  assert.deepEqual(JSON.parse(JSON.stringify(ex[4].movimientos)), [{ nombre: 'Burpee', dosis: 10 }, 'Remo kettlebell']);
});

test('T544.2 strength exercises are exactly as before (no new keys) and prescription / order are untouched', () => {
  const ctx = load();
  const ex = ctx._normalizeTrainingPlan(rawDay()).days[0].exercises;
  const keys = Object.keys(ex[0]).sort();
  assert.deepEqual(keys, ['alternatives', 'coachNote', 'exerciseName', 'nivel_medio', 'sets', 'supersetGroup', 'technique', 'techniqueNote', 'variacion_vertical'].sort());
  assert.deepEqual(Object.keys(ex[0].sets[0]).sort(), ['drop', 'load', 'repsTarget', 'restSeconds', 'rirTarget', 'setIndex', 'setNote', 'tempo']);
  assert.deepEqual(ex.map(e => e.exerciseName), ['Press banca', 'Bicicleta zona 2', 'Dominadas estrictas', 'Farmer carry', 'Finisher metabólico'], 'order preserved');
  assert.deepEqual(ex[2].sets.map(s => [s.repsTarget, s.rirTarget, s.restSeconds]), [[8, 2, 90], [8, 2, 90], [8, 2, 90]]);
});

test('T544.3 a strength exercise with no sets is still discarded (existing behavior)', () => {
  const ctx = load();
  const raw = rawDay(); raw.days[0].exercises.push({ exerciseName: 'Sin series', sets: [] });
  assert.equal(ctx._normalizeTrainingPlan(raw).days[0].exercises.length, 5);
});

test('T544.4 containment: unknown fields, prototype keys, HTML and oversized / nested data are not carried', () => {
  const ctx = load();
  const raw = rawDay();
  const bad = raw.days[0].exercises[1];
  bad.evil = '<script>alert(1)</script>'; bad.__proto__ = { polluted: true }; bad.constructor = 'x'; bad.duracionMin = { nested: { deep: 1 } }; bad.ritmoObjetivo = 'x'.repeat(5000);
  raw.days[0].exercises[4].movimientos = [{ nombre: 'A', __proto__: { p: 1 }, evil: 'x', dosis: { a: 1 } }, ...Array.from({ length: 80 }, (_, i) => 'm' + i)];
  const out = ctx._normalizeTrainingPlan(raw).days[0].exercises;
  assert.equal(out[1].evil, undefined); assert.equal({}.polluted, undefined); assert.equal(Object.prototype.hasOwnProperty.call(out[1], 'constructor'), false);
  assert.equal(out[1].duracionMin, undefined, 'nested object rejected for a scalar field');
  assert.ok(String(out[1].ritmoObjetivo || '').length <= 120, 'strings capped');
  assert.ok(out[4].movimientos.length <= 30, 'movement list capped');
  assert.deepEqual(Object.keys(out[4].movimientos[0]).filter(k => !['nombre', 'exerciseName', 'dosis', 'reps', 'distancia', 'unit', 'unidad'].includes(k)), []);
  assert.equal(typeof out[4].movimientos[0].dosis === 'object', false);
});

test('T544.5 unknown exerciseType is dropped; tipo legacy alias is preserved only when valid; canonical wins at runtime (client _getExType)', () => {
  const ctx = load();
  const raw = rawDay();
  raw.days[0].exercises.push({ exerciseName: 'Tipo raro', exerciseType: 'inventado', modo: 'z2', sets: S(2) }, { exerciseName: 'Solo tipo', tipo: 'Cardio', duracionMin: 20, sets: [] }, { exerciseName: 'Ambos', exerciseType: 'estacion', tipo: 'cardio', dosis: 10, sets: S(1) });
  const out = ctx._normalizeTrainingPlan(raw).days[0].exercises;
  const by = n => out.find(e => e.exerciseName === n);
  assert.equal(by('Tipo raro').exerciseType, undefined); assert.equal(by('Tipo raro').modo, undefined, 'performance fields ride only with a valid non-strength type');
  assert.equal(by('Solo tipo').tipo, 'cardio'); assert.equal(by('Solo tipo').duracionMin, 20);
  assert.equal(by('Ambos').exerciseType, 'estacion'); assert.equal(by('Ambos').tipo, 'cardio', 'legacy alias retained as authored; runtime _getExType prefers exerciseType');
});

test('T544.6 the Coach whitelist equals the client (T543) whitelist, field for field', () => {
  const grab = (src, re) => (src.match(re) || [null, ''])[1].match(/'([^']+)'/g).map(x => x.slice(1, -1)).sort();
  const c = grab(coach, /const _PERF_RX_FIELDS = \[([\s\S]*?)\];/), k = grab(client, /var _PERF_RX_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(c.length > 20);
  assert.deepEqual(c, k);
});

test('T544.7 every other Coach surface that rebuilds imported exercises carries the fields (JSON tab, update-plan modal, editor, export)', () => {
  for (const f of ['parsePlanFromJSON', 'showUpdatePlanModal', 'saveTrainingPlan', 'exportActivePlanJSON']) assert.ok(/_perfCarry(Ex|Set)\(/.test(fnSrc(coach, f)), f + ' carries performance fields');
  assert.ok(/data-perf=/.test(coach) && /row\.dataset\.perf/.test(fnSrc(coach, 'saveTrainingPlan')), 'editor round-trips the fields through the row');
});

test('T544.8 identity and authority are untouched by the carrier', () => {
  const ctx = load();
  const out = ctx._normalizeTrainingPlan(rawDay()).days[0].exercises;
  for (const e of out) { assert.equal(e.prescriptionExerciseId, undefined, 'PID stamping stays in _stampPrescriptionIds'); assert.equal(e.exerciseId, undefined); }
  const stamp = fnSrc(coach, '_stampPrescriptionIds');
  assert.ok(/Object\.assign\(\{\}, ex, \{ prescriptionExerciseId: newId \}\)/.test(stamp), 'stamping keeps all other fields');
});

function loadParse(json) {
  const el = { value: json, innerHTML: '' };
  const ctx = { console, window: {}, document: { getElementById: () => el }, showToast() {}, _escH: x => x, showParsedPreview(p) { ctx.preview = p; } };
  vm.createContext(ctx);
  const helpers = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk', '_perfCarryEx', '_perfCarrySet', '_normRestSeconds', '_carryPrescriptionId', '_normNivelMedio', '_normVariacionVertical', '_carryClassification'].map(n => fnSrc(coach, n)).join('\n');
  vm.runInContext(consts() + '\n' + helpers + '\n' + fnSrc(coach, 'parsePlanFromJSON') + '\nthis.parsePlanFromJSON = parsePlanFromJSON;', ctx);
  return { ctx, el };
}

test('T544.9 JSON-tab import (parsePlanFromJSON) preserves type + prescription, preview receives them, and PID passthrough is unchanged', () => {
  const fx = fixture(); fx.entrenamiento.days[0].exercises[0].prescriptionExerciseId = 'pid-keep-1';
  const { ctx } = loadParse(JSON.stringify(fx));
  ctx.parsePlanFromJSON();
  const ex = ctx.window._importedPlan.days[0].exercises;
  assert.equal(ex.length, 5);
  assert.equal(ex[0].prescriptionExerciseId, 'pid-keep-1');
  assert.deepEqual(JSON.parse(JSON.stringify(ex.slice(1).map(e => e.exerciseType))), ['cardio', 'calistenia', 'estacion', 'circuito']);
  assert.equal(ex[1].duracionMin, 30); assert.equal(ex[3].sets[0].dosis, 50); assert.equal(ex[2].sets[0].rpeTarget, 8);
  assert.equal(ex[4].timeCapMin, 10);
  assert.equal(ctx.preview, ctx.window._importedPlan, 'preview shows the same normalized plan that will be saved');
});

test('T544.10 saved-plan payload: saveImportedPlan writes the normalized days (through _stampPrescriptionIds, which keeps every other field)', () => {
  const s = fnSrc(coach, 'saveImportedPlan');
  assert.ok(/\.\.\.planObj,\s*days: _stampPrescriptionIds\(planObj\.days\)/.test(s));
  const stamp = fnSrc(coach, '_stampPrescriptionIds'), gen = 'function _genPrescriptionId() { return "pid-" + Math.random().toString(36).slice(2); }';
  const ctx = {}; vm.createContext(ctx); vm.runInContext(gen + '\n' + stamp + '\nthis.f=_stampPrescriptionIds;', ctx);
  const c = load(); const days = c._normalizeTrainingPlan(rawDay()).days;
  const out = ctx.f(days);
  assert.deepEqual(JSON.parse(JSON.stringify(out[0].exercises.map(e => e.exerciseType || null))), [null, 'cardio', 'calistenia', 'estacion', 'circuito']);
  assert.equal(out[0].exercises[3].sets[0].dosis, 50);
  assert.ok(out[0].exercises.every(e => /^pid-/.test(e.prescriptionExerciseId)) && new Set(out[0].exercises.map(e => e.prescriptionExerciseId)).size === 5);
});

test('T544.11 editor round trip: row state carries type / prescription / per-set doses / empty-sets, and save merges them back', () => {
  const c = load();
  const stored = c._normalizeTrainingPlan(rawDay()).days[0].exercises;
  const state = stored.map(e => JSON.parse(c._perfRowState ? c._perfRowState(e) : '{}'));
  assert.equal(state[1].ex.exerciseType, 'cardio'); assert.equal(state[1].noSets, true);
  assert.equal(state[3].sets[0].dosis, 50); assert.equal(state[3].noSets, false);
  assert.equal(state[0].noSets, false); assert.deepEqual(state[0].ex, {}, 'strength rows carry nothing');
});

test('T544.12 pre-write gate: cardio / circuito with sets:[] pass; strength with no sets is still a blocker', () => {
  const ctx = { console };
  vm.createContext(ctx);
  const helpers = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk'].map(n => fnSrc(coach, n)).join('\n');
  vm.runInContext(consts() + '\n' + helpers + '\n' + fnSrc(coach, '_guardPlanIntegrity') + '\nthis.g = _guardPlanIntegrity;', ctx);
  const mk = ex => ({ days: [{ label: 'D1', exercises: [ex] }] });
  const st = { exerciseName: 'Press', sets: [{ repsTarget: 8, rirTarget: 2 }] };
  assert.equal(ctx.g(mk({ exerciseName: 'Bici', exerciseType: 'cardio', sets: [] })).errors.length, 0);
  assert.equal(ctx.g(mk({ exerciseName: 'Finisher', exerciseType: 'circuito', sets: [] })).errors.length, 0);
  assert.equal(ctx.g(mk({ exerciseName: 'Press', sets: [] })).errors.length, 1, 'strength without sets still blocks');
  assert.equal(ctx.g(mk({ exerciseName: 'X', exerciseType: 'bogus', sets: [] })).errors.length, 1, 'unknown type is fuerza');
  assert.equal(ctx.g(mk(st)).errors.length, 0);
});
