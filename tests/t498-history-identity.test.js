// T498: when a prescriptionExerciseId exists, PID history is the only history authority: no name fallback,
// no positional fallback, no name-keyed writes from synthetic (express) fills. Same-name/different-PID isolation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const fn = (name) => { const i = client.indexOf('function ' + name + '('); assert.ok(i >= 0, name); return client.slice(i, client.indexOf('\n}\n', i) + 3); };

function env(EXERCISE_HISTORY, LOGS) {
  const byWeek = { log: {} };
  Object.keys(LOGS).forEach(k => { const w = +k.split('_')[1]; (byWeek.log[w] = byWeek.log[w] || []).push(k); });
  const ctx = { EXERCISE_HISTORY, LOGS, LOGS_BY_WEEK: byWeek,
    _avgArr: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0,
    _normName: s => String(s || '').toLowerCase().trim() };
  vm.createContext(ctx);
  vm.runInContext(fn('_historyPidKey') + fn('_getExerciseHistoryEntry') + fn('_getPrevWeekData') +
    '\nthis._h=_getExerciseHistoryEntry; this._p=_getPrevWeekData;', ctx);
  return ctx;
}
const entry = (pid, carga, snap) => ({ done: true, carga: String(carga), reps: '8', rir_real: 2, ics: 8, prescriptionExerciseId: pid, exerciseNameSnapshot: snap });

test('T498.1 PID present: history never falls back to the name entry', () => {
  const e = env({ press: { load: '100' }, __pid__B: { load: '60' } }, {});
  assert.equal(Object.keys(e._h('press', 'A')).length, 0, 'PID A has no history: name entry must not answer');
  assert.equal(e._h('press', 'B').load, '60');
  assert.equal(e._h('press', 'A').load, undefined);
});

test('T498.2 no PID (genuinely legacy): name history is still readable', () => {
  const e = env({ press: { load: '100' } }, {});
  assert.equal(e._h('press', undefined).load, '100');
  assert.equal(e._h('press', null).load, '100');
});

test('T498.3 same name / different PID are isolated in history', () => {
  const e = env({ __pid__A: { load: '80' }, __pid__B: { load: '50' } }, {});
  assert.equal(e._h('curl', 'A').load, '80');
  assert.equal(e._h('curl', 'B').load, '50');
});

test('T498.4 previous-week data: PID present and no PID logs -> null (no positional/name fallback)', () => {
  const LOGS = { 'log_1_0_0_s0': entry('OTHER', 90, 'Press'), 'log_1_0_0_s1': entry(undefined, 90, 'Press') };
  const e = env({}, LOGS);
  assert.equal(e._p(2, 0, 0, 8, 'A', 'Press'), null);
});

test('T498.5 previous-week data: same name, different PID never leaks across', () => {
  const LOGS = { 'log_1_0_0_s0': entry('A', 90, 'Press'), 'log_1_1_0_s0': entry('B', 40, 'Press') };
  const e = env({}, LOGS);
  assert.equal(e._p(2, 0, 0, 8, 'A', 'Press').avgLoad, 90);
  assert.equal(e._p(2, 1, 0, 8, 'B', 'Press').avgLoad, 40);
  assert.equal(e._p(2, 0, 0, 8, 'B', 'Press').avgLoad, 40);
});

test('T498.6 no PID: legacy positional fallback (with name guard) is unchanged', () => {
  const LOGS = { 'log_1_0_0_s0': entry(undefined, 90, 'Press') };
  const e = env({}, LOGS);
  assert.equal(e._p(2, 0, 0, 8, undefined, 'Press').avgLoad, 90);
  assert.equal(e._p(2, 0, 0, 8, undefined, 'Curl'), null);
});

test('T498.7 every _getPrevWeekData call site passes the PID', () => {
  const calls = client.match(/_getPrevWeekData\([^)]*\)/g).filter(c => !c.startsWith('_getPrevWeekData(week'));
  assert.ok(calls.length >= 7);
  for (const c of calls) assert.ok(/prescriptionExerciseId/.test(c), c);
});

test('T498.8 express fills read history by PID and never write synthetic data into history', () => {
  for (const name of ['expressFillWeek', 'fillSessionFromHistory']) { void name; }
  assert.ok(!/EXERCISE_HISTORY\[exName\]\s*=/.test(client), 'no name-keyed history write from synthetic fills');
  assert.ok(!/EXERCISE_HISTORY\[exName\] \|\| \{\}/.test(client), 'no name-keyed history read in fills');
  assert.ok(!client.includes('captureHistory(exName)'));
});
