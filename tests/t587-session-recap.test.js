'use strict';
// T587 / FASE C: the final session recap. Pure helpers are extracted from vdsen-cliente.html and run in a vm sandbox; the DOM wiring is checked as a static contract and in the real browser (docs/T587_SESSION_RECAP.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function fnSrc(name) {
  let i = html.indexOf('function ' + name + '('); assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = html.indexOf('{', i); k < html.length; k++) {
    const c = html[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && html[k + 1] === '/') { k = html.indexOf('\n', k); continue; }
    if (c === '/' && html[k + 1] === '*') { k = html.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return html.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const PURE = ['_recapNum', '_recapFmtNum', '_recapJoin', '_recapRestFmt', '_recapDate', '_recapBuild', '_recapPaginate'];
function sandbox(extra) {
  const ctx = Object.assign({ console, Date, Math, parseInt, parseFloat, isFinite, String, Number, Array, Object, JSON }, extra || {});
  vm.createContext(ctx); vm.runInContext(PURE.map(fnSrc).join('\n') + '\n' + (extra && extra.__collect ? fnSrc('_recapCollect') : '') + '\nthis.__x={' + PURE.map((n) => n + ':' + n).join(',') + (extra && extra.__collect ? ',_recapCollect:_recapCollect' : '') + '};', ctx);
  return ctx.__x;
}
const J = (o) => JSON.parse(JSON.stringify(o));
const set = (o) => Object.assign({ done: true, reps: '10', carga: '100', unit: 'KG', rir_real: 2, ics: 8 }, o);
const R = sandbox();

test('T587-R1 per exercise: real sets, reps, load + unit, RIR, ICS; a uniform exercise reads compactly, differing sets read per set', () => {
  const o = J(R._recapBuild({ sessionName: 'Empuje', week: 2, dateMs: Date.parse('2026-10-20T12:00:00Z'), exercises: [
    { name: 'Press', sets: [set(), set(), set()], prescribedRest: 90, note: 'sin molestias' },
    { name: 'Curl', sets: [set({ reps: '12', carga: '40', rir_real: 3, ics: 9 }), set({ reps: '10', carga: '40', rir_real: 2, ics: 8 }), set({ reps: '8', carga: '35', rir_real: 1, ics: 7 })] }] }));
  assert.deepEqual([o.totals.exercises, o.totals.sets], [2, 6]);
  assert.deepEqual([o.rows[0].sets, o.rows[0].repsText, o.rows[0].loadText, o.rows[0].rirText, o.rows[0].icsText, o.rows[0].restText, o.rows[0].restLabel, o.rows[0].note], [3, '10 reps', '100 kg', 'RIR 2', 'ICS 8', '1:30', 'Descanso prescrito', 'sin molestias']);
  assert.deepEqual([o.rows[1].repsText, o.rows[1].loadText, o.rows[1].rirText, o.rows[1].icsText], ['12·10·8 reps', '40·40·35 kg', 'RIR 3·2·1', 'ICS 8']);
  assert.ok(o.dateText.includes('2026') && o.dateText.length > 6);
});

test('T587-R2 NOTHING IS INVENTED: missing reps / load / RIR / ICS / rest / note are omitted, never filled; the rest is only ever labelled PRESCRIBED; suggested values never appear', () => {
  const o = J(R._recapBuild({ exercises: [{ name: 'Sin datos', sets: [{ done: true }, { done: true }] }, { name: 'Solo carga', sets: [set({ reps: '', ics: '', rir_real: '' })], note: '   ' }] }));
  const a = o.rows[0], b = o.rows[1];
  assert.deepEqual([a.repsText, a.loadText, a.rirText, a.icsText, a.restText, a.restLabel, a.note], ['', '', '', '', '', '', '']); assert.equal(a.sets, 2);
  assert.deepEqual([b.repsText, b.loadText, b.rirText, b.icsText, b.note], ['', '100 kg', '', '', '']);
  assert.equal(R._recapBuild({ exercises: [{ name: 'x', sets: [] }, { name: 'y' }] }).rows.length, 0, 'an exercise without executed sets is not listed');
  assert.equal(R._recapBuild({ exercises: [{ name: 'x', sets: [set()], prescribedRest: 0 }] }).rows[0].restLabel, '', 'rest 0 / unknown: no rest line at all');
});

test('T587-R3 units are never mixed into one number; decimals use the app format; express sets are tagged and keep only the observations the athlete really gave', () => {
  const o = J(R._recapBuild({ exercises: [{ name: 'Mixto', sets: [set({ carga: '100', unit: 'KG' }), set({ carga: '225', unit: 'LB' })] }, { name: 'Decimal', sets: [set({ carga: '102.5' })] },
    { name: 'Express', sets: [set({ express: true, rir_real: '', ics: '' }), set({ expressFinal: true, rir_real: 2, ics: 9 })] }] }));
  assert.equal(o.rows[0].loadText, '100 kg · 225 lb'); assert.equal(o.rows[1].loadText, '102,5 kg');
  assert.equal(o.rows[2].express, true); assert.equal(o.rows[2].rirText, 'RIR 2'); assert.equal(o.rows[2].icsText, 'ICS 9');
});

test('T587-R4 helpers: rest format, number format, compact join', () => {
  assert.deepEqual([R._recapRestFmt(90), R._recapRestFmt(120), R._recapRestFmt(45), R._recapRestFmt('x'), R._recapRestFmt(0)], ['1:30', '2:00', '45 s', '', '']);
  assert.deepEqual([R._recapFmtNum(100), R._recapFmtNum(7.5), R._recapFmtNum(7.25), R._recapFmtNum(8.001)], ['100', '7,5', '7,25', '8']);
  assert.equal(R._recapJoin([10, 10, 10]), '10'); assert.equal(R._recapJoin([10, null, 8]), '10·8'); assert.equal(R._recapJoin([null]), '');
  assert.equal(R._recapDate(0), ''); assert.equal(R._recapDate('x'), '');
});

test('T587-R5 pagination: measured blocks are packed in order, never split or shrunk; a very tall block stands alone; empty is one empty page', () => {
  assert.deepEqual(J(R._recapPaginate([100, 100, 100, 100], 250)), [[0, 1], [2, 3]]);
  assert.deepEqual(J(R._recapPaginate([100, 100, 100], 1000)), [[0, 1, 2]], 'a habitual session fits one screen');
  assert.deepEqual(J(R._recapPaginate([80, 900, 80], 400)), [[0], [1], [2]], 'an oversized block is alone, not cut');
  assert.deepEqual(J(R._recapPaginate([], 400)), [[]]);
  const heights = Array.from({ length: 12 }, (_, i) => 70 + (i % 3) * 20), pages = R._recapPaginate(heights, 640);
  assert.deepEqual(J(pages).flat(), heights.map((_, i) => i), 'every block appears exactly once, in order'); assert.ok(pages.length >= 2);
});

test('T587-R6 collection from the logbook: only DONE, non-autofilled sets; substituted name; prescribed rest; note by PID (legacy fallback); date from the post-session; other weeks / days never leak', () => {
  const LOGS = {
    log_2_0_0_s0: set({ ts: 1000 }), log_2_0_0_s1: set({ ts: 2000 }), log_2_0_0_s2: set({ done: false }), log_2_0_0_s3: set({ autoFilled: true }),
    log_2_0_1_s0: set({ reps: '12', ts: 3000 }), exsub_2_0_1: { nombre: 'Curl sustituto' },
    log_3_0_0_s0: set({ reps: '99' }), log_2_1_0_s0: set({ reps: '77' }),
    postsession_2_0: { ts: 1792400000000, eimd: 2 }, exnote_2_0_1: 'nota legado' };
  LOGS['exnotepid_2_pid-A'] = { text: 'nota por PID' };
  const ses = [{ dia: 'DÍA 1 — Empuje', exercises: [{ nombre: 'Press', prescriptionExerciseId: 'pid-A', numSeries: 4, sets: [{ restSeconds: 150 }] }, { nombre: 'Curl', prescriptionExerciseId: 'pid-B', sets: [{ restSeconds: 60 }] }, { nombre: 'Sin series', sets: [{}] }] }];
  const sb = sandbox({ __collect: true, LOGS, getSesiones: () => ses, isTechniqueActive: () => true, _getExType: () => 'fuerza', _stripDayNo: (x) => x });
  const d = J(sb._recapCollect(0, 2));
  assert.equal(d.sessionName, 'Empuje');
  const dash = sandbox({ __collect: true, LOGS: {}, getSesiones: () => [{ dia: 'Día 1 - Empuje', exercises: [] }, { dia: 'SESIÓN 2: — ', exercises: [] }], isTechniqueActive: () => true, _getExType: () => 'fuerza', _stripDayNo: (v) => v });
  assert.equal(J(dash._recapCollect(0, 1)).sessionName, 'Empuje', 'a leading hyphen left by the day prefix is removed'); assert.equal(J(dash._recapCollect(1, 1)).sessionName, 'Sesión', 'an empty name falls back'); assert.deepEqual(d.exercises.map((e) => [e.name, e.sets.length, e.prescribedRest, e.note]), [['Press', 2, 150, 'nota por PID'], ['Curl sustituto', 1, 60, 'nota legado'], ['Sin series', 0, null, '']]);
  assert.equal(d.dateMs, 1792400000000); assert.ok(d.exercises[0].sets.every((s) => s.reps === '10'), 'week 3 / day 1 values did not leak');
  assert.equal(sb._recapCollect(5, 2), null);
});

test('T587-R7 READ-ONLY contract (static): the recap never saves, never triggers progression, never writes Firestore; one overlay at a time; reopened from the session header', () => {
  const body = ['openSessionRecap', '_recapLayout', '_recapRender', '_recapGo', '_recapCapture', 'closeSessionRecap', '_recapCollect', '_recapBuild', '_recapRowHtml'].map(fnSrc).join('\n');
  assert.ok(!/_doSaveLogs|_scheduleTrustedProgression|calculateProgression|_confirmSessionDone|setDoc|updateDoc|FB\.|fetch\(|localStorage|LOGS\[[^\]]+\]\s*=[^=]/.test(body), 'no writes, no fetch, no progression');
  assert.match(fnSrc('openSessionRecap'), /getElementById\('sessRecap'\)[\s\S]*?\.remove\(\)/, 'an existing overlay is replaced (never two)');
  assert.match(html, /if \(_saved !== false\) showSessionSummary\(di\);/, 'still only after a successful save');
  assert.match(fnSrc('showSessionSummary'), /openSessionRecap\(di, CURRENT_WEEK, \{ auto: true \}\)[\s\S]*?_showSessionSummaryCard\(di\)/, 'recap first, legacy card only as a fallback');
  assert.equal((html.match(/openSessionRecap\('\+DIA_ACTIVO\+'\)/g) || []).length, 2, 'RESUMEN button for completed and partial sessions');
  assert.ok(!/_buildProgreSummaryHtml/.test(fnSrc('openSessionRecap') + fnSrc('_recapRowHtml')), 'the Client recommendation is not shown in the recap (the server is the authority)');
});

test('T587-R8 capture mode (static): full screen above the navigation, no controls except the page counter, tap to page, official logo crop reused, no new typefaces', () => {
  const css = /\/\* T587 · session recap[\s\S]*?\n@media \(max-width:359px\)\{#sessRecap[^\n]*\n/.exec(html)[0];
  assert.match(css, /#sessRecap\{position:fixed;inset:0;z-index:2147483000/); assert.match(css, /#sessRecap\[data-capture="1"\] \.rc-foot/); assert.match(css, /\.rc-head \.brand-word\{height:22px\}/);
  assert.ok(!/font-family:\s*['"]/.test(css), 'only the existing tokens var(--font-display) / var(--font-num)');
  assert.match(fnSrc('_recapRender'), /st\.capture\s*\?\s*dots/); assert.match(fnSrc('_recapRender'), /ov\.onclick = st\.capture/);
  assert.match(fnSrc('openSessionRecap'), /class="brand-word" aria-label="VDSEN"/, 'the logo is the existing official-artwork crop, not redrawn');
});
