const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('function completeSet(key, di, ei, si, unit) {');
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
    var CURRENT_WEEK = 1, REAL_WEEK = 1, EJ_ACTIVO = 0;
    var LOGS = {};
    var _EJERCICIOS_DIA = [{ exerciseName: 'Press', prescriptionExerciseId: 'pid-press', sets: [{ restSeconds: 0 }] }];
    var window = {};
    var navigator = {};
    var elements = {
      carga_log_1_0_0_s0: { value: '80' }, reps_log_1_0_0_s0: { value: '8' },
      rir_log_1_0_0_s0: { value: '2' }, ics_log_1_0_0_s0: { value: '8' },
      setrow_log_1_0_0_s0: { dataset: { exname: 'Press' }, style: {}, offsetHeight: 0 }
    };
    var document = { getElementById: function(id) { return elements[id] || null; } };
    function getExUnit() { return 'KG'; }
    function getAdjustedRIR() { return 2; }
    function _lbwTrack() {}
    function _recordExerciseHistoryAndPR() {}
    function saveLogs() {}
    function _isExerciseFullyDone() { return false; }
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
    return { save: completeSet, log: function() { return LOGS.log_1_0_0_s0; } };
  `)();
}

test('T399: rapid duplicate save cannot unmark the just-confirmed set', () => {
  const app = makeRuntime();
  app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  assert.equal(app.log().done, true);
});
