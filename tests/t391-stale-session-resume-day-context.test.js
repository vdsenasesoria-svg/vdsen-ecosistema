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

const resumeSource = extractFunction('function _resumeStaleSessionFromHome(week, di) {');
const homeDaySource = extractFunction('function _goToHomeDay(idx) {');
const goTabSource = extractFunction('function goTab(i) {');

function runtime() {
  return new Function(`
    var CURRENT_WEEK = 2, REAL_WEEK = 2, DIA_ACTIVO = 0, _goTabSkipWeekReset = false;
    function renderEntrenamiento() {}
    function goTab(i) {
      if (i === 1) {
        if (!_goTabSkipWeekReset) CURRENT_WEEK = REAL_WEEK;
        _goTabSkipWeekReset = false;
        renderEntrenamiento();
      }
    }
    function selDia(i) { DIA_ACTIVO = i; renderEntrenamiento(); }
    ${homeDaySource}
    ${resumeSource}
    return {
      resume: _resumeStaleSessionFromHome,
      homeDay: _goToHomeDay,
      state: function() { return { week: CURRENT_WEEK, day: DIA_ACTIVO }; }
    };
  `)();
}

test('T391: stale-session resume keeps the requested week/day identity', () => {
  assert.match(goTabSource, /if \(!_goTabSkipWeekReset\) CURRENT_WEEK = REAL_WEEK;/);
  const app = runtime();

  // The stale session is Day A = week 1 / day 1. The real week is week 2.
  app.resume(1, 1);

  // Before the fix this ended at Day B = week 2 / day 1 without another user choice.
  assert.deepEqual(app.state(), { week: 1, day: 1 });
});

test('T391: ordinary Home day navigation still opens that day in the real week', () => {
  const app = runtime();
  app.homeDay(1);
  assert.deepEqual(app.state(), { week: 2, day: 1 });
});
