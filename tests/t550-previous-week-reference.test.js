'use strict';
// T550: DISPLAY-ONLY "ÚLTIMA SEMANA" reference = the previous week's EXECUTED standard sets of the same PID (same plan), read from LOGS only.
// Never prescription / defaults / Express / observed-RIR assumptions; never prefills the current inputs; no progression authority.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i > -1, 'missing function ' + name);
  let d = 0; const j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const FNS = ['_exNotePidKey', '_exNoteCtx', '_exNoteValid', '_exNoteShadowed', '_prevWeekRef', '_prevWeekHtml', 'togglePrevWeek'];
const PRES = [{ prescriptionExerciseId: 'pidA', exerciseName: 'Press banca', coachNote: 'Baja 3 s', sets: [{ rirTarget: 2, load: 100, repsTarget: 8 }, { rirTarget: 2, load: 100, repsTarget: 8 }] }, { prescriptionExerciseId: 'pidB', exerciseName: 'Remo', sets: [] }];
function world(o) {
  o = o || {};
  const ctx = { console, Number, Math, JSON, Date, Object, Array, String, parseInt, isNaN, RegExp,
    LOGS: o.logs || {}, ACTIVE_PLAN_ID: o.planId || 'planA', CURRENT_WEEK: o.week || 2, _EJERCICIOS_DIA: o.ex || PRES,
    _escHTml: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), document: { getElementById: () => null } };
  ctx.window = ctx; vm.createContext(ctx); for (const f of FNS) vm.runInContext(fnSrc(f), ctx); return ctx;
}
const set = (o) => Object.assign({ carga: '80', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: '3', prescriptionExerciseId: 'pidA', ts: 1 }, o);
const ref = (w, ei, di) => { const r = w._prevWeekRef(w.LOGS, w._exNoteCtx(di === undefined ? 1 : di, ei === undefined ? 0 : ei)); return r && JSON.parse(JSON.stringify(r)); };
const W1 = () => ({ log_1_1_0_s0: set({}), log_1_1_0_s1: set({ reps: '9', rir_real: '2' }), log_1_1_0_s2: set({ reps: '8', rir_real: '1' }) });

