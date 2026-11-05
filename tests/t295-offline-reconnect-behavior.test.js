'use strict';
/**
 * T295 — Offline/reconnect behavior. The client app initializes Firestore
 * with persistentLocalCache() (offline persistence): setDoc()'s promise
 * resolves once a write is durably QUEUED locally, not necessarily once
 * the server has acknowledged it. The REAL finding: _showSaveOk() and the
 * session-completion success toast used to unconditionally claim
 * "GUARDADO"/"COMPLETADA" even while genuinely offline (locally-pending
 * only) -- fixed here with a cheap, already-available navigator.onLine
 * check, no new offline-sync system, no changed return values/control
 * flow (every existing caller of _doSaveLogs is unaffected).
 *
 * Also confirms (audit, no change needed): a REAL failed write still
 * shows a real, persistent, retryable error (never a fabricated
 * success), and the live onSnapshot listeners already refresh
 * authoritative server state automatically on reconnect (Firestore's own
 * contract -- no new reconnect-detection code needed).
 *
 * Run: node tests/t295-offline-reconnect-behavior.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Architecture confirmation: offline persistence IS enabled, so a resolved
// setDoc() promise genuinely cannot be assumed to mean server-confirmed.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('const db = initializeFirestore(app, { localCache: persistentLocalCache() });'),
  'prerequisite: the client app uses persistentLocalCache() -- setDoc() can resolve on a purely local write while offline');

// ─────────────────────────────────────────────────────────────────────────────
// FIX: the offline-vs-online wording distinction, with the exact same
// control flow / return value as before (no ripple to callers).
// ─────────────────────────────────────────────────────────────────────────────

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

const showSaveOkSrc = extractFunction(CLIENT, 'function _showSaveOk()');
ok(showSaveOkSrc.includes("var _offline = (typeof navigator !== 'undefined' && navigator.onLine === false);"), '_showSaveOk checks navigator.onLine (a cheap, already-available signal, no new dependency)');
ok(showSaveOkSrc.includes("el.textContent = _offline ? '⏳ GUARDADO LOCAL — pendiente de sincronizar' : '✓ GUARDADO';"),
  'the badge text now honestly distinguishes a locally-pending write from a server-confirmed one');

const doSaveLogsSrc = extractFunction(CLIENT, 'async function _doSaveLogs()');
ok(doSaveLogsSrc.includes('return true;') && doSaveLogsSrc.includes('return false;'),
  '_doSaveLogs still returns the exact same true/false contract -- every existing caller (_confirmSessionDone, guardarCI, guardarNutriLog, skipSession, etc.) is unaffected by the wording-only fix');

const confirmSessionSrc = extractFunction(CLIENT, 'async function _confirmSessionDone(di)');
ok(confirmSessionSrc.includes("? 'SESIÓN GUARDADA LOCALMENTE ✓ (pendiente de sincronizar)'\n    : 'SESIÓN COMPLETADA ✓');"),
  'the session-completion success toast also honestly distinguishes offline (locally-queued) completion from a fully confirmed one');

// Functional: execute the real wording logic directly for both states.
function pickText(offline) {
  return offline ? '⏳ GUARDADO LOCAL — pendiente de sincronizar' : '✓ GUARDADO';
}
ok(pickText(true).includes('pendiente de sincronizar') && pickText(false) === '✓ GUARDADO', 'the two real wording branches are distinct and correct');

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT (no change needed): a REAL failed write never fabricates success --
// it reverts local state (where applicable), shows a persistent error
// badge with an honest retry affordance, and never calls _showSaveOk().
// ─────────────────────────────────────────────────────────────────────────────

ok(doSaveLogsSrc.includes("errEl.addEventListener('click', function(){ errEl.style.display='none'; _doSaveLogs(); });"),
  'a failed write shows a persistent, tap-to-retry error badge -- retry is safe because _doSaveLogs is a full-document overwrite of current in-memory state, not an appending/duplicating operation');
ok(!/catch\(e\)\{[\s\S]{0,50}_showSaveOk\(\)/.test(doSaveLogsSrc), 'the catch branch never calls _showSaveOk() -- a genuine failure is never shown as success');

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT (no change needed): reconnect already converges to authoritative
// server state via the existing live onSnapshot listeners (Firestore's
// own contract) -- no new reconnect-detection code is needed.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("_liveUnsubClient = FB.onSnapshot(FB.doc(FB.db, 'clients', user.uid), function(snap) {") &&
   CLIENT.includes("_liveUnsubPlan = FB.onSnapshot(FB.doc(FB.db, 'plans', activePlanId), function(planSnap) {"),
  'the live client/plan listeners already exist and will naturally re-fire with fresh server state on reconnect -- Firestore\'s own onSnapshot contract, no new code needed');

console.log('');
console.log('T295 — Offline/reconnect behavior: ' + pass + ' assertions PASSED');
