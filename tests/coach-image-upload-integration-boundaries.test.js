'use strict';
// The two integration boundaries that were wrong before the UI existed.
//
//   1. PREPARED TOKEN BINDING — a stale prepared image from an earlier editor generation on the SAME coach
//      and SAME exercise must not save. Coach/exercise equality is not enough; the generation is a
//      separate question.
//   2. ADAPTER ALLOW-LIST — the adapter used to copy only imageUrl/assetRef, which threw away the coach's
//      metadata in the very write that was supposed to persist it together with the image.
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../assets/coach-image-upload/paths.js');
const { createController, CODES } = require('../assets/coach-image-upload/controller.js');
const ADAPTER = require('../assets/coach-image-upload/firebase-adapter.js');

const COACH_A = 'coachA000000000000000001';
const EX_A = 'exA';

const jpegBytes = () => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0].concat(new Array(64).fill(0x20), [0xFF, 0xD9]));
const fileOf = (b) => ({ type: 'image/jpeg', size: b.length, name: 'x', arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
const blobOf = (size, type) => ({ size, type });

function deps() {
  const calls = { processed: 0, uploaded: [], published: [], deleted: [] };
  return {
    calls,
    process: async () => { calls.processed++; return { ok: true, blob: blobOf(200 * 1024, 'image/jpeg'), type: 'image/jpeg', width: 1600, height: 1200 }; },
    upload: (p, b, ct) => { calls.uploaded.push({ p, b, ct }); return Promise.resolve(); },
    getDownloadUrl: (p) => Promise.resolve('https://example.invalid/' + p),
    deleteObject: (p) => { calls.deleted.push(p); return Promise.resolve(); },
    publish: (exId, patch) => { calls.published.push({ exId, patch }); return Promise.resolve(); },
    // Token 11 IS current: the point of the test is that a current token is still not enough.
    isCurrent: (t) => t === 11 || t === 10,
    onCleanupFailure: () => {},
  };
}

test('a prepared image from an OLD generation is refused even though the token is current', async () => {
  const d = deps();
  const c = createController(d);
  // Generation 10 produces the prepared image...
  const prep = await c.prepare(fileOf(jpegBytes()), { token: 10, coachUid: COACH_A, exerciseId: EX_A });
  assert.equal(prep.ok, true);
  assert.equal(prep.token, 10);

  // ...and is then saved under generation 11: same coach, same exercise, and 11 IS current.
  const r = await c.savePrepared(prep, { token: 11, coachUid: COACH_A, exerciseId: EX_A, currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.STALE);
  assert.equal(d.calls.uploaded.length, 0, 'no upload');
  assert.equal(d.calls.published.length, 0, 'no publish');
  assert.equal(d.calls.deleted.length, 0, 'no delete');
});

test('the SAME generation saves normally (the binding is not over-strict)', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes()), { token: 10, coachUid: COACH_A, exerciseId: EX_A });
  const r = await c.savePrepared(prep, { token: 10, coachUid: COACH_A, exerciseId: EX_A, currentPath: '' });
  assert.equal(r.ok, true);
  assert.equal(d.calls.uploaded.length, 1);
  assert.equal(d.calls.published.length, 1);
});

test('a prepared image from generation 11 saves under 11 after reopening the same editor target', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes()), { token: 11, coachUid: COACH_A, exerciseId: EX_A });
  const r = await c.savePrepared(prep, { token: 11, coachUid: COACH_A, exerciseId: EX_A, currentPath: '' });
  assert.equal(r.ok, true);
});

test('the token check runs BEFORE any upload is attempted', async () => {
  const d = deps();
  const c = createController(d);
  const prep = await c.prepare(fileOf(jpegBytes()), { token: 10, coachUid: COACH_A, exerciseId: EX_A });
  const seen = [];
  d.upload = (p) => { seen.push(p); return Promise.resolve(); };
  await c.savePrepared(prep, { token: 11, coachUid: COACH_A, exerciseId: EX_A, currentPath: '' });
  assert.equal(seen.length, 0, 'the upload must not even be called');
});

// --- adapter allow-list ------------------------------------------------------

function fakeSdk() {
  const writes = [];
  return {
    writes,
    storage: { __storage: true },
    ref: (s, p) => ({ s, p }),
    uploadBytes: () => Promise.resolve(),
    getDownloadURL: () => Promise.resolve('https://example.invalid/x'),
    deleteObject: () => Promise.resolve(),
    db: { __db: true },
    doc: (db, col, id) => ({ db, col, id }),
    updateDoc: (ref, patch) => { writes.push({ ref, patch }); return Promise.resolve(); },
  };
}

test('the adapter publishes ALL relevant visual fields, not just the image ones', async () => {
  const sdk = fakeSdk();
  const a = ADAPTER.createAdapter(sdk);
  await a.publishExerciseImage('exA', {
    gym: 'San Diego', equipment: 'Mancuernas', instructions: 'texto',
    imageUrl: 'https://example.invalid/x', assetRef: 'exercise-media/' + COACH_A + '/exA/image-aaaaaaaaaaaaaaaa',
  });
  const patch = sdk.writes[0].patch;
  assert.equal(patch.gym, 'San Diego');
  assert.equal(patch.equipment, 'Mancuernas');
  assert.equal(patch.instructions, 'texto');
  assert.equal(patch.imageUrl, 'https://example.invalid/x');
  assert.equal(patch.assetRef, 'exercise-media/' + COACH_A + '/exA/image-aaaaaaaaaaaaaaaa');
});

test('the adapter refuses ownership and arbitrary fields', async () => {
  const sdk = fakeSdk();
  const a = ADAPTER.createAdapter(sdk);
  await a.publishExerciseImage('exA', {
    gym: 'x', coachId: 'foreign-coach', exerciseId: 'other', id: 'other', prescriptionExerciseId: 'pid',
    createdAt: '2020-01-01', evil: 'payload', __proto__: { polluted: true },
  });
  const patch = sdk.writes[0].patch;
  assert.equal(patch.gym, 'x');
  for (const k of ['coachId', 'exerciseId', 'id', 'prescriptionExerciseId', 'createdAt', 'evil', 'polluted']) {
    assert.equal(Object.prototype.hasOwnProperty.call(patch, k), false, 'must not write: ' + k);
  }
});

test('the allow-list is exactly the ten visual fields and is exported for review', () => {
  assert.deepEqual(ADAPTER.ALLOWED_VISUAL_FIELDS.slice().sort(), [
    'assetRef', 'commonErrors', 'equipment', 'execution', 'gym', 'imageUrl',
    'instructions', 'setup', 'technicalObjective', 'variants',
  ]);
});

test('an empty patch still produces an update rather than throwing', async () => {
  const sdk = fakeSdk();
  const a = ADAPTER.createAdapter(sdk);
  await a.publishExerciseImage('exA', {});
  assert.equal(sdk.writes.length, 1);
  assert.deepEqual(sdk.writes[0].patch, {});
});

test('the adapter takes a real Storage INSTANCE, not a lazy factory', () => {
  // Guards against the integration mistake of passing a function to sdk.ref(sdk.storage, ...).
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'assets', 'coach-image-upload', 'firebase-adapter.js'), 'utf8');
  assert.match(src, /sdk\.ref\(sdk\.storage, path\)/);
  assert.equal(/typeof sdk\.storage === 'function'/.test(src), false);
});
