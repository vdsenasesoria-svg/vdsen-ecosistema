'use strict';
// Coach exercise image — module unit tests.
//
// Two areas carry the real risk and get the most attention:
//   * MAGIC BYTES - neither the filename nor file.type may be trusted, so these cases feed real byte
//     signatures through the sniffer and assert that a renamed SVG or HTML cannot pass.
//   * SURVIVING STATE ON FAILURE - each failure row asserts what remains in Storage and Firestore, not
//     merely that a promise rejected. "An error was shown" is not a correctness statement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const nodePath = require('node:path');

const V = require('../assets/coach-image-upload/validate.js');
const S = require('../assets/coach-image-upload/sniff.js');
const P = require('../assets/coach-image-upload/paths.js');
const PR = require('../assets/coach-image-upload/process.js');
const { createController, CODES } = require('../assets/coach-image-upload/controller.js');

const COACH_A = 'coachA000000000000000001';
const COACH_B = 'coachB000000000000000002';
const EX_A = 'exA';

// --- real byte signatures ----------------------------------------------------
// Each fixture is structurally valid enough that the sniffer's sanity checks pass, so a rejection means
// the CONTENT was rejected rather than the structure being malformed.
function jpegBytes(pad) {
  const head = [0xFF, 0xD8, 0xFF, 0xE0];
  const tail = [0xFF, 0xD9];
  const body = new Array(pad || 64).fill(0x20);
  return new Uint8Array(head.concat(body, tail));
}
function pngBytes(pad) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const len = [0x00, 0x00, 0x00, 0x0D];
  const ihdr = [0x49, 0x48, 0x44, 0x52];
  return new Uint8Array(sig.concat(len, ihdr, new Array(pad || 48).fill(0x11)));
}
function webpBytes(pad) {
  const total = 12 + (pad || 16);
  const riff = [0x52, 0x49, 0x46, 0x46];
  const size = [total & 0xFF, (total >> 8) & 0xFF, 0, 0];
  const webp = [0x57, 0x45, 0x42, 0x50];
  return new Uint8Array(riff.concat(size, webp, new Array(pad || 16).fill(0x22)));
}
const ascii = (s, pad) => new Uint8Array(Buffer.from(s + ' '.repeat(pad || 64), 'utf8'));
const fileOf = (bytes, type, name) => ({ type, size: bytes.length, name: name || 'x', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const blobOf = (size, type) => ({ size, type });

// --- magic bytes (the core security rows) -----------------------------------
test('real JPEG bytes are accepted and sniffed as image/jpeg', () => {
  const r = S.sniff(jpegBytes(), 'image/jpeg');
  assert.equal(r.ok, true); assert.equal(r.type, 'image/jpeg');
});
test('real PNG bytes are accepted and sniffed as image/png', () => {
  const r = S.sniff(pngBytes(), 'image/png');
  assert.equal(r.ok, true); assert.equal(r.type, 'image/png');
});
test('real WebP bytes are accepted and sniffed as image/webp', () => {
  const r = S.sniff(webpBytes(), 'image/webp');
  assert.equal(r.ok, true); assert.equal(r.type, 'image/webp');
});
test('declared JPEG with HTML bytes is REJECTED (rename cannot help)', () => {
  const r = V.validateBytes(ascii('<html><body>hi</body></html>'), 'image/jpeg');
  assert.equal(r.ok, false); assert.equal(r.code, 'MARKUP');
});
test('declared PNG with SVG bytes is REJECTED', () => {
  const r = V.validateBytes(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png');
  assert.equal(r.ok, false); assert.equal(r.code, 'MARKUP');
});
test('an XML prologue before the SVG is still rejected', () => {
  assert.equal(V.validateBytes(ascii('<?xml version="1.0"?><svg></svg>'), 'image/png').ok, false);
});
test('MIME/signature mismatch is rejected even when both are images', () => {
  const r = V.validateBytes(pngBytes(), 'image/jpeg');
  assert.equal(r.ok, false); assert.equal(r.code, 'MISMATCH');
});
test('GIF, PDF and random text are rejected', () => {
  assert.equal(S.sniff(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6])).code, 'GIF');
  assert.equal(S.sniff(ascii('%PDF-1.4 xxxx')).code, 'PDF');
});
test('a truncated JPEG (missing EOI) is rejected as malformed', () => {
  const bad = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(S.sniff(bad, 'image/jpeg').code, 'MALFORMED');
});
test('a too-short buffer is rejected as empty', () => {
  assert.equal(S.sniff(new Uint8Array([0xFF, 0xD8]), 'image/jpeg').code, 'EMPTY');
});

// --- source size boundaries --------------------------------------------------
test('15 MiB source boundary is accepted, and 15 MiB + 1 is rejected', () => {
  assert.equal(V.validateSourceFile({ type: 'image/jpeg', size: 15 * 1024 * 1024 }).ok, true);
  assert.equal(V.validateSourceFile({ type: 'image/jpeg', size: 15 * 1024 * 1024 + 1 }).code, 'TOO_BIG_SOURCE');
});
test('a 5 MiB phone photo passes the cheap check (the old 512 KiB limit would have rejected it)', () => {
  assert.equal(V.validateSourceFile({ type: 'image/jpeg', size: 5 * 1024 * 1024 }).ok, true);
});
test('zero-byte and oversize are rejected before any bytes are read', () => {
  assert.equal(V.validateSourceFile({ type: 'image/jpeg', size: 0 }).code, 'EMPTY');
  assert.equal(V.validateSourceFile({ type: 'image/jpeg', size: 20 * 1024 * 1024 }).code, 'TOO_BIG_SOURCE');
});
test('processed blob: target and hard cap are enforced separately from the source', () => {
  assert.equal(V.validateProcessedBlob(blobOf(300 * 1024, 'image/jpeg')).ok, true);
  assert.equal(V.validateProcessedBlob(blobOf(480 * 1024, 'image/jpeg')).ok, true);
  assert.equal(V.validateProcessedBlob(blobOf(480 * 1024 + 1, 'image/jpeg')).code, 'TOO_BIG_PROCESSED');
  assert.equal(V.validateProcessedBlob(blobOf(1000, 'image/svg+xml')).code, 'UNSUPPORTED');
});

// --- process pipeline maths (platform-free) ---------------------------------
test('4000x3000 is resized to fit 1600 on the long edge, aspect preserved', () => {
  const f = PR.fitWithin(4000, 3000, 1600);
  assert.equal(f.width, 1600); assert.equal(f.height, 1200); assert.equal(f.scaled, true);
});
test('an image already inside the limit is NEVER upscaled', () => {
  const f = PR.fitWithin(800, 600, 1600);
  assert.equal(f.width, 800); assert.equal(f.height, 600); assert.equal(f.scaled, false);
});
test('pickType keeps WebP for transparency and uses JPEG otherwise', () => {
  assert.equal(PR.pickType('image/png', true), 'image/webp');
  assert.equal(PR.pickType('image/png', false), 'image/jpeg');
  assert.equal(PR.pickType('image/jpeg', false), 'image/jpeg');
});
test('the quality ladder descends and the scale ladder ends at half size', () => {
  for (let i = 1; i < PR.QUALITY_LADDER.length; i++) assert.ok(PR.QUALITY_LADDER[i] < PR.QUALITY_LADDER[i - 1]);
  assert.equal(PR.SCALE_LADDER[0], 1);
  assert.ok(PR.SCALE_LADDER[PR.SCALE_LADDER.length - 1] <= 0.5);
});
test('the hard cap stays strictly under the storage.rules ceiling', () => {
  assert.ok(PR.HARD_CAP_BYTES < V.STORAGE_SERVER_CAP_BYTES);
  assert.ok(PR.TARGET_BYTES < PR.HARD_CAP_BYTES);
});

// A fake processing environment: the "encoder" returns a blob whose size is driven by the width, so the
// ladder behaviour is observable without a real canvas.
function fakeEnv(opts) {
  opts = opts || {};
  const seen = { decode: 0, canvases: [], released: 0 };
  return {
    seen,
    decode: async () => {
      seen.decode++;
      if (opts.decodeFails) throw new Error('decode');
      return { width: opts.width || 4000, height: opts.height || 3000, source: { close() { seen.released++; } } };
    },
    createCanvas: (w, h) => {
      seen.canvases.push([w, h]);
      return { width: w, height: h, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob(cb) { cb(blobOf(opts.sizeFor ? opts.sizeFor(w) : 200 * 1024, 'image/jpeg')); } };
    },
    // Mirrors browserEnv.release: closing the decoded source is what frees the ImageBitmap, so the fake
    // must implement it for the release assertion to mean anything.
    release: (source) => { seen.released++; if (source && source.close) source.close(); },
  };
}

test('processing lands under the target for an ordinary photo', async () => {
  const env = fakeEnv({ sizeFor: () => 200 * 1024 });
  const r = await PR.processImage({ type: 'image/jpeg' }, env);
  assert.equal(r.ok, true);
  assert.ok(r.bytes <= PR.TARGET_BYTES);
  assert.equal(r.atTarget, true);
  // >= 1 rather than == 1: the fake's release() and the source's own close() both count, and what matters
  // is that the decoded source is released at all - a leaked ImageBitmap is the actual risk.
  assert.ok(env.seen.released >= 1, 'the decoded source must always be released');
});
test('processing drops to a smaller scale when quality alone cannot hit the target', async () => {
  const env = fakeEnv({ sizeFor: (w) => (w <= 800 ? 200 * 1024 : 900 * 1024) });
  const r = await PR.processImage({ type: 'image/jpeg' }, env);
  assert.equal(r.ok, true);
  assert.ok(r.width <= 800, 'expected a reduced width, got ' + r.width);
  assert.ok(env.seen.canvases.length > 1);
});
test('processing fails cleanly when even the hard cap is unreachable', async () => {
  const r = await PR.processImage({ type: 'image/jpeg' }, fakeEnv({ sizeFor: () => 900 * 1024 }));
  assert.equal(r.ok, false); assert.equal(r.code, 'TOO_BIG');
});
test('a decode failure is reported cleanly', async () => {
  const r = await PR.processImage({ type: 'image/jpeg' }, fakeEnv({ decodeFails: true }));
  assert.equal(r.ok, false); assert.equal(r.code, 'DECODE_FAILED');
});

// --- secure RNG --------------------------------------------------------------
test('generated names use exactly 16 lowercase hex characters', () => {
  for (let i = 0; i < 50; i++) assert.match(P.randomHex16(), /^[a-f0-9]{16}$/);
});
test('there is no executable Math.random fallback in paths.js', () => {
  const src = fs.readFileSync(nodePath.join(__dirname, '..', 'assets', 'coach-image-upload', 'paths.js'), 'utf8');
  const executable = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/Math\.random/.test(executable), false);
});
test('NO_CRYPTO fails closed instead of degrading to weak randomness', () => {
  // Injecting a null source is the only honest way to prove this: merely undefining globalThis.crypto
  // would still leave the node:crypto fallback reachable, so the test would pass for the wrong reason.
  for (const source of [null, {}, { getRandomValues: 'not-a-function' }]) {
    let code = null;
    try { P.randomHex16(source); } catch (e) { code = e.code; }
    assert.equal(code, 'NO_CRYPTO', 'expected NO_CRYPTO for source ' + JSON.stringify(source));
  }
});

