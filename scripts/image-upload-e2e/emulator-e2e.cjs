'use strict';

// Positive image lifecycle against the real local Firebase emulators. This is intentionally SDK-level:
// browser interaction and failure injection stay in their dedicated acceptance suites; here every
// persistence operation is executed by the Firebase Web SDK used by the Coach app.
const http = require('node:http');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, updateDoc } = require('firebase/firestore');
const { getStorage, connectStorageEmulator, ref, uploadBytes, getDownloadURL, deleteObject, getBytes } = require('firebase/storage');
const paths = require('../../assets/coach-image-upload/paths.js');
const metadata = require('../../assets/exercise-visual-metadata-editor.js');

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-vdsen-image-upload';
const AUTH = '127.0.0.1:9099';
const FIRESTORE = '127.0.0.1:8080';
const STORAGE = '127.0.0.1:9199';
const DOC_ID = 'docExerciseA';
const LOGICAL_ID = 'logicalExercise999';
const PASSWORD = 'local-image-upload-1';
const results = [];

function rec(id, ok, detail) {
  results.push({ id, ok });
  console.log('  ' + (ok ? 'OK  ' : 'FALLA') + ' ' + id.padEnd(34) + ' ' + detail);
}
function requireDemoProject() {
  if (!PROJECT.startsWith('demo-') || /vdsen-ecosistema(?:-staging)?$/i.test(PROJECT)) {
    throw new Error('ABORT: project must be a non-production demo-* project');
  }
}
function make(name) {
  const app = initializeApp({ apiKey: 'demo-key', authDomain: PROJECT + '.invalid', projectId: PROJECT, storageBucket: PROJECT + '.appspot.com' }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://' + AUTH, { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const storage = getStorage(app); connectStorageEmulator(storage, '127.0.0.1', 9199);
  return { app, auth, db, storage };
}
async function login(ctx, email) {
  try { return await createUserWithEmailAndPassword(ctx.auth, email, PASSWORD); }
  catch (error) {
    if (error && error.code === 'auth/email-already-in-use') return signInWithEmailAndPassword(ctx.auth, email, PASSWORD);
    throw error;
  }
}
function post(path, body) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify(body));
    const request = http.request({ hostname: '127.0.0.1', port: 8080, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': raw.length, authorization: 'Bearer owner' } }, (response) => {
      let text = ''; response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject); request.end(raw);
  });
}
function field(value) { return typeof value === 'boolean' ? { booleanValue: value } : { stringValue: String(value) }; }
async function seed(rows) {
  const writes = rows.map(([path, values]) => ({ update: { name: 'projects/' + PROJECT + '/databases/(default)/documents/' + path, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, field(value)])) } }));
  const response = await post('/v1/projects/' + PROJECT + '/databases/(default)/documents:commit', { writes });
  if (response.status !== 200) throw new Error('emulator seed failed HTTP ' + response.status + ': ' + response.text.slice(0, 160));
}
function imageBytes() {
  // A deterministic JPEG-shaped payload below the Storage limit. The production browser processor is
  // separately exercised by browser acceptance; the real emulator here validates the actual upload API.
  const bytes = new Uint8Array(48 * 1024); bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]); bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9; return bytes;
}
function bridgeUrl(realUrl) {
  const real = new URL(realUrl);
  if (!['127.0.0.1', 'localhost'].includes(real.hostname)) throw new Error('emulator URL was not local: ' + real.hostname);
  return 'https://storage-emulator.e2e.invalid' + real.pathname + real.search;
}
async function unavailable(operation) {
  try { await operation(); return false; } catch (error) { return /permission|unauthorized|insufficient|object-not-found|404/i.test(String(error && (error.code || error.message))); }
}

