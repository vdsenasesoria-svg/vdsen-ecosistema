'use strict';
// T549: athlete exercise notes persist week to week, bound to the stable prescription identity (planId + PID + week), read-only history for prior weeks.
// Storage: ADDITIVE keys inside the existing logs entries (`exnotepid_{week}_{PID}` object) + the Coach-compatible per-week string mirror `exnote_{W}_{D}_{E}`.
// No new collection, no name matching, no position identity (position only for pre-T549 legacy evidence that has no PID).
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
const FNS = ['_exNotePidKey', '_exNoteCtx', '_exNoteValid', '_exNoteShadowed', '_exNoteCurrent', '_exNoteHistory', '_exNoteHistoryHtml', '_getExNote', 'saveUserNote'];
function world(o) {
  o = o || {};
  const calls = { save: 0, refresh: 0, toast: 0 };
  const ctx = {
    console, Number, Math, JSON, Date, Object, Array, String, parseInt, isNaN,
    LOGS: o.logs || {}, ACTIVE_PLAN_ID: o.planId || 'planA', CURRENT_WEEK: o.week || 1, REAL_WEEK: o.week || 1,
    _EJERCICIOS_DIA: o.ex || [{ prescriptionExerciseId: 'pidA', exerciseName: 'Press banca', coachNote: 'Baja 3 s' }, { prescriptionExerciseId: 'pidB', exerciseName: 'Remo' }],
    _escHTml: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    saveLogs() { calls.save++; }, _refreshExPanelOnly() { calls.refresh++; }, showToast() { calls.toast++; },
  };
  ctx.window = ctx; vm.createContext(ctx);
  for (const f of FNS) vm.runInContext(fnSrc(f), ctx);
  return { ctx, calls, at(week, ei, text, di) { ctx.CURRENT_WEEK = week; ctx.saveUserNote(di === undefined ? 1 : di, ei, text); } };
}
const hist = (w, ei, di) => JSON.parse(JSON.stringify(w.ctx._exNoteHistory(w.ctx.LOGS, w.ctx._exNoteCtx(di === undefined ? 1 : di, ei))));
const cur = (w, ei, di) => w.ctx._getExNote(di === undefined ? 1 : di, ei);