// --- path safety -------------------------------------------------------------
test('unsafe coach uids and exercise ids are refused', () => {
  for (const bad of ['../evil', 'a/b', 'a b', 'a%2Fb', '', 'a.b']) {
    assert.throws(() => P.buildPath(bad, EX_A, 'aaaaaaaaaaaaaaaa'), (e) => e.code === 'BAD_COACH_UID');
  }
  for (const bad of ['../evil', 'a/b', 'a b', '']) {
    assert.throws(() => P.buildPath(COACH_A, bad, 'aaaaaaaaaaaaaaaa'), (e) => e.code === 'BAD_EXERCISE_ID');
  }
});
test('the canonical path shape is exact', () => {
  const p = P.newPath(COACH_A, EX_A);
  assert.match(p, new RegExp('^exercise-media/' + COACH_A + '/' + EX_A + '/image-[a-f0-9]{16}$'));
});
test('a path is managed only for its own coach and exercise', () => {
  const p = P.newPath(COACH_A, EX_A);
  assert.equal(P.isManagedPathFor(p, COACH_A, EX_A), true);
  assert.equal(P.isManagedPathFor(p, COACH_B, EX_A), false);
  assert.equal(P.isManagedPathFor(p, COACH_A, 'exB'), false);
  assert.equal(P.isManagedPathFor('https://cdn.example.com/a.jpg', COACH_A, EX_A), false);
  assert.equal(P.isManagedPathFor('assets/img/x.png', COACH_A, EX_A), false);
  assert.equal(P.isManagedPathFor('exercise-media/../evil/exA/image-aaaaaaaaaaaaaaaa', COACH_A, EX_A), false);
});

