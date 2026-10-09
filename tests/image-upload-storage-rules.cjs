'use strict';
// PHASE 5/6 — Storage rules security matrix against the REAL Storage emulator rules engine.
//
// Drives the normal Firebase client SDKs against the emulators (Auth, Firestore, Storage) under a
// single `demo-` project, so the rules that decide each outcome are the real ones. There is no fake
// rules evaluator and no stubbing: if a case cannot execute it is reported as UNKNOWN, never as PASS.
//
// @firebase/rules-unit-testing has no Storage client, so the real Storage SDK is used instead.
const path = require('node:path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
const { getStorage, connectStorageEmulator, ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-vdsen-image-upload';
if (!PROJECT.startsWith('demo-')) { console.error('ABORT: project must start with demo-'); process.exit(2); }

const AUTH = '127.0.0.1:9099', FS = '127.0.0.1:8080', ST = '127.0.0.1:9199';
const results = [];
const rec = (id, ok, d) => { results.push({ id, ok, expected: d.expected, actual: d.actual }); console.log('  ' + (ok ? 'OK  ' : 'FALLA') + ' ' + id.padEnd(4) + ' ' + d.label + '  [esperado=' + d.expected + ' real=' + d.actual + ']'); };

const mk = (name) => {
  const app = initializeApp({ apiKey: 'demo-key', projectId: PROJECT, storageBucket: PROJECT + '.appspot.com' }, name);
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://' + AUTH, { disableWarnings: true });
  const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const storage = getStorage(app); connectStorageEmulator(storage, '127.0.0.1', 9199);
  return { app, auth, db, storage };
};

const pw = 'pw-local-1';
async function actor(name, email, anon) {
  const ctx = mk(name);
  if (!anon) {
    try { await createUserWithEmailAndPassword(ctx.auth, email, pw); }
    catch (e) { await signInWithEmailAndPassword(ctx.auth, email, pw); }
  }
  return ctx;
}

// Authority fixture seeding through the emulator ADMIN path (Bearer owner).
//
// Test setup only: it must not itself be governed by firestore.rules, or the fixture fails before any
// Storage case runs. The Storage rules then read these documents, which is the authorization under test.
const http = require('node:http');
function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}) },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function fv(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { stringValue: String(v) };
}
async function seedAuthority(rows) {
  const writes = rows.map(([p, obj]) => ({
    update: {
      name: 'projects/' + PROJECT + '/databases/(default)/documents/' + p,
      fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fv(v)])),
    },
  }));
  const r = await post('http://' + FS + '/v1/projects/' + PROJECT + '/databases/(default)/documents:commit',
    { writes }, { authorization: 'Bearer owner' });
  if (r.status !== 200) throw new Error('seed failed HTTP ' + r.status + ' ' + String(r.text).slice(0, 200));
}

const bytes = (n) => new Uint8Array(n);
const imgPath = (coach, ex, hex) => 'exercise-media/' + coach + '/' + ex + '/image-' + hex;

async function tryUpload(ctx, p, contentType, size) {
  try { await uploadBytes(ref(ctx.storage, p), bytes(size), { contentType }); return 'ALLOW'; }
  catch (e) { const c = String(e && e.code || e && e.message || e); return /unauthorized|permission|403/i.test(c) ? 'DENY' : 'ERR:' + c.slice(0, 60); }
}
async function tryRead(ctx, p) {
  try { await getBytes(ref(ctx.storage, p)); return 'ALLOW'; }
  catch (e) { const c = String(e && e.code || e && e.message || e); return /unauthorized|permission|404|403|object-not-found/i.test(c) ? 'DENY' : 'ERR:' + c.slice(0, 60); }
}
async function tryDelete(ctx, p) {
  try { await deleteObject(ref(ctx.storage, p)); return 'ALLOW'; }
  catch (e) { const c = String(e && e.code || e && e.message || e); return /unauthorized|permission|404|403|object-not-found/i.test(c) ? 'DENY' : 'ERR:' + c.slice(0, 60); }
}

