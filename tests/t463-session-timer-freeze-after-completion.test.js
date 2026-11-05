'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENT = fs.readFileSync('vdsen-cliente.html', 'utf8');
let pass = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  pass++;
}

const fmtStart = CLIENT.indexOf('function _fmtElapsed(startMs, endMs) {');
const fmtEnd = CLIENT.indexOf('\n}\n\n', fmtStart) + 2;
const fmtSrc = CLIENT.slice(fmtStart, fmtEnd);
const _fmtElapsed = new Function('Date', 'return ' + fmtSrc)(Date);

// Reproduction: a live callback survives the completion transition. The
// callback must notice the persisted completion timestamp and render the
// frozen value instead of falling back to Date.now().
const liveTickStarts = [];
for (const marker of ['function _updateSesTimer()', 'window._sesTimerInterval = setInterval(function() {']) {
  const start = CLIENT.indexOf(marker);
  ok(start >= 0, `session timer callback exists: ${marker}`);
  liveTickStarts.push(start);
}
for (const start of liveTickStarts) {
  const end = CLIENT.indexOf('\n    }, 1000);', start);
  const body = CLIENT.slice(start, end > start ? end : start + 600);
  ok(body.includes('window._sesTimerEnd'), 'live callback observes completion state before updating');
  ok(body.includes('_fmtElapsed(window._sesTimerStart, window._sesTimerEnd)'), 'completed callback renders the frozen end timestamp');
}

const sessionStart = 1_700_000_000_000;
const completion = sessionStart + 8 * 60 * 1000;
const frozen = _fmtElapsed(sessionStart, completion);
ok(frozen === '08:00', 'completed session duration is fixed at its completion timestamp');
ok(_fmtElapsed(sessionStart, completion) === frozen, 're-entry with the same persisted timestamps remains frozen');
ok(_fmtElapsed(sessionStart, null) !== frozen, 'partial/open session still uses the live elapsed contract');

// The close marker is scoped to the exact week/day key used by production.
const doneKey = "done_'+CURRENT_WEEK+'_'+DIA_ACTIVO";
ok(CLIENT.includes(doneKey), 'completion timestamp is read from the session-scoped done key');

console.log('T463 — session timer freezes after completion: ' + pass + ' assertions PASSED');
