#!/usr/bin/env node
'use strict';
// LOCAL security suite for storage.rules (exercise photos): Auth + Firestore (real firestore.rules) + Cloud Storage emulators. Synthetic data only.
//   node scripts/coach-image-storage-rules.cjs [--out results.json]
const fs = require('node:fs');
const path = require('node:path');
const L = require('./storage-emulator-lib.cjs');
const i = process.argv.indexOf('--out'); const outFile = i > 0 ? process.argv[i + 1] : null;
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };

// Minimal valid files (rules only look at declared contentType + size).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(2000, 3)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const hex = n => n.toString(16).padStart(16, '0');

async function main() {
  L.installPackages();
  const ports = await L.startStack();
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + ports.fs; process.env.GCLOUD_PROJECT = L.PROJECT; process.env.METADATA_SERVER_DETECTION = 'none';
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_AUTH_EMULATOR_HOST']) delete process.env[k];
  const req = require('node:module').createRequire(path.join(L.runtime, 'noop.js'));
  const { initializeApp: initAdmin } = req('firebase-admin/app'), { getFirestore: adminFs } = req('firebase-admin/firestore');
  const { initializeApp } = req('firebase/app'), A = req('firebase/auth'), S = req('firebase/storage');
  const PASS = 'Rules-pass-123';
  const u = {};
  for (const n of ['coachA', 'coachB', 'athleteA', 'athleteB', 'stranger']) u[n] = await L.signUp(ports.auth, n + '@rules.invalid', PASS);
  const adb = adminFs(initAdmin({ projectId: L.PROJECT }, 'rules-seed'));
  await adb.doc('coaches/' + u.coachA).set({ role: 'coach', email: 'coachA@rules.invalid' });
  await adb.doc('coaches/' + u.coachB).set({ role: 'coach', email: 'coachB@rules.invalid' });
  await adb.doc('clients/' + u.athleteA).set({ coachId: u.coachA, role: 'client' });
  await adb.doc('clients/' + u.athleteB).set({ coachId: u.coachB, role: 'client' });
  await adb.doc('exercises/EXA').set({ coachId: u.coachA, name: 'Ejercicio A' });
  await adb.doc('exercises/EXA2').set({ coachId: u.coachA, name: 'Ejercicio A2' });
  await adb.doc('exercises/EXB').set({ coachId: u.coachB, name: 'Ejercicio B' });

  const sessions = {};
  async function as(name) {
    if (sessions[name]) return sessions[name];
    if (name === 'anon') { const app = initializeApp({ apiKey: 'demo-key', projectId: L.PROJECT, storageBucket: L.BUCKET }, 'anon'); const st = S.getStorage(app); S.connectStorageEmulator(st, '127.0.0.1', ports.storage); return (sessions[name] = st); }
    const app = initializeApp({ apiKey: 'demo-key', projectId: L.PROJECT, storageBucket: L.BUCKET, authDomain: L.PROJECT + '.firebaseapp.com' }, name);
    const auth = A.getAuth(app); A.connectAuthEmulator(auth, 'http://127.0.0.1:' + ports.auth, { disableWarnings: true });
    await A.signInWithEmailAndPassword(auth, name + '@rules.invalid', PASS);
    const st = S.getStorage(app); S.connectStorageEmulator(st, '127.0.0.1', ports.storage); return (sessions[name] = st);
  }
  const put = async (who, p, bytes, type) => { try { await S.uploadBytes(S.ref(await as(who), p), bytes, type ? { contentType: type } : undefined); return 'ok'; } catch (e) { return (e && e.code) || String(e); } };
  const get = async (who, p) => { try { await S.getDownloadURL(S.ref(await as(who), p)); return 'ok'; } catch (e) { return (e && e.code) || String(e); } };
  const del = async (who, p) => { try { await S.deleteObject(S.ref(await as(who), p)); return 'ok'; } catch (e) { return (e && e.code) || String(e); } };
  const denied = r => r === 'storage/unauthorized' || r === 'storage/unauthenticated';
  const P = (coach, ex, n) => 'exercise-media/' + u[coach] + '/' + ex + '/image-' + hex(n);

  // 1-3 owner lifecycle (versioned replacement)
  check('owner-upload-jpeg', await put('coachA', P('coachA', 'EXA', 1), JPEG, 'image/jpeg') === 'ok');
  check('owner-replace-new-version', await put('coachA', P('coachA', 'EXA', 2), JPEG, 'image/jpeg') === 'ok');
  check('owner-overwrite-same-object', await put('coachA', P('coachA', 'EXA', 2), JPEG, 'image/jpeg') === 'ok');
  check('owner-delete-old-version', await del('coachA', P('coachA', 'EXA', 1)) === 'ok');
  check('owner-reads-own', await get('coachA', P('coachA', 'EXA', 2)) === 'ok');
  // accepted formats
  check('owner-upload-png', await put('coachA', P('coachA', 'EXA', 3), PNG, 'image/png') === 'ok');
  check('owner-upload-webp', await put('coachA', P('coachA', 'EXA', 4), WEBP, 'image/webp') === 'ok');
  // rejected content
  check('reject-svg', denied(await put('coachA', P('coachA', 'EXA', 5), SVG, 'image/svg+xml')));
  check('reject-html', denied(await put('coachA', P('coachA', 'EXA', 6), HTML, 'text/html')));
  check('reject-octet-stream', denied(await put('coachA', P('coachA', 'EXA', 7), JPEG, 'application/octet-stream')));
  check('reject-oversized', denied(await put('coachA', P('coachA', 'EXA', 8), Buffer.alloc(600 * 1024, 7), 'image/jpeg')));
  check('reject-unversioned-name', denied(await put('coachA', 'exercise-media/' + u.coachA + '/EXA/image.jpg', JPEG, 'image/jpeg')));
  check('reject-name-outside-scheme', denied(await put('coachA', 'exercise-media/' + u.coachA + '/EXA/foto-1', JPEG, 'image/jpeg')));
  check('reject-other-top-level-path', denied(await put('coachA', 'misc/' + u.coachA + '/x', JPEG, 'image/jpeg')));
  // cross-coach
  check('coachB-cannot-upload-into-coachA-path', denied(await put('coachB', P('coachA', 'EXA', 9), JPEG, 'image/jpeg')));
  check('coachB-cannot-overwrite-coachA-object', denied(await put('coachB', P('coachA', 'EXA', 2), JPEG, 'image/jpeg')));
  check('coachB-cannot-delete-coachA-object', denied(await del('coachB', P('coachA', 'EXA', 2))));
  check('coachB-cannot-read-coachA-object', denied(await get('coachB', P('coachA', 'EXA', 2))));
  check('coachA-cannot-write-under-coachB', denied(await put('coachA', P('coachB', 'EXB', 1), JPEG, 'image/jpeg')));
  check('coachA-cannot-claim-coachB-exercise-in-own-path', denied(await put('coachA', P('coachA', 'EXB', 1), JPEG, 'image/jpeg')));
  check('coachA-cannot-use-nonexistent-exercise', denied(await put('coachA', P('coachA', 'NOPE', 1), JPEG, 'image/jpeg')));
  check('coachB-own-upload-still-ok', await put('coachB', P('coachB', 'EXB', 1), JPEG, 'image/jpeg') === 'ok');
  check('coachA-object-still-intact', await get('coachA', P('coachA', 'EXA', 2)) === 'ok');
  // unauthenticated / non-coach
  check('anonymous-cannot-upload', denied(await put('anon', P('coachA', 'EXA', 10), JPEG, 'image/jpeg')));
  check('anonymous-cannot-delete', denied(await del('anon', P('coachA', 'EXA', 2))));
  check('anonymous-cannot-read', denied(await get('anon', P('coachA', 'EXA', 2))));
  check('stranger-cannot-upload', denied(await put('stranger', P('coachA', 'EXA', 11), JPEG, 'image/jpeg')));
  check('stranger-cannot-read', denied(await get('stranger', P('coachA', 'EXA', 2))));
  check('athlete-cannot-upload', denied(await put('athleteA', P('coachA', 'EXA', 12), JPEG, 'image/jpeg')));
  check('athlete-cannot-delete', denied(await del('athleteA', P('coachA', 'EXA', 2))));
  // athlete read model: only the athlete assigned to the owning coach
  check('athlete-of-coach-reads', await get('athleteA', P('coachA', 'EXA', 2)) === 'ok');
  check('athlete-of-other-coach-cannot-read', denied(await get('athleteB', P('coachA', 'EXA', 2))));
  check('athlete-of-coachB-reads-coachB', await get('athleteB', P('coachB', 'EXB', 1)) === 'ok');
  // owner deletes last objects
  check('owner-delete-own-final', await del('coachA', P('coachA', 'EXA', 2)) === 'ok');
  check('deleted-object-gone', await get('coachA', P('coachA', 'EXA', 2)) !== 'ok');

  const failed = results.filter(r => !r.pass).length;
  console.log('\nSTORAGE RULES: ' + (results.length - failed) + '/' + results.length + ' passed');
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  return failed ? 1 : 0;
}
main().then(async c => { await L.cleanup(); process.exit(c); }, async e => { console.error(e); await L.cleanup(); process.exit(1); });
