// T488: previous-week execution alone never raises the prescribed/rendered set count above the
// Coach-authored plan. Current-session execution (started/resumed sets) is still preserved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const between = (a, b) => { const i = client.indexOf(a); assert.ok(i >= 0, a); const j = client.indexOf(b, i); assert.ok(j > i, b); return client.slice(i, j); };
const region = between('// ── Determinar numSeries', '// Para FST7: siempre exactamente 7 sets') +
  "if ((ej.technique || '').toLowerCase() === 'fst7') numSeries = Math.min(numSeries, (ej.sets || []).length || 7);";

function count({ planSets = 3, LOGS = {}, week = 3, numSeries: explicit }) {
  const ej = { prescriptionExerciseId: 'pid-A', sets: Array.from({ length: planSets }, (_, i) => ({ setIndex: i, repsTarget: 10 })) };
  const context = { LOGS, CURRENT_WEEK: week, di: 0, ei: 0, ej, progrec: null, _isY3T: false, _effectiveSets: [],
    numSeries: explicit === undefined ? planSets : explicit };
  vm.createContext(context);
  vm.runInContext(region + '\nthis.__n = numSeries;', context);
  return context.__n;
}
const sets = (week, n, day = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['log_' + week + '_' + day + '_0_s' + i, { carga: '80', reps: '8', done: true }]));

test('T488.1 last week executing 5 sets does not raise this week above the 3-set plan', () => {
  assert.equal(count({ planSets: 3, LOGS: sets(2, 5) }), 3);
  assert.equal(count({ planSets: 3, LOGS: sets(2, 4), week: 4 }), 3);
  assert.equal(count({ planSets: 3, LOGS: Object.assign(sets(1, 6), sets(2, 6)), week: 3 }), 3);
});

test('T488.2 a plan the Coach raises to 5 renders 5; lowering it to 2 renders 2', () => {
  assert.equal(count({ planSets: 5, LOGS: sets(2, 3) }), 5);
  assert.equal(count({ planSets: 2, LOGS: sets(2, 5) }), 2);
});

test('T488.3 sets already executed in the CURRENT session are never hidden (resume)', () => {
  assert.equal(count({ planSets: 3, LOGS: sets(3, 4) }), 4, 'athlete already logged 4 this session');
  assert.equal(count({ planSets: 4, LOGS: sets(3, 2) }), 4, 'remaining prescribed sets stay visible');
});

test('T488.4 historical LOGS are untouched (evidence is kept, not erased)', () => {
  const LOGS = Object.freeze(sets(2, 5));
  const before = JSON.stringify(LOGS);
  assert.equal(count({ planSets: 3, LOGS }), 3);
  assert.equal(JSON.stringify(LOGS), before);
});

test('T488.5 explicit per-exercise modification (exmod numSeries) still applies to its own week', () => {
  assert.equal(count({ planSets: 3, numSeries: 4 }), 4);
});

test('T488.6 no previous-week set-count carry-over remains in any renderer', () => {
  for (const gone of ['_lastWeekDone', '_lwdBC', '_lscBC', 'continuidad desde la semana anterior'])
    assert.ok(!client.includes(gone), gone);
  assert.ok(!/log_'\+\(CURRENT_WEEK-1\)\+'_'\+di\+'_'\+ei\+'_s'\+_ls/.test(client));
});
