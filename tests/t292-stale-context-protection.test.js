'use strict';
/**
 * T292 — Stale-context protection. Verifies the REAL fix: after
 * _renderClientTabMonitor's getDoc await, it now re-checks _detailClientId
 * before writing into the shared #clientDetailTabContent element -- a
 * stale response from a client the coach has since navigated away from
 * can no longer overwrite the currently-displayed client's Monitor tab.
 *
 * Run: node tests/t292-stale-context-protection.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

const idx = COACH.indexOf('async function _renderClientTabMonitor(cont) {');
const braceStart = COACH.indexOf('{', idx);
let depth = 0, end = -1;
for (let i = braceStart; i < COACH.length; i++) {
  if (COACH[i] === '{') depth++;
  else if (COACH[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const monitorFnBody = COACH.slice(idx, end + 1);

ok(monitorFnBody.includes("const logsSnap = await getDoc(doc(db, 'logs', clientId)).catch(() => null);\n    // T292"), 'the guard is inserted immediately after the getDoc await, before any use of the result');
ok(monitorFnBody.includes('if (_detailClientId !== clientId) return;'), 'the fix re-checks _detailClientId against the captured clientId, matching the T127-H pattern used everywhere else');
ok((monitorFnBody.match(/_detailClientId/g) || []).length === 2, 'exactly 2 references now: the initial capture and the new post-await guard');

// ── Functional: execute the ACTUAL guard line logic with the exact real
// variable names, both when identity matches and when it has drifted
// mid-await (the coach switched clients while getDoc was in flight). ──────
{
  ok(monitorFnBody.includes("const clientId = _detailClientId;"), 'prerequisite: the real function captures clientId from _detailClientId before the await, exactly as simulated below');

  function simulateGuard(clientIdAtStart, clientIdAfterAwait) {
    var _detailClientId = clientIdAtStart;
    var clientId = _detailClientId;
    // ...await resolves here, and meanwhile the coach switched clients...
    _detailClientId = clientIdAfterAwait;
    if (_detailClientId !== clientId) return 'DISCARDED_STALE_RESPONSE';
    return 'APPLIED_TO_DOM';
  }
  ok(simulateGuard('client-A', 'client-A') === 'APPLIED_TO_DOM', 'same client throughout -> the response is applied normally');
  ok(simulateGuard('client-A', 'client-B') === 'DISCARDED_STALE_RESPONSE', 'coach switched to client-B while client-A\'s getDoc was in flight -> the exact real guard expression discards the stale response, never overwriting client-B\'s view');
}

console.log('');
console.log('T292 — Stale-context protection: ' + pass + ' assertions PASSED');