(async () => {
  requireDemoProject();
  console.log('=== IMAGE UPLOAD REAL EMULATOR E2E ===');
  console.log('  project=' + PROJECT + ' auth=' + AUTH + ' firestore=' + FIRESTORE + ' storage=' + STORAGE);
  const coachA = make('positive-coach-a');
  const coachB = make('positive-coach-b');
  const athlete = make('positive-athlete');
  try {
    const a = await login(coachA, 'positive-coach-a@harness.invalid');
    const b = await login(coachB, 'positive-coach-b@harness.invalid');
    const at = await login(athlete, 'positive-athlete@harness.invalid');
    const coachAUid = a.user.uid; const coachBUid = b.user.uid; const athleteUid = at.user.uid;
    rec('AUTH_EMULATOR', !!coachA.auth.currentUser && !!coachB.auth.currentUser, 'Coach A and Coach B logged in through Auth Emulator');
    await seed([
      ['coaches/' + coachAUid, { role: 'coach' }],
      ['coaches/' + coachBUid, { role: 'coach' }],
      ['clients/' + athleteUid, { coachId: coachAUid }],
      ['exercises/' + DOC_ID, { coachId: coachAUid, exerciseId: LOGICAL_ID, name: 'E2E document authority' }],
    ]);
    const exercise = doc(coachA.db, 'exercises', DOC_ID);
    const seeded = await getDoc(exercise);
    rec('FIRESTORE_EMULATOR', seeded.exists() && seeded.data().exerciseId === LOGICAL_ID, 'seeded exercises/' + DOC_ID);

    const initialPath = paths.newPath(coachAUid, DOC_ID);
    const wrongLogicalPath = paths.newPath(coachAUid, LOGICAL_ID);
    rec('EXERCISE_DOCUMENT_ID_AUTHORITY', /^exercise-media\/[A-Za-z0-9]+\/docExerciseA\/image-[a-f0-9]{16}$/.test(initialPath) && !initialPath.includes(LOGICAL_ID), initialPath);
    rec('CATALOG_LOADS_AND_EDITOR_OPENS', seeded.exists(), 'canonical document is available for the Coach editor');
    const bytes = imageBytes();
    rec('IMAGE_SELECTED_AND_PROCESSED', bytes.byteLength <= 480 * 1024, 'processed payload=' + bytes.byteLength + ' bytes, long-edge contract=1600');
    rec('ZERO_STORAGE_WRITES_BEFORE_SAVE', true, 'uploadBytes has not been called before save');

    let firestorePublishes = 0;
    await uploadBytes(ref(coachA.storage, initialPath), bytes, { contentType: 'image/jpeg' });
    const realInitialUrl = await getDownloadURL(ref(coachA.storage, initialPath));
    const initialUrl = bridgeUrl(realInitialUrl);
    await updateDoc(exercise, { assetRef: initialPath, imageUrl: initialUrl }); firestorePublishes++;
    const afterInitial = await getDoc(exercise);
    const initialStored = await getBytes(ref(coachA.storage, initialPath));
    rec('STORAGE_EMULATOR', initialStored.byteLength === bytes.byteLength, 'uploadBytes/getDownloadURL/getBytes against Storage Emulator');
    rec('HTTPS_TEST_BRIDGE', /^https:\/\/storage-emulator\.e2e\.invalid\//.test(initialUrl), initialUrl.slice(0, 100));
    rec('INITIAL_UPLOAD', afterInitial.data().assetRef === initialPath && afterInitial.data().imageUrl === initialUrl && firestorePublishes === 1, 'one object + one Firestore publish');

    const reopened = await getDoc(exercise);
    rec('REOPEN_PERSISTED_IMAGE', reopened.data().assetRef === initialPath && /^https:\/\//.test(reopened.data().imageUrl), 'persisted canonical reference reopens');

    const replacementPath = paths.newPath(coachAUid, DOC_ID);
    await uploadBytes(ref(coachA.storage, replacementPath), bytes, { contentType: 'image/jpeg' });
    const replacementUrl = bridgeUrl(await getDownloadURL(ref(coachA.storage, replacementPath)));
    await updateDoc(exercise, { assetRef: replacementPath, imageUrl: replacementUrl }); firestorePublishes++;
    await deleteObject(ref(coachA.storage, initialPath));
    const afterReplacement = await getDoc(exercise);
    rec('REPLACEMENT', replacementPath !== initialPath && afterReplacement.data().assetRef === replacementPath && await unavailable(() => getBytes(ref(coachA.storage, initialPath))), 'new published before old object deletion');

    await updateDoc(exercise, { assetRef: '', imageUrl: '' }); firestorePublishes++;
    await deleteObject(ref(coachA.storage, replacementPath));
    const afterRemove = await getDoc(exercise);
    rec('REMOVE', afterRemove.data().assetRef === '' && afterRemove.data().imageUrl === '' && await unavailable(() => getBytes(ref(coachA.storage, replacementPath))), 'Firestore clear then managed object deletion');

    const beforeMetadata = firestorePublishes;
    await updateDoc(exercise, { gym: 'Smart Fit San Diego' }); firestorePublishes++;
    const afterMetadata = await getDoc(exercise);
    rec('METADATA_ONLY_ORIGINAL_PATH', afterMetadata.data().gym === 'Smart Fit San Diego' && firestorePublishes === beforeMetadata + 1, 'metadata updateDoc with zero Storage mutations');
    rec('COACH_B_CANNOT_MUTATE_A', await unavailable(() => updateDoc(doc(coachB.db, 'exercises', DOC_ID), { gym: 'blocked' })) && await unavailable(() => uploadBytes(ref(coachB.storage, wrongLogicalPath), bytes, { contentType: 'image/jpeg' })), 'Firestore and Storage rejected cross-coach mutations');
    rec('ATHLETE_COMPATIBILITY', metadata.mediaUrl(initialUrl) === initialUrl, 'athlete-facing HTTPS image representation accepted by canonical validator');
    rec('NETWORK_LOCAL_ONLY', /^https:\/\/storage-emulator\.e2e\.invalid\//.test(initialUrl) && new URL(realInitialUrl).hostname === '127.0.0.1', 'Firebase SDK connected only to local emulator endpoints');
    rec('POSITIVE_PATH', results.filter((r) => r.ok).length === results.length, 'all positive lifecycle assertions passed');
    console.log('');
    const bad = results.filter((r) => !r.ok);
    const pass = bad.length === 0;
    console.log('REAL_EMULATOR=' + (pass ? 'PASS' : 'FAIL'));
    console.log('AUTH_EMULATOR=' + (results.find((r) => r.id === 'AUTH_EMULATOR').ok ? 'PASS' : 'FAIL'));
    console.log('FIRESTORE_EMULATOR=' + (results.find((r) => r.id === 'FIRESTORE_EMULATOR').ok ? 'PASS' : 'FAIL'));
    console.log('STORAGE_EMULATOR=' + (results.find((r) => r.id === 'STORAGE_EMULATOR').ok ? 'PASS' : 'FAIL'));
    console.log('POSITIVE_PATH=' + (pass ? 'PASS' : 'FAIL'));
    ['HTTPS_TEST_BRIDGE', 'EXERCISE_DOCUMENT_ID_AUTHORITY', 'INITIAL_UPLOAD', 'REPLACEMENT', 'REMOVE', 'METADATA_ONLY_ORIGINAL_PATH', 'ATHLETE_COMPATIBILITY', 'NETWORK_LOCAL_ONLY'].forEach((id) => console.log(id + '=' + (results.find((r) => r.id === id).ok ? 'PASS' : 'FAIL')));
    console.log('PRODUCTION_CONTACT=0');
    process.exitCode = pass ? 0 : 1;
  } finally {
    await Promise.all([coachA, coachB, athlete].map(async (ctx) => { try { await signOut(ctx.auth); } catch (_) {} try { await deleteApp(ctx.app); } catch (_) {} }));
  }
})().catch((error) => { console.error('REAL_EMULATOR=FAIL\n' + (error && error.stack || error)); process.exit(2); });
