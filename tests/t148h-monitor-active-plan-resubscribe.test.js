'use strict';
/**
 * T148 — Plan / Monitor version consistency.
 *
 * Scope: active plan reads, Monitor reads, updatedAt/version/week, refresh
 * handlers.
 *
 * Bug found: loadMonitorClients()'s select.onchange handler captured
 * clientData.activePlanId from a ONE-TIME getDocs query (run once when the
 * Monitor section first loads) and attached a single onSnapshot listener to
 * that fixed plans/{activePlanId} document. If the client's active plan
 * changed while being monitored — via ANY activation path (Preview/Activate,
 * the Ficha-tab instant-generate, duplicatePlan, template apply, etc.) — the
 * outgoing plan doc is never deleted or mutated (by design, preserved for
 * history), so the Monitor's listener kept firing with the OLD plan's
 * unchanged content forever. Re-selecting the same client in the monitor
 * dropdown didn't fix it either, since clientsMap itself was populated from
 * the same one-time getDocs snapshot — only fully navigating away from and
 * back to the Monitor section (forcing a fresh loadMonitorClients() call)
 * would pick up the change. Meanwhile the client app's own listener and the
 * coach's Plan tab (via showClientDetail's fresh getDoc on every open/save)
 * both converge correctly — only the standalone Monitor panel was affected.
 *
 * Fix: added an onSnapshot listener on the client doc itself
 * (clients/{selectedId}) that detects activePlanId changes and re-points
 * the plan listener (_monitorSubscribeToPlan) at the new plan, tearing down
 * the old one first — same unsubscribe-before-resubscribe discipline as
 * every other listener in this file (Round 8 lifecycle conventions). The
 * new _monitorClientUnsub is cleaned up on client re-selection and on
 * logout, alongside the existing _monitorUnsub/_monitorPlanUnsub.
 *
 * Run: node tests/t148h-monitor-active-plan-resubscribe.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

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

const loadMonitorFn = extractFunction(COACH, 'async function loadMonitorClients()');
assert.ok(loadMonitorFn, 'loadMonitorClients must exist');

// ─────────────────────────────────────────────────────────────────────────────
// Fix: a client-doc listener that re-subscribes the plan listener when
// activePlanId changes.
// ─────────────────────────────────────────────────────────────────────────────

assert.ok(
  /window\._monitorClientUnsub = onSnapshot\(doc\(db, 'clients', select\.value\)/.test(loadMonitorFn),
  'T148-H: loadMonitorClients must subscribe to the client doc to detect activePlanId changes'
);
assert.ok(
  /function _monitorSubscribeToPlan\(planId\)/.test(loadMonitorFn),
  'T148-H: a _monitorSubscribeToPlan helper must exist to (re)attach the plan listener'
);
assert.ok(
  /if \(newActivePlanId === _monitorActivePlanId\) return;/.test(loadMonitorFn) &&
  /_monitorSubscribeToPlan\(newActivePlanId\);/.test(loadMonitorFn),
  'T148-H: the client listener must re-subscribe to the plan listener when activePlanId actually changes'
);

// The plan-subscribe helper itself must unsubscribe the previous plan
// listener before attaching a new one (no listener leak on plan switch).
const subscribeHelperIdx = loadMonitorFn.indexOf('function _monitorSubscribeToPlan(planId)');
const subscribeHelperBody = loadMonitorFn.slice(subscribeHelperIdx, subscribeHelperIdx + 400);
assert.ok(
  /if \(window\._monitorPlanUnsub\) \{ window\._monitorPlanUnsub\(\); window\._monitorPlanUnsub = null; \}/.test(subscribeHelperBody),
  'T148-H: _monitorSubscribeToPlan must unsubscribe the previous plan listener before attaching a new one'
);

console.log('Monitor re-subscribes its plan listener when activePlanId changes — OK');

// ─────────────────────────────────────────────────────────────────────────────
// Regression guards — cleanup on client re-selection and on logout, and the
// existing plan-edit-detection onSnapshot behavior remain intact.
// ─────────────────────────────────────────────────────────────────────────────

const onchangeIdx = loadMonitorFn.indexOf('select.onchange = async () => {');
const onchangeTop = loadMonitorFn.slice(onchangeIdx, onchangeIdx + 400);
assert.ok(
  /if \(window\._monitorClientUnsub\) \{ window\._monitorClientUnsub\(\); window\._monitorClientUnsub = null; \}/.test(onchangeTop),
  'T148-H regression: _monitorClientUnsub must be cleared at the top of select.onchange (client re-selection), like _monitorUnsub/_monitorPlanUnsub'
);

const signOutFn = extractFunction(COACH, 'window._vdsenSignOut = () => {');
assert.ok(signOutFn, '_vdsenSignOut must exist');
assert.ok(
  /if \(window\._monitorClientUnsub\)\{ window\._monitorClientUnsub\(\); window\._monitorClientUnsub = null; \}/.test(signOutFn),
  'T148-H regression: _monitorClientUnsub must be cleared on coach logout, like _monitorUnsub/_monitorPlanUnsub'
);

assert.ok(
  loadMonitorFn.includes("mantiene _activePlanCache fresco si el plan es editado"),
  'T148-H regression: the original plan-edit-detection comment/behavior context must remain present'
);

console.log('Cleanup on client re-selection and logout, and existing plan-edit listener, all unchanged — OK');

console.log('');
console.log('T148 — Plan/Monitor version consistency: ALL ASSERTIONS PASSED');
