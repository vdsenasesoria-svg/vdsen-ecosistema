'use strict';
// T592: client audit fixes. Pure helpers are extracted from vdsen-cliente.html and run in a vm; wiring is checked as static contracts and, separately, in the real browser (docs/T592_CLIENT_AUDIT.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function fnSrc(name) {
  const i = html.indexOf('function ' + name + '('); assert.ok(i >= 0, name + ' exists');
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
function sandbox(names, extra) {
  const ctx = Object.assign({ _exCatIdx: { src: null, at: 0, map: {} }, EXERCISE_CATALOG: {}, EXERCISE_CATALOG_BY_ID: {}, console, Date, Math, parseInt, parseFloat, isFinite, isNaN, String, Number, Array, Object, JSON }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(names.map(fnSrc).join('\n') + '\nthis.__x={' + names.map((n) => n + ':' + n).join(',') + '};', ctx);
  return { x: ctx.__x, ctx };
}

test('T592-1 performance entries (cardio / calisthenics / station / circuit): refused in preview and past weeks, and a repeated tap on the same entry is ignored', () => {
  const toasts = [];
  const { x, ctx } = sandbox(['_perfBlocked'], { CURRENT_WEEK: 2, REAL_WEEK: 1, showToast: (m, e) => toasts.push([m, e]), _perfTapLock: {} });
  assert.equal(x._perfBlocked('log_2_0_1'), true); assert.match(toasts[0][0], /Vista previa/);
  ctx.CURRENT_WEEK = 1; ctx.REAL_WEEK = 2;
  assert.equal(x._perfBlocked('log_1_0_1'), true); assert.match(toasts[1][0], /Semana pasada/);
  ctx.CURRENT_WEEK = 3; ctx.REAL_WEEK = 3;
  assert.equal(x._perfBlocked('log_3_0_1'), false, 'the current week writes');
  assert.equal(x._perfBlocked('log_3_0_1'), true, 'second tap within 700 ms on the same entry is ignored');
  assert.equal(x._perfBlocked('log_3_0_2'), false, 'another entry is independent');
  ctx.Date = { now: () => Date.now() + 1000 }; assert.equal(x._perfBlocked('log_3_0_1'), false, 'after the window the entry can be edited again');
});

test('T592-2 each of the four performance confirmations starts with the guard (the strength path already had its own)', () => {
  for (const f of ['completeCardio', 'completeCalisteniaSet', 'completeEstacionSet', 'completeCircuito']) assert.match(fnSrc(f).split('\n').slice(0, 3).join('\n'), /_perfBlocked\(key\)/, f);
  assert.match(fnSrc('completeSet').slice(0, 600), /REAL_WEEK/);
});

test('T592-3 series counters: cardio is never a strength series (statistics), the planned total excludes it, and cardio is reported apart', () => {
  const { x } = sandbox(['_calcSessionStats', '_dayTotals', '_progressText', '_getExType', '_exNormKey', '_exHasCardioPattern', '_exCatPatternIndex'], { isTechniqueActive: () => true });
  const logs = { log_1_0_0_s0: { done: true, rir_real: 2, ics: 8, ts: 1000 }, log_1_0_0_s1: { done: true, rir_real: 1, ics: 8, ts: 2000 }, log_1_0_1: { done: true, exType: 'cardio', duracionMin: 30, rpe: 6, ts: 3000 }, log_1_0_2_s0: { done: true, autoFilled: true } };
  const st = JSON.parse(JSON.stringify(x._calcSessionStats(logs, 0, 1)));
  assert.equal(st.strengthSets, 2); assert.equal(st.cardioDone, 1); assert.equal(st.completedSets, 3, 'completedSets keeps its historical meaning (any executed entry): session flows depend on it');
  assert.equal(st.avgRIR, 1.5); assert.equal(st.avgICS, 8);
  const ses = { exercises: [{ numSeries: 3, sets: [{}, {}, {}] }, { exerciseType: 'cardio', numSeries: 1, sets: [] }, { numSeries: 2, sets: [{}, {}] }] };
  assert.deepEqual(JSON.parse(JSON.stringify(x._dayTotals(ses, 1))), { sets: 5, cardio: 1 });
  assert.equal(x._progressText(2, 5, 1, 1), '2/5 series · 1/1 cardio');
  assert.equal(x._progressText(0, 0, 0, 1), '0/1 cardio', 'a cardio-only day never says "0/0 series"');
  assert.equal(x._progressText(3, 3, 0, 0), '3/3 series'); assert.equal(x._progressText(0, 0, 0, 0), '0/0 series');
  assert.deepEqual(JSON.parse(JSON.stringify(x._dayTotals({ exercises: [{ exerciseType: 'cardio' }, { exerciseType: 'cardio' }] }, 1))), { sets: 0, cardio: 2 });
});

test('T592-4 every series display uses the strength numbers (home status, both dashboards, partial-close text); the rail keeps the whole session', () => {
  assert.equal((html.match(/home\.progress\.completedSets/g) || []).length, 0, 'home status no longer prints the mixed counter');
  assert.ok((html.match(/_progressText\(home\.progress\.strengthDone/g) || []).length >= 3);
  assert.equal((html.match(/_sesStats\.strengthSets \+ '\/' \+ _sesTotSets/g) || []).length, 2, 'both dashboards');
  assert.ok(!/_statCell\(_sesStats\.completedSets \+ '\/' \+ _sesTotSets/.test(html));
  assert.match(html, /aria-label="Progreso de la sesión" aria-valuemin="0" aria-valuemax="' \+ \(_sesTotSets \+ _dt\.cardio\)/);
  assert.match(fnSrc('_endSessionAsPartial'), /_progressText/);
});

test('T592-5 the cardio classification is cheap enough for hot paths (indexed catalog, not a scan per call)', () => {
  const CAT = {}; for (let i = 0; i < 600; i++) CAT['ejercicio número ' + i] = { motorPattern: i % 50 === 0 ? 'Cardio' : 'Empuje' };
  const { x } = sandbox(['_getExType', '_exNormKey', '_exHasCardioPattern', '_exCatPatternIndex'], { EXERCISE_CATALOG: CAT });
  const t0 = Date.now(); let cardio = 0;
  for (let i = 0; i < 30000; i++) if (x._getExType({ exerciseName: 'Ejercicio Número ' + (i % 600) }) === 'cardio') cardio++;
  const ms = Date.now() - t0;
  assert.equal(cardio, 30000 / 600 * 12, 'every 50th catalog entry is cardio (12 of 600)'); assert.ok(ms < 1500, '30000 classifications in ' + ms + ' ms');
});

test('T592-6 touch targets: the session banner buttons and the profile switches reach 44 px without changing the layout', () => {
  const banner = html.split('\n').filter((l) => /(Reabrir|Ver Resumen)<[/]button>/.test(l));
  assert.ok(banner.length >= 4); for (const l of banner) assert.match(l, /min-height:44px/);
  assert.match(html, /button\[onclick\^="setRestTimerDisabled"\]::before[^}]*inset:-7px -4px/);
  for (const n of ['setRestTimerDisabled', 'toggleLightMode', 'setExpressDisabled']) assert.ok(html.includes('button[onclick^="' + n + '"]{position:relative}') || html.includes('button[onclick^="' + n + '"],'), n);
});
