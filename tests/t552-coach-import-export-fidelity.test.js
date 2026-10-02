// T552: (a) an explicit rest of 0 seconds survives import -> normalization -> save -> export (it was coerced to 90 by `parseInt(x ?? 90) || 90`);
// (b) prescriptionExerciseId survives export -> import -> save byte for byte (the export whitelist dropped it, and two import normalizers did not carry it).
// POSITION != IDENTITY: nothing here derives, repairs or matches PIDs by name / index; exerciseId is never confused with the PID.
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
const consts = () => (coach.match(/const _PERF_[A-Z_]+\b[\s\S]*?;\n/g) || []).join('\n');
function load(docs) {
  const written = {};
  const ctx = { console, JSON, Object, Array, String, Number, Math, parseInt, parseFloat, isNaN, Date, crypto: { randomUUID: (() => { let n = 0; return () => 'gen-' + (++n); })() },
    db: {}, doc: (db, c, id) => ({ c, id }), getDoc: async ref => ({ exists: () => !!docs && !!docs[ref.id], data: () => docs[ref.id] }),
    showToast() {}, navigator: { clipboard: { writeText: async t => { written.text = t; } } }, Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }), body: { appendChild() {}, removeChild() {} } }, written };
  vm.createContext(ctx);
  const helpers = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk', '_perfCarryEx', '_perfCarrySet', '_genPrescriptionId', '_stampPrescriptionIds', '_normRestSeconds', '_carryPrescriptionId'].filter(n => coach.includes('function ' + n + '(')).map(n => fnSrc(coach, n)).join('\n');
  vm.runInContext(consts() + '\n' + helpers + '\n' + fnSrc(coach, '_normalizeTrainingPlan') + '\n' + fnSrc(coach, 'exportActivePlanJSON') +
    '\nthis._normalizeTrainingPlan = _normalizeTrainingPlan; this.exportActivePlanJSON = exportActivePlanJSON; this._stampPrescriptionIds = _stampPrescriptionIds;' +
    (helpers.includes('function _normRestSeconds') ? ' this._normRestSeconds = _normRestSeconds;' : ''), ctx);
  return ctx;
}
const S = (rests) => rests.map((r, i) => ({ setIndex: i, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: r }));
const J = o => JSON.parse(JSON.stringify(o));
const plan = (rests, pid) => ({ weeks: 6, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'D1', exercises: [Object.assign({ exerciseName: 'Press banca', sets: S(rests) }, pid ? { prescriptionExerciseId: pid } : {}) ] }] });

// ---------------- REST = 0 ----------------
test('T552.R1 _normalizeTrainingPlan: an explicit rest of 0 stays 0; ordinary values unchanged; absent / invalid keep the existing 90 fallback', () => {
  const ctx = load(); const out = J(ctx._normalizeTrainingPlan(plan([0, 60, 90, 150, null, undefined, 'abc', '', '45', '0'])));
  assert.deepEqual(out.days[0].exercises[0].sets.map(s => s.restSeconds), [0, 60, 90, 150, 90, 90, 90, 90, 45, 0]);
});
test('T552.R2 ONE helper owns the fallback and every normalizer / export site uses it (no `|| 90` coercion left)', () => {
  assert.ok(coach.includes('function _normRestSeconds('), 'helper exists');
  assert.ok(!/parseInt\(s\.restSeconds \?\? 90\) \|\| 90/.test(coach), 'no truthy coercion of restSeconds in any normalizer');
  assert.ok(!/restSeconds: s\.restSeconds \|\| 90/.test(coach), 'export no longer coerces 0');
  assert.ok((coach.match(/_normRestSeconds\(s\.restSeconds\)/g) || []).length >= 4, 'parsePlanFromJSON + _normalizeTrainingPlan + update-plan modal + export');
});
test('T552.R3 raw import -> normalization -> save shape -> export keeps rest 0 (and 60 / 90 / 150)', async () => {
  const ctx = load(); const norm = J(ctx._normalizeTrainingPlan(plan([0, 60, 90, 150], 'pid-A')));
  const saved = J(Object.assign({}, norm, { days: ctx._stampPrescriptionIds(norm.days) }));   // what saveImportedPlan persists
  const ctx2 = load({ p1: saved }); await ctx2.exportActivePlanJSON('client-123456', 'p1');
  const exported = JSON.parse(ctx2.written.text); assert.deepEqual(exported.days[0].exercises[0].sets.map(s => s.restSeconds), [0, 60, 90, 150]);
  const again = J(ctx2._normalizeTrainingPlan(exported)); assert.deepEqual(again.days[0].exercises[0].sets.map(s => s.restSeconds), [0, 60, 90, 150], 'export -> import is stable');
});
test('T552.R4 the 0 is a real value for the Client too: rest 0 means "no rest timer" (unchanged Client behaviour)', () => {
  const client = fs.readFileSync('vdsen-cliente.html', 'utf8'); assert.ok(client.includes('parseInt(_setSpec.restSeconds) > 0 ? parseInt(_setSpec.restSeconds) : 0'));
});

