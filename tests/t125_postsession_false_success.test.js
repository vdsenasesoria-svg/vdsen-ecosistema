// T125-C: submitPostSession must not show session summary when _confirmSessionDone fails
// Bug: before the fix, showSessionSummary(di) was called unconditionally after
// _confirmSessionDone, even when the Firestore write failed and the session was not saved.
'use strict';
const assert = require('assert');
const fs = require('fs');

const CLIENT = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// 1. _confirmSessionDone must return false on write failure path
assert.ok(
  /return false;\s*\/\/ T125-C/.test(CLIENT),
  '_confirmSessionDone must return false (T125-C) on write failure path'
);

// 2. _confirmSessionDone must return true on success path
assert.ok(
  /return true;\s*\/\/ T125-C/.test(CLIENT),
  '_confirmSessionDone must return true (T125-C) on success path'
);

// 3. submitPostSession must guard showSessionSummary on the return value
assert.ok(
  /_saved\s*!==\s*false.*showSessionSummary/.test(CLIENT),
  'submitPostSession must guard showSessionSummary with _saved !== false check'
);

// 4. The old unconditional pattern must be gone
assert.ok(
  !/await _confirmSessionDone\(di\);\s*showSessionSummary/.test(CLIENT),
  'showSessionSummary must not be called unconditionally after _confirmSessionDone'
);

console.log('# T125-C PASS: submitPostSession guards session summary on write failure');
