'use strict';
// T551: ONE canonical previous-week identity model: SAME PLAN + SAME prescriptionExerciseId + EXACTLY WEEK-1 (no name / position / index fallback, no aggregation).
// The T550 display block and the explicit "USAR CARGA/REPS" reuse action share the SAME resolver (_prevWeekRef). Reuse = athlete-explicit, DRAFT only,
// load + reps only (never RIR / ICS / Pump / prescription / notes), mapped per set, never autosaved.
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
const FNS = ['_exNotePidKey', '_exNoteCtx', '_exNoteValid', '_exNoteShadowed', '_roundUnit', '_convertCarga', '_prevWeekRef', '_prevWeekHtml', '_prevWeekReuse', '_prevWeekKeyParts', '_prevWeekReuseHtml', '_prevWeekUse', '_buildSetReferenceHtml'];
const PRES = [{ prescriptionExerciseId: 'pidA', exerciseName: 'Press banca', sets: [{ rirTarget: 2, load: 100, repsTarget: 8 }, { rirTarget: 2, load: 100, repsTarget: 8 }, { rirTarget: 1, load: 100, repsTarget: 8 }] }, { prescriptionExerciseId: 'pidB', exerciseName: 'Remo', sets: [] }];
function world(o) {
  o = o || {}; const calls = { save: 0, rir: 0, toast: 0, hint: 0 }; const els = {};
  ['carga', 'reps', 'rir', 'ics'].forEach(k => { els[k + '_log_2_1_0_s0'] = { value: '' }; els[k + '_log_2_1_0_s1'] = { value: '' }; els[k + '_log_2_1_0_s2'] = { value: '' }; });
  const ctx = { console, Number, Math, JSON, Date, Object, Array, String, parseInt, parseFloat, isNaN, RegExp,
    LOGS: o.logs || {}, ACTIVE_PLAN_ID: o.planId || 'planA', CURRENT_WEEK: o.week || 2, _EJERCICIOS_DIA: o.ex || PRES,
    _escHTml: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    document: { getElementById: id => els[id] || null }, els, calls,
    saveLogs() { calls.save++; }, completeSet() { calls.save++; }, setRirReal() { calls.rir++; }, showToast() { calls.toast++; }, bcProgHint() { calls.hint++; } };
  ctx.window = ctx; vm.createContext(ctx); for (const f of FNS) vm.runInContext(fnSrc(f), ctx); return ctx;
}
const set = o => Object.assign({ carga: '80', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: '3', ics: 7, pump: 2, prescriptionExerciseId: 'pidA', ts: 1 }, o);
const W1 = () => ({ log_1_1_0_s0: set({}), log_1_1_0_s1: set({ reps: '9', rir_real: '2' }), log_1_1_0_s2: set({ carga: '75', reps: '8', rir_real: '1' }) });
const reuse = (w, si, ei, di) => { const r = w._prevWeekReuse(w.LOGS, w._exNoteCtx(di === undefined ? 1 : di, ei === undefined ? 0 : ei), si); return r && JSON.parse(JSON.stringify(r)); };
const btn = (w, si, ei, di) => w._prevWeekReuseHtml('log_' + w.CURRENT_WEEK + '_' + (di === undefined ? 1 : di) + '_' + (ei === undefined ? 0 : ei) + '_s' + si, 'KG');