// ---------------- PID export / import ----------------
const PIDS = Array.from({ length: 32 }, (_, i) => (i % 5 === 0 ? 'PID with spaces ' + i : 'b3f1c0de-0000-4000-8000-' + String(i).padStart(12, '0')));
const bigPlan = () => ({ weeks: 6, daysPerWeek: 4, days: Array.from({ length: 4 }, (_, d) => ({ dayIndex: d, label: 'D' + (d + 1), exercises: Array.from({ length: 8 }, (_, e) => ({
  exerciseName: e % 2 ? 'Press banca' : 'Sentadilla', exerciseId: 'ex-catalog-' + (e % 3), prescriptionExerciseId: PIDS[d * 8 + e], alternatives: [], technique: 'straight', sets: S([0, 90]) })) })) });   // duplicate NAMES, distinct PIDs, shared exerciseId
test('T552.P1 export keeps prescriptionExerciseId for every exercise (it was dropped by the export whitelist)', async () => {
  const p = bigPlan(); const ctx = load({ p1: p }); await ctx.exportActivePlanJSON('client-123456', 'p1'); const out = JSON.parse(ctx.written.text);
  assert.deepEqual(out.days.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId)), PIDS);
});
test('T552.P2 export -> import (_normalizeTrainingPlan) -> save (stamp) preserves 32 PIDs byte for byte, in order, with duplicate names and shared exerciseId', async () => {
  const ctx = load({ p1: bigPlan() }); await ctx.exportActivePlanJSON('client-123456', 'p1'); const norm = J(ctx._normalizeTrainingPlan(JSON.parse(ctx.written.text)));
  const saved = J(ctx._stampPrescriptionIds(norm.days)); const got = saved.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId));
  assert.equal(got.length, 32); assert.equal(new Set(got).size, 32); assert.deepEqual(got, PIDS);
  assert.ok(saved.flatMap(d => d.exercises).every(e => e.prescriptionExerciseId !== e.exerciseId), 'exerciseId is never used as the PID');
});
test('T552.P3 the update-plan modal normalizer carries a valid PID too (it minted a new one), via the shared helper', () => {
  assert.ok(coach.includes('function _carryPrescriptionId('), 'shared helper');
  assert.ok((coach.match(/_carryPrescriptionId\(ex\)/g) || []).length >= 2, 'used by _normalizeTrainingPlan and the update-plan modal');
  const ctx = load(); const out = J(ctx._normalizeTrainingPlan(plan([90], '  weird PID  '))); assert.equal(out.days[0].exercises[0].prescriptionExerciseId, '  weird PID  ', 'byte for byte, no trim / case change');
});
test('T552.P4 nothing is invented: no PID in => no PID out of the export / normalizer (only the explicit save-time stamp mints one); exerciseId is not promoted', async () => {
  const p = plan([90]); p.days[0].exercises[0].exerciseId = 'ex-1'; const ctx = load({ p1: p }); await ctx.exportActivePlanJSON('client-123456', 'p1');
  const ex = JSON.parse(ctx.written.text).days[0].exercises[0]; assert.ok(!('prescriptionExerciseId' in ex)); assert.ok(!('exerciseId' in ex), 'the export does not leak catalog ids as identity');
  const out = J(ctx._normalizeTrainingPlan(JSON.parse(ctx.written.text))); assert.ok(!('prescriptionExerciseId' in out.days[0].exercises[0]));
  for (const bad of [null, '', 0, {}, []]) assert.ok(!('prescriptionExerciseId' in J(ctx._normalizeTrainingPlan(Object.assign(plan([90]), { days: [{ label: 'D', exercises: [{ exerciseName: 'Press banca', prescriptionExerciseId: bad, sets: S([90]) }] }] }))).days[0].exercises[0]), String(bad));
});
test('T552.P5 intra-plan duplicate PIDs keep the existing repair (first keeps, later gets a new one) - not changed by this ticket', () => {
  const ctx = load(); const p = plan([90], 'dup'); p.days[0].exercises.push(Object.assign({}, p.days[0].exercises[0], { exerciseName: 'Remo' }));
  const saved = J(ctx._stampPrescriptionIds(J(ctx._normalizeTrainingPlan(p)).days)); const ids = saved[0].exercises.map(e => e.prescriptionExerciseId); assert.equal(ids[0], 'dup'); assert.notEqual(ids[1], 'dup');
});