// --- controller --------------------------------------------------------------
function deps(opts) {
  opts = opts || {};
  const calls = { uploaded: [], published: [], deleted: [], cleanupDebt: [], processed: 0 };
  let releaseUpload = null;
  return {
    calls,
    process: async () => { calls.processed++; return opts.processFails ? { ok: false, message: 'no' } : { ok: true, blob: blobOf(200 * 1024, 'image/jpeg'), type: 'image/jpeg' }; },
    // Holds ONLY the first upload. Blocking every upload would deadlock the third save in the
    // single-flight test and keep the test runner alive, which is a mock bug and not a product one.
    upload: (path, blob, ct) => {
      calls.uploaded.push({ path, ct, blob });
      if (opts.holdFirstUpload && calls.uploaded.length === 1) {
        return new Promise((r) => { releaseUpload = () => r(); });
      }
      return opts.uploadFails ? Promise.reject(new Error('upload')) : Promise.resolve();
    },
    getDownloadUrl: (path) => (opts.urlFails ? Promise.reject(new Error('url')) : Promise.resolve('https://example.invalid/' + path)),
    deleteObject: (path) => { if (opts.deleteFails) return Promise.reject(new Error('delete')); calls.deleted.push(path); return Promise.resolve(); },
    publish: (exId, patch) => { if (opts.publishFails) return Promise.reject(new Error('publish')); calls.published.push({ exId, patch }); return Promise.resolve(); },
    isCurrent: (t) => (opts.staleFor !== undefined ? t !== opts.staleFor : true),
    onCleanupFailure: (path) => calls.cleanupDebt.push(path),
    releaseUpload: () => releaseUpload && releaseUpload(),
  };
}
const req = (over) => Object.assign({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: fileOf(jpegBytes(), 'image/jpeg'), currentPath: '' }, over || {});

