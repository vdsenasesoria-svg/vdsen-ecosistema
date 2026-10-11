'use strict';
// Deterministic async barriers for the Image Upload acceptance harness.
//
// WHY: lifecycle races (logout, coach switch, stale sessions) must be proven at an EXACT point of the
// pipeline, never by sleeping and hoping. An armed operation blocks at 'before' (nothing committed) or
// 'after' (state committed, promise still pending = UI settlement paused) until the harness releases it.
// This is harness instrumentation only; it lives in the generated test copy and never in the product.
//
// Operations and phases:
//   uploadBytes     before | after     (Storage double)
//   getDownloadURL  before | after     (Storage double)
//   deleteObject    before | after     (Storage double)
//   updateDoc       before | after     (Firestore double; 'after' = post-publish / pre-UI settlement)
//
// SINGLE SOURCE OF TRUTH. This module is instantiated TWICE in the browser: once as `window` scope
// (the guard at the bottom) and once as the page's ESM module graph (the bundle the coach HTML runs).
// The armed/waiters/triggered state therefore lives on `window.__HARNESS_BARRIERS_STATE__`, which BOTH
// copies read and write through the same Maps. Without this, a `window.__HARNESS_BARRIERS__.arm(...)`
// set from the harness side and the `gate(...)` consulted inside the bundled `uploadBytes` would use
// DIFFERENT Maps, so `waiting()` would never reach 1 and every pre-commit pause would silently no-op
// (which is exactly how the F01/F06/F09/F10/PC rows failed before this was fixed).
const key = (op, phase) => op + ':' + (phase || 'before');

// A tiny state registry shared across module instances via a unique symbol on the shared `window`.
const STATE_KEY = '__HARNESS_BARRIERS_STATE__';

function state(root) {
  if (!root[STATE_KEY]) {
    root[STATE_KEY] = { armed: new Map(), waiters: new Map(), triggered: new Map() };
  }
  return root[STATE_KEY];
}

// The shared Maps for the "window" context (there is no DOM-less context in the harness; every stub
// is loaded by the page bundle and the harness server injects `window` at the top).
function S() {
  if (typeof window === 'undefined') {
    // Should not happen in the harness (the module always runs inside a page), but keep a local
    // fallback so a node-side import does not crash; nothing in this file relies on it.
    const local = {};
    Object.defineProperty(local, STATE_KEY, { value: { armed: new Map(), waiters: new Map(), triggered: new Map() }, enumerable: false });
    return local[STATE_KEY];
  }
  return state(window);
}

function notify() {
  if (typeof window !== 'undefined' && window.__HARNESS_BARRIERS__ && typeof window.__HARNESS_BARRIERS__._onchange === 'function') {
    try { window.__HARNESS_BARRIERS__._onchange(); } catch (e) { /* observation only */ }
  }
}

export async function gate(op, phase) {
  const s = S();
  const k = key(op, phase);
  const mode = s.armed.get(k);
  if (!mode) return;
  s.triggered.set(k, (s.triggered.get(k) || 0) + 1);
  if (mode !== 'hold') s.armed.delete(k);   // one-shot arms fire exactly once
  notify();
  await new Promise((resolve) => {
    if (!s.waiters.has(k)) s.waiters.set(k, []);
    s.waiters.get(k).push(resolve);
    notify();
  });
  notify();
}

function arm(op, phase, mode) {
  const s = S();
  const k = key(op, phase);
  s.armed.set(k, mode);
  notify();
  return k;
}

function releaseOps(ops) {
  const s = S();
  const targets = ops ? [].concat(ops) : Array.from(s.waiters.keys()).concat(Array.from(s.armed.keys()));
  let released = 0;
  for (const k of targets) {
    s.armed.delete(k);
    const w = s.waiters.get(k) || [];
    s.waiters.delete(k);
    for (const r of w) { r(); released++; }
  }
  notify();
  return released;
}

export function install(root) {
  if (!root) return undefined;
  // A single API per root; on `window` it is what the harness CDP side calls.
  if (!root.__HARNESS_BARRIERS__) {
    root.__HARNESS_BARRIERS__ = {
      // one-shot: the NEXT matching call pauses until release
      arm: (op, phase) => arm(op, phase, true),
      // persistent: every matching call pauses until release
      armHold: (op, phase) => arm(op, phase, 'hold'),
      release: (op) => releaseOps(op ? [key(op, 'before'), key(op, 'after')] : null),
      releaseAll: () => releaseOps(null),
      waiting: () => {
        let n = 0; for (const w of state(root).waiters.values()) n += w.length; return n;
      },
      armedList: () => Array.from(state(root).armed.keys()),
      triggered: () => Object.fromEntries(state(root).triggered),
      reset: () => { state(root).armed.clear(); state(root).waiters.clear(); state(root).triggered.clear(); notify(); },
    };
  }
  // Both copies share the SAME `window` state, so there is nothing to re-mount here.
  return root.__HARNESS_BARRIERS__;
}

if (typeof window !== 'undefined') install(window);
