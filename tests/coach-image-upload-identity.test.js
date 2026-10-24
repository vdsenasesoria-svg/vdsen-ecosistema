'use strict';
// PHASE 0.2 — EXERCISE_DOCUMENT_ID_AUTHORITY = PASS
//
// A Firestore document at exercises/docExerciseA whose field exerciseId is logicalExercise999. The two
// identities are deliberately DIFFERENT, and Image Upload must use the DOCUMENT id everywhere, because
// storage.rules validates ownership with
//     firestore.exists(/databases/(default)/documents/exercises/$(exerciseId))
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const P = require('../assets/coach-image-upload/paths.js');
const { createController } = require('../assets/coach-image-upload/controller.js');

const COACH_A = 'coachA000000000000000001';
const DOC_A = 'docExerciseA';                  // Firestore document id
const LOGICAL_A = 'logicalExercise999';        // the document's exerciseId FIELD

const COACH = fs.readFileSync(path.join(ROOT, 'vdsen-coach.html'), 'utf8');

test('the editor context names document identity and domain identity separately', () => {
  assert.match(COACH, /documentId: exercise\.id,/);
  assert.match(COACH, /logicalExerciseId: exercise\.exerciseId \|\| null,/);
  // The old, dangerous coercion must be gone: it silently used the FIELD as the document id.
  assert.equal(/exerciseId: exercise\.exerciseId \|\| exercise\.id/.test(COACH), false);
});

test('the context authority resolves to the DOCUMENT id, not the domain id', () => {
  assert.match(COACH, /exerciseId: ex \? \(ex\.documentId \|\| ex\.id\) : null,/);
  assert.match(COACH, /documentId: ex \? \(ex\.documentId \|\| ex\.id\) : null,/);
  // The logical id is exposed for reference but must never be the authority.
  assert.match(COACH, /logicalExerciseId: ex \? \(ex\.logicalExerciseId \|\| null\) : null,/);
});

test('the generation token binds to the DOCUMENT id', () => {
  assert.match(COACH, /\(ex \? \(ex\.documentId \|\| ex\.id\) : ""\)/);
});

test('paths.buildPath places the DOCUMENT id in the path segment rules will look up', () => {
  const p = P.buildPath(COACH_A, DOC_A);
  assert.equal(p.startsWith('exercise-media/' + COACH_A + '/' + DOC_A + '/image-'), true, p);
  assert.equal(p.includes(LOGICAL_A), false, 'the domain id must not appear in the path');
  // And that exact segment is what the rules resolve as a document reference.
  const seg = p.split('/')[2];
  assert.equal(seg, DOC_A);
  assert.notEqual(seg, LOGICAL_A);
});

test('the DOCUMENT id is accepted by the path validator and the domain id would be a DIFFERENT namespace', () => {
  const docPath = P.buildPath(COACH_A, DOC_A);
  assert.equal(P.isManagedPathFor(docPath, COACH_A, DOC_A), true);
  // A path built from the logical id must NOT be considered managed for this document: it belongs to a
  // namespace that does not exist, which is exactly why rules would deny it.
  const logicalPath = P.buildPath(COACH_A, LOGICAL_A);
  assert.equal(P.isManagedPathFor(logicalPath, COACH_A, DOC_A), false);
  assert.equal(P.isManagedPathFor(docPath, COACH_A, LOGICAL_A), false);
});

