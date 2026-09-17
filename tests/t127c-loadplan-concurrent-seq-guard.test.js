'use strict';
// T127-C: loadPlan concurrent sequence guard
// Bug: when onAuthStateChanged fires twice in quick succession (e.g. token refresh),
// two concurrent loadPlan calls run. Each calls _clearLiveListeners() at the start,
// but since neither has registered live listeners yet, neither cancels the other's
// subscriptions. Whichever call finishes first stores its Firestore unsubscribe refs
// in the globals; the second call then overwrites those globals without calling the
// first subscriptions' unsubscribe fns — orphaning them permanently.
// Fix (T127-C): a generation counter (_loadPlanSeq) is incremented at the top of
// each loadPlan call. Each call captures its own sequence number (_mySeq). Right
// before registering live listeners, a guard `if (_mySeq !== _loadPlanSeq) return;`
// aborts the older call so it never stores its subscriptions in the globals, leaving
// the newer call free to register and own them cleanly.

var assert = require('assert');
var fs     = require('fs');
var path   = require('path');

var CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

var PASS = 0, FAIL = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

// ── 1. _loadPlanSeq variable is declared ────────────────────────────────────
test('T127-C: _loadPlanSeq variable declared as 0', function() {
  assert.ok(CLIENT.includes('var _loadPlanSeq = 0;'),
    '_loadPlanSeq not declared with initial value 0');
});

// ── 2. _loadPlanSeq is incremented at the top of loadPlan ───────────────────
test('T127-C: loadPlan increments _loadPlanSeq and captures local _mySeq', function() {
  var loadPlanIdx = CLIENT.indexOf('async function loadPlan(user)');
  assert.ok(loadPlanIdx !== -1, 'loadPlan function not found');
  // Extract the first ~200 chars of the function body (up to first async await)
  var fnTop = CLIENT.slice(loadPlanIdx, loadPlanIdx + 400);
  assert.ok(fnTop.includes('var _mySeq = ++_loadPlanSeq'),
    'loadPlan must capture its sequence: var _mySeq = ++_loadPlanSeq');
});

// ── 3. The increment happens before the first await ─────────────────────────
test('T127-C: _mySeq capture precedes first await inside loadPlan', function() {
  var loadPlanIdx = CLIENT.indexOf('async function loadPlan(user)');
  var fnTop = CLIENT.slice(loadPlanIdx, loadPlanIdx + 600);
  var seqIdx   = fnTop.indexOf('var _mySeq = ++_loadPlanSeq');
  var awaitIdx = fnTop.indexOf('await ');
  assert.ok(seqIdx   !== -1, '_mySeq capture not found in loadPlan');
  assert.ok(awaitIdx !== -1, 'no await found in loadPlan preamble');
  assert.ok(seqIdx < awaitIdx,
    '_mySeq must be captured before the first await (seqIdx=' + seqIdx + ', awaitIdx=' + awaitIdx + ')');
});

// ── 4. Guard check exists before live listener registration ─────────────────
test('T127-C: sequence guard present before onSnapshot registrations', function() {
  // The guard must appear between the loadPlan start and _liveUnsubClient assignment
  var loadPlanIdx = CLIENT.indexOf('async function loadPlan(user)');
  var unsubIdx    = CLIENT.indexOf('_liveUnsubClient = FB.onSnapshot');
  assert.ok(loadPlanIdx !== -1, 'loadPlan not found');
  assert.ok(unsubIdx    !== -1, '_liveUnsubClient onSnapshot not found');
  // Slice between the two
  var region = CLIENT.slice(loadPlanIdx, unsubIdx);
  assert.ok(region.includes('if (_mySeq !== _loadPlanSeq) return'),
    'Guard "if (_mySeq !== _loadPlanSeq) return" must appear before live listener registration');
});

// ── 5. Guard is the last statement before the live-listener try block ────────
test('T127-C: guard is immediately before the live-listener try block', function() {
  var guardStr   = 'if (_mySeq !== _loadPlanSeq) return;';
  var tryComment = '// Escuchar cambios en tiempo real';
  var guardIdx = CLIENT.indexOf(guardStr);
  var tryIdx   = CLIENT.indexOf(tryComment);
  assert.ok(guardIdx !== -1, 'Guard not found');
  assert.ok(tryIdx   !== -1, 'Live-listener comment not found');
  // The guard should be very close to the try block (within ~400 chars)
  var gap = tryIdx - guardIdx;
  assert.ok(gap > 0 && gap < 400,
    'Guard must appear just before the live-listener try block (gap=' + gap + ')');
});

// ── 6. _clearLiveListeners is still called at the top of loadPlan ───────────
test('T127-C: _clearLiveListeners() still called at start of loadPlan', function() {
  var loadPlanIdx = CLIENT.indexOf('async function loadPlan(user)');
  var fnTop = CLIENT.slice(loadPlanIdx, loadPlanIdx + 200);
  var clearIdx = fnTop.indexOf('_clearLiveListeners()');
  var seqIdx   = fnTop.indexOf('var _mySeq');
  assert.ok(clearIdx !== -1, '_clearLiveListeners() not found at start of loadPlan');
  assert.ok(seqIdx   !== -1, '_mySeq capture not found at start of loadPlan');
  // _clearLiveListeners comes before seq capture (it's the very first line of loadPlan)
  assert.ok(clearIdx < seqIdx,
    '_clearLiveListeners must come before _mySeq capture (clearIdx=' + clearIdx + ', seqIdx=' + seqIdx + ')');
});

console.log('\nT127-C: loadPlan concurrent seq guard: ' + PASS + '/' + (PASS + FAIL) + ' assertions passed' + (FAIL > 0 ? ' — FAILURES: ' + FAIL : ''));
if (FAIL > 0) process.exit(1);
console.log('T127-C: loadPlan concurrent seq guard: ALL ASSERTIONS PASSED');
