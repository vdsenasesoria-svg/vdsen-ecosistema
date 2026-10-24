'use strict';
// Two-phase API (prepare / savePrepared) and metadata coherence.
//
// The two-phase shape is what lets the UI show a preview of the PROCESSED image while the photo is
// processed exactly ONCE, and what lets a single Firestore write publish the image fields together with
// the editor's own metadata. A second test file rather than additions to the existing suite, so the
// cases stay grouped by contract.
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../assets/coach-image-upload/paths.js');
const { createController, CODES } = require('../assets/coach-image-upload/controller.js');

const COACH_A = 'coachA000000000000000001';
const COACH_B = 'coachB000000000000000002';
const EX_A = 'exA';

const jpegBytes = () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(64).fill(0x20), [0xFF, 0xD9]));
const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].concat([0, 0, 0, 0x0D], [0x49, 0x48, 0x44, 0x52], new Array(40).fill(0x11)));
const fileOf = (bytes, type) => ({ type, size: bytes.length, name: 'x', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const blobOf = (size, type) => ({ size, type });

function deps(opts) {
  opts = opts || {};
  const calls = { processed: 0, uploaded: [], published: [], deleted: [], cleanupDebt: [] };
  return {
    calls,
    process: async () => { calls.processed++; return { ok: true, blob: blobOf(200 * 1024, 'image/jpeg'), type: 'image/jpeg', width: 1600, height: 1200 }; },
    upload: (path, blob, ct) => { calls.uploaded.push({ path, blob, ct }); return Promise.resolve(); },
    getDownloadUrl: (path) => Promise.resolve('https://example.invalid/' + path),
    deleteObject: (path) => { calls.deleted.push(path); return Promise.resolve(); },
    publish: (exId, patch) => { calls.published.push({ exId, patch }); return Promise.resolve(); },
    isCurrent: (t) => (opts.staleFor !== undefined ? t !== opts.staleFor : true),
    onCleanupFailure: (path) => calls.cleanupDebt.push(path),
  };
}
const ctx = (over) => Object.assign({ token: 1, coachUid: COACH_A, exerciseId: EX_A }, over || {});

test('prepare processes exactly once and writes nothing', async () => {
  const d = deps();
  const prep = await createController(d).prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx());
  assert.equal(prep.ok, true);
  assert.equal(d.calls.processed, 1);
  assert.equal(d.calls.uploaded.length, 0, 'prepare must not upload');
  assert.equal(d.calls.published.length, 0, 'prepare must not publish');
  assert.ok(prep.blob && prep.bytes > 0);
});

test('savePrepared uploads THE PREPARED BLOB by identity and never re-processes', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx());
  const r = await c.savePrepared(prep, ctx({ currentPath: '' }));
  assert.equal(r.ok, true);
  assert.equal(d.calls.processed, 1, 'savePrepared must NOT process again');
  assert.equal(d.calls.uploaded[0].blob, prep.blob, 'the uploaded blob must be the prepared one');
});

test('prepare honours a stale token and writes nothing', async () => {
  const d = deps({ staleFor: 9 });
  const prep = await createController(d).prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx({ token: 9 }));
  assert.equal(prep.ok, false);
  assert.equal(prep.code, CODES.STALE);
  assert.equal(d.calls.processed, 0);
});

test('prepare refuses bytes that do not match the declared image', async () => {
  const d = deps();
  const prep = await createController(d).prepare(fileOf(pngBytes(), 'image/jpeg'), ctx());
  assert.equal(prep.code, CODES.INVALID);
  assert.equal(d.calls.processed, 0);
});

test('savePrepared refuses a prepared image belonging to ANOTHER coach or exercise', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx({ coachUid: COACH_B }));
  const r = await c.savePrepared(prep, ctx({ currentPath: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.STALE);
  assert.equal(d.calls.uploaded.length, 0, 'a cross-editor prepared image must never upload');
});

test('savePrepared revalidates the blob and refuses one above the hard cap', async () => {
  const d = deps();
  const forged = { ok: true, blob: blobOf(900 * 1024, 'image/jpeg'), type: 'image/jpeg', coachUid: COACH_A, exerciseId: EX_A };
  const r = await createController(d).savePrepared(forged, ctx({ currentPath: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.PROCESS_FAILED);
  assert.equal(d.calls.uploaded.length, 0);
});

test('savePrepared refuses an object that is not a prepared image', async () => {
  const d = deps();
  for (const bad of [null, {}, { ok: false }, { ok: true }]) {
    const r = await createController(d).savePrepared(bad, ctx({ currentPath: '' }));
    assert.equal(r.ok, false);
  }
  assert.equal(d.calls.uploaded.length, 0);
});

test('savePrepared merges the editor metadata into the SAME single publish as the image fields', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx());
  const meta = { gym: 'San Diego', equipment: 'Mancuernas', instructions: 'texto del coach' };
  const r = await c.savePrepared(prep, ctx({ currentPath: '', metadata: meta }));
  assert.equal(r.ok, true);
  assert.equal(d.calls.published.length, 1, 'exactly ONE publish: two would race and could lose edits');
  const patch = d.calls.published[0].patch;
  assert.equal(patch.gym, 'San Diego');
  assert.equal(patch.equipment, 'Mancuernas');
  assert.equal(patch.instructions, 'texto del coach');
  assert.equal(patch.imageUrl, r.url);
  assert.equal(patch.assetRef, r.path);
  assert.equal(patch.coachId, undefined, 'no ownership field may be written');
});

test('removeImage merges the editor metadata into its single clearing publish', async () => {
  const p = P.newPath(COACH_A, EX_A);
  const d = deps();
  const r = await createController(d).removeImage(ctx({ currentPath: p, metadata: { gym: 'Bugambilias' } }));
  assert.equal(r.ok, true);
  assert.equal(d.calls.published.length, 1);
  assert.equal(d.calls.published[0].patch.gym, 'Bugambilias');
  assert.equal(d.calls.published[0].patch.imageUrl, '');
  assert.equal(d.calls.published[0].patch.assetRef, '');
});

test('the metadata patch cannot overwrite the image fields with stale values', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx());
  // A caller passing a stale imageUrl/assetRef in metadata must not win: the controller sets them last.
  const r = await c.savePrepared(prep, ctx({ currentPath: '', metadata: { imageUrl: 'https://stale.example/x.jpg', assetRef: 'exercise-media/old/exA/image-aaaaaaaaaaaaaaaa' } }));
  assert.equal(r.ok, true);
  const patch = d.calls.published[0].patch;
  assert.equal(patch.imageUrl, r.url, 'the freshly obtained URL must win');
  assert.equal(patch.assetRef, r.path, 'the freshly generated path must win');
});

test('savePrepared still performs the safe replacement order with metadata present', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes(), 'image/jpeg'), ctx());
  const r = await c.savePrepared(prep, ctx({ currentPath: oldPath, metadata: { gym: 'x' } }));
  assert.equal(r.ok, true);
  assert.notEqual(r.path, oldPath);
  assert.deepEqual(d.calls.deleted, [oldPath], 'OLD is deleted only after the publish');
  assert.equal(d.calls.published.length, 1);
});
