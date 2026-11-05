'use strict';
/**
 * T565 — Client startup modal coordination.
 *
 * Bug (reproduced in the local training harness): on the first app entry after the
 * phone rollout the client received TWO stacked modals — "Actualizaciones recientes"
 * (showWhatsNew, unconditional at loadPlan) and, 900 ms later, the phone confirmation
 * prompt, which was scheduled on a fixed timer WITHOUT checking whether another
 * startup modal was already on screen. Both covered the training screen.
 *
 * Fix: the phone prompt now waits until the startup modals are closed.
 *
 * Run: node tests/t565-startup-modal-coordination.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced: ' + decl);
}

// Minimal fake DOM: only what _startupModalOpen reads.
function makeDom(visibleIds) {
  const els = {};
  for (const id of visibleIds) els[id] = { id, style: { display: 'flex' }, offsetParent: null };
  return { getElementById: (id) => els[id] || null, _els: els };
}

const src = extractFunction(CLIENT, 'function _startupModalOpen(') + '\n' + extractFunction(CLIENT, 'function _showPhoneConfirmWhenClear(');

function build(dom, options = {}) {
  const calls = [];
  const timers = [];
  const sandbox = {
    document: dom,
    Date: { now: () => options.now || 1000 },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    showPhoneConfirmModal: (ref, data) => calls.push({ ref, data }),
    // Models the browser: a mounted, not explicitly hidden overlay is OPEN, even though a
    // position:fixed element reports offsetParent === null. The first version of this test
    // stubbed only offsetParent, which is exactly the trap that made the real fix ineffective.
    getComputedStyle: (el) => ({ display: (el.style && el.style.display) || 'flex', visibility: 'visible', opacity: '1' }),
  };
  const factory = new Function('sandbox', `
    const document = sandbox.document, Date = sandbox.Date, setTimeout = sandbox.setTimeout;
    const showPhoneConfirmModal = sandbox.showPhoneConfirmModal;
    const window = { getComputedStyle: sandbox.getComputedStyle };
    ${src}
    return { _startupModalOpen, _showPhoneConfirmWhenClear };
  `);
  return { api: factory(sandbox), calls, timers };
}

let pass = 0, fail = 0;
const eq = (a, b, label) => { if (a === b) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label + ' :: ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); } };
const ok = (v, label) => eq(!!v, true, label);

console.log('T565 — startup modal coordination');

// 1. no startup modal open -> shows after the initial delay
{
  const dom = makeDom([]);
  const { api, calls, timers } = build(dom);
  api._showPhoneConfirmWhenClear({}, {});
  eq(timers.length, 1, 'T565-1 schedules the first attempt');
  eq(timers[0].ms, 900, 'T565-2 waits for the other startup work first');
  timers[0].fn();
  eq(calls.length, 1, 'T565-3 shows the prompt when nothing else is open');
}

// 2. WhatsNew open -> it must NOT stack; it waits
{
  const dom = makeDom(['wnModal']);
  const { api, calls, timers } = build(dom);
  api._showPhoneConfirmWhenClear({}, {});
  timers[0].fn();
  eq(calls.length, 0, 'T565-4 does NOT stack on top of WhatsNew');
  eq(timers.length, 2, 'T565-5 reschedules while WhatsNew is open');
  // client closes WhatsNew -> next attempt shows it
  delete dom._els.wnModal;
  timers[1].fn();
  eq(calls.length, 1, 'T565-6 shows once WhatsNew is closed');
}

// 3. bitacora info modal also defers
{
  const dom = makeDom(['biModal']);
  const { api, calls, timers } = build(dom);
  api._showPhoneConfirmWhenClear({}, {});
  timers[0].fn();
  eq(calls.length, 0, 'T565-7 defers for the bitacora modal too');
}

// 4. already open prompt -> no duplicate (showPhoneConfirmModal also guards)
{
  const dom = makeDom(['phoneConfirmOverlay']);
  const { api, calls, timers } = build(dom);
  api._showPhoneConfirmWhenClear({}, {});
  timers[0].fn();
  eq(calls.length, 0, 'T565-8 never duplicates an open prompt');
}

// 5. already confirmed / recently skipped -> never shows
{
  const dom = makeDom([]);
  const a = build(dom);
  a.api._showPhoneConfirmWhenClear({}, { phoneConfirmedAt: 123 });
  a.timers[0].fn();
  eq(a.calls.length, 0, 'T565-9 confirmed clients are never asked again');

  const b = build(dom, { now: 1000 });
  b.api._showPhoneConfirmWhenClear({}, { phoneSkippedAt: 1000 });
  b.timers[0].fn();
  eq(b.calls.length, 0, 'T565-10 a recent skip is respected');

  const c = build(dom, { now: 9 * 86400000 });
  c.api._showPhoneConfirmWhenClear({}, { phoneSkippedAt: 1000 });
  c.timers[0].fn();
  eq(c.calls.length, 1, 'T565-11 an older-than-7-days skip asks again');
}

// 6. never lost: after the hard cap it shows even if a modal stayed open
{
  const dom = makeDom(['wnModal']);
  const { api, calls, timers } = build(dom);
  api._showPhoneConfirmWhenClear({}, {});
  let guard = 0;
  while (calls.length === 0 && guard < 2000) { const t = timers.pop(); if (!t) break; t.fn(); guard++; }
  eq(calls.length, 1, 'T565-12 the prompt is never silently lost');
  ok(guard <= 5 * 60 * 1000 / 400 + 4, 'T565-13 gives up within the 5 minute cap (attempts=' + guard + ')');
}

// 7. source contract: the fixed 900 ms timer must be gone from loadPlan
{
  ok(!/setTimeout\(function\(\)\{ showPhoneConfirmModal\(clientRef, clientData\); \}, 900\);/.test(CLIENT), 'T565-14 the uncoordinated fixed timer is removed');
  ok(/_showPhoneConfirmWhenClear\(clientRef, clientData\)/.test(CLIENT), 'T565-15 loadPlan uses the coordinated path');
  ok(/window\._showPhoneConfirmWhenClear = _showPhoneConfirmWhenClear/.test(CLIENT), 'T565-16 helper is exposed for the existing harnesses');
}

// 8. the underlying prompt keeps its own duplicate guard
{
  ok(/function showPhoneConfirmModal\(clientRef, clientData\) \{\s*\n\s*if \(document\.getElementById\('phoneConfirmOverlay'\)\) return;/.test(CLIENT), 'T565-17 showPhoneConfirmModal still refuses to open twice');
}

console.log('\nT565: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
