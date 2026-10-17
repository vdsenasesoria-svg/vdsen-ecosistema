// T125-C: _clearLiveListeners must reset FB._planLastUpdatedAt to null.
// Without this reset, if onAuthStateChanged fires again (Firebase token refresh)
// without a page reload, the new _liveUnsubPlan listener's first snapshot skips
// the baseline guard and can trigger a spurious reload when updatedAt changed.
'use strict';
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/../vdsen-cliente.html', 'utf8');

// Locate _clearLiveListeners function body
const fnStart = src.indexOf('function _clearLiveListeners()');
assert.ok(fnStart !== -1, '_clearLiveListeners function not found');

const fnBody = (function() {
  let braceStart = src.indexOf('{', fnStart);
  assert.ok(braceStart !== -1, 'opening brace not found');
  let depth = 0;
  let i = braceStart;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(fnStart, i + 1);
    }
    i++;
  }
  return src.slice(fnStart, fnStart + 1000);
})();

// The function must reset FB._planLastUpdatedAt
assert.ok(
  fnBody.includes('FB._planLastUpdatedAt'),
  'T125-C: _clearLiveListeners must reset FB._planLastUpdatedAt'
);

// It must set it to null (not just read it)
assert.ok(
  fnBody.includes('FB._planLastUpdatedAt = null'),
  'T125-C: _clearLiveListeners must set FB._planLastUpdatedAt = null'
);

// Confirm it guards against FB being null (FB could be null on very early calls)
assert.ok(
  fnBody.includes('if (FB)') || fnBody.includes('FB &&'),
  'T125-C: reset must be guarded (FB can be null before Firebase initializes)'
);

console.log('T125-C PASS: _clearLiveListeners resets FB._planLastUpdatedAt');
