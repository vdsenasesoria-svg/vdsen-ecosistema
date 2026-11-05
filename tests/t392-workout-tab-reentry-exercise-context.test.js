const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('  // ── Populate global ejercicios + auto-select active ─────────────────');
const end = client.indexOf('  // ── Build exercise cards HTML', start);

assert.notEqual(start, -1, 'exercise-selection block exists');
assert.notEqual(end, -1, 'exercise-selection block ends before card rendering');

const selectionBlock = client.slice(start, end);
const selDiaStart = client.indexOf('function selDia(i) {');
const selDiaEnd = client.indexOf('\n}', selDiaStart) + 2;
const selDiaSource = client.slice(selDiaStart, selDiaEnd);

function renderExerciseContext(activeExercise) {
  return new Function(`
    var DIA_ACTIVO = 0;
    var EJ_ACTIVO = ${activeExercise};
    var CURRENT_WEEK = 1;
    var _EJERCICIOS_DIA = [];
    var ejercicios = [{ nombre: 'A' }, { nombre: 'B' }];
    function isTechniqueActive() { return true; }
    function _isExerciseFullyDone() { return false; }
    ${selectionBlock}
    return EJ_ACTIVO;
  `)();
}

test('T392: returning to Entrenamiento keeps a valid selected exercise', () => {
  // The user selected exercise B, left the workout tab, and the real render
  // selection block ran again when returning.
  assert.equal(renderExerciseContext(1), 1);
});

test('T392: an invalid active exercise still falls back to the first pending one', () => {
  assert.equal(renderExerciseContext(9), 0);
});

test('T392: selecting another day resets exercise context before its render', () => {
  assert.match(selDiaSource, /DIA_ACTIVO = i;\s+EJ_ACTIVO = 0;[\s\S]*renderEntrenamiento\(\)/);
});
