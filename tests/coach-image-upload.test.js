'use strict';
// Coach exercise image — module unit tests.
//
// The replacement failure matrix is the important part: each row asserts the STATE that must survive a
// failure, not merely that a promise rejected. Client validation is explicitly not treated as a security
// boundary - storage.rules is - so these tests cover UX validation and orchestration ordering only.
const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../assets/coach-image-upload/validate.js');
const P = require('../assets/coach-image-upload/paths.js');
const { createController, CODES } = require('../assets/coach-image-upload/controller.js');

const COACH_A = 'coachA000000000000000001';
const COACH_B = 'coachB000000000000000002';
const EX_A = 'exA';
const file = (type, size) => ({ type, size, name: 'x' });

// A fake dependency set that records what the controller asked for and can be told to fail at a step.
function deps(opts) {
  opts = opts || {};
  const calls = { uploaded: [], published: [], deleted: [], cleanupDebt: [] };
  return {
    calls,
    upload: async (path, f, ct) => { if (opts.uploadFails) throw new Error('upload'); calls.uploaded.push({ path, ct }); },
    publish: async (exId, ref) => { if (opts.publishFails) throw new Error('publish'); calls.published.push({ exId, ref }); },
    deleteObject: async (path) => { if (opts.deleteFails) throw new Error('delete'); calls.deleted.push(path); },
    // `staleFor` names the token that is NO LONGER current, so the test states the invalidation directly
    // instead of leaving it implicit in an equality comparison.
    isCurrent: (t) => (opts.staleFor !== undefined ? t !== opts.staleFor : true),
    onCleanupFailure: (path) => calls.cleanupDebt.push(path),
  };
}

// --- P01-P07 validation -----------------------------------------------------
test('P01 valid JPEG accepted', () => { const r = V.validate(file('image/jpeg', 1024)); assert.equal(r.ok, true); assert.equal(r.contentType, 'image/jpeg'); });
test('P02 valid PNG accepted', () => { assert.equal(V.validate(file('image/png', 1024)).ok, true); });
test('P03 valid WEBP accepted', () => { assert.equal(V.validate(file('image/webp', 1024)).ok, true); });
test('P04 SVG rejected by name', () => { const r = V.validate(file('image/svg+xml', 10)); assert.equal(r.ok, false); assert.equal(r.code, 'REJECTED_TYPE'); });
test('P05 HTML rejected by name', () => { assert.equal(V.validate(file('text/html', 10)).code, 'REJECTED_TYPE'); });
test('P06 oversize rejected (512 KiB + 1)', () => { const r = V.validate(file('image/jpeg', 512 * 1024 + 1)); assert.equal(r.code, 'TOO_BIG'); });
test('P07 zero-byte rejected', () => { assert.equal(V.validate(file('image/jpeg', 0)).code, 'EMPTY'); });

test('exactly 512 KiB is allowed (the boundary belongs to the accepted side)', () => {
  assert.equal(V.validate(file('image/jpeg', 512 * 1024)).ok, true);
});

test('GIF and unknown types are rejected', () => {
  assert.equal(V.validate(file('image/gif', 10)).code, 'REJECTED_TYPE');
  assert.equal(V.validate(file('application/pdf', 10)).code, 'UNSUPPORTED');
});

test('the extension is never consulted - a .png name with an SVG type is still rejected', () => {
  assert.equal(V.validate({ type: 'image/svg+xml', size: 10, name: 'photo.png' }).ok, false);
});

// --- P08-P09 path generation -------------------------------------------------
test('P08 generated path matches the exact required pattern', () => {
  const p = P.newPath(COACH_A, EX_A);
  assert.match(p, new RegExp('^exercise-media/' + COACH_A + '/' + EX_A + '/image-[a-f0-9]{16}$'));
  assert.equal(P.parsePath(p).coachUid, COACH_A);
});

test('P08b random names do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(P.newPath(COACH_A, EX_A));
  assert.equal(seen.size, 200);
});

test('P08c an exercise id that could escape its segment is rejected', () => {
  assert.throws(() => P.buildPath(COACH_A, '../evil', 'aaaaaaaaaaaaaaaa'));
  assert.throws(() => P.buildPath(COACH_A, 'a/b', 'aaaaaaaaaaaaaaaa'));
});

test('P09 the path is only managed for its own coach and exercise', () => {
  const p = P.newPath(COACH_A, EX_A);
  assert.equal(P.isManagedPathFor(p, COACH_A, EX_A), true);
  assert.equal(P.isManagedPathFor(p, COACH_B, EX_A), false);
  assert.equal(P.isManagedPathFor(p, COACH_A, 'exB'), false);
  assert.equal(P.isManagedPathFor('https://example.com/x.jpg', COACH_A, EX_A), false);
  assert.equal(P.isManagedPathFor('assets/img/x.png', COACH_A, EX_A), false);
});