(async () => {
  console.log('=== STORAGE RULES MATRIX — emulador real ===');
  console.log('  project=' + PROJECT + '  storage=' + ST + '  firestore=' + FS + '  auth=' + AUTH);

  const CA = await actor('ca', 'ca@harness.invalid');
  const CB = await actor('cb', 'cb@harness.invalid');
  const AA = await actor('aa', 'aa@harness.invalid');
  const AB = await actor('ab', 'ab@harness.invalid');
  const ANON = await actor('an', null, true);
  const uid = (c) => c.auth.currentUser.uid;
  const [coachA, coachB, athA, athB] = [uid(CA), uid(CB), uid(AA), uid(AB)];
  console.log('  coachA=' + coachA.slice(0, 10) + '  coachB=' + coachB.slice(0, 10) + '  athA=' + athA.slice(0, 10));

  // Authority fixture, seeded through the emulator ADMIN path.
  //
  // The first attempt used the client SDK, which made the SEEDING itself subject to firestore.rules and
  // failed with PERMISSION_DENIED before a single Storage case could run. Seeding is test setup, not part
  // of the contract under test, so it uses the owner credential. The Storage rules then read these exact
  // documents, so the cross-service authorization being exercised is the real one.
  await seedAuthority([
    ['coaches/' + coachA, { role: 'coach' }],
    ['coaches/' + coachB, { role: 'coach' }],
    ['exercises/exA', { coachId: coachA, name: 'exA' }],
    ['exercises/exB', { coachId: coachB, name: 'exB' }],
    ['clients/' + athA, { coachId: coachA }],
    ['clients/' + athB, { coachId: coachB }],
  ]);
  await new Promise((r) => setTimeout(r, 1500));

  const pA = (hex) => imgPath(coachA, 'exA', hex);
  const h1 = 'aaaaaaaaaaaaaaaa', h2 = 'bbbbbbbbbbbbbbbb';

  const T = async (id, label, fn, expected) => {
    const actual = await fn();
    rec(id, actual === expected, { label, expected, actual });
  };

  await T('S01', 'anonimo JPEG create', () => tryUpload(ANON, pA(h1), 'image/jpeg', 1024), 'DENY');
  await T('S02', 'Coach A JPEG propio', () => tryUpload(CA, pA(h1), 'image/jpeg', 1024), 'ALLOW');
  await T('S03', 'Coach A PNG propio', () => tryUpload(CA, pA(h2), 'image/png', 1024), 'ALLOW');
  await T('S04', 'Coach A WEBP propio', () => tryUpload(CA, imgPath(coachA, 'exA', 'cccccccccccccccc'), 'image/webp', 1024), 'ALLOW');
  await T('S05', 'Coach B -> coachA/exA', () => tryUpload(CB, pA('dddddddddddddddd'), 'image/jpeg', 1024), 'DENY');
  await T('S06', 'Coach A -> exB (de B)', () => tryUpload(CA, imgPath(coachA, 'exB', 'eeeeeeeeeeeeeeee'), 'image/jpeg', 1024), 'DENY');
  await T('S07', 'path spoofeado', () => tryUpload(CA, imgPath(coachB, 'exA', 'ffffffffffffffff'), 'image/jpeg', 1024), 'DENY');
  await T('S08', 'filename invalido', () => tryUpload(CA, imgPath(coachA, 'exA', 'ZZZZ'), 'image/jpeg', 1024), 'DENY');
  await T('S09', 'SVG', () => tryUpload(CA, imgPath(coachA, 'exA', '1111111111111111'), 'image/svg+xml', 1024), 'DENY');
  await T('S10', 'text/html', () => tryUpload(CA, imgPath(coachA, 'exA', '2222222222222222'), 'text/html', 1024), 'DENY');
  await T('S11', 'xhtml+xml', () => tryUpload(CA, imgPath(coachA, 'exA', '3333333333333333'), 'application/xhtml+xml', 1024), 'DENY');
  await T('S12', 'image/gif', () => tryUpload(CA, imgPath(coachA, 'exA', '4444444444444444'), 'image/gif', 1024), 'DENY');
  await T('S13', 'cero bytes', () => tryUpload(CA, imgPath(coachA, 'exA', '5555555555555555'), 'image/jpeg', 0), 'DENY');
  await T('S14', 'exactamente 512 KiB', () => tryUpload(CA, imgPath(coachA, 'exA', '6666666666666666'), 'image/jpeg', 512 * 1024), 'ALLOW');
  await T('S15', '512 KiB + 1', () => tryUpload(CA, imgPath(coachA, 'exA', '7777777777777777'), 'image/jpeg', 512 * 1024 + 1), 'DENY');
  await T('S16', 'segundo CREATE con nombre nuevo', () => tryUpload(CA, imgPath(coachA, 'exA', '8888888888888888'), 'image/jpeg', 1024), 'ALLOW');
  // S17 - overwrite of the SAME object path: reported as UNKNOWN, deliberately.
  //
  // storage.rules grants NO `update` anywhere - only `create`, `read` and `delete` - and the official
  // linter (cloud-storage-rules-runtime lint) accepts the ruleset with no issues. An overwrite of an
  // existing object therefore cannot be authorized by these rules: Cloud Storage evaluates a write to an
  // existing object as an `update` and would deny it.
  //
  // The Storage EMULATOR, however, routes a second uploadBytes() to the same path as a fresh `create`
  // and answers ALLOW, and it exposes no way to force the update path through the client SDK. The
  // emulator therefore cannot answer this particular question, so the case is recorded as UNKNOWN and is
  // NOT counted as a pass. It must be confirmed against a real bucket before production reliance.
  {
    const path17 = pA(h1);
    const first = await tryUpload(CA, path17, 'image/jpeg', 1024);
    const second = await tryUpload(CA, path17, 'image/jpeg', 2048);
    rec('S17', false, {
      label: 'OVERWRITE del mismo path => UNKNOWN (1er=' + first + ' 2do=' + second + ')',
      expected: 'DENY en produccion (no se concede update)',
      actual: 'UNKNOWN_EMULATOR_TREATS_AS_CREATE',
    });
  }
  await T('S18', 'lectura anonima', () => tryRead(ANON, pA(h1)), 'DENY');
  await T('S19', 'Coach A lee lo propio', () => tryRead(CA, pA(h1)), 'ALLOW');
  await T('S20', 'Coach B lee lo de A', () => tryRead(CB, pA(h1)), 'DENY');
  await T('S21', 'Atleta A lee media de su coach', () => tryRead(AA, pA(h1)), 'ALLOW');
  await T('S22', 'Atleta B lee media de A', () => tryRead(AB, pA(h1)), 'DENY');
  await T('S23', 'Coach A borra lo propio', () => tryDelete(CA, pA(h2)), 'ALLOW');
  await T('S24', 'Coach B borra lo de A', () => tryDelete(CB, pA(h1)), 'DENY');
  await T('S25', 'borrado anonimo', () => tryDelete(ANON, pA(h1)), 'DENY');
  await T('S26', 'path fuera de exercise-media', () => tryUpload(CA, 'otra-carpeta/' + coachA + '/x/image-' + h1, 'image/jpeg', 1024), 'DENY');

  console.log('');
  const bad = results.filter((r) => !r.ok);
  console.log('  ' + (results.length - bad.length) + '/' + results.length + ' filas');
  if (bad.length) console.log('  FALLAN: ' + bad.map((x) => x.id + '(' + x.actual + ')').join(', '));
  console.log('  STORAGE_RULES_ACCEPTANCE=' + (bad.length ? 'FAIL' : 'PASS'));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('  FATAL ' + (e && e.stack || e)); process.exit(2); });
