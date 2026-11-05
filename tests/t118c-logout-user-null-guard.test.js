// T118-C: USER=null before signOut + guard in _waitUnsubActivePlan callback
// Bug: USER was set to null AFTER FB.signOut(). If a buffered Firestore snapshot
// arrived after the listener was unsubscribed, the _waitUnsubActivePlan callback
// could fire with USER still set, triggering a spurious toast and reload after logout.
// Fix: set USER=null before signOut(); add if(!USER) return in the callback.

var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

test('T118-C: doLogout sets USER=null before FB.signOut', function() {
  var fnIdx = src.indexOf('async function doLogout()');
  assert.ok(fnIdx !== -1, 'doLogout function not found');
  // Extract function body (up to the closing brace)
  var fnBody = src.slice(fnIdx, fnIdx + 400);
  var userNullIdx  = fnBody.indexOf('USER = null');
  var signOutIdx   = fnBody.indexOf('FB.signOut');
  assert.ok(userNullIdx !== -1, 'USER = null not found in doLogout');
  assert.ok(signOutIdx  !== -1, 'FB.signOut not found in doLogout');
  assert.ok(userNullIdx < signOutIdx,
    'USER = null must come before FB.signOut (userNullIdx=' + userNullIdx + ', signOutIdx=' + signOutIdx + ')');
});

test('T118-C: _waitUnsubActivePlan callback has if(!USER) return guard', function() {
  // Find the _waitUnsubActivePlan snapshot callback
  var callbackIdx = src.indexOf('_waitUnsubActivePlan = FB.onSnapshot');
  assert.ok(callbackIdx !== -1, '_waitUnsubActivePlan onSnapshot not found');
  var callbackBody = src.slice(callbackIdx, callbackIdx + 400);
  assert.ok(callbackBody.indexOf('if (!USER) return') !== -1,
    '_waitUnsubActivePlan callback must have if (!USER) return guard');
});

test('T118-C: guard in callback precedes activePlanId check', function() {
  var callbackIdx = src.indexOf('_waitUnsubActivePlan = FB.onSnapshot');
  var callbackBody = src.slice(callbackIdx, callbackIdx + 400);
  var guardIdx    = callbackBody.indexOf('if (!USER) return');
  var planCheckIdx = callbackBody.indexOf('activePlanId');
  assert.ok(guardIdx !== -1, 'Guard not found');
  assert.ok(planCheckIdx !== -1, 'activePlanId check not found');
  assert.ok(guardIdx < planCheckIdx,
    'Guard must precede activePlanId check (guardIdx=' + guardIdx + ', planCheckIdx=' + planCheckIdx + ')');
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL > 0 ? ' — FAILURES: ' + FAIL : ''));
if (FAIL > 0) process.exit(1);