test('T549.1 a saved note carries planId + PID + week + day + name snapshot + text + timestamp (additive key, no new collection)', () => {
  const w = world(); w.at(1, 0, '  Molestia leve al final del rango  ');
  const v = w.ctx.LOGS['exnotepid_1_pidA'];
  assert.ok(v, 'stored under the PID + week key');
  assert.equal(v.planId, 'planA'); assert.equal(v.prescriptionExerciseId, 'pidA'); assert.equal(v.week, 1); assert.equal(v.day, 1);
  assert.equal(v.exerciseNameSnapshot, 'Press banca'); assert.equal(v.text, 'Molestia leve al final del rango'); assert.ok(Number.isFinite(v.updatedAt) && v.updatedAt > 0);
  assert.equal(w.ctx.LOGS['exnote_1_1_0'], 'Molestia leve al final del rango', 'Coach-compatible per-week string mirror (existing reader format)');
  assert.equal(w.calls.save, 1);
  assert.ok(!/collection\([^)]*['"]exnote|exnotes?['"]\s*\)/i.test(fnSrc('saveUserNote')), 'no new collection');
});
test('T549.2 Week 1 note is visible in Week 2 for the same PID (read-only history); the Week 2 input starts empty', () => {
  const w = world(); w.at(1, 0, 'Mejor control con 80 kg'); w.ctx.CURRENT_WEEK = 2;
  const h = hist(w, 0); assert.equal(h.length, 1); assert.equal(h[0].week, 1); assert.equal(h[0].text, 'Mejor control con 80 kg'); assert.equal(h[0].day, 1);
  assert.equal(cur(w, 0), '', 'current week note is separate from history');
});
test('T549.3 Week 1 + Week 2 are both visible in Week 3', () => {
  const w = world(); w.at(1, 0, 'n1'); w.at(2, 0, 'n2'); w.ctx.CURRENT_WEEK = 3;
  assert.deepEqual(hist(w, 0).map(x => [x.week, x.text]), [[2, 'n2'], [1, 'n1']]);
});
test('T549.4 history is newest-first', () => {
  const w = world(); for (const k of [3, 1, 4, 2]) w.at(k, 0, 'n' + k); w.ctx.CURRENT_WEEK = 5;
  assert.deepEqual(hist(w, 0).map(x => x.week), [4, 3, 2, 1]);
});
test('T549.5 a different PID never sees the note (even at the same position or the same name)', () => {
  const w = world(); w.at(1, 0, 'solo pidA'); w.ctx.CURRENT_WEEK = 2;
  assert.equal(hist(w, 1).length, 0, 'other exercise: its own (empty) history');
  w.ctx._EJERCICIOS_DIA = [{ prescriptionExerciseId: 'pidZ', exerciseName: 'Press banca' }, w.ctx._EJERCICIOS_DIA[1]];   // same NAME + same POSITION, other PID
  assert.equal(hist(w, 0).length, 0, 'no name-based and no position-based match');
});
test('T549.6 a different plan never sees the note', () => {
  const w = world(); w.at(1, 0, 'plan A note'); w.ctx.CURRENT_WEEK = 2; w.ctx.ACTIVE_PLAN_ID = 'planB';
  assert.equal(hist(w, 0).length, 0); assert.equal(cur(w, 0), '');
});
test('T549.7 a different client cannot see the note: history resolves only from the signed-in athlete\'s own entries (the log doc is per uid); rules covered by t549-note-isolation.cjs', () => {
  const a = world(); a.at(1, 0, 'athlete A private');
  const b = world(); b.ctx.CURRENT_WEEK = 2;   // athlete B has his own LOGS object: nothing of A's
  assert.equal(hist(b, 0).length, 0);
  assert.ok(fs.readFileSync('tests/t549-note-isolation.cjs', 'utf8').includes('other athlete'));
});
test('T549.8 editing Week 2 never mutates Week 1; clearing the current week deletes ONLY the current week', () => {
  const w = world(); w.at(1, 0, 'week one'); const before = JSON.stringify(w.ctx.LOGS['exnotepid_1_pidA']);
  w.at(2, 0, 'week two'); w.at(2, 0, 'week two edited');
  assert.equal(JSON.stringify(w.ctx.LOGS['exnotepid_1_pidA']), before); assert.equal(w.ctx.LOGS['exnote_1_1_0'], 'week one');
  w.at(2, 0, '   ');
  assert.ok(!w.ctx.LOGS['exnotepid_2_pidA'] && !w.ctx.LOGS['exnote_2_1_0'], 'current week cleared (existing empty = delete semantics, current week only)');
  assert.equal(JSON.stringify(w.ctx.LOGS['exnotepid_1_pidA']), before, 'Week 1 intact'); w.ctx.CURRENT_WEEK = 2; assert.equal(hist(w, 0)[0].text, 'week one');
});
test('T549.9 Coach note stays separate: labels, no merging, athlete history never rendered with Coach styling', () => {
  const w = world(); w.at(1, 0, 'mi nota'); w.ctx.CURRENT_WEEK = 2;
  const html = w.ctx._exNoteHistoryHtml(1, 0);
  assert.ok(html.includes('NOTAS ANTERIORES DEL ALUMNO') && html.includes('mi nota')); assert.ok(!/cnote|NOTA DEL COACH|NOTA COACH/.test(html));
  assert.ok(!w.ctx.LOGS['exnotepid_1_pidA'].text.includes('Baja 3 s'), 'the Coach prescription note is never copied into the athlete note');
  assert.ok(SRC.includes('NOTA DEL ALUMNO') && SRC.includes('class="cnote-l">NOTA DEL COACH'), 'distinct labels');
});
test('T549.10 no name-based matching: the resolver never reads a name (snapshot is display/provenance only)', () => {
  const body = fnSrc('_exNoteHistory') + fnSrc('_exNoteCurrent') + fnSrc('_exNoteShadowed');
  assert.ok(!/exerciseName|nombre|toLowerCase|normalize|localeCompare|_normName/.test(body), 'no name comparison in identity resolution');
  const w = world({ ex: [{ prescriptionExerciseId: 'pidX', exerciseName: 'Press banca' }] });
  w.ctx.LOGS['exnotepid_1_other'] = { planId: 'planA', prescriptionExerciseId: 'other', week: 1, day: 1, exerciseNameSnapshot: 'Press banca', text: 'same name, other PID', updatedAt: 1 };
  w.ctx.CURRENT_WEEK = 2; assert.equal(hist(w, 0).length, 0);
});
test('T549.11 reload preserves note history (the notes are plain logs entries: JSON round trip)', () => {
  const w = world(); w.at(1, 0, 'a'); w.at(2, 0, 'b');
  const reloaded = world({ logs: JSON.parse(JSON.stringify(w.ctx.LOGS)), week: 3 });
  assert.deepEqual(hist(reloaded, 0).map(x => x.text), ['b', 'a']);
  w.ctx.CURRENT_WEEK = 2; assert.equal(cur(w, 0), 'b', 'current week note survives');
});
test('T549.12 missing history produces no empty-history chrome', () => {
  const w = world(); w.ctx.CURRENT_WEEK = 2; assert.equal(w.ctx._exNoteHistoryHtml(1, 0), '');
  w.at(2, 0, 'only current'); assert.equal(w.ctx._exNoteHistoryHtml(1, 0), '', 'a current-week note alone is not "history"');
});
test('T549.13 latest 3 shown, the rest behind "Ver historial completo"; long text is clamped; V3 tokens only', () => {
  const w = world(); for (let k = 1; k <= 5; k++) w.at(k, 0, 'nota ' + k); w.ctx.CURRENT_WEEK = 6;
  const html = w.ctx._exNoteHistoryHtml(1, 0);
  assert.equal((html.match(/class="un-hi"/g) || []).length, 5); assert.equal((html.match(/data-more="1"/g) || []).length, 2);
  assert.ok(html.includes('Ver historial completo (5)')); assert.ok(html.indexOf('SEM 5') < html.indexOf('SEM 4') && html.indexOf('SEM 1') > html.indexOf('SEM 3'));
  const css = (SRC.match(/\.un-h[a-z-]*\{[^}]*\}/g) || []).join(' '); assert.ok(css.length > 40 && !/gradient|box-shadow|text-shadow/.test(css) && /line-clamp/.test(css));
  const w3 = world(); w3.at(1, 0, 'x'); w3.ctx.CURRENT_WEEK = 2; assert.ok(!w3.ctx._exNoteHistoryHtml(1, 0).includes('Ver historial'), 'no toggle for <= 3');
});
test('T549.14 PID-less legacy evidence keeps ONLY the established position fallback (exnote_W_D_E / exnote_D_E), no fuzzy matching', () => {
  const w = world({ ex: [{ exerciseName: 'Legacy ex' }], logs: { exnote_1_1_0: 'legacy w1', exnote_1_0: 'legacy sin semana', exnote_1_1_1: 'otra posicion' } }); w.ctx.CURRENT_WEEK = 2;
  assert.deepEqual(hist(w, 0).map(x => [x.week, x.text]), [[1, 'legacy w1'], [null, 'legacy sin semana']]);
  w.at(2, 0, 'nuevo'); assert.ok(!w.ctx.LOGS['exnotepid_2_undefined'], 'no PID => no PID key');
  assert.equal(w.ctx.LOGS['exnote_2_1_0'], 'nuevo'); assert.equal(w.ctx.LOGS['exnote_1_0'], 'legacy sin semana', 'the un-weeked legacy note is never overwritten');
});
test('T549.15 the Coach-compatible mirror is not double-listed as history (shadowed by the PID entry)', () => {
  const w = world(); w.at(1, 0, 'once'); w.ctx.CURRENT_WEEK = 2; assert.equal(hist(w, 0).length, 1);
  w.ctx._EJERCICIOS_DIA = [{ prescriptionExerciseId: 'pidOther' }, w.ctx._EJERCICIOS_DIA[1]];
  assert.equal(hist(w, 0).length, 0, 'the mirror at this position belongs to a PID note, so it never leaks to the PID now sitting there');
});
test('T549.16 PID wins over day/order: provenance of the original week/day is kept', () => {
  const w = world(); w.at(1, 0, 'moved', 3); w.ctx.CURRENT_WEEK = 2;
  const h = JSON.parse(JSON.stringify(w.ctx._exNoteHistory(w.ctx.LOGS, w.ctx._exNoteCtx(0, 0))));   // same PID now on day 0
  assert.equal(h.length, 1); assert.equal(h[0].day, 3); assert.ok(w.ctx._exNoteHistoryHtml(0, 0).includes('SEM 1') && w.ctx._exNoteHistoryHtml(0, 0).includes('D4'));
});
test('T549.17 UI wiring: history rendered in both card builders; labels; no athlete write to anything but entries; progression untouched', () => {
  assert.equal((SRC.match(/_exNoteHistoryHtml\(di, ?ei\)/g) || []).length >= 2, true);
  assert.ok(SRC.includes('NOTA DEL ALUMNO'));
  const body = fnSrc('saveUserNote'); for (const bad of ['progrec', 'progressionApplications', 'setDoc(', 'updateDoc(', 'markSessionDone', 'completeSet']) assert.ok(!body.includes(bad), bad);
  assert.ok(SRC.includes('NUMERIC_APPLY_ENABLED') && !/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(SRC));
});