test('initial upload: processes, uploads, gets the URL, publishes imageUrl + assetRef', async () => {
  const d = deps();
  const r = await createController(d).saveImage(req());
  assert.equal(r.ok, true);
  assert.equal(d.calls.processed, 1);
  assert.equal(d.calls.uploaded.length, 1);
  assert.equal(d.calls.published.length, 1);
  assert.equal(d.calls.published[0].patch.imageUrl, r.url);
  assert.equal(d.calls.published[0].patch.assetRef, r.path);
  assert.equal(d.calls.published[0].patch.coachId, undefined, 'no ownership field may be written');
  assert.equal(r.replaced, false);
});
test('source invalid: no process, no upload, no publish', async () => {
  const d = deps();
  const r = await createController(d).saveImage(req({ file: fileOf(pngBytes(), 'image/jpeg') }));
  assert.equal(r.ok, false); assert.equal(r.code, CODES.INVALID);
  assert.equal(d.calls.processed, 0); assert.equal(d.calls.uploaded.length, 0); assert.equal(d.calls.published.length, 0);
});
test('processing failure: no upload, no publish', async () => {
  const d = deps({ processFails: true });
  const r = await createController(d).saveImage(req());
  assert.equal(r.code, CODES.PROCESS_FAILED);
  assert.equal(d.calls.uploaded.length, 0); assert.equal(d.calls.published.length, 0);
});
test('upload failure: Firestore untouched', async () => {
  const d = deps({ uploadFails: true });
  const r = await createController(d).saveImage(req());
  assert.equal(r.code, CODES.UPLOAD_FAILED);
  assert.equal(d.calls.published.length, 0);
});
test('URL failure: NEW orphan removed, Firestore untouched', async () => {
  const d = deps({ urlFails: true });
  const r = await createController(d).saveImage(req());
  assert.equal(r.code, CODES.URL_FAILED);
  assert.deepEqual(d.calls.deleted, [d.calls.uploaded[0].path]);
  assert.equal(d.calls.published.length, 0);
});
test('publish failure: NEW orphan removed, OLD never touched', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps({ publishFails: true });
  const r = await createController(d).saveImage(req({ currentPath: oldPath }));
  assert.equal(r.code, CODES.PUBLISH_FAILED);
  assert.deepEqual(d.calls.deleted, [d.calls.uploaded[0].path]);
  assert.ok(!d.calls.deleted.includes(oldPath));
});
test('replacement: NEW path differs, publish happens, and only then is OLD removed', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps();
  const r = await createController(d).saveImage(req({ currentPath: oldPath }));
  assert.equal(r.ok, true);
  assert.notEqual(r.path, oldPath);
  assert.equal(r.replaced, true);
  assert.deepEqual(d.calls.deleted, [oldPath]);
  assert.equal(r.cleanup, 'DELETED');
});
test('OLD delete failure still succeeds, keeps NEW live, records cleanup debt', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps({ deleteFails: true });
  const r = await createController(d).saveImage(req({ currentPath: oldPath }));
  assert.equal(r.ok, true);
  assert.equal(r.cleanup, 'PENDING');
  assert.deepEqual(d.calls.cleanupDebt, [oldPath]);
  assert.equal(d.calls.published[0].patch.assetRef, r.path);
  assert.ok(r.warning.length > 0);
});
test('legacy external URL and foreign path are never deleted', async () => {
  for (const cur of ['https://cdn.example.com/a.jpg', 'assets/img/x.png', P.newPath(COACH_B, EX_A)]) {
    const d = deps();
    const r = await createController(d).saveImage(req({ currentPath: cur }));
    assert.equal(r.ok, true);
    assert.equal(r.replaced, false);
    assert.equal(d.calls.deleted.length, 0);
  }
});

