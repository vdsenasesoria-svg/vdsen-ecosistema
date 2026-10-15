'use strict';
// PHASE 6 regressions for the three findings, plus the save-interception contract.
//
// The interception decision MUST be synchronous. Event propagation cannot be cancelled once a handler has
// returned, so a stopPropagation() inside a .then() runs after saveBtn.onclick was already reached - which
// would allow TWO Firestore publications for a single Save.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UI = require('../assets/coach-image-upload/photo-section.js');
const MOUNT_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', 'mount.js'), 'utf8');
const COACH = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');
const PS_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', 'photo-section.js'), 'utf8');

const COACH_A = 'coachA000000000000000001';
const EX_A = 'exA';

// Minimal DOM double. It records what the preview receives, which is how the injection regression is
// proven without any product test global.
function fakeDom() {
  const made = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], attrs: {}, style: {}, textContent: '',
      id: '', disabled: false, value: '', files: null, onclick: null, onchange: null, _src: null, _html: '',
      // A PROPERTY assignment. It must NOT populate attrs, because that separation is exactly what the
      // injection regression proves: the value can only ever become a URL, never markup.
      set src(v) { this._src = v; },
      get src() { return this._src; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
      // attach() inserts the section before the Save button and then queries its own parts by id, so a
      // query for an unknown id must materialise a node rather than return null.
      querySelector(sel) {
        const id = String(sel).replace('#', '');
        if (!this.byId[id]) { this.byId[id] = el('div'); this.byId[id].id = id; }
        return this.byId[id];
      },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      get firstChild() { return this.children[0] || null; },
      byId: {},
    };
    made.push(node);
    return node;
  }
  const document = {
    createElement: el,
    getElementById: () => null,
  };
  return { document, el, made };
}

function harness(exercise, deps) {
  const dom = fakeDom();
  const box = dom.el('div');
  const saveBtn = dom.el('button');
  // attach() calls saveBtn.parentNode.insertBefore(section, saveBtn). Capture the inserted section so the
  // assertions read the node the section really populated.
  let attached = null;
  saveBtn.parentNode = { insertBefore: (node) => { attached = node; return node; } };

  let current = { coachUid: COACH_A, coachId: COACH_A, exerciseId: EX_A, exercise };
  const section = UI.createPhotoSection({
    env: { document: dom.document, URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} } },
    controllerApi: deps || { prepare: async () => ({ ok: false, message: 'x' }) },
    pathsApi: require('../assets/coach-image-upload/paths.js'),
    getContext: () => current,
    generation: { token: () => '1:' + COACH_A + ':' + EX_A },
  });
  const handle = section.attach(box, saveBtn);
  // The node attach() actually built and inserted is the one carrying the queried parts.
  const live = attached || box;
  return { section, handle, box: live, saveBtn, dom, setExercise: (e) => { current = Object.assign({}, current, { exercise: e }); } };
}

// --- SAVE-RACE-01 / 02: the synchronous pending query ------------------------

test('SAVE-RACE-01 pending image reports hasPendingChange synchronously', async () => {
  const blob = { size: 200 * 1024, type: 'image/jpeg' };
  const g = harness({}, {
    prepare: async () => ({ ok: true, blob, type: 'image/jpeg', bytes: 200 * 1024, width: 1600, height: 1200, token: '1:' + COACH_A + ':' + EX_A }),
  });
  // Nothing staged yet.
  assert.equal(g.handle.hasPendingChange(), false);
  // Drive the same path the file input drives.
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(64).fill(0x20), [0xFF, 0xD9]));
  const file = { type: 'image/jpeg', size: jpeg.length, name: 'x', arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) };
  const input = g.box.querySelector('#vm-photo-file');
  input.files = [file];
  input.onchange();
  await new Promise((r) => setTimeout(r, 30));
  // The query is SYNCHRONOUS: it answered without awaiting anything.
  assert.equal(g.handle.hasPendingChange(), true);
});

test('SAVE-RACE-02 no image change reports false', () => {
  const h = harness({});
  assert.equal(h.handle.hasPendingChange(), false);
});

test('SAVE-RACE-03 the mount decides synchronously and cancels propagation immediately', () => {
  // The guard runs BEFORE any async work and uses stopImmediatePropagation in the same synchronous turn.
  assert.match(MOUNT_SRC, /if \(!handle\.hasPendingChange\(\)\) return;/);
  assert.match(MOUNT_SRC, /ev\.stopImmediatePropagation\(\);/);
  // stopPropagation() must NOT appear: it cannot cancel already-dispatched propagation from a later turn.
  assert.equal(/ev\.stopPropagation\(\);/.test(MOUNT_SRC), false);
  // The synchronous guard must appear before the promise chain is created.
  assert.ok(MOUNT_SRC.indexOf('hasPendingChange()') < MOUNT_SRC.indexOf('Promise.resolve(handle.persist('),
    'the pending check must precede the async persist');
});

test('SAVE-RACE-04 the metadata-only path does not suppress, disable or prevent anything', () => {
  // The early return must come before preventDefault / disabled / stopImmediatePropagation.
  const guard = MOUNT_SRC.indexOf('if (!handle.hasPendingChange()) return;');
  const prevent = MOUNT_SRC.indexOf('ev.preventDefault();');
  const stopNow = MOUNT_SRC.indexOf('ev.stopImmediatePropagation();');
  const disable = MOUNT_SRC.indexOf('saveBtn.disabled = true;');
  assert.ok(guard > 0 && guard < prevent, 'guard before preventDefault');
  assert.ok(guard < stopNow, 'guard before stopImmediatePropagation');
  assert.ok(guard < disable, 'guard before disabling Save');
});