test('T551.1 same PID + previous week => the reuse action is available (and shares the T550 resolver)', () => {
  const w = world({ logs: W1() }); assert.deepEqual(reuse(w, 0), { n: 1, load: '80', unit: 'KG', reps: '10' });
  assert.ok(btn(w, 0).includes('USAR CARGA/REPS') && btn(w, 0).includes('_prevWeekUse('));
  assert.ok(fnSrc('_prevWeekReuse').includes('_prevWeekRef('), 'ONE resolver: the reuse action calls the canonical _prevWeekRef');
});
test('T551.2 different PID with the SAME NAME => unavailable', () => {
  const w = world({ logs: W1() }); w._EJERCICIOS_DIA = [{ prescriptionExerciseId: 'pidZ', exerciseName: 'Press banca' }];
  assert.equal(reuse(w, 0), null); assert.equal(btn(w, 0), '');
});
test('T551.3 same POSITION, different PID => unavailable', () => {
  const w = world({ logs: W1() }); assert.equal(reuse(w, 0, 1), null, 'exercise index 1 (other PID) at the same day');
  assert.equal(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: 'pidOther' }) } })._prevWeekReuseHtml('log_2_1_0_s0', 'KG'), '');
});
test('T551.4 missing PID (legacy plan / log without PID) => unavailable, no name or position guess', () => {
  const w = world({ logs: { log_1_1_0_s0: { carga: '80', reps: '10', done: true, unit: 'KG', exerciseNameSnapshot: 'Press banca' } }, ex: [{ exerciseName: 'Press banca' }] });
  assert.equal(reuse(w, 0), null); assert.equal(btn(w, 0), '');
  const w2 = world({ logs: W1(), ex: [{ exerciseName: 'Press banca' }] }); assert.equal(reuse(w2, 0), null, 'the current exercise has no PID');
});
test('T551.5 the same PID at several previous positions (ambiguous identity) => unavailable', () => {
  const w = world({ logs: Object.assign(W1(), { log_1_3_1_s0: set({}) }) }); assert.equal(reuse(w, 0), null);
});
test('T551.6 substituted exposure => unavailable (current or previous)', () => {
  assert.equal(reuse(world({ logs: Object.assign(W1(), { exsub_2_1_0: { nombre: 'Otro' } }) }), 0), null);
  assert.equal(reuse(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: null }) } }), 0), null);
});
test('T551.7 different plan => unavailable (the other plan\'s PIDs are different identities; its evidence is not in this plan\'s log)', () => {
  assert.equal(reuse(world({ logs: { log_1_1_0_s0: set({ prescriptionExerciseId: 'pid-of-plan-B' }) } }), 0), null);
  assert.ok(!fnSrc('_prevWeekReuse').includes('_getExerciseHistoryEntry') && !fnSrc('_prevWeekReuseHtml').includes('EXERCISE_HISTORY'), 'no cross-plan history fallback');
});
test('T551.8 Week 1 => unavailable', () => { assert.equal(reuse(world({ logs: W1(), week: 1 }), 0), null); assert.equal(btn(world({ logs: W1(), week: 1 }), 0), ''); });
test('T551.9 Week 3 with no Week 2 evidence => unavailable (exactly WEEK-1, no aggregation)', () => { assert.equal(reuse(world({ logs: W1(), week: 3 }), 0), null); });
test('T551.10 Express-only previous evidence => unavailable', () => {
  const ex = { log_1_1_0_s0: set({ express: true }), log_1_1_0_s1: set({ express: true }), log_1_1_0_s2: set({ expressFinal: true }) }; assert.equal(reuse(world({ logs: ex }), 0), null); assert.equal(reuse(world({ logs: ex }), 2), null);
});
test('T551.11 warm-up / autoFilled / undone previous sets are excluded', () => {
  for (const f of [{ warmup: true }, { autoFilled: true }, { done: false }]) assert.equal(reuse(world({ logs: { log_1_1_0_s0: set(f) } }), 0), null, JSON.stringify(f));
});
test('T551.12-14 only previous EXECUTED load/reps are copied: never observed RIR, never prescribed RIR, never ICS / Pump / notes / prescription', () => {
  const w = world({ logs: W1() }); w._prevWeekUse('log_2_1_0_s0');
  assert.equal(w.els['carga_log_2_1_0_s0'].value, '80'); assert.equal(w.els['reps_log_2_1_0_s0'].value, '10');
  assert.equal(w.els['rir_log_2_1_0_s0'].value, '', 'observed RIR (3) NOT copied'); assert.equal(w.calls.rir, 0, 'setRirReal never called (prescribed rir 2 / observed 3)');
  assert.equal(w.els['ics_log_2_1_0_s0'].value, '', 'ICS not copied');
  const r = reuse(w, 0); assert.deepEqual(Object.keys(r).sort(), ['load', 'n', 'reps', 'unit'], 'the reusable payload has no RIR / ICS / Pump / note field');
  const body = fnSrc('_prevWeekUse') + fnSrc('_prevWeekReuse') + fnSrc('_prevWeekReuseHtml');
  for (const bad of ['rir', 'ics', 'pump', 'setRirReal', 'rirTarget', 'repsTarget', 'coachNote', 'exnote_', 'exnotepid']) assert.ok(!new RegExp(bad, 'i').test(body.replace(/rir_real/g, '')) || bad === 'rir' && !/setRirReal|rir_real|\.rir\b|'rir_/.test(body), bad);
});
test('T551.15 athlete-explicit only: rendering the set card never fills the inputs; copy happens only inside the click handler', () => {
  const w = world({ logs: W1() }); btn(w, 0); w._buildSetReferenceHtml(null, null, 0, 'KG', 2, 2, undefined, 'log_2_1_0_s0');
  assert.equal(w.els['carga_log_2_1_0_s0'].value, ''); assert.equal(w.els['reps_log_2_1_0_s0'].value, '');
  assert.ok(/class="pw-use"[^>]*onclick="_prevWeekUse\('log_2_1_0_s0'\)"|onclick="_prevWeekUse\('log_2_1_0_s0'\)"[^>]*class="pw-use"/.test(btn(w, 0)));
  const card = SRC.slice(SRC.indexOf('function _buildExCard('), SRC.indexOf('function _buildExCard(') + 60000);
  assert.ok(/var carga\s*=\s*saved\.carga\s*\|\|\s*'';\s*var reps\s*=\s*saved\.reps\s*\|\|\s*'';\s*var rirReal\s*=\s*saved\.rir_real\|\|\s*'';/.test(card.replace(/\n\s*/g, ' ').replace(/\s+/g, ' ').replace(/ ;/g, ';')) || card.includes("var carga   = saved.carga   || '';"), 'inputs start from the athlete\'s own saved values only');
});
test('T551.16 NO autosave: the click handler never saves, completes a set or marks anything done', () => {
  const w = world({ logs: W1() }); const before = JSON.stringify(w.LOGS); w._prevWeekUse('log_2_1_0_s1');
  assert.equal(w.calls.save, 0); assert.equal(JSON.stringify(w.LOGS), before, 'LOGS untouched');
  const body = fnSrc('_prevWeekUse'); for (const bad of ['saveLogs', '_doSaveLogs', 'completeSet', 'setDoc', 'updateDoc', 'LOGS[', 'done']) assert.ok(!body.includes(bad), bad);
});
test('T551.17 current prescribed values stay unchanged by a reuse', () => {
  const w = world({ logs: W1() }); const before = JSON.stringify(w._EJERCICIOS_DIA); w._prevWeekUse('log_2_1_0_s0'); assert.equal(JSON.stringify(w._EJERCICIOS_DIA), before);
});
test('T551.18 the copied draft stays editable (plain input values; nothing locked, no handler on the inputs)', () => {
  const w = world({ logs: W1() }); w._prevWeekUse('log_2_1_0_s0'); w.els['carga_log_2_1_0_s0'].value = '82.5'; w.els['reps_log_2_1_0_s0'].value = '9';
  assert.equal(w.els['carga_log_2_1_0_s0'].value, '82.5'); assert.ok(!/readOnly|disabled|setAttribute|dataset/.test(fnSrc('_prevWeekUse')));
});
test('T551.19 PER-SET mapping: S1 -> prior S1, S2 -> prior S2; a missing prior set leaves the draft empty (never fanned out)', () => {
  const logs = { log_1_1_0_s0: set({ carga: '80', reps: '10' }), log_1_1_0_s1: set({ carga: '78', reps: '9' }) };   // no prior S3
  const w = world({ logs }); assert.deepEqual(reuse(w, 0), { n: 1, load: '80', unit: 'KG', reps: '10' }); assert.deepEqual(reuse(w, 1), { n: 2, load: '78', unit: 'KG', reps: '9' }); assert.equal(reuse(w, 2), null);
  w._prevWeekUse('log_2_1_0_s2'); assert.equal(w.els['carga_log_2_1_0_s2'].value, ''); assert.equal(w.els['reps_log_2_1_0_s2'].value, ''); assert.equal(btn(w, 2), '');
  w._prevWeekUse('log_2_1_0_s1'); assert.equal(w.els['carga_log_2_1_0_s1'].value, '78'); assert.equal(w.els['carga_log_2_1_0_s0'].value, '', 'other current sets untouched');
});
test('T551.20 partial prior evidence: only the field that exists is copied (nothing manufactured)', () => {
  const w = world({ logs: { log_1_1_0_s0: set({ carga: '', reps: '12' }) } }); w._prevWeekUse('log_2_1_0_s0'); assert.equal(w.els['carga_log_2_1_0_s0'].value, ''); assert.equal(w.els['reps_log_2_1_0_s0'].value, '12');
  assert.ok(btn(w, 0).includes('— × 12'));
});
test('T551.21 unit conversion: a LB prior set shown / copied in the current KG unit (explicit conversion only)', () => {
  const w = world({ logs: { log_1_1_0_s0: set({ carga: '100', unit: 'LB', reps: '8' }) } }); const html = btn(w, 0); assert.ok(/45\.4|45\.35|45\.5/.test(html), html);
});
test('T551.22 the OLD hint is gone: no ↩ SEM chip, no 📋 HISTORIAL chip, no prefill with RIR, no positional / name / history lookup in the hint path', () => {
  const body = fnSrc('_buildSetReferenceHtml'); assert.ok(!/↩ SEM|HISTORIAL|_prefillFromReference|histEx\.|prev\.rir_real|prev\.carga/.test(body));
  assert.ok(!SRC.includes('function _prefillFromReference('), 'the RIR-copying prefill helper is removed');
  const live = SRC.slice(SRC.indexOf('function _buildExCard('), SRC.indexOf('function _buildExCard(') + 60000);
  assert.ok(!/refHtml\s*=\s*_buildSetReferenceHtml\(prev,/.test(live) || /_buildSetReferenceHtml\(null, null/.test(live), 'the live card no longer feeds the positional `prev` record');
  assert.ok(!/var prev = LOGS\[prevKey\]/.test(live.split('function buildBoostcampExercise')[0]), 'no positional LOGS[prevKey] lookup in the live card');
});
test('T551.23 NOTE DEDUPLICATION: ÚLTIMA SEMANA = performance only; the previous note stays owned by the T549 history', () => {
  const logs = Object.assign(W1(), { exnotepid_1_pidA: { planId: 'planA', prescriptionExerciseId: 'pidA', week: 1, day: 1, exerciseIndex: 0, text: 'Me costó mantener técnica', updatedAt: 1 } });
  const html = world({ logs })._prevWeekHtml(1, 0); assert.ok(html.includes('S1 · 80 kg × 10 · RIR 3')); assert.ok(!/NOTA|Me costó|pw-n/.test(html));
  assert.ok(SRC.includes('NOTAS ANTERIORES DEL ALUMNO') && SRC.includes('function _exNoteHistoryHtml('), 'T549 history intact');
  assert.ok(!/exnote/.test(fnSrc('_prevWeekRef') + fnSrc('_prevWeekHtml')), 'the performance block no longer reads notes');
});
test('T551.24 PRESCRIPCIÓN · COACH stays separate from TU EJECUCIÓN; the reuse control is secondary (no lime, no glow)', () => {
  assert.ok(SRC.includes('TU EJECUCIÓN') && SRC.includes('PRESCRIPCIÓN'));
  const css = (SRC.match(/\.pw-use[a-z-]*\{[^}]*\}/g) || []).join(' '); assert.ok(css.length > 40 && !/gradient|box-shadow|text-shadow|accent-fill|accent\b/.test(css), css);
});
test('T551.25 user-facing help no longer describes the removed chips (↩ SEM / 📋 HISTORIAL appear only in code comments)', () => {
  const lines = SRC.split('\n').filter(l => /↩ SEM|📋 HISTORIAL/.test(l)); assert.ok(lines.every(l => l.trim().startsWith('//')), lines.join(' | ').slice(0, 200));
  assert.ok(SRC.includes('<strong>USAR CARGA/REPS</strong>') && SRC.includes('<strong>ÚLTIMA SEMANA</strong>'));
});
