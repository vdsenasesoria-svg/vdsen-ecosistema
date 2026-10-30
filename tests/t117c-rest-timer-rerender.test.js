// T117-C: Rest timer overlay restored after renderEntrenamiento wipes innerHTML
// Bug: renderEntrenamiento() replaces cont.innerHTML (which contains #restTimerOverlay
// and #timerPill with display:none). A running rest timer becomes invisible.
// Fix: after cont.innerHTML, if _restTimer is active, re-show overlay and re-fetch _restEl.

var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

test('T117-C: _timerWasMin captured before main cont.innerHTML', function() {
  // There are two cont.innerHTML= in renderEntrenamiento (early-return + main).
  // _timerWasMin must precede the MAIN assignment.
  var saveIdx = src.indexOf('// T117-C: Save rest timer state before innerHTML');
  assert.ok(saveIdx !== -1, 'T117-C save comment not found');
  var mainAssignIdx = src.indexOf('cont.innerHTML =', saveIdx);
  assert.ok(mainAssignIdx !== -1, 'Main cont.innerHTML = not found after save comment');
  var captureIdx = src.indexOf('_timerWasMin =', saveIdx);
  assert.ok(captureIdx !== -1, '_timerWasMin = not found after save comment');
  assert.ok(captureIdx < mainAssignIdx,
    '_timerWasMin must be captured BEFORE main cont.innerHTML (captureIdx=' + captureIdx + ', mainAssignIdx=' + mainAssignIdx + ')');
});

test('T117-C: restore block exists after main cont.innerHTML', function() {
  var saveIdx = src.indexOf('// T117-C: Save rest timer state before innerHTML');
  var mainAssignIdx = src.indexOf('cont.innerHTML =', saveIdx);
  var restoreIdx = src.indexOf('// T117-C: Restore rest timer', mainAssignIdx);
  assert.ok(restoreIdx !== -1, 'T117-C restore comment not found after cont.innerHTML');
  assert.ok(restoreIdx > mainAssignIdx, 'Restore block must come after main cont.innerHTML');
});

test('T117-C: restore block re-fetches _restEl from DOM', function() {
  var restoreIdx = src.indexOf('// T117-C: Restore rest timer');
  assert.ok(restoreIdx !== -1, 'T117-C restore comment not found');
  var block = src.slice(restoreIdx, restoreIdx + 600);
  assert.ok(block.indexOf('_restEl = document.getElementById') !== -1,
    'Must re-fetch _restEl from DOM in restore block');
});

test('T117-C: restore block sets overlay display to flex', function() {
  var restoreIdx = src.indexOf('// T117-C: Restore rest timer');
  assert.ok(restoreIdx !== -1, 'T117-C restore comment not found');
  var block = src.slice(restoreIdx, restoreIdx + 600);
  assert.ok(block.indexOf("display = 'flex'") !== -1,
    'Restore block must show overlay with display:flex');
});

test('T117-C: restore block calls updateTimerDisplay', function() {
  var restoreIdx = src.indexOf('// T117-C: Restore rest timer');
  assert.ok(restoreIdx !== -1, 'T117-C restore comment not found');
  var block = src.slice(restoreIdx, restoreIdx + 600);
  assert.ok(block.indexOf('updateTimerDisplay()') !== -1,
    'Restore block must call updateTimerDisplay()');
});

test('T117-C: restore block guards on _restTimer truthy', function() {
  var restoreIdx = src.indexOf('// T117-C: Restore rest timer');
  assert.ok(restoreIdx !== -1, 'T117-C restore comment not found');
  var block = src.slice(restoreIdx, restoreIdx + 300);
  assert.ok(block.indexOf('if (_restTimer)') !== -1,
    'Restore block must guard on if (_restTimer)');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL > 0 ? ' — FAILURES: ' + FAIL : ''));
if (FAIL > 0) process.exit(1);
