// T506: an athlete-side substitution (exsub_*) is EXECUTION of a different exercise. Its sets must never be attributed
// to the plan exercise's prescriptionExerciseId (no PID evidence / PID history / PR contamination), and the legacy
// engine must not recommend an exercise substitution (EXERCISE is Coach authority).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('async function completeSet(key, di, ei, si, unit) {');
let depth = 0, end = client.indexOf('{', start);
for (; end < client.length; end++) { if (client[end] === '{') depth++; if (client[end] === '}' && --depth === 0) break; }
const completeSetSource = client.slice(start, end + 1);

function runtime(sub) {
  return new Function('SUB', `
    var CURRENT_WEEK = 1, REAL_WEEK = 1, DIA_ACTIVO = 0, EJ_ACTIVO = 0;
    var LOGS = SUB ? { exsub_1_0_0: SUB } : {}, EXERCISE_HISTORY = {}, LOGS_BY_WEEK = { log: { 1: [] } }, _saveLogsTimer = null;
    var _EJERCICIOS_DIA = [{ exerciseName: 'Press', exerciseId: 'ex-press', prescriptionExerciseId: 'pid-press', sets: [{ restSeconds: 0 }] }];
    var window = {}, navigator = {}, recorded = [];
    var elements = {
      carga_log_1_0_0_s0: { value: '80' }, reps_log_1_0_0_s0: { value: '8' },
      rir_log_1_0_0_s0: { value: '2' }, ics_log_1_0_0_s0: { value: '8' },
      setrow_log_1_0_0_s0: { dataset: { exname: 'press mancuernas' }, style: {}, offsetHeight: 0 }
    };
    var document = { getElementById: function(id) { return elements[id] || null; } };
    function getExUnit() { return 'KG'; }
    function getAdjustedRIR() { return 2; }
    function _coachRIR() { return 2; }
    function _historyPidKey(pid) { return pid ? '__pid__' + String(pid) : ''; }
    function _lbwTrack() {}
    function _recordExerciseHistoryAndPR() { recorded.push([].slice.call(arguments)); return false; }
    function _rebuildExerciseHistoryFromLogs() {}
    function saveLogs() {}
    async function _doSaveLogs() { return true; }
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
    function setTimeout(fn) { fn(); }
    ${completeSetSource}
    return { save: completeSet, log: function() { return LOGS.log_1_0_0_s0; }, recorded: function() { return recorded; } };
  `)(sub);
}

test('T506.1 a set logged without substitution keeps the plan PID and exerciseId (unchanged)', async () => {
  const app = runtime(null);
  await app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  assert.equal(app.log().prescriptionExerciseId, 'pid-press'); assert.equal(app.log().exerciseId, 'ex-press');
  assert.equal(app.recorded()[0][7], 'pid-press');
});

test('T506.2 a set logged under a substitution is NOT attributed to the plan PID', async () => {
  const app = runtime({ nombre: 'Press mancuernas', original: 'Press' });
  await app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  const l = app.log();
  assert.equal(l.prescriptionExerciseId, undefined); assert.equal(l.exerciseId, undefined);
  assert.equal(l.exerciseNameSnapshot, 'Press mancuernas');
  assert.deepEqual(l.substitutedFrom, { prescriptionExerciseId: 'pid-press', exerciseId: 'ex-press', exerciseName: 'Press' });
  assert.equal(l.carga, '80'); assert.equal(l.reps, '8'); assert.equal(l.rir_real, '2', 'executed truth preserved');
});

test('T506.3 history/PR for a substituted set is never keyed by the plan PID', async () => {
  const app = runtime({ nombre: 'Press mancuernas', original: 'Press' });
  await app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  assert.equal(app.recorded()[0][7], null);
});

test('T506.4 the legacy engine no longer recommends an alternative exercise', () => {
  assert.ok(!client.includes('Considera sustituir por'));
  assert.ok(!/altEx\b/.test(client));
  assert.ok(!client.includes('EXERCISE_CATALOG[ck].motorPattern === pattern'));
});

test('T506.5 the low-ICS advisory only reads logs of the same PID when the exercise has one', () => {
  const i = client.indexOf('// ── Aviso de ICS bajo persistente');
  const block = client.slice(i, client.indexOf('// Session progress summary', i));
  assert.ok(block.includes('prescriptionExerciseId'), 'PID-aware');
  assert.ok(/revisa técnica con tu coach/.test(block));
});
