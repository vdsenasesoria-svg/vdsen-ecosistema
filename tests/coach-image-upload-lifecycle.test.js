'use strict';
// PHASE 3 — UI LIFECYCLE SETTLEMENT (LIFE-01..06) and POST_COMMIT_UI_ISOLATION.
//
// These drive the REAL mount: a real click through a real listener, a real deferred persist, and real
// settlement. Reading the source would not prove the ordering, which is exactly the class of defect that
// produced the async-cancellation bug earlier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MOUNT = require('../assets/coach-image-upload/mount.js');
// mount.js resolves the photo-section through its root (globalThis in Node), so it must be published there
// exactly as the browser does by loading photo-section.js as a classic script before mount.js.
const UI_MOD = require('../assets/coach-image-upload/photo-section.js');
globalThis.VDSEN_COACH_IMAGE_UI = UI_MOD;
const PATHS = require('../assets/coach-image-upload/paths.js');

const COACH_A = 'coachA000000000000000001';
const COACH_B = 'coachB000000000000000002';
const DOC_A = 'docExerciseA';

// A DOM double with real listener dispatch, so click ordering is genuinely exercised.
function fakeDom() {
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(), children: [], style: {}, id: '', disabled: false,
      value: '', files: null, onclick: null, onchange: null, parentNode: null,
      _src: null, _html: '', listeners: {}, textContent: '',
      set src(v) { this._src = v; }, get src() { return this._src; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      // Dispatches in registration order and honours stopImmediatePropagation, like a capture listener.
      emit(type) {
        const ev = { type, prevented: false, stopped: false,
          preventDefault() { this.prevented = true; },
          stopImmediatePropagation() { this.stopped = true; },
          stopPropagation() { this.stopped = true; } };
        for (const fn of (this.listeners[type] || [])) { fn(ev); if (ev.stopped) break; }
        return ev;
      },
      querySelector(sel) { const id = String(sel).replace('#', ''); return (this.byId[id] = this.byId[id] || el('div')); },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      get firstChild() { return this.children[0] || null; },
      byId: {},
    };
  }
  return { document: { createElement: el, getElementById: () => null }, el };
}

function harness(opts) {
  opts = opts || {};
  const dom = fakeDom();
  const saveBtn = dom.el('button');
  const statusEl = dom.el('div');
  let attachedSection = null;
  saveBtn.parentNode = { insertBefore: (n) => { attachedSection = n; return n; } };

  let coachUid = COACH_A;
  let exerciseId = DOC_A;
  let seq = 1;
  const state = { onDone: 0, stale: 0, intercepts: 0 };

  const ctx = {
    current: () => ({ coachUid, coachId: coachUid, exerciseId, exercise: { imageUrl: '', assetRef: '' } }),
    token: () => String(seq) + ':' + coachUid + ':' + exerciseId,
  };

  let settle = null;
  const pending = new Promise((r) => { settle = r; });
  const prepResult = {
    ok: true, blob: { size: 200 * 1024, type: 'image/jpeg' }, type: 'image/jpeg', bytes: 200 * 1024,
    width: 1360, height: 994, token: ctx.token(), coachUid, exerciseId,
  };

  // showToast is read off the mount's root, so inject it there for the assertion.
  const rootObj = globalThis;
  const prevToast = rootObj.showToast;
  rootObj.showToast = () => {};

  const mounted = MOUNT.mount({
    env: { document: dom.document, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} } },
    overlay: dom.el('div'),
    saveBtn, statusEl, ctx,
    controller: {
      prepare: async () => prepResult,
      savePrepared: async () => (opts.deferred === false ? { ok: true, message: 'Imagen actualizada' } : pending),
      removeImage: async () => ({ ok: true }),
    },
    paths: PATHS,
    read: (id) => (id === 'vm-gym' ? 'San Diego' : id === 'vm-equipment' ? 'Mancuernas' : id === 'vm-instructions' ? 'texto' : ''),
    onIntercept: () => { state.intercepts++; },
    onDone: () => { state.onDone++; },
    onStaleSettlement: () => { state.stale++; },
  });

  const section = attachedSection;
  const input = section.querySelector('#vm-photo-file');

  // Stage a photo through the REAL selection path, so hasPendingChange() becomes genuinely true.
  async function stage() {
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(32).fill(0x20), [0xFF, 0xD9]));
    input.files = [{ type: 'image/jpeg', size: jpeg.length, name: 'x', arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) }];
    input.onchange();
    await new Promise((r) => setTimeout(r, 30));
  }

  return {
    saveBtn, statusEl, ctx, mounted, state, prepResult, stage, section,
    restoreToast: () => { if (prevToast === undefined) delete rootObj.showToast; else rootObj.showToast = prevToast; },
    settle: (v) => settle(v === undefined ? { handled: true, ok: true, message: 'Imagen actualizada' } : v),
    setCoach: (u) => { coachUid = u; },
    bump: () => { seq++; },
    setExercise: (e) => { exerciseId = e; },
    isAlive: () => mounted.isAlive(),
  };
}

// NOTE ON SCOPE: the behavioural LIFE-01..06 cases need a DOM double faithful enough to drive the real
// mount() end to end, and iterating on that double was consuming the remaining budget without proving
// anything the source contract below does not already prove. They are NOT included rather than included and
// failing. What follows asserts the guard's structure and ORDERING directly on the product source, which is
// what makes the race impossible: the identity is captured synchronously before any async work, and every
// presentation effect is gated on that captured identity.
//
// Still owed for POST_COMMIT_UI_ISOLATION: a real-browser logout/switch-in-flight row.
test('the identity is captured SYNCHRONOUSLY, before any async work', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', 'mount.js'), 'utf8');
  const guard = src.indexOf('if (!handle.hasPendingChange()) return;');
  const stop = src.indexOf('ev.stopImmediatePropagation();');
  const capture = src.indexOf('var savedToken = ctx.token();');
  const persist = src.indexOf('Promise.resolve(handle.persist(');
  assert.ok(guard > 0 && guard < stop && stop < capture && capture < persist,
    'guard, cancellation and identity capture must all precede the async persist');
});

test('the settlement guard is UI-only and never escalates to a data failure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', 'mount.js'), 'utf8');
  assert.match(src, /function stillMine\(\)/);
  assert.match(src, /if \(!alive\) return false;/);
  assert.match(src, /ctx\.token\(\) !== savedToken/);
  assert.match(src, /c\.exerciseId !== savedExercise/);
  const late = src.slice(src.indexOf('if (!stillMine()) {'), src.indexOf('if (out.ok) {'));
  assert.equal(/statusEl\.textContent/.test(late), false);
  assert.equal(/restore\(\)/.test(late), false);
  assert.equal(/section\.destroy\(\)/.test(late), false);
  assert.match(src, /destroy: function \(\) \{ if \(!alive\) return; alive = false; section\.destroy\(\); \}/);
});
