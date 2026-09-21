'use strict';
/**
 * T335 — Authenticated AI generation gate (Coach client-side half).
 *
 * The server-side half (api/vdsen-generate.js's auth step, api/vdsen-auth.js,
 * api/_firebaseAdmin.js) has its own dedicated test files
 * (api/vdsen-auth.test.js, api/_firebaseAdmin.test.js) and its own
 * integration cases inside api/vdsen-generate.test.js (T-AUTH-A..J). This
 * file covers what only exists in the browser: vdsenAIPreview() now sends a
 * real Firebase ID token, guards against calling the endpoint while logged
 * out, and composes with the pre-existing T144-H stale-context guard rather
 * than replacing it.
 *
 * CASE G (Coach logout during request): getIdToken() is itself an await;
 *   this file adds a SECOND `!auth.currentUser` check immediately after it
 *   resolves, before the button is set to "generating" or the fetch fires —
 *   composing with the pre-existing T144-H guards further downstream (after
 *   the network await too) that already prevent a false-success UI update
 *   for a client the coach has since navigated away from.
 * CASE H (double-click): unchanged — UI_STATES.building_request() (the very
 *   first line of the try block, unconditionally before this new code) still
 *   disables the button synchronously; native disabled-button semantics mean
 *   no second click can re-enter the function while a request is in flight.
 *   No new reentrancy flag was needed or added.
 *
 * Run: node tests/t335-authenticated-ai-generation-gate.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

const previewSrc = extractFunction(COACH, 'async function vdsenAIPreview() {');

// ── Client sends a real Firebase ID token, not a fabricated identity. ──────
ok(previewSrc.includes('_vdsenIdToken = await auth.currentUser.getIdToken();'),
  'vdsenAIPreview obtains a real Firebase ID token via auth.currentUser.getIdToken() -- never a hand-built or cached string');
ok(previewSrc.includes("'Authorization': 'Bearer ' + _vdsenIdToken"),
  'the token is sent as a standard Authorization: Bearer header on the /api/vdsen-generate request');
ok(!/coachId\s*:\s*['"]|Authorization.*coachId/.test(previewSrc.match(/headers:\s*\{[^}]*\}/)?.[0] || ''),
  'the Authorization header carries the token only -- no client-supplied coachId/uid is sent as an identity claim');

// ── Guard: no logged-in Coach -> never call the endpoint at all. ───────────
const preTokenGuardIdx = previewSrc.indexOf('if (!auth.currentUser)');
ok(preTokenGuardIdx !== -1 && preTokenGuardIdx < previewSrc.indexOf('getIdToken()'),
  'a "no logged-in Coach" guard exists and runs BEFORE any token is requested');
ok(!previewSrc.slice(0, preTokenGuardIdx).includes("fetch('/api/vdsen-generate'"),
  'the pre-token guard runs before the fetch call exists in source order -- the endpoint is never reachable without a token attempt first');

// ── Token failure is a visible error, not a silent/false success. ─────────
const tokenTryIdx = previewSrc.indexOf('_vdsenIdToken = await auth.currentUser.getIdToken();');
const tokenCatchSlice = previewSrc.slice(tokenTryIdx, tokenTryIdx + 300);
ok(tokenCatchSlice.includes('catch (tokenErr)') && tokenCatchSlice.includes('UI_STATES.error('),
  'a getIdToken() failure (e.g. network error refreshing the token) surfaces a real UI_STATES.error, never a silent failure');

// ── CASE G: a SECOND currentUser check immediately after the token await,
// before the button flips to "generating" or the network call fires. ──────
const afterTokenGuardCount = (previewSrc.match(/if \(!auth\.currentUser\)/g) || []).length;
ok(afterTokenGuardCount >= 2, 'CASE G: auth.currentUser is re-checked AFTER the getIdToken() await resolves, not just before it -- a logout during that await is caught');
const secondGuardIdx = previewSrc.indexOf('if (!auth.currentUser)', tokenTryIdx);
ok(secondGuardIdx > tokenTryIdx && secondGuardIdx < previewSrc.indexOf('UI_STATES.generating()'),
  'CASE G: the post-await re-check happens strictly before UI_STATES.generating() and the fetch — no window where a stale session still proceeds');

// ── CASE G continued: this composes with, does not replace, the pre-existing
// T144-H guards further downstream (after the network round-trip). ────────
ok((previewSrc.match(/planClientSelect'\)\?\.value !== clientId/g) || []).length >= 2,
  'the pre-existing T144-H stale-context guards (checked after the network response too) are still present and unmodified');

// ── CASE H: double-click guard is untouched — button disables synchronously
// before any of the new async token/fetch code runs. ──────────────────────
const buildingReqIdx = previewSrc.indexOf('UI_STATES.building_request();');
ok(buildingReqIdx !== -1 && buildingReqIdx < preTokenGuardIdx,
  'CASE H: UI_STATES.building_request() (which disables the button) still runs before any new auth-guard code — double-click protection is unchanged');

// ── Server rejection of the token (401/403) is a visible, distinct error. ──
const httpErrSrc = extractFunction(COACH, 'function _vdsenAIHttpError(status, body, UI_STATES) {');
ok(httpErrSrc.includes('status === 401') && httpErrSrc.includes('status === 403'),
  '401 (unauthenticated) and 403 (authenticated but not an authorized coach) are both handled as distinct, visible errors');
ok(httpErrSrc.indexOf('status === 401') < httpErrSrc.indexOf('status === 400'),
  '401/403 are checked before the pre-existing 400/422/500 branches -- ordering preserved, nothing before them removed');

console.log('');
console.log('T335 — Authenticated AI generation gate (client side): ' + pass + ' assertions PASSED.');