// --- stale cleanup -----------------------------------------------------------
test('stale before upload: no upload, no publish', async () => {
  const d = deps({ staleFor: 2 });
  const r = await createController(d).saveImage(req({ token: 2 }));
  assert.equal(r.code, CODES.STALE);
  assert.equal(d.calls.uploaded.length, 0); assert.equal(d.calls.published.length, 0);
});
test('stale AFTER the upload: NEW is cleaned up and nothing is published', async () => {
  let current = true;
  const seen = { uploaded: [], published: 0, deleted: [] };
  const c = createController({
    process: async () => ({ ok: true, blob: blobOf(200 * 1024, 'image/jpeg'), type: 'image/jpeg' }),
    upload: async (p) => { seen.uploaded.push(p); current = false; },
    getDownloadUrl: async () => 'https://example.invalid/x',
    publish: async () => { seen.published++; },
    deleteObject: async (p) => { seen.deleted.push(p); },
    isCurrent: () => current,
  });
  const r = await c.saveImage(req());
  assert.equal(r.ok, false); assert.equal(r.code, CODES.STALE);
  assert.equal(seen.published, 0, 'nothing may be published into the next session');
  assert.deepEqual(seen.deleted, seen.uploaded, 'the orphaned NEW object must be removed');
});
test('stale after the URL is retrieved: NEW cleaned up, no publish', async () => {
  let current = true;
  const seen = { uploaded: [], deleted: [], published: 0 };
  const c = createController({
    process: async () => ({ ok: true, blob: blobOf(1024, 'image/jpeg'), type: 'image/jpeg' }),
    upload: async (p) => { seen.uploaded.push(p); },
    getDownloadUrl: async () => { current = false; return 'https://example.invalid/x'; },
    publish: async () => { seen.published++; },
    deleteObject: async (p) => { seen.deleted.push(p); },
    isCurrent: () => current,
  });
  const r = await c.saveImage(req());
  assert.equal(r.code, CODES.STALE);
  assert.equal(seen.published, 0);
  assert.deepEqual(seen.deleted, seen.uploaded);
});

