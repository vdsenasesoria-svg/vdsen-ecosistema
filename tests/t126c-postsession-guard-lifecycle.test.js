// T126-C: _postSessionSubmitting lifecycle guard
// Verifies:
//   1. _postSessionSubmitting = true is set before any await
//   2. A finally block resets it to false (robust against unexpected exceptions)
//   3. showSessionSummary is inside the try block (R6-GAP-02 still intact)
//   4. closePostSessionModal does NOT reset _postSessionSubmitting
'use strict';
const assert = require('assert');
const fs = require('fs');

const CLIENT = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Extract the submitPostSession function body for targeted analysis.
// We grab from the function declaration to the closing brace of the outer finally block.
var fnMatch = CLIENT.match(/var _postSessionSubmitting\s*=\s*false;\s*async function submitPostSession\(\)[^]*?^}/m);
assert.ok(fnMatch, 'submitPostSession function must be present in source');
var fnBody = fnMatch[0];

// ── Test 1: _postSessionSubmitting = true appears in the function ────────────
assert.ok(
  /_postSessionSubmitting\s*=\s*true/.test(fnBody),
  'submitPostSession must set _postSessionSubmitting = true'
);

// ── Test 2: _postSessionSubmitting = true appears BEFORE the first await ─────
// The first await in the function should come after the true assignment.
var trueIdx  = fnBody.indexOf('_postSessionSubmitting = true');
var awaitIdx = fnBody.indexOf('await ');
assert.ok(trueIdx >= 0,  '_postSessionSubmitting = true must be present');
assert.ok(awaitIdx >= 0, 'at least one await must be present in submitPostSession');
assert.ok(
  trueIdx < awaitIdx,
  '_postSessionSubmitting = true must appear BEFORE the first await (got trueIdx=' + trueIdx + ' awaitIdx=' + awaitIdx + ')'
);

// ── Test 3: a finally block resets _postSessionSubmitting to false ────────────
// The robust lifecycle requires:  finally { _postSessionSubmitting = false; }
assert.ok(
  /finally\s*\{[^}]*_postSessionSubmitting\s*=\s*false/.test(fnBody),
  'submitPostSession must have a finally block that resets _postSessionSubmitting = false'
);

// ── Test 4: showSessionSummary is inside the try block (R6-GAP-02 intact) ────
// Verify that _saved !== false && showSessionSummary pattern is present and
// that showSessionSummary does NOT appear after the finally (outside the try).
assert.ok(
  /_saved\s*!==\s*false.*showSessionSummary/.test(fnBody),
  'showSessionSummary must be guarded by _saved !== false (R6-GAP-02 intact)'
);

// The finally keyword must come AFTER showSessionSummary in the function body
// (i.e., showSessionSummary is inside the try, before the finally).
var summaryIdx = fnBody.indexOf('showSessionSummary');
var finallyIdx = fnBody.indexOf('} finally {');
assert.ok(summaryIdx >= 0, 'showSessionSummary must appear in submitPostSession');
assert.ok(finallyIdx >= 0, 'finally block must be present in submitPostSession');
assert.ok(
  summaryIdx < finallyIdx,
  'showSessionSummary must appear inside the try block (before the finally); got summaryIdx=' + summaryIdx + ' finallyIdx=' + finallyIdx
);

// ── Test 5: closePostSessionModal must NOT reset _postSessionSubmitting ────────
// Extract closePostSessionModal body.
var closeFnMatch = CLIENT.match(/function closePostSessionModal\(\)\s*\{[^}]*\}/);
assert.ok(closeFnMatch, 'closePostSessionModal must be present in source');
var closeFnBody = closeFnMatch[0];

assert.ok(
  !/_postSessionSubmitting\s*=\s*false/.test(closeFnBody),
  'closePostSessionModal must NOT reset _postSessionSubmitting = false (T126-C fix)'
);

// ── Test 6: _postSessionSubmitting is reset to false in exactly ONE finally ───
// Count occurrences of the reset in finally context — should be exactly 1.
var finallyResets = (fnBody.match(/finally\s*\{[^}]*_postSessionSubmitting\s*=\s*false/g) || []).length;
assert.strictEqual(
  finallyResets, 1,
  'exactly one finally-based reset of _postSessionSubmitting expected, got ' + finallyResets
);

console.log('# T126-C PASS: _postSessionSubmitting lifecycle is robust — try/finally guards all async paths');
