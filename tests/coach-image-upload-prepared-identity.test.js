'use strict';
// PHASE 2 — PREPARED_OBJECT_IDENTITY.
//
// The bug this suite exists for: photo-section rebuilt the prepared object field by field and dropped
// `ok: true`, so savePrepared() returned IMAGE_INVALID with zero uploads even though the photo had been
// processed correctly. The assertion is therefore OBJECT IDENTITY, not deepEqual - a partial copy that
// happened to carry every field we thought of would still be the same class of defect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UI = require('../assets/coach-image-upload/photo-section.js');
const PS_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', 'photo-section.js'), 'utf8');

const COACH_A = 'coachA000000000000000001';
const DOC_A = 'docExerciseA';

function fakeDom() {
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(), children: [], attrs: {}, style: {}, textContent: '',
      id: '', disabled: false, value: '', files: null, onclick: null, onchange: null, _src: null, _html: '',
      set src(v) { this._src = v; },
      get src() { return this._src; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      querySelector(sel) { const id = String(sel).replace('#', ''); return (this.byId[id] = this.byId[id] || el('div')); },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      get firstChild() { return this.children[0] || null; },
      byId: {},
    };
  }
  return { createElement: el, getElementById: () => null };
}

// Records exactly what savePrepared receives, so identity can be asserted on the real boundary.
function mount(controllerApi) {
  const dom = fakeDom();
  const saveBtn = dom.createElement('button');
  let attached = null;
  saveBtn.parentNode = { insertBefore: (n) => { attached = n; return n; } };
  const section = UI.createPhotoSection({
    env: { document: dom, URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} } },
    controllerApi,
    pathsApi: require('../assets/coach-image-upload/paths.js'),
    getContext: () => ({ coachUid: COACH_A, coachId: COACH_A, exerciseId: DOC_A, exercise: { imageUrl: '', assetRef: '' } }),
    generation: { token: () => '1:' + COACH_A + ':' + DOC_A },
  });
  const handle = section.attach(attached || dom.createElement('div'), saveBtn);
  return { handle, box: attached, saveBtn };
}

const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(64).fill(0x20), [0xFF, 0xD9]));
const fileOf = () => ({ type: 'image/jpeg', size: jpeg.length, name: 'x', arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) });

test('PREPARED_OBJECT_IDENTITY: savePrepared receives the EXACT object prepare returned', async () => {
  const blob = { size: 200 * 1024, type: 'image/jpeg' };
  const prepResult = {
    ok: true, code: 'OK', blob, type: 'image/jpeg', bytes: 200 * 1024,
    width: 1360, height: 994, quality: 0.85, attempts: 2,
    token: '1:' + COACH_A + ':' + DOC_A, coachUid: COACH_A, exerciseId: DOC_A,
  };
  let received = null;
  const m = mount({
    prepare: async () => prepResult,
    savePrepared: async (prepared) => { received = prepared; return { ok: true, code: 'OK', url: 'https://x/y', path: 'exercise-media/' + COACH_A + '/' + DOC_A + '/image-aaaaaaaaaaaaaaaa' }; },
    removeImage: async () => ({ ok: true }),
  });

  // Drive the real file-selection path.
  const input = m.box.querySelector('#vm-photo-file');
  input.files = [fileOf()];
  input.onchange();
  await new Promise((r) => setTimeout(r, 50));

  const out = await m.handle.persist({ gym: 'San Diego' });

  // OBJECT IDENTITY, not deepEqual: the same reference must reach the controller.
  assert.equal(received, prepResult, 'savePrepared must receive the identical object from prepare()');
  assert.equal(out.handled, true);
  assert.equal(out.ok, true, 'the prepared image must not become IMAGE_INVALID merely by being staged');

  // Every binding field the controller enforces must survive.
  assert.equal(received.ok, true, 'ok:true must survive the UI boundary');
  assert.equal(received.coachUid, COACH_A);
  assert.equal(received.exerciseId, DOC_A);
  assert.equal(received.token, prepResult.token);
  assert.equal(received.quality, prepResult.quality);
  assert.equal(received.attempts, prepResult.attempts);
  assert.equal(received.blob, blob);
});

test('PREPARED_OBJECT_IDENTITY: a partial copy would have failed the controller guard', async () => {
  // Demonstrates the defect class directly: the truncated shape the UI used to build is rejected by the
  // controller's own guard, which is why the fix must preserve the object rather than copy fields.
  const { createController, CODES } = require('../assets/coach-image-upload/controller.js');
  const truncated = { blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg', bytes: 1024, width: 100, height: 100, token: 't' };
  assert.equal(truncated.ok, undefined, 'the truncated shape has no ok flag');
  const calls = { uploaded: 0 };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg' }),
    upload: () => { calls.uploaded++; return Promise.resolve(); },
    getDownloadUrl: () => Promise.resolve('https://x/y'),
    deleteObject: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    isCurrent: () => true,
  });
  const r = await c.savePrepared(truncated, { token: 't', coachUid: COACH_A, exerciseId: DOC_A, currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.INVALID);
  assert.equal(calls.uploaded, 0, 'zero uploads, exactly as measured in the browser');
});

test('PREPARED_OBJECT_IDENTITY: the source no longer rebuilds the prepared object', () => {
  assert.match(PS_SRC, /staged = prep;/);
  assert.equal(/staged = \{ blob: prep\.blob/.test(PS_SRC), false, 'the partial rebuild must be gone');
  // The preview must read the blob from the object that will be uploaded, not from a copy.
  assert.match(PS_SRC, /createObjectURL\(staged\.blob\)/);
});

test('PREPARED_OBJECT_IDENTITY: a stale prepared object is still refused after the fix', async () => {
  // The fix must not weaken the token binding: identity is preserved AND the generation checks still run.
  const { createController, CODES } = require('../assets/coach-image-upload/controller.js');
  const prep = {
    ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg',
    token: 'gen10', coachUid: COACH_A, exerciseId: DOC_A,
  };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg' }),
    upload: () => Promise.resolve(),
    getDownloadUrl: () => Promise.resolve('https://x/y'),
    deleteObject: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    isCurrent: () => true,   // gen11 IS current; identity alone must not be enough
  });
  const r = await c.savePrepared(prep, { token: 'gen11', coachUid: COACH_A, exerciseId: DOC_A, currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.STALE);
});