test('T550.1 Week 2 shows Week 1 of the same PID, with its real executed sets', () => {
  const w = world({ logs: W1() }); const r = ref(w);
  assert.equal(r.week, 1); assert.deepEqual(r.sets.map(s => [s.n, s.load, s.reps, s.rir]), [[1, '80', '10', 3], [2, '80', '9', 2], [3, '80', '8', 1]]);
  const html = w._prevWeekHtml(1, 0); assert.ok(html.includes('ÚLTIMA SEMANA') && html.includes('S1 · 80 kg × 10 · RIR 3') && html.includes('S3 · 80 kg × 8 · RIR 1') && html.includes('Referencia de tu sesión anterior'));
});
test('T550.2 Week 3 shows Week 2 as the reference, not Week 1 (never aggregates weeks)', () => {
  const logs = Object.assign(W1(), { log_2_1_0_s0: set({ carga: '82.5', reps: '10', rir_real: '2' }) });
  const w = world({ logs, week: 3 }); const r = ref(w); assert.equal(r.week, 2); assert.equal(r.sets.length, 1); assert.equal(r.sets[0].load, '82.5');
  const w4 = world({ logs: W1(), week: 3 }); assert.equal(ref(w4), null, 'Week 2 has no evidence: no fallback to Week 1');
});
test('T550.3 a different PID is excluded (same position, same name, other PID)', () => {
  const w = world({ logs: W1() }); w.CURRENT_WEEK = 2; assert.equal(ref(w, 1), null, 'other exercise has no reference');
  w._EJERCICIOS_DIA = [{ prescriptionExerciseId: 'pidZ', exerciseName: 'Press banca' }]; assert.equal(ref(w, 0), null, 'same name + same position, other PID');
  assert.ok(!/exerciseName|nombre|toLowerCase|_normName|normalize/.test(fnSrc('_prevWeekRef')), 'no name matching');
});
test('T550.4 a different plan is excluded (its PID is a different identity; its notes carry another planId)', () => {
  const logs = { log_1_1_0_s0: set({ prescriptionExerciseId: 'pidOfPlanB' }), exnotepid_1_pidA: { planId: 'planB', prescriptionExerciseId: 'pidA', week: 1, day: 1, exerciseIndex: 0, text: 'otro plan', updatedAt: 1 }, log_1_1_0_s5: set({}) };
  const w = world({ logs }); const r = ref(w); assert.equal(r.sets.length, 1); assert.equal(r.note, null, 'a note of another plan never attaches');
});
test('T550.5 prescribed values never appear as executed values', () => {
  const w = world({ logs: { log_1_1_0_s0: { done: true, prescriptionExerciseId: 'pidA', rir: 2, carga: '', reps: '' } } });
  assert.equal(ref(w), null, 'only prescribed `rir` / plan load present: nothing executed => no block');
  const w2 = world({ logs: { log_1_1_0_s0: { done: true, prescriptionExerciseId: 'pidA', rir: 2, carga: '60', reps: '8' } } }); const r = ref(w2);
  assert.equal(r.sets[0].rir, null, 'prescribed rir 2 is NOT shown as observed'); const html = w2._prevWeekHtml(1, 0); assert.ok(html.includes('RIR —') && !html.includes('RIR 2') && !html.includes('100'));
  assert.ok(!/rirTarget|repsTarget|restSeconds|getEffectiveSets|_EJERCICIOS_DIA|calculateProgression|_getPrevWeekData/.test(fnSrc('_prevWeekRef') + fnSrc('_prevWeekHtml')), 'resolver never reads the prescription or the legacy engine');
});
test('T550.6 missing RIR / load / reps stay missing ("—"), never filled', () => {
  const w = world({ logs: { log_1_1_0_s0: set({ rir_real: '' }), log_1_1_0_s1: set({ carga: '', reps: '8', rir_real: undefined }), log_1_1_0_s2: set({ reps: '', rir_real: 1 }) } }); const r = ref(w);
  assert.deepEqual(r.sets.map(s => [s.load, s.reps, s.rir]), [['80', '10', null], [null, '8', null], ['80', null, 1]]);
  const html = w._prevWeekHtml(1, 0); assert.ok(html.includes('S1 · 80 kg × 10 · RIR —') && html.includes('S2 · — × 8 · RIR —') && html.includes('S3 · 80 kg × — · RIR 1'));
});
test('T550.7 heterogeneous per-set values are preserved (no flattening, order = set order, own unit)', () => {
  const w = world({ logs: { log_1_1_0_s2: set({ carga: '70', reps: '12', rir_real: '0', unit: 'LB' }), log_1_1_0_s0: set({ carga: '80', reps: '8', rir_real: '3' }), log_1_1_0_s1: set({ carga: '75', reps: '10', rir_real: '2' }) } });
  const html = w._prevWeekHtml(1, 0); assert.ok(html.indexOf('S1 · 80 kg × 8 · RIR 3') < html.indexOf('S2 · 75 kg × 10 · RIR 2') && html.indexOf('S2') < html.indexOf('S3 · 70 lb × 12 · RIR 0'));
});
test('T550.8 Express-only exposure is excluded; mixed exposure shows only the standard sets', () => {
  const express = { log_1_1_0_s0: set({ express: true }), log_1_1_0_s1: set({ express: true }), log_1_1_0_s2: set({ expressFinal: true, rir_real: '1' }), exexpress_1_1_0: { done: true } };
  assert.equal(ref(world({ logs: express })), null, 'only Express evidence => no block');
  assert.equal(world({ logs: express })._prevWeekHtml(1, 0), '');
  const mixed = Object.assign({ log_1_1_0_s0: set({ carga: '90' }) }, { log_1_1_0_s1: set({ express: true }) }); assert.deepEqual(ref(world({ logs: mixed })).sets.map(s => s.load), ['90']);
  for (const f of ['warmup', 'autoFilled']) assert.equal(ref(world({ logs: { log_1_1_0_s0: set({ [f]: true }) } })), null, f);
  assert.equal(ref(world({ logs: { log_1_1_0_s0: set({ done: false }) } })), null, 'an undone set is not executed evidence');
});
test('T550.9 partial standard evidence is shown as it is (only the sets that exist)', () => {
  const w = world({ logs: { log_1_1_0_s0: set({}), log_1_1_0_s2: set({ reps: '7' }) } }); const r = ref(w);
  assert.deepEqual(r.sets.map(s => s.n), [1, 3]); const html = w._prevWeekHtml(1, 0); assert.ok(!html.includes('S2 ·'));
});
test('T550.10 no empty chrome: Week 1, no evidence, substituted / ambiguous PID', () => {
  assert.equal(world({ logs: W1(), week: 1 })._prevWeekHtml(1, 0), '', 'Week 1');
  assert.equal(world({ logs: {} })._prevWeekHtml(1, 0), '', 'no evidence');
  assert.equal(world({ logs: Object.assign(W1(), { exsub_2_1_0: { nombre: 'Otro' } }) })._prevWeekHtml(1, 0), '', 'the current exposure is a substitute');
  assert.equal(world({ logs: Object.assign(W1(), { log_1_3_1_s0: set({}) }) })._prevWeekHtml(1, 0), '', 'same PID at two positions last week: ambiguous identity, no reference');
  assert.equal(world({ logs: { log_1_1_0_s0: { carga: '80', reps: '10', done: true } } })._prevWeekHtml(1, 0), '', 'legacy evidence without PID: no name/position guess');
  const sub = world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: null }) } }); assert.equal(sub._prevWeekHtml(1, 0), '', 'a substituted exposure is logged without the plan PID');
});
test('T550.11 reload preserves the display (pure function of the persisted entries)', () => {
  const a = world({ logs: Object.assign(W1(), { exnotepid_1_pidA: { planId: 'planA', prescriptionExerciseId: 'pidA', week: 1, day: 1, exerciseIndex: 0, text: 'x', updatedAt: 1 } }) });
  const b = world({ logs: JSON.parse(JSON.stringify(a.LOGS)) }); assert.equal(a._prevWeekHtml(1, 0), b._prevWeekHtml(1, 0)); assert.ok(a._prevWeekHtml(1, 0).length > 100);
});
test('T550.12 athlete note shown inside the reference as NOTA; Coach prescription / Coach note never mixed in; no inputs, display only', () => {
  const logs = Object.assign(W1(), { exnotepid_1_pidA: { planId: 'planA', prescriptionExerciseId: 'pidA', week: 1, day: 1, exerciseIndex: 0, text: 'Me costó mantener técnica', updatedAt: 1 } });
  const w = world({ logs }); const html = w._prevWeekHtml(1, 0);
  assert.ok(html.includes('NOTA') && html.includes('Me costó mantener técnica')); assert.ok(!/NOTA DEL COACH|cnote|PRESCRIPCIÓN|Baja 3 s/.test(html), 'Coach note / prescription not in the block');
  assert.ok(!/<input|<textarea|contenteditable|onclick="(?!togglePrevWeek)/.test(html), 'display only');
  assert.ok(!w._prevWeekHtml(1, 0).includes('exnotepid'), 'no raw keys');
  const noNote = world({ logs: W1() })._prevWeekHtml(1, 0); assert.ok(!/NOTA/.test(noNote.replace('Referencia', '')), 'no note chrome without a note');
});
test('T550.13 many sets compact with expansion; V3 tokens only (no gradient / glow / lime)', () => {
  const logs = {}; for (let i = 0; i < 8; i++) logs['log_1_1_0_s' + i] = set({ reps: String(10 - i) });
  const html = world({ logs })._prevWeekHtml(1, 0); assert.equal((html.match(/class="pw-i"/g) || []).length, 8); assert.equal((html.match(/data-more="1"/g) || []).length, 2); assert.ok(html.includes('Ver todas (8)'));
  const css = (SRC.match(/\.pw[a-z-]*\{[^}]*\}/g) || []).join(' '); assert.ok(css.length > 60 && !/gradient|box-shadow|text-shadow|accent/.test(css));
});
test('T550.14 DISPLAY ONLY: wired before the sets, never prefills inputs, never feeds progression / prescription', () => {
  assert.ok(/wuHtml \+ _prevWeekHtml\(di, ei\) \+ setsHtml/.test(SRC.replace(/\s+/g, ' ')), 'rendered next to the set controls');
  const body = fnSrc('_prevWeekRef') + fnSrc('_prevWeekHtml'); for (const bad of ['LOGS[', '.value', 'saveLogs', 'setDoc', 'updateDoc', 'progrec', 'PLAN', 'getEffectiveSets', 'prefill']) assert.ok(!body.includes(bad), bad);
  assert.ok(!/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(SRC));
});
