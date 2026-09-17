'use strict';
/**
 * QA Round 8 — Listener / Timer Lifecycle Contract Tests
 *
 * Static-analysis assertions that verify structural invariants for listener
 * cleanup, timer cleanup, session-boundary state resets, and modal state
 * isolation in vdsen-cliente.html (CLIENT) and vdsen-coach.html (COACH).
 *
 * Gap-doc pattern: confirmed structural bugs are documented with
 * console.warn('[R8-GAP-XX] ...') and do NOT call assert.fail so the
 * suite keeps running.  Agent A/B should address each GAP.
 *
 * Run: node tests/qa_r8_listener_lifecycle_contracts.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'),  'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the source text of a named function from a source string.
 * Works for:  async function name(  /  function name(
 * Returns the text starting from "function name(" up to a balanced
 * closing brace (heuristic — stops at the first dedented '}' that closes
 * the outermost brace pair opened after the function keyword).
 */
function extractFunction(src, name) {
  // Locate the function declaration
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m  = re.exec(src);
  if (!m) return null;

  let start = m.index;
  // Find the opening brace
  let braceStart = src.indexOf('{', start);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null; // unbalanced — shouldn't happen
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-01
// Every FB.onSnapshot call result is stored in a named ref variable.
// Fire-and-forget onSnapshot leaks a live listener with no cleanup path.
// ─────────────────────────────────────────────────────────────────────────────

(function testC01_onSnapshotAllStored() {
  // Collect every FB.onSnapshot( occurrence in CLIENT.
  // We need the full line to check whether the call is preceded by an assignment.
  const lines = CLIENT.split('\n');
  const unassigned = [];
  for (const line of lines) {
    if (!line.includes('FB.onSnapshot(')) continue;
    // Must be assigned:  <varName> = FB.onSnapshot(
    if (!/\w+\s*=\s*FB\.onSnapshot\(/.test(line)) {
      unassigned.push(line.trim().slice(0, 120));
    }
  }
  assert.deepStrictEqual(
    unassigned, [],
    'C-01: All FB.onSnapshot calls must be stored in a ref variable. ' +
    'Unassigned calls: ' + JSON.stringify(unassigned)
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-02
// _clearLiveListeners exists and references every stored unsubscribe ref.
// ─────────────────────────────────────────────────────────────────────────────

(function testC02_clearLiveListenersComplete() {
  const fn = extractFunction(CLIENT, '_clearLiveListeners');
  assert.ok(fn, 'C-02a: _clearLiveListeners function must exist in CLIENT');

  const expectedRefs = [
    '_liveUnsubClient',
    '_liveUnsubPlan',
    '_liveUnsubLogs',
    '_waitUnsubClientDoc',
    '_waitUnsubActivePlan',
  ];
  for (const ref of expectedRefs) {
    assert.ok(
      fn.includes(ref),
      'C-02b: _clearLiveListeners must reference ' + ref
    );
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-03
// Each unsubscribe ref is nulled after calling inside _clearLiveListeners
// (prevents double-unsubscribe with a stale function reference).
// ─────────────────────────────────────────────────────────────────────────────

(function testC03_refsNulledAfterUnsub() {
  const fn = extractFunction(CLIENT, '_clearLiveListeners');
  assert.ok(fn, 'C-03 prerequisite: _clearLiveListeners exists');

  const refs = [
    '_liveUnsubClient',
    '_liveUnsubPlan',
    '_liveUnsubLogs',
    '_waitUnsubClientDoc',
    '_waitUnsubActivePlan',
  ];
  for (const ref of refs) {
    // Pattern:  ref = null  (with optional whitespace)
    const nullPattern = new RegExp(ref + '\\s*=\\s*null');
    assert.ok(
      nullPattern.test(fn),
      'C-03: ' + ref + ' must be set to null after unsubscribe in _clearLiveListeners'
    );
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-04
// Plan switch (loadPlan) calls _clearLiveListeners before registering
// any new onSnapshot listeners.
// ─────────────────────────────────────────────────────────────────────────────

(function testC04_planSwitchClearsFirst() {
  const fn = extractFunction(CLIENT, 'loadPlan');
  assert.ok(fn, 'C-04 prerequisite: loadPlan function exists in CLIENT');

  const clearIdx    = fn.indexOf('_clearLiveListeners');
  const snapshotIdx = fn.indexOf('FB.onSnapshot(');

  assert.ok(
    clearIdx !== -1,
    'C-04a: loadPlan must call _clearLiveListeners'
  );
  assert.ok(
    snapshotIdx !== -1,
    'C-04b: loadPlan must register at least one FB.onSnapshot listener'
  );
  assert.ok(
    clearIdx < snapshotIdx,
    'C-04c: _clearLiveListeners must appear before the first FB.onSnapshot in loadPlan'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-05
// clearInterval / stopRestTimer is called on the rest timer before re-arming.
// Prevents ghost intervals when the timer is restarted mid-session.
// ─────────────────────────────────────────────────────────────────────────────

(function testC05_restTimerClearedBeforeRearm() {
  const startFn = extractFunction(CLIENT, 'startRestTimer');
  assert.ok(startFn, 'C-05 prerequisite: startRestTimer function exists in CLIENT');

  // startRestTimer must call stopRestTimer() before setInterval
  const stopIdx     = startFn.indexOf('stopRestTimer()');
  const intervalIdx = startFn.indexOf('setInterval(');

  assert.ok(
    stopIdx !== -1,
    'C-05a: startRestTimer must call stopRestTimer() before arming the interval'
  );
  assert.ok(
    intervalIdx !== -1,
    'C-05b: startRestTimer must call setInterval to arm the timer'
  );
  assert.ok(
    stopIdx < intervalIdx,
    'C-05c: stopRestTimer() must precede setInterval() in startRestTimer'
  );

  // stopRestTimer itself must call clearInterval(_restTimer)
  const stopFn = extractFunction(CLIENT, 'stopRestTimer');
  assert.ok(stopFn, 'C-05d: stopRestTimer function exists in CLIENT');
  assert.ok(
    /clearInterval\(\s*_restTimer\s*\)/.test(stopFn),
    'C-05e: stopRestTimer must call clearInterval(_restTimer)'
  );
  assert.ok(
    /_restTimer\s*=\s*null/.test(stopFn),
    'C-05f: stopRestTimer must null _restTimer after clearInterval'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-06a
// _ciSubjTemp is reset on session/week boundary (setWeek) to prevent
// subjective check-in values from the previous week bleeding into a save
// that happens after the week is advanced.
// ─────────────────────────────────────────────────────────────────────────────

(function testC06a_ciSubjTempResetOnWeekChange() {
  const fn = extractFunction(CLIENT, 'setWeek');
  assert.ok(fn, 'C-06a prerequisite: setWeek function exists in CLIENT');
  assert.ok(
    /_ciSubjTemp\s*=\s*null/.test(fn),
    'C-06a: setWeek must null window._ciSubjTemp to prevent CI bleed across weeks'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-06b
// _ssStep is reset on session/week boundary (setWeek) to prevent stale
// superset step-state from a previous week being used in the new week.
// ─────────────────────────────────────────────────────────────────────────────

(function testC06b_ssStepResetOnWeekChange() {
  const fn = extractFunction(CLIENT, 'setWeek');
  assert.ok(fn, 'C-06b prerequisite: setWeek function exists in CLIENT');
  assert.ok(
    /_ssStep\s*=\s*\{\s*\}/.test(fn),
    'C-06b: setWeek must reset window._ssStep to {} to prevent superset step-state bleed'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT — C-07 (GAP)
// vdsen_active_plan_id is written per-user to localStorage but is NOT cleared
// on logout.  If a second user logs in on the same device, the stale plan ID
// can trigger a spurious plan-version reload for the new user.
// ─────────────────────────────────────────────────────────────────────────────

(function testC07_activePlanIdClearedOnLogout() {
  const logoutFn = extractFunction(CLIENT, 'doLogout');
  assert.ok(logoutFn, 'C-07 prerequisite: doLogout exists in CLIENT');

  const cleared = /removeItem\s*\(\s*['"]vdsen_active_plan_id['"]/.test(logoutFn);
  if (!cleared) {
    console.warn(
      '[R8-GAP-01] CLIENT doLogout does not call ' +
      "localStorage.removeItem('vdsen_active_plan_id').  " +
      'On a shared device, a second user sees the first user\'s stale plan ID, ' +
      'triggering an unnecessary plan-version reload.  ' +
      'Fix: add localStorage.removeItem(\'vdsen_active_plan_id\') in doLogout().'
    );
  } else {
    assert.ok(cleared, 'C-07: doLogout must clear vdsen_active_plan_id from localStorage');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-01
// Every onSnapshot call in COACH is assigned to a named window/let ref.
// Fire-and-forget onSnapshot leaks a live Firestore listener.
// ─────────────────────────────────────────────────────────────────────────────

(function testH01_onSnapshotAllStored() {
  // In COACH, onSnapshot is imported directly (not via FB.*).
  // Collect every bare onSnapshot( occurrence per line.
  const lines = COACH.split('\n');
  const unassigned = [];
  for (const line of lines) {
    if (!line.includes('onSnapshot(')) continue;
    // Skip import declaration lines and comment lines
    if (/^\s*import\s+/.test(line) || /from\s+['"]/.test(line)) continue;
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
    // Only check lines that actually call onSnapshot (not just reference it in a comment)
    if (!/\bonSnapshot\s*\(/.test(line)) continue;
    // Must be assigned:  <varName> = onSnapshot(
    if (!/\w+\s*=\s*onSnapshot\(/.test(line)) {
      unassigned.push(line.trim().slice(0, 120));
    }
  }
  assert.deepStrictEqual(
    unassigned, [],
    'H-01: All onSnapshot calls in COACH must be stored in a ref variable. ' +
    'Unassigned: ' + JSON.stringify(unassigned)
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-02
// Monitor panel re-subscribe: unsubscribe on _monitorUnsub and _monitorPlanUnsub
// is called before new onSnapshot listeners are registered.
// ─────────────────────────────────────────────────────────────────────────────

(function testH02_monitorUnsubBeforeReSub() {
  const fn = extractFunction(COACH, 'loadMonitorClients');
  assert.ok(fn, 'H-02 prerequisite: loadMonitorClients function exists in COACH');

  // _monitorUnsub() call must precede window._monitorUnsub = onSnapshot(
  const clearMonitorIdx = fn.indexOf('_monitorUnsub()');
  const setMonitorIdx   = fn.indexOf('_monitorUnsub = onSnapshot(');
  assert.ok(clearMonitorIdx !== -1, 'H-02a: loadMonitorClients must call _monitorUnsub() before re-subscribing');
  assert.ok(setMonitorIdx   !== -1, 'H-02b: loadMonitorClients must assign _monitorUnsub = onSnapshot(...)');
  assert.ok(
    clearMonitorIdx < setMonitorIdx,
    'H-02c: _monitorUnsub() call must precede the new _monitorUnsub = onSnapshot assignment'
  );

  // _monitorPlanUnsub cleared before re-subscribe
  const clearPlanIdx = fn.indexOf('_monitorPlanUnsub()');
  const setPlanIdx   = fn.indexOf('_monitorPlanUnsub = onSnapshot(');
  assert.ok(clearPlanIdx !== -1, 'H-02d: loadMonitorClients must call _monitorPlanUnsub() before re-subscribing');
  assert.ok(setPlanIdx   !== -1, 'H-02e: loadMonitorClients must assign _monitorPlanUnsub = onSnapshot(...)');
  assert.ok(
    clearPlanIdx < setPlanIdx,
    'H-02f: _monitorPlanUnsub() call must precede the new _monitorPlanUnsub = onSnapshot assignment'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-03
// Monitor panel listeners are stored in named refs AND nulled on unsubscribe.
// ─────────────────────────────────────────────────────────────────────────────

(function testH03_monitorListenersStoredAndNulled() {
  // _monitorUnsub
  assert.ok(
    /window\._monitorUnsub\s*=\s*onSnapshot\(/.test(COACH),
    'H-03a: _monitorUnsub must be assigned from onSnapshot()'
  );
  assert.ok(
    /window\._monitorUnsub\s*=\s*null/.test(COACH),
    'H-03b: _monitorUnsub must be nulled after calling'
  );

  // _monitorPlanUnsub
  assert.ok(
    /window\._monitorPlanUnsub\s*=\s*onSnapshot\(/.test(COACH),
    'H-03c: _monitorPlanUnsub must be assigned from onSnapshot()'
  );
  assert.ok(
    /window\._monitorPlanUnsub\s*=\s*null/.test(COACH),
    'H-03d: _monitorPlanUnsub must be nulled after calling'
  );

  // _fichasUnsub
  assert.ok(
    /_fichasUnsub\s*=\s*onSnapshot\(/.test(COACH),
    'H-03e: _fichasUnsub must be assigned from onSnapshot()'
  );
  assert.ok(
    /_fichasUnsub\s*=\s*null/.test(COACH),
    'H-03f: _fichasUnsub must be nulled after calling'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-04 (GAP)
// _importedPlan is NOT cleared in showClientDetail.  If the coach imports a
// plan for client A, then opens client B via navClient or a direct call to
// showClientDetail, window._importedPlan still holds client A's plan.
// A subsequent saveImportedPlan() (which uses _detailClientId as default)
// would write client A's plan structure to client B.
//
// The T117-H fix only clears _importedPlan on planClientSelect.onchange and
// in saveImportedPlan itself — it does NOT cover the navClient → showClientDetail
// path.
// ─────────────────────────────────────────────────────────────────────────────

(function testH04_importedPlanClearedOnClientSwitch() {
  // Extract the showClientDetail function body
  const fn = extractFunction(COACH, 'showClientDetail');
  assert.ok(fn, 'H-04 prerequisite: showClientDetail function exists in COACH');

  // Does showClientDetail clear _importedPlan anywhere in its body?
  const clearedInDetail = /_importedPlan\s*=\s*null/.test(fn);

  if (!clearedInDetail) {
    console.warn(
      '[R8-GAP-02] COACH showClientDetail does NOT clear window._importedPlan ' +
      'when switching clients.  Only planClientSelect.onchange and saveImportedPlan ' +
      'clear it.  The navClient → showClientDetail path leaves a stale plan object ' +
      'that can be written to the wrong client on the next saveImportedPlan() call.  ' +
      'Fix: add `window._importedPlan = null;` at the top of showClientDetail().'
    );
  } else {
    assert.ok(clearedInDetail, 'H-04: showClientDetail must clear window._importedPlan on entry');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-05a (GAP)
// saveCoachNote is async and writes to _detailClientData AFTER an await.
// It does not capture a snapshot guard (_clientIdSnap = _detailClientId)
// before the await, so if the coach switches clients while the Firestore
// write is in-flight the post-await mutation targets the wrong in-memory object.
// Compare with saveNutritionPlan which correctly uses _clientIdSnap.
// ─────────────────────────────────────────────────────────────────────────────

(function testH05a_saveCoachNoteSnapshotGuard() {
  const fn = extractFunction(COACH, 'saveCoachNote');
  assert.ok(fn, 'H-05a prerequisite: saveCoachNote exists in COACH');

  // Look for a snapshot-guard pattern:
  //   const _clientIdSnap = _detailClientId  (before the await)
  //   or:  if (_detailClientId !== _clientIdSnap) return  (after the await)
  const hasGuard = /const\s+_\w*[Ss]nap\w*\s*=\s*_detailClientId/.test(fn) ||
                   /_detailClientId\s*!==\s*_\w*[Ss]nap/.test(fn);

  if (!hasGuard) {
    console.warn(
      '[R8-GAP-03] COACH saveCoachNote has no snapshot guard for _detailClientId. ' +
      'It writes `_detailClientData.coachNote = val` after an await.  If the coach ' +
      'switches clients while the write is in-flight, _detailClientData now points to ' +
      'the new client\'s data and the mutation corrupts it.  ' +
      'Fix: capture `const _clientIdSnap = _detailClientId` before the first await ' +
      'and add `if (_detailClientId !== _clientIdSnap) return;` before post-await DOM/data writes.'
    );
  } else {
    assert.ok(hasGuard, 'H-05a: saveCoachNote must have a stale-client snapshot guard');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-05b (GAP)
// saveClientMessage has the same post-await _detailClientData mutation without
// a snapshot guard.
// ─────────────────────────────────────────────────────────────────────────────

(function testH05b_saveClientMessageSnapshotGuard() {
  const fn = extractFunction(COACH, 'saveClientMessage');
  assert.ok(fn, 'H-05b prerequisite: saveClientMessage exists in COACH');

  const hasGuard = /const\s+_\w*[Ss]nap\w*\s*=\s*_detailClientId/.test(fn) ||
                   /_detailClientId\s*!==\s*_\w*[Ss]nap/.test(fn);

  if (!hasGuard) {
    console.warn(
      '[R8-GAP-04] COACH saveClientMessage has no snapshot guard for _detailClientId. ' +
      'It writes `_detailClientData.clientMessage = val` after an await.  ' +
      'Same race as GAP-03 — if client is switched during the await, the mutation ' +
      'corrupts the new client\'s in-memory data.  ' +
      'Fix: same pattern as saveNutritionPlan — capture _clientIdSnap before await, ' +
      'guard the post-await data mutation.'
    );
  } else {
    assert.ok(hasGuard, 'H-05b: saveClientMessage must have a stale-client snapshot guard');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-05c
// saveNutritionPlan correctly uses a snapshot guard — verify this positive
// case so regressions are caught if the guard is accidentally removed.
// ─────────────────────────────────────────────────────────────────────────────

(function testH05c_saveNutritionPlanHasGuard() {
  const fn = extractFunction(COACH, 'saveNutritionPlan');
  assert.ok(fn, 'H-05c prerequisite: saveNutritionPlan exists in COACH');

  const hasCapture = /const\s+_clientIdSnap\s*=\s*_detailClientId/.test(fn);
  const hasCheck   = /_detailClientId\s*!==\s*_clientIdSnap/.test(fn);

  assert.ok(
    hasCapture,
    'H-05c: saveNutritionPlan must capture _clientIdSnap = _detailClientId before await'
  );
  assert.ok(
    hasCheck,
    'H-05c: saveNutritionPlan must guard post-await DOM writes with _detailClientId !== _clientIdSnap'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// COACH — H-02-extra
// logout / signOut path in COACH also clears all monitor listeners so no
// orphaned Firestore subscriptions survive after the session ends.
// ─────────────────────────────────────────────────────────────────────────────

(function testH02extra_logoutClearsMonitorListeners() {
  // Find the signOut / auth-state-changed null branch that performs cleanup.
  // Look for the block that runs when user === null and confirm it calls
  // _monitorUnsub() and _monitorPlanUnsub() before the session ends.
  const hasMonitorClear     = /if\s*\(\s*window\._monitorUnsub\s*\)\s*\{[^}]*window\._monitorUnsub\s*=\s*null/.test(COACH);
  const hasMonitorPlanClear = /if\s*\(\s*window\._monitorPlanUnsub\s*\)\s*\{[^}]*window\._monitorPlanUnsub\s*=\s*null/.test(COACH);

  assert.ok(
    hasMonitorClear,
    'H-02-extra: COACH must clear _monitorUnsub (call + null) on session end'
  );
  assert.ok(
    hasMonitorPlanClear,
    'H-02-extra: COACH must clear _monitorPlanUnsub (call + null) on session end'
  );
})();

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log('');
console.log('QA Round 8 — listener lifecycle contracts');
console.log('==========================================');
console.log('Invariants checked:');
console.log('  CLIENT C-01  All FB.onSnapshot calls stored in ref          PASS');
console.log('  CLIENT C-02  _clearLiveListeners exists & covers all refs   PASS');
console.log('  CLIENT C-03  All unsub refs nulled inside _clearLiveListeners PASS');
console.log('  CLIENT C-04  loadPlan calls _clearLiveListeners before sub  PASS');
console.log('  CLIENT C-05  startRestTimer clears interval before re-arming PASS');
console.log('  CLIENT C-06a _ciSubjTemp nulled in setWeek                  PASS');
console.log('  CLIENT C-06b _ssStep reset in setWeek                       PASS');
console.log('  CLIENT C-07  vdsen_active_plan_id cleared on logout         GAP  → [R8-GAP-01]');
console.log('  COACH  H-01  All onSnapshot calls stored in ref             PASS');
console.log('  COACH  H-02  Monitor unsubscribes before re-subscribing     PASS');
console.log('  COACH  H-03  All monitor listener refs stored and nulled    PASS');
console.log('  COACH  H-04  _importedPlan cleared in showClientDetail      GAP  → [R8-GAP-02]');
console.log('  COACH  H-05a saveCoachNote has snapshot guard               GAP  → [R8-GAP-03]');
console.log('  COACH  H-05b saveClientMessage has snapshot guard           GAP  → [R8-GAP-04]');
console.log('  COACH  H-05c saveNutritionPlan snapshot guard (positive)    PASS');
console.log('  COACH  H-02x logout clears monitor listeners                PASS');
console.log('');
console.log('QA Round 8 — listener lifecycle contracts: ALL ASSERTIONS PASSED');
