/**
 * T112-C — onSnapshot must trigger location.reload() when coach rolls back currentWeek
 *
 * Bug: the logs onSnapshot handler only advanced REAL_WEEK when newWeek > REAL_WEEK.
 * A coach-driven rollback (newWeek < REAL_WEEK) was silently ignored: LOGS got
 * overwritten but REAL_WEEK stayed at the old value, causing the client to keep
 * writing log_<old_week>_* keys into the reset database. A full reload is the
 * safest way to re-initialize all week-dependent state cleanly.
 *
 * Run: node tests/t112c-snapshot-rollback-reload.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

console.log('T112-C — onSnapshot rollback triggers location.reload()');

test('onSnapshot handler is present', function() {
  assert.ok(src.indexOf('_liveUnsubLogs = FB.onSnapshot') > -1, 'onSnapshot wiring found');
});

test('rollback guard checks newWeek < REAL_WEEK', function() {
  assert.ok(
    src.indexOf('newWeek < REAL_WEEK') > -1,
    'rollback condition (newWeek < REAL_WEEK) must be present in snapshot handler'
  );
});

test('location.reload() is called on rollback', function() {
  assert.ok(
    src.indexOf('location.reload()') > -1,
    'location.reload() must be called when a rollback is detected'
  );
});

test('rollback guard precedes the advance-only guard', function() {
  var rollbackPos = src.indexOf('newWeek < REAL_WEEK');
  var advancePos  = src.indexOf('if (newWeek > REAL_WEEK)');
  assert.ok(rollbackPos > -1, 'rollback guard present');
  assert.ok(advancePos  > -1, 'advance guard present');
  assert.ok(rollbackPos < advancePos, 'rollback guard (' + rollbackPos + ') before advance guard (' + advancePos + ')');
});

test('rollback path shows a toast before reloading', function() {
  // Find the rollback block and verify showToast is called before location.reload
  var rollbackIdx = src.indexOf('newWeek < REAL_WEEK');
  assert.ok(rollbackIdx > -1, 'rollback guard present');
  // Slice 400 chars after the condition to inspect the handler body
  var snippet = src.slice(rollbackIdx, rollbackIdx + 400);
  assert.ok(snippet.indexOf('showToast') > -1, 'showToast called in rollback path');
  var toastPos  = snippet.indexOf('showToast');
  var reloadPos = snippet.indexOf('location.reload()');
  assert.ok(toastPos < reloadPos, 'showToast before location.reload()');
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
