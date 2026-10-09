/**
 * T116-C — markWeekCompleteFromHistory must use CURRENT_WEEK (not REAL_WEEK)
 *           for all log key writes.
 *
 * Issue: markWeekCompleteFromHistory() wrote postsession_, progrec_, and done_
 * keys using REAL_WEEK while other session-completion paths (submitPostSession,
 * markSessionDoneFromHistory) consistently use CURRENT_WEEK. A guard at the top
 * of the function (CURRENT_WEEK !== REAL_WEEK → return) ensures they are equal
 * at runtime, so this caused no data corruption today. However, using REAL_WEEK
 * is fragile: if the guard were relaxed or bypassed, the writes would target the
 * ACTIVE week instead of the VIEWED week, silently corrupting week progression
 * and triggering _autoAdvanceWeekIfDone on the wrong week.
 *
 * Fix: replace REAL_WEEK with CURRENT_WEEK in all four key writes inside the
 * function's inner loop. The guard remains in place.
 *
 * Run: node tests/t116c-markweek-from-history-current-week.test.js
 */
'use strict';
var assert = require('assert');
var fs     = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Helper: extract a function's body up to its closing brace
function extractFnBody(fnDecl, maxLen) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  maxLen = maxLen || 6000; // markWeekCompleteFromHistory is ~4700 chars
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  var limit = Math.min(start + maxLen, src.length);
  while (i < limit) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

console.log('T116-C — markWeekCompleteFromHistory uses CURRENT_WEEK for writes');

// ── Function exists and has the CURRENT_WEEK !== REAL_WEEK guard ───────────

test('markWeekCompleteFromHistory function exists', function() {
  assert.ok(
    src.indexOf('async function markWeekCompleteFromHistory()') > -1,
    'function declaration found'
  );
});

test('markWeekCompleteFromHistory has CURRENT_WEEK !== REAL_WEEK guard', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'function body extracted');
  assert.ok(
    body.indexOf('CURRENT_WEEK !== REAL_WEEK') > -1,
    'function must guard against being called when CURRENT_WEEK !== REAL_WEEK'
  );
});

// ── Key writes must use CURRENT_WEEK ──────────────────────────────────────

test('postsession_ key uses CURRENT_WEEK', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'body extracted');
  assert.ok(
    body.indexOf("'postsession_'+CURRENT_WEEK") > -1 ||
    body.indexOf('"postsession_"+CURRENT_WEEK') > -1,
    'postsession_ key must be keyed by CURRENT_WEEK'
  );
});

test('postsession_ key does NOT use REAL_WEEK', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'body extracted');
  assert.ok(
    body.indexOf("'postsession_'+REAL_WEEK") === -1 &&
    body.indexOf('"postsession_"+REAL_WEEK') === -1,
    'postsession_ key must not use REAL_WEEK (inconsistent with submitPostSession)'
  );
});

test('progrec_ key uses CURRENT_WEEK', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'body extracted');
  assert.ok(
    body.indexOf("'progrec_'+CURRENT_WEEK") > -1 ||
    body.indexOf('"progrec_"+CURRENT_WEEK') > -1,
    'progrec_ key must be keyed by CURRENT_WEEK'
  );
});

test('progrec_ key does NOT use REAL_WEEK', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'body extracted');
  assert.ok(
    body.indexOf("'progrec_'+REAL_WEEK") === -1 &&
    body.indexOf('"progrec_"+REAL_WEEK') === -1,
    'progrec_ key must not use REAL_WEEK'
  );
});

test('done_ key uses CURRENT_WEEK for autoClosed fromHistory write', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'body extracted');
  // Look for the done_ write with autoClosed:true and fromHistory:true
  var doneIdx = body.indexOf('autoClosed: true, fromHistory: true');
  assert.ok(doneIdx > -1, 'done_ fromHistory write found');
  // Search backwards from that point for the key construction
  var keySnippet = body.slice(Math.max(0, doneIdx - 100), doneIdx);
  assert.ok(
    keySnippet.indexOf("'done_'+CURRENT_WEEK") > -1 ||
    keySnippet.indexOf('"done_"+CURRENT_WEEK') > -1,
    'done_ fromHistory key must use CURRENT_WEEK'
  );
});

test('done_ fromHistory key does NOT use REAL_WEEK', function() {
  var body = extractFnBody('async function markWeekCompleteFromHistory()');
  assert.ok(body, 'body extracted');
  var doneIdx = body.indexOf('autoClosed: true, fromHistory: true');
  assert.ok(doneIdx > -1, 'done_ fromHistory write found');
  var keySnippet = body.slice(Math.max(0, doneIdx - 100), doneIdx);
  assert.ok(
    keySnippet.indexOf("'done_'+REAL_WEEK") === -1 &&
    keySnippet.indexOf('"done_"+REAL_WEEK') === -1,
    'done_ fromHistory key must not use REAL_WEEK'
  );
});

// ── Consistency: submitPostSession also uses CURRENT_WEEK ─────────────────

test('submitPostSession postsession_ also uses CURRENT_WEEK (consistency check)', function() {
  var body = extractFnBody('async function submitPostSession()');
  assert.ok(body, 'submitPostSession body extracted');
  assert.ok(
    body.indexOf("'postsession_'+CURRENT_WEEK") > -1 ||
    body.indexOf('"postsession_"+CURRENT_WEEK') > -1,
    'submitPostSession must also use CURRENT_WEEK for postsession_ key'
  );
});

console.log('\n' + PASS + '/' + (PASS+FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
