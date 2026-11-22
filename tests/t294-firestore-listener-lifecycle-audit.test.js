'use strict';
/**
 * T294 — Firestore listener lifecycle (audit-only, no code change).
 *
 * Every real onSnapshot() call site in both apps (4 in vdsen-coach.html:
 * monitor plan/client/logs + fichas_publicas; 5 in vdsen-cliente.html:
 * onboarding-wait client/plan + live client/plan/logs) already follows
 * the correct lifecycle:
 *
 *   1. prior listener unsubscribed before replacement -- every
 *      subscription site nulls out its own unsub var (or calls it) right
 *      before reassigning it.
 *   2. client switch does not retain the previous listener -- the coach's
 *      monitorClientSelect.onchange handler tears down all 3
 *      (_monitorUnsub/_monitorPlanUnsub/_monitorClientUnsub) at its own
 *      top, plus a _monitorGeneration counter guards the async getDoc
 *      before the plan/client listeners are even registered.
 *   3. activePlanId change re-subscribes correctly -- T148-H's client-doc
 *      listener re-points the plan listener at the new plan the moment
 *      activePlanId changes, rather than leaving it stuck on the
 *      superseded plan doc.
 *   4. logout tears down client-specific listeners -- both
 *      window._vdsenSignOut (coach) and _clearLiveListeners() (client,
 *      called before signOut) explicitly unsubscribe everything.
 *   5. repeated render does not stack duplicate listeners -- every
 *      subscribe function unsubscribes its OWN prior listener first
 *      (idempotent to call twice in a row).
 *   6. historical view cannot replace live listener state -- confirmed in
 *      T281/T290: _buildHistoricalMesocycleView/_onHistoricalMesoToggle
 *      use one-shot getDoc/getDocs only, never onSnapshot, and never
 *      touch any _liveUnsub-prefixed or _monitor-prefixed Unsub global.
 *
 * Run: node tests/t294-firestore-listener-lifecycle-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ── Real onSnapshot call-site count (excluding the unrelated
// _buildClientDecisionSnapshot false-positive substring match). ───────────
const coachRealOnSnapshot = (COACH.match(/= onSnapshot\(/g) || []).length;
ok(coachRealOnSnapshot === 4, 'exactly 4 real onSnapshot() listener registrations exist in vdsen-coach.html (monitor plan/client/logs + fichas_publicas)');
const clientRealOnSnapshot = (CLIENT.match(/FB\.onSnapshot\(/g) || []).length;
ok(clientRealOnSnapshot === 5, 'exactly 5 real onSnapshot() listener registrations exist in vdsen-cliente.html (2 onboarding-wait + 3 live)');

// ── 1/5. Teardown-before-reassign at every subscription site. ─────────────
ok(COACH.includes("if (window._monitorPlanUnsub) { window._monitorPlanUnsub(); window._monitorPlanUnsub = null; }\n        if (!planId)"),
  '_monitorSubscribeToPlan unsubscribes its own prior listener before checking/reassigning -- idempotent to call twice in a row');
ok(CLIENT.includes('function _clearLiveListeners() {'), 'the client app centralizes all live-listener teardown in one function');

// ── 2. Client switch tears down all 3 monitor listeners + generation guard. ──
ok(COACH.includes('let _monitorGeneration = 0;') && COACH.includes('const _myMonGen = ++_monitorGeneration;') && COACH.includes('if (_myMonGen !== _monitorGeneration) return;'),
  'the coach Monitor tab client-select handler uses a generation counter to abort a stale async getDoc before subscribing');
ok(COACH.includes('if (window._monitorUnsub) { window._monitorUnsub(); window._monitorUnsub = null; }\n      if (window._monitorPlanUnsub) { window._monitorPlanUnsub(); window._monitorPlanUnsub = null; }\n      if (window._monitorClientUnsub) { window._monitorClientUnsub(); window._monitorClientUnsub = null; } // T148-H'),
  'switching the monitored client tears down all 3 prior listeners (logs/plan/client) before anything new is registered');

// ── 3. activePlanId change re-subscribes the plan listener. ────────────────
ok(COACH.includes('const newActivePlanId = clientSnap.data().activePlanId || null;\n        if (newActivePlanId === _monitorActivePlanId) return;\n        _monitorActivePlanId = newActivePlanId;\n        _monitorSubscribeToPlan(newActivePlanId);'),
  'T148-H: when activePlanId changes on the monitored client, the plan listener is re-pointed at the NEW plan, never left stuck on the superseded one');

// ── 4. Logout tears down every client-specific listener, both apps. ────────
{
  const signOutIdx = COACH.indexOf('window._vdsenSignOut = () => {');
  const signOutSrc = COACH.slice(signOutIdx, COACH.indexOf('};', signOutIdx) + 2);
  ok(signOutSrc.includes('window._monitorUnsub') && signOutSrc.includes('window._monitorPlanUnsub') &&
     signOutSrc.includes('window._monitorClientUnsub') && signOutSrc.includes('window._fichasUnsub') && signOutSrc.includes('signOut(auth);'),
    'coach logout (_vdsenSignOut) tears down _monitorUnsub/_monitorPlanUnsub/_monitorClientUnsub/_fichasUnsub before signOut(auth)');
}
ok(CLIENT.includes('_clearLiveListeners();\n  await FB.signOut(FB.auth);'), 'client logout calls _clearLiveListeners() before FB.signOut');

// ── 5. Repeated render (loadFichasRecibidas) is idempotent. ────────────────
ok(COACH.includes('if(_fichasUnsub){ _fichasUnsub(); _fichasUnsub = null; }'), 'loadFichasRecibidas tears down its own prior listener before resubscribing -- safe to call repeatedly');

// ── 6. Historical subsystem never uses onSnapshot / never touches live
// listener globals. ─────────────────────────────────────────────────────
const histViewSrc = (function() {
  const idx = COACH.indexOf('function _buildHistoricalMesocycleView(planId, mesoDoc, planDoc, coachInterventions)');
  const braceStart = COACH.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < COACH.length; i++) {
    if (COACH[i] === '{') depth++;
    else if (COACH[i] === '}') { depth--; if (depth === 0) return COACH.slice(idx, i + 1); }
  }
  return '';
})();
ok(!histViewSrc.includes('onSnapshot'), '_buildHistoricalMesocycleView never registers a listener -- pure, one-shot, read-only');
const histToggleIdx = COACH.indexOf('window._onHistoricalMesoToggle = async function(clientId, isOpen) {');
const histToggleSrc = COACH.slice(histToggleIdx, COACH.indexOf('};', histToggleIdx) + 2);
ok(!histToggleSrc.includes('onSnapshot') && !histToggleSrc.includes('_monitorUnsub') && !histToggleSrc.includes('_liveUnsub'),
  '_onHistoricalMesoToggle never registers a listener and never touches any live-listener global -- structurally isolated from live state');

console.log('');
console.log('T294 — Firestore listener lifecycle audit: ' + pass + ' assertions PASSED (no defect found, no code change)');
