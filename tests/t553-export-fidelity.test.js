// T553: supersetGroup, nivel_medio and variacion_vertical survive export -> import (JSON paste) -> preview -> save -> edit -> export.
// They pass through explicit sanitizing helpers (no raw spreads; unknown fields dropped; PIDs untouched).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
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
const HELPERS = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk', '_perfCarryEx', '_perfCarrySet', '_genPrescriptionId', '_stampPrescriptionIds', '_normRestSeconds', '_carryPrescriptionId', '_normNivelMedio', '_normVariacionVertical', '_carryClassification'];
function load(docs) {
  const written = {}, status = { html: '' }, el = { value: '', set innerHTML(v) { status.html = v; } };
  const ctx = { console, JSON, Object, Array, String, Number, Math, parseInt, parseFloat, isNaN, Date, crypto: { randomUUID: (() => { let n = 0; return () => 'gen-' + (++n); })() },
    db: {}, doc: (db, c, id) => ({ c, id }), getDoc: async ref => ({ exists: () => !!docs && !!docs[ref.id], data: () => docs[ref.id] }),
    showToast() {}, showParsedPreview() {}, navigator: { clipboard: { writeText: async t => { written.text = t; } } }, Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { getElementById: id => (id === 'planJsonInput' ? el : { set innerHTML(v) { status.html = v; } }), createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }), body: { appendChild() {}, removeChild() {} } },
    window: {}, written, status, el };
  vm.createContext(ctx);
  const src = HELPERS.map(h => fnSrc(coach, h)).join('\n');
  vm.runInContext(consts() + '\n' + src + '\n' + fnSrc(coach, '_normalizeTrainingPlan') + '\n' + fnSrc(coach, 'exportActivePlanJSON') + '\n' + fnSrc(coach, 'parsePlanFromJSON') +
    '\nthis._normalizeTrainingPlan=_normalizeTrainingPlan; this.exportActivePlanJSON=exportActivePlanJSON; this.parsePlanFromJSON=parsePlanFromJSON; this._stampPrescriptionIds=_stampPrescriptionIds; this._carryClassification=_carryClassification;', ctx);
  return ctx;
}
const J = o => JSON.parse(JSON.stringify(o));
const VV = { semana_inicio: 3, semana_variacion: 5, ejercicio_sustituto: 'Press inclinado', nivel_sustituto: 'suplementario' };
const S = n => Array.from({ length: n }, (_, i) => ({ setIndex: i, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }));
const ex = (name, extra) => Object.assign({ exerciseName: name, alternatives: [], technique: 'straight', sets: S(2) }, extra);
const plan = exs => ({ weeks: 6, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D1', exercises: exs }] });
const NM = ['fundamental', 'suplementario', 'asistencia_mayor', 'asistencia_secundario'];

test('T553.E1 export keeps supersetGroup, nivel_medio and variacion_vertical (they were dropped by the export whitelist)', async () => {
  const p = plan([ex('Press banca', { prescriptionExerciseId: 'p1', supersetGroup: 'A', nivel_medio: 'fundamental', variacion_vertical: VV }), ex('Remo', { prescriptionExerciseId: 'p2', supersetGroup: 'A', nivel_medio: 'asistencia_mayor', variacion_vertical: null }), ex('Curl', { prescriptionExerciseId: 'p3', supersetGroup: '' })]);
  const ctx = load({ p1: p }); await ctx.exportActivePlanJSON('client-123456', 'p1'); const out = JSON.parse(ctx.written.text).days[0].exercises;
  assert.deepEqual([out[0].supersetGroup, out[0].nivel_medio, out[0].variacion_vertical], ['A', 'fundamental', VV]);
  assert.deepEqual([out[1].supersetGroup, out[1].nivel_medio, 'variacion_vertical' in out[1]], ['A', 'asistencia_mayor', false]);
  assert.equal(out[2].supersetGroup, ''); assert.ok(!('nivel_medio' in out[2]) && !('variacion_vertical' in out[2]), 'nothing invented');
});
test('T553.E2 JSON paste import (parsePlanFromJSON) carries nivel_medio + variacion_vertical (it dropped them) and supersetGroup', () => {
  const ctx = load(); ctx.el.value = JSON.stringify(plan([ex('Press banca', { supersetGroup: ' B ', nivel_medio: 'suplementario', variacion_vertical: VV, prescriptionExerciseId: 'pid-x' })]));
  ctx.parsePlanFromJSON(); const e = J(ctx.window._importedPlan).days[0].exercises[0];
  assert.deepEqual([e.supersetGroup, e.nivel_medio, e.variacion_vertical, e.prescriptionExerciseId], ['B', 'suplementario', VV, 'pid-x']);
});
test('T553.E3 export -> import -> save -> export is stable for all three fields and the PIDs', async () => {
  const p = plan([ex('Press banca', { prescriptionExerciseId: 'p1', supersetGroup: 'A', nivel_medio: 'fundamental', variacion_vertical: VV }), ex('Remo', { prescriptionExerciseId: 'p2', supersetGroup: 'A', nivel_medio: 'asistencia_secundario' })]);
  const c1 = load({ p1: p }); await c1.exportActivePlanJSON('client-123456', 'p1'); const first = JSON.parse(c1.written.text);
  c1.el.value = c1.written.text; c1.parsePlanFromJSON(); const imported = J(c1.window._importedPlan);
  const saved = Object.assign({}, imported, { days: J(c1._stampPrescriptionIds(imported.days)) });
  const c2 = load({ p1: saved }); await c2.exportActivePlanJSON('client-123456', 'p1'); assert.deepEqual(JSON.parse(c2.written.text), first);
});
test('T553.E4 sanitization: invalid nivel_medio dropped, variacion_vertical coerced field by field, unknown fields dropped, no raw spread', () => {
  const ctx = load(); const c = J(ctx._carryClassification({ nivel_medio: 'intermedio', variacion_vertical: 'completa', hax: 1 })); assert.deepEqual(c, {});
  const d = J(ctx._carryClassification({ nivel_medio: 'fundamental', variacion_vertical: { semana_inicio: '4', semana_variacion: null, ejercicio_sustituto: '  X ', nivel_sustituto: 'suplementario', __proto__x: 1, evil: '<script>' } }));
  assert.deepEqual(d, { nivel_medio: 'fundamental', variacion_vertical: { semana_inicio: 4, semana_variacion: null, ejercicio_sustituto: 'X', nivel_sustituto: 'suplementario' } });
  for (const v of NM) assert.equal(J(ctx._carryClassification({ nivel_medio: v })).nivel_medio, v);
  assert.ok(!/\.\.\.\s*ex\b(?!\w)/.test(fnSrc(coach, 'exportActivePlanJSON')), 'no raw spread of the stored exercise in the export');
});
test('T553.E5 the three normalizers and the export share the helpers (no copy-pasted enum / object literals left)', () => {
  assert.ok((coach.match(/_normNivelMedio\(/g) || []).length >= 3, 'helper used by the normalizers');
  assert.ok((coach.match(/_carryClassification\(ex\)/g) || []).length >= 2, 'JSON-paste import + export');
  assert.ok(!/nivel_medio: \['fundamental','suplementario','asistencia_mayor','asistencia_secundario'\]\.includes/.test(coach), 'no inline enum copy');
});
test('T553.E6 Ayrton-shaped synthetic round trip: 6w / 7d / 32 exercises / 80 sets / 32 PIDs, zero unexpected diffs, populated supersetGroup fixture', async () => {
  const days = Array.from({ length: 7 }, (_, d) => ({ dayIndex: d, label: 'D' + (d + 1), exercises: [] })); let n = 0, sets = 0;
  const per = [5, 5, 5, 5, 4, 4, 4];
  per.forEach((cnt, d) => { for (let e = 0; e < cnt; e++, n++) { const ns = n < 16 ? 3 : 2; sets += ns; days[d].exercises.push(ex(n % 3 ? 'Press banca' : 'Sentadilla', { prescriptionExerciseId: 'pid-' + n, exerciseId: 'cat-' + (n % 4), supersetGroup: (n % 4 === 0 || n % 4 === 1) ? 'SS' + Math.floor(n / 4) : '', nivel_medio: NM[n % 4], variacion_vertical: n % 2 ? VV : null, sets: S(ns) })); } });
  assert.deepEqual([n, sets], [32, 80]);
  const p = { weeks: 6, daysPerWeek: 7, days };
  const c1 = load({ p1: p }); await c1.exportActivePlanJSON('client-123456', 'p1'); c1.el.value = c1.written.text; c1.parsePlanFromJSON(); const imp = J(c1.window._importedPlan);
  const saved = Object.assign({}, imp, { days: J(c1._stampPrescriptionIds(imp.days)) });
  const c2 = load({ p1: saved }); await c2.exportActivePlanJSON('client-123456', 'p1');
  const strip = (pl) => J(pl).days.flatMap(d => d.exercises.map(e => ({ n: e.exerciseName, pid: e.prescriptionExerciseId, ss: e.supersetGroup || '', nm: e.nivel_medio || null, vv: e.variacion_vertical || null, sets: e.sets.map(s => [s.repsTarget, s.rirTarget, s.restSeconds]) })));
  assert.deepEqual(strip(JSON.parse(c2.written.text)), strip(p), 'zero unexpected diffs');
  assert.equal(strip(p).filter(e => e.ss).length, 16, 'populated superset fixture');
});
