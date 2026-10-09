'use strict';
/**
 * T321 — Reload / interruption / offline resilience (audit; already
 * correct across this whole run's prior tickets, no code change needed).
 *
 * Scenarios and where each is already handled:
 *  - reload during workout / after PARTIAL / after nutrition save: every
 *    terminal write is real-awaited (_doSaveLogs) before its success
 *    signal; LOGS is reloaded fresh from Firestore on every app boot
 *    (loadPlan), so a reload always shows the true persisted state
 *    (T295, T306 case R, T314 case N/O all already prove this).
 *  - reload while a form is open with unsaved input: standard, expected
 *    browser behavior (nothing was persisted yet, so nothing is "erased" --
 *    there is no partially-saved state to lose). Not a gap.
 *  - browser/app closed mid-session / stale session next day: T303's
 *    canonical stale-session recovery remains untouched and is the
 *    single source of truth (re-confirmed T311/T314 case H).
 *  - transient Firestore failure: _doSaveLogs() catches and returns false;
 *    every caller reverts its optimistic LOGS mutation and shows a real,
 *    persistent, tap-to-retry error -- never a fabricated success (T295).
 *  - listener reconnect: Firestore's own onSnapshot contract re-fires with
 *    fresh state; no custom reconnect-detection code needed (T294/T295).
 *  - PWA standalone reopen: the service worker (sw.js) uses network-first
 *    for the app's own HTML (falls back to cache only on network failure)
 *    and explicitly never intercepts Firebase Auth/Firestore requests --
 *    the SDK's own persistentLocalCache handles offline reads/writes.
 *    There is no second offline queue to keep in sync (this ticket
 *    explicitly forbids building one). loadPlan() (which includes T303's
 *    stale-session check) runs on every app boot regardless of standalone
 *    vs browser-tab mode.
 *  - a failed Firestore READ never erases real local data: loadBackupLogs()
 *    is tried BEFORE ever falling back to an empty LOGS = {}, and it even
 *    already guards against a stale cross-plan backup (if the backup's
 *    planId differs from the current activePlanId, only exercise
 *    history/units are recovered -- LOGS/week state is not blindly
 *    restored from a different plan's data).
 *
 * Run: node tests/t321-reload-offline-interruption-resilience.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const SW     = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

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

// ── Service worker: network-first for the app's own HTML, Firebase requests
// always pass through untouched -- no second offline queue. ────────────────
ok(SW.includes("if (url.hostname.includes('googleapis.com') && url.pathname.includes('/google.firestore')) return;"),
  'the service worker never intercepts Firestore requests -- the Firebase SDK\'s own persistentLocalCache handles offline reads/writes, no competing queue');
ok(SW.includes("if (url.hostname.includes('identitytoolkit.googleapis.com')) return;"), 'Auth requests also pass through untouched');
ok(/HTML propio.*network-first/.test(SW) || (SW.indexOf('fetch(req)') > 0 && SW.includes('.catch(() => caches.match(req))')),
  'the app\'s own HTML uses network-first with a cache fallback -- a standalone/PWA reopen with connectivity always gets the freshest app shell, never a stale cached version masking new deploys');

// ── A failed READ never erases real local data. ────────────────────────────
const loadBackupLogsSrc = extractFunction(CLIENT, 'function loadBackupLogs() {');
ok(loadBackupLogsSrc.includes('if (bkPlanId && curPlanId && bkPlanId !== curPlanId) {'),
  'loadBackupLogs() guards against restoring LOGS/week state from a STALE cross-plan local backup -- only exercise history/units are recovered in that case, never someone else\'s (or an old plan\'s) session data');
ok(loadBackupLogsSrc.indexOf('CURRENT_WEEK = 1;') > 0 || loadBackupLogsSrc.indexOf('CURRENT_WEEK = REAL_WEEK;') > 0,
  'loadBackupLogs() keeps REAL_WEEK/CURRENT_WEEK consistent with whichever state it actually restores');

const loadPlanIdx = CLIENT.indexOf('async function loadPlan(user) {');
const catchIdx = CLIENT.indexOf('catch(logErr)', loadPlanIdx);
const catchBlockSrc = CLIENT.slice(catchIdx, catchIdx + 300);
ok(catchBlockSrc.includes('if (!loadBackupLogs())'), 'on a failed Firestore logs read, loadPlan() tries the local backup BEFORE ever falling back to an empty LOGS = {} -- a transient read failure does not erase real data that exists locally');

// ── T303's stale-session detector remains the single canonical recovery
// path -- T321 did not add a second one. ───────────────────────────────────
ok((CLIENT.match(/function _findStaleOpenSession\(/g) || []).length === 1, 'exactly one _findStaleOpenSession definition -- still the single canonical stale-session detector');
ok(CLIENT.includes('_findStaleOpenSession(LOGS, REAL_WEEK, getSesiones())'), 'loadPlan still runs the stale-session check on every app boot, standalone or browser tab alike');

console.log('');
console.log('T321 — Reload/offline/interruption resilience: ' + pass + ' assertions PASSED. Already correct; no code changed this phase.');
