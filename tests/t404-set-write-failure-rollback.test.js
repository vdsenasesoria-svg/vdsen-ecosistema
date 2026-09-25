const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('async function completeSet(key, di, ei, si, unit) {');
assert.notEqual(start, -1, 'completeSet exists');
let depth = 0;
const brace = client.indexOf('{', start);
let end = brace;
for (; end < client.length; end++) {
  if (client[end] === '{') depth++;
  if (client[end] === '}' && --depth === 0) break;
}
const completeSetSource = client.slice(start, end + 1);

function makeRuntime() {
  return new Function(`
    var CURRENT_WEEK = 1, REAL_WEEK = 1, DIA_ACTIVO = 0, EJ_ACTIVO = 0;
    var LOGS = {}, EXERCISE_HISTORY = {}, LOGS_BY_WEEK = { log: { 1: [] } }, _saveLogsTimer = null;
    var _EJERCICIOS_DIA = [
      { exerciseName: 'Press', prescriptionExerciseId: 'pid-press', sets: [{ restSeconds: 0 }] },
      { exerciseName: 'Remo', prescriptionExerciseId: 'pid-row', sets: [{ restSeconds: 0 }] }
    ];
    var window = {}, navigator = {};
    var elements = {
      carga_log_1_0_0_s0: { value: '80' }, reps_log_1_0_0_s0: { value: '8' },
      rir_log_1_0_0_s0: { value: '2' }, ics_log_1_0_0_s0: { value: '8' },
      setrow_log_1_0_0_s0: { dataset: { exname: 'Press' }, style: {}, offsetHeight: 0 }
    };
    var document = { getElementById: function(id) { return elements[id] || null; } };
    function getExUnit() { return 'KG'; }
    function getAdjustedRIR() { return 2; }
    function _lbwTrack() {}
    var celebrations = 0;
    function _recordExerciseHistoryAndPR(a, b, c, d, e, f, showCelebration) {
      if (showCelebration !== false) celebrations++;
      return true;
    }
    function _rebuildExerciseHistoryFromLogs() {}
    function showPRCelebration() { celebrations++; }
    function saveLogs() {}
    var resolveSave;
    function _doSaveLogs() { return new Promise(function(resolve) { resolveSave = resolve; }); }
    function _isExerciseFullyDone(di, ei) { return ei === 0; }
    function isTechniqueActive() { return true; }
    function _refreshExPanelOnly() {}
    function _resolveNextWorkoutAction() { return { type: 'NONE' }; }
    function _renderNextWorkoutAction() {}
    function isY3TExercise() { return false; }
    function getEffectiveSets(e) { return e.sets; }
    function getTotalWeeks() { return 6; }
    function showToast() {}
    function startRestTimer() {}
    function _maybeSuggestExtraSet() {}
    function setTimeout(fn) { fn(); }
    ${completeSetSource}
    return {
      save: completeSet,
      resolveSave: function(result) { resolveSave(result); },
      log: function() { return LOGS.log_1_0_0_s0; },
      activeExercise: function() { return EJ_ACTIVO; },
      setContext: function(day, exercise) { DIA_ACTIVO = day; EJ_ACTIVO = exercise; },
      celebrations: function() { return celebrations; }
    };
  `)();
}

test('T404: a rejected set write leaves the set pending and does not advance exercise', async () => {
  const app = makeRuntime();
  const pending = app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  app.resolveSave(false);
  await pending;
  assert.equal(app.log(), undefined);
  assert.equal(app.activeExercise(), 0);
  assert.equal(app.celebrations(), 0);
});

test('T405: a set write resolving after day navigation cannot advance the new context', async () => {
  const app = makeRuntime();
  const pending = app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  app.setContext(1, 0);
  app.resolveSave(true);
  await pending;
  assert.equal(app.log().done, true);
  assert.equal(app.activeExercise(), 0);
});