test('SAVE-RACE-05 the controller receives exactly one publish for one Save', async () => {
  const paths = require('../assets/coach-image-upload/paths.js');
  const { createController } = require('../assets/coach-image-upload/controller.js');
  const calls = { published: [], uploaded: [] };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 100 * 1024, type: 'image/jpeg' }, type: 'image/jpeg', width: 1600, height: 1200 }),
    upload: (p) => { calls.uploaded.push(p); return Promise.resolve(); },
    getDownloadUrl: (p) => Promise.resolve('https://example.invalid/' + p),
    deleteObject: () => Promise.resolve(),
    publish: (id, patch) => { calls.published.push({ id, patch }); return Promise.resolve(); },
    isCurrent: () => true,
  });
  const prep = { ok: true, blob: { size: 100 * 1024, type: 'image/jpeg' }, type: 'image/jpeg', token: 't', coachUid: COACH_A, exerciseId: EX_A };
  const r = await c.savePrepared(prep, { token: 't', coachUid: COACH_A, exerciseId: EX_A, currentPath: '', metadata: { gym: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(calls.published.length, 1);
  assert.equal(calls.uploaded.length, 1);
  assert.equal(calls.published[0].patch.gym, 'x');
});

test('SAVE-RACE-06 a second concurrent save is refused, so a double click is one operation', async () => {
  const { createController, CODES } = require('../assets/coach-image-upload/controller.js');
  let release; const gate = new Promise((r) => { release = r; });
  const calls = { published: 0, uploaded: 0 };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg' }),
    upload: () => { calls.uploaded++; return gate; },
    getDownloadUrl: () => Promise.resolve('https://example.invalid/x'),
    deleteObject: () => Promise.resolve(),
    publish: () => { calls.published++; return Promise.resolve(); },
    isCurrent: () => true,
  });
  const prep = { ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg', token: 't', coachUid: COACH_A, exerciseId: EX_A };
  const first = c.savePrepared(prep, { token: 't', coachUid: COACH_A, exerciseId: EX_A, currentPath: '' });
  const second = await c.savePrepared(prep, { token: 't', coachUid: COACH_A, exerciseId: EX_A, currentPath: '' });
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.BUSY);
  release();
  const r1 = await first;
  assert.equal(r1.ok, true);
  assert.equal(calls.uploaded, 1, 'a double click must produce exactly one upload');
  assert.equal(calls.published, 1, 'and exactly one publish');
});

// --- DEBUG-01 -----------------------------------------------------------------

test('DEBUG-01 no product debug global exists, and no new __vdsen* assignment was introduced', () => {
  assert.equal(COACH.includes('__vdsenMountErr'), false, 'the mount debug global must be gone');
  assert.equal(/window\.__vdsen[A-Za-z]*\s*=/.test(COACH), false, 'no new product debug global');
  // The stack must not be leaked anywhere in the product image surface.
  for (const f of ['mount.js', 'photo-section.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', f), 'utf8');
    assert.equal(/\.stack/.test(src), false, f + ' must not touch .stack');
  }
});

// --- HTML-01 ------------------------------------------------------------------

test('HTML-01 an adversarial persisted URL cannot inject markup or an event handler', () => {
  const evil = 'https://example.invalid/x" onerror="window.__bad=1';
  const h = harness({ imageUrl: evil, assetRef: '' });
  const preview = h.box.byId['vm-photo-preview'];
  const child = preview.children[0];
  assert.ok(child, 'a preview node was created');
  assert.equal(child.tagName, 'IMG');
  // The value became a PROPERTY, so it can only ever be a (failing) URL - never markup.
  assert.equal(child.src, evil);
  assert.deepEqual(Object.keys(child.attrs), [], 'the img must receive no attributes at all');
  assert.equal(child.innerHTML, '', 'the img must not receive markup');
  assert.equal(/onerror\s*=/.test(String(child.innerHTML)), false);
  assert.equal(preview.innerHTML === undefined || preview.innerHTML === '', true,
    'the container must not receive concatenated markup');
});

test('HTML-01b the no-photo placeholder uses textContent, not markup', () => {
  const h = harness({});
  const child = h.box.byId['vm-photo-preview'].children[0];
  assert.ok(child);
  assert.equal(child.textContent, 'Sin foto');
});

test('HTML-01c the preview path contains no innerHTML assignment for the image element', () => {
  assert.equal(/els\.preview\.innerHTML/.test(PS_SRC), false);
  assert.match(PS_SRC, /document\.createElement\('img'\)/);
  assert.match(PS_SRC, /img\.src = src;/);
});

test('HTML-01d no dynamic value is interpolated into innerHTML anywhere in the image surface', () => {
  for (const f of ['mount.js', 'photo-section.js', 'controller.js', 'firebase-adapter.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'assets', 'coach-image-upload', f), 'utf8');
    const bad = src.match(/innerHTML\s*=\s*[^;]*\+/g) || [];
    assert.deepEqual(bad, [], f + ' must not concatenate into innerHTML');
  }
});