// --- P10-P11 initial upload --------------------------------------------------
test('P10 initial upload uploads then publishes', async () => {
  const d = deps();
  const c = createController(d);
  const r = await c.saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' });
  assert.equal(r.ok, true);
  assert.equal(d.calls.uploaded.length, 1);
  assert.equal(d.calls.published.length, 1);
  assert.equal(d.calls.published[0].ref, r.path);
  assert.equal(d.calls.deleted.length, 0);
  assert.equal(r.replaced, false);
});

test('P11 upload failure leaves Firestore untouched', async () => {
  const d = deps({ uploadFails: true });
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.UPLOAD_FAILED);
  assert.equal(d.calls.published.length, 0);
});

test('P12 publish failure deletes the NEW orphan and reports the publish failure', async () => {
  const d = deps({ publishFails: true });
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.PUBLISH_FAILED);
  assert.deepEqual(d.calls.deleted, [d.calls.uploaded[0].path]);   // exactly the new object
});

test('an invalid file never reaches the network', async () => {
  const d = deps();
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/svg+xml', 10), currentPath: '' });
  assert.equal(r.code, CODES.INVALID);
  assert.equal(d.calls.uploaded.length, 0);
  assert.equal(d.calls.published.length, 0);
});

// --- P13-P16 replacement matrix ---------------------------------------------
test('P13 replacement uploads a NEW path, publishes it, and only then deletes the OLD one', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps();
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 2048), currentPath: oldPath });
  assert.equal(r.ok, true);
  assert.notEqual(r.path, oldPath);
  assert.equal(r.replaced, true);
  assert.equal(d.calls.published[0].ref, r.path);
  assert.deepEqual(d.calls.deleted, [oldPath]);
  assert.equal(r.cleanup, 'DELETED');
  // Ordering: the publish must be observed before the delete.
  assert.ok(d.calls.published.length === 1 && d.calls.deleted.length === 1);
});

test('P14 replacement upload failure preserves the OLD reference and object', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps({ uploadFails: true });
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 2048), currentPath: oldPath });
  assert.equal(r.ok, false);
  assert.equal(d.calls.published.length, 0);
  assert.equal(d.calls.deleted.length, 0);          // OLD is never touched
});

test('P15 replacement publish failure preserves OLD and cleans up only NEW', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps({ publishFails: true });
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 2048), currentPath: oldPath });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.PUBLISH_FAILED);
  assert.deepEqual(d.calls.deleted, [d.calls.uploaded[0].path]);
  assert.ok(!d.calls.deleted.includes(oldPath), 'OLD must never be deleted when the publish failed');
});

test('P16 OLD delete failure still succeeds, keeps NEW live, and records cleanup debt', async () => {
  const oldPath = P.newPath(COACH_A, EX_A);
  const d = deps({ deleteFails: true });
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 2048), currentPath: oldPath });
  assert.equal(r.ok, true, 'the user-visible replacement is correct');
  assert.equal(r.cleanup, 'PENDING');
  assert.equal(d.calls.published[0].ref, r.path);
  assert.deepEqual(d.calls.cleanupDebt, [oldPath]);
  assert.ok(r.warning.length > 0);
});

test('P16b a legacy external URL is never treated as a managed object to delete', async () => {
  const d = deps();
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: 'https://cdn.example.com/a.jpg' });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, false);
  assert.equal(d.calls.deleted.length, 0);
});

test('P17 a path belonging to ANOTHER coach is not replaced', async () => {
  const foreign = P.newPath(COACH_B, EX_A);
  const d = deps();
  const r = await createController(d).saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: foreign });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, false);
  assert.equal(d.calls.deleted.length, 0);
});

// --- P18-P19 session safety --------------------------------------------------
test('P18 a stale token publishes nothing and deletes nothing', async () => {
  const d = deps({ staleFor: 2 });   // token 2 is the one that has been superseded
  const r = await createController(d).saveImage({ token: 2, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.STALE);
  assert.equal(d.calls.uploaded.length, 0);
  assert.equal(d.calls.published.length, 0);
});

test('P18b a token that goes stale DURING the upload still refuses to publish', async () => {
  let current = true;
  const seen = { published: 0, deleted: [] };
  const c = createController({
    upload: async () => { current = false; },                 // the session ends mid-upload
    publish: async () => { seen.published++; },
    deleteObject: async (p) => { seen.deleted.push(p); },
    isCurrent: () => current,
  });
  const r = await c.saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.STALE);
  assert.equal(seen.published, 0, 'nothing may be published into the next session');
});

test('P19 the module exposes no write path other than saveImage', () => {
  const d = deps();
  const c = createController(d);
  assert.deepEqual(Object.keys(c).sort(), ['CODES', 'MESSAGES', 'saveImage']);
});

test('P19b concurrent saves generate distinct paths (no shared mutable name)', async () => {
  const d = deps();
  const c = createController(d);
  const [a, b] = await Promise.all([
    c.saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' }),
    c.saveImage({ token: 1, coachUid: COACH_A, exerciseId: EX_A, file: file('image/jpeg', 1024), currentPath: '' }),
  ]);
  assert.notEqual(a.path, b.path);
});