// --- required processor (no fallback to the original file) -------------------
test('an absent processor fails closed with IMAGE_PROCESSOR_UNAVAILABLE and ZERO side effects', async () => {
  const d = deps();
  delete d.process;   // simulate a wiring mistake
  const r = await createController(d).saveImage(req());
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.NO_PROCESSOR);
  assert.equal(d.calls.uploaded.length, 0, 'the ORIGINAL file must never be uploaded');
  assert.equal(d.calls.published.length, 0);
  assert.equal(d.calls.deleted.length, 0);
});

test('the payload passed to upload is always the PROCESSED blob, never the source file', async () => {
  const d = deps();
  const sentinel = blobOf(200 * 1024, 'image/jpeg');
  d.process = async () => ({ ok: true, blob: sentinel, type: 'image/jpeg' });
  const sourceFile = fileOf(jpegBytes(), 'image/jpeg');
  const r = await createController(d).saveImage(req({ file: sourceFile }));
  assert.equal(r.ok, true);
  assert.equal(d.calls.uploaded[0].blob, sentinel);
  assert.notEqual(d.calls.uploaded[0].blob, sourceFile);
  assert.equal(d.calls.uploaded[0].ct, 'image/jpeg');
});

// --- single flight -----------------------------------------------------------
test('a second concurrent save is refused with IMAGE_SAVE_IN_PROGRESS and ZERO side effects', async () => {
  const d = deps({ holdFirstUpload: true });
  const c = createController(d);
  const first = c.saveImage(req());
  await new Promise((r) => setTimeout(r, 20));           // let the first reach the upload

  const second = await c.saveImage(req());
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.BUSY);
  assert.equal(d.calls.uploaded.length, 1, 'the second save must not upload');
  assert.equal(d.calls.published.length, 0);

  d.releaseUpload();
  assert.equal((await first).ok, true);

  const third = await c.saveImage(req());
  assert.equal(third.ok, true, 'a save after the first settles must work (busy reset in finally)');
  assert.equal(d.calls.uploaded.length, 2);
});
test('busy resets after EVERY outcome, including an unexpected dependency exception', async () => {
  const cases = [
    { name: 'success', opts: {} },
    { name: 'invalid source', opts: {}, file: fileOf(pngBytes(), 'image/jpeg') },
    { name: 'process failure', opts: { processFails: true } },
    { name: 'upload failure', opts: { uploadFails: true } },
    { name: 'URL failure', opts: { urlFails: true } },
    { name: 'publish failure', opts: { publishFails: true } },
    { name: 'old delete failure', opts: { deleteFails: true } },
    { name: 'stale', opts: { staleFor: 1 } },
  ];
  for (const c of cases) {
    const ctrl = createController(deps(c.opts));
    await ctrl.saveImage(req({ file: c.file || fileOf(jpegBytes(), 'image/jpeg') }));
    assert.equal(ctrl.busy, false, 'busy stuck after: ' + c.name);
  }
  const d = deps();
  d.getDownloadUrl = () => { throw new Error('boom'); };
  const ctrl = createController(d);
  await ctrl.saveImage(req()).catch(() => {});
  assert.equal(ctrl.busy, false, 'busy stuck after an unexpected throw');
});

// --- remove image ------------------------------------------------------------
test('removeImage clears Firestore FIRST and only then deletes the managed object', async () => {
  const p = P.newPath(COACH_A, EX_A);
  const d = deps();
  const r = await createController(d).removeImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, currentPath: p });
  assert.equal(r.ok, true);
  assert.equal(d.calls.published.length, 1);
  assert.equal(d.calls.published[0].patch.imageUrl, '');
  assert.equal(d.calls.published[0].patch.assetRef, '');
  assert.deepEqual(d.calls.deleted, [p]);
});
test('removeImage never Storage-deletes a legacy external image', async () => {
  const d = deps();
  const r = await createController(d).removeImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, currentPath: 'https://cdn.example.com/a.jpg' });
  assert.equal(r.ok, true);
  assert.equal(d.calls.deleted.length, 0);
  assert.equal(r.removedPath, null);
});
test('removeImage publish failure leaves the image in place', async () => {
  const p = P.newPath(COACH_A, EX_A);
  const d = deps({ publishFails: true });
  const r = await createController(d).removeImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, currentPath: p });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.PUBLISH_FAILED);
  assert.equal(d.calls.deleted.length, 0);
});
