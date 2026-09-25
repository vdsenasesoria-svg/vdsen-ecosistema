const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');

function extractFunction(declaration) {
  const start = client.indexOf(declaration);
  assert.notEqual(start, -1, `missing ${declaration}`);
  const brace = client.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < client.length; i++) {
    if (client[i] === '{') depth++;
    if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error(`unterminated ${declaration}`);
}

const selDiaSource = extractFunction('function selDia(i) {');
const continueSource = extractFunction('function _continueNextWorkoutAction() {');
const stopRestSource = extractFunction('function stopRestTimer() {');

test('T394: changing day invalidates a rest CTA from the previous day', () => {
  assert.match(stopRestSource, /window\._nextAction25 = null;/);
  const app = new Function(`
    var DIA_ACTIVO = 0, EJ_ACTIVO = 0;
    var window = { _nextAction25: { type: 'SESSION_DONE' } };
    var localStorage = { setItem: function() {} };
    var markedDay = null;
    function renderEntrenamiento() {}
    function stopRestTimer() { window._nextAction25 = null; }
    function markSessionDone(di) { markedDay = di; }
    function _scrollToNextPendingSet() {}
    ${selDiaSource}
    ${continueSource}
    return {
      changeDay: selDia,
      continueAction: _continueNextWorkoutAction,
      markedDay: function() { return markedDay; }
    };
  `)();

  // Day 0 finished a set and exposed SESSION_DONE during rest. The client
  // explicitly opens day 1 before tapping the old overlay CTA.
  app.changeDay(1);
  app.continueAction();

  assert.equal(app.markedDay(), null);
});