test('savePrepared uploads under the DOCUMENT id and publishes to the DOCUMENT document', async () => {
  const calls = { uploaded: [], published: [], deleted: [] };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 100 * 1024, type: 'image/jpeg' }, type: 'image/jpeg', width: 1600, height: 1200 }),
    upload: (p) => { calls.uploaded.push(p); return Promise.resolve(); },
    getDownloadUrl: (p) => Promise.resolve('https://example.invalid/' + p),
    deleteObject: (p) => { calls.deleted.push(p); return Promise.resolve(); },
    // The controller calls publish(exerciseId, patch); record BOTH, since the target document identity is
    // exactly what this suite is about.
    publish: (exerciseId, patch) => { calls.published.push({ exerciseId, patch }); return Promise.resolve(); },
    isCurrent: () => true,
  });
  const prep = {
    ok: true, blob: { size: 100 * 1024, type: 'image/jpeg' }, type: 'image/jpeg',
    token: 't', coachUid: COACH_A, exerciseId: DOC_A,
  };
  const r = await c.savePrepared(prep, { token: 't', coachUid: COACH_A, exerciseId: DOC_A, currentPath: '' });
  assert.equal(r.ok, true);

  // Storage path segment = the DOCUMENT id, which is what rules resolve.
  assert.equal(calls.uploaded[0].split('/')[2], DOC_A);
  assert.equal(calls.uploaded[0].includes(LOGICAL_A), false);
  assert.equal(r.path.split('/')[2], DOC_A);

  // Firestore target = exercises/docExerciseA, NOT exercises/logicalExercise999.
  assert.equal(calls.published[0].exerciseId, DOC_A);
  assert.notEqual(calls.published[0].exerciseId, LOGICAL_A);
  assert.equal(calls.published[0].patch.assetRef.split('/')[2], DOC_A);
});

test('a prepared image bound to the DOMAIN id is refused for the DOCUMENT namespace', async () => {
  // Guards against a regression that would silently address the wrong document: a prepared result carrying
  // the logical id cannot be saved as the document, because the identities disagree.
  const calls = { uploaded: [], published: [] };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg' }),
    upload: (p) => { calls.uploaded.push(p); return Promise.resolve(); },
    getDownloadUrl: () => Promise.resolve('https://example.invalid/x'),
    deleteObject: () => Promise.resolve(),
    publish: (exerciseId, patch) => { calls.published.push({ exerciseId, patch }); return Promise.resolve(); },
    isCurrent: () => true,
  });
  const prep = { ok: true, blob: { size: 1024, type: 'image/jpeg' }, type: 'image/jpeg', token: 't', coachUid: COACH_A, exerciseId: LOGICAL_A };
  const r = await c.savePrepared(prep, { token: 't', coachUid: COACH_A, exerciseId: DOC_A, currentPath: '' });
  assert.equal(r.ok, false, 'a cross-namespace prepared image must not save');
  assert.equal(calls.uploaded.length, 0);
  assert.equal(calls.published.length, 0);
});

test('replacement under the DOCUMENT id keeps NEW and OLD in the same document namespace', async () => {
  const oldPath = P.buildPath(COACH_A, DOC_A);
  const calls = { uploaded: [], published: [], deleted: [] };
  const c = createController({
    process: async () => ({ ok: true, blob: { size: 100 * 1024, type: 'image/jpeg' }, type: 'image/jpeg', width: 1600, height: 1200 }),
    upload: (p) => { calls.uploaded.push(p); return Promise.resolve(); },
    getDownloadUrl: (p) => Promise.resolve('https://example.invalid/' + p),
    deleteObject: (p) => { calls.deleted.push(p); return Promise.resolve(); },
    publish: (exerciseId, patch) => { calls.published.push({ exerciseId, patch }); return Promise.resolve(); },
    isCurrent: () => true,
  });
  const prep = { ok: true, blob: { size: 100 * 1024, type: 'image/jpeg' }, type: 'image/jpeg', token: 't', coachUid: COACH_A, exerciseId: DOC_A };
  const r = await c.savePrepared(prep, { token: 't', coachUid: COACH_A, exerciseId: DOC_A, currentPath: oldPath });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, true, 'the OLD managed object in the same namespace is recognised');
  assert.notEqual(r.path, oldPath);
  assert.equal(r.path.split('/')[2], DOC_A);
  assert.deepEqual(calls.deleted, [oldPath]);
  assert.equal(calls.published[0].exerciseId, DOC_A);
});
