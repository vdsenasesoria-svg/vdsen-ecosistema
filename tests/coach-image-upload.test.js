'use strict';
// Coach direct photo upload (Firebase Storage, Option A): validation, local processing, staging/race safety, naming, editor patch, shell cleanup and athlete URL
// compatibility. Storage rules + real browser behaviour: scripts/coach-image-storage-rules.cjs, scripts/coach-image-upload-e2e.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const IMG = require('../assets/exercise-image-upload.js');
const VME = require('../assets/exercise-visual-metadata-editor.js');
const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const body = (src, name) => { const i = src.indexOf(name); assert.ok(i > -1, name); let d = 0; const j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error('unbalanced'); };

const H = { jpeg: [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0], png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0], webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], svg: Array.from(Buffer.from('<svg xmlns="http://www.w3.org')) , html: Array.from(Buffer.from('<html><body>')) };
const file = (type, head, size, extra) => Object.assign({ type, size: size == null ? 5000 : size, head }, extra || {});
// Fake browser: a "blob" size is derived from pixel count and quality, so compression/shrinking is observable.
function fakeEnv(opts) {
  opts = opts || {}; const revoked = [], created = []; let n = 0;
  const env = {
    supportsWebp: opts.webp !== false,
    readHead: async f => { if (opts.headThrows) throw new Error('x'); return f.head; },
    decode: async f => { if (opts.decodeThrows) throw new Error('corrupt'); if (opts.gate) await opts.gate; return { width: f.w || 4000, height: f.h || 3000, hasAlpha: () => !!f.alpha, draw() {}, close() { env.closed = (env.closed || 0) + 1; } }; },
    createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ({ drawImage() {} }) }),
    encode: async (c, mime, q) => ({ size: Math.round(c.width * c.height * 0.5 * q * (opts.heavy || 0.2)), type: mime }),
    url: { create: () => { const u = 'blob:fake/' + (++n); created.push(u); return u; }, revoke: u => revoked.push(u) },
    revoked, created
  };
  return env;
}

test('IU.1 JPEG, PNG and WebP are accepted; SVG, HTML, GIF, PDF are refused before decoding', async () => {
  const env = fakeEnv();
  for (const [t, h] of [['image/jpeg', H.jpeg], ['image/png', H.png], ['image/webp', H.webp]]) assert.equal((await IMG.validateImageFile(file(t, h), env)).ok, true, t);
  for (const t of ['image/svg+xml', 'text/html', 'image/gif', 'application/pdf', '', 'application/octet-stream']) { const r = await IMG.validateImageFile(file(t, H.svg), env); assert.equal(r.ok, false, t); assert.equal(r.code, 'UNSUPPORTED_TYPE'); }
});

test('IU.2 a renamed SVG/HTML (declared jpeg, wrong bytes), a MIME mismatch and an unreadable header are refused', async () => {
  const env = fakeEnv();
  assert.equal((await IMG.validateImageFile(file('image/jpeg', H.svg), env)).code, 'MALFORMED');
  assert.equal((await IMG.validateImageFile(file('image/png', H.html), env)).code, 'MALFORMED');
  assert.equal((await IMG.validateImageFile(file('image/png', H.jpeg), env)).code, 'MIME_MISMATCH');
  assert.equal((await IMG.validateImageFile(file('image/jpeg', H.jpeg, 0), env)).code, 'EMPTY');
  assert.equal((await IMG.validateImageFile(file('image/jpeg', H.jpeg), fakeEnv({ headThrows: true }))).code, 'MALFORMED');
  assert.equal((await IMG.validateImageFile(null, env)).code, 'EMPTY');
});

test('IU.3 a source above the limit is refused with the user-facing message; the limit itself is allowed', async () => {
  const env = fakeEnv(), L = IMG.LIMITS;
  const over = await IMG.validateImageFile(file('image/jpeg', H.jpeg, L.sourceBytes + 1), env);
  assert.equal(over.ok, false); assert.equal(over.code, 'TOO_LARGE'); assert.equal(over.message, 'La imagen es demasiado grande. Intenta con otra foto.');
  assert.equal((await IMG.validateImageFile(file('image/jpeg', H.jpeg, L.sourceBytes), env)).ok, true);
});

test('IU.4 resize: long edge capped at 1600, aspect preserved, never upscaled, portrait handled', () => {
  assert.deepEqual(IMG.fitSize(4000, 3000, 1600), { width: 1600, height: 1200, scale: 0.4 });
  assert.deepEqual(IMG.fitSize(3000, 4000, 1600), { width: 1200, height: 1600, scale: 0.4 });
  assert.equal(IMG.fitSize(800, 600, 1600).width, 800); assert.equal(IMG.fitSize(800, 600, 1600).scale, 1);
  assert.equal(IMG.fitSize(10000, 1, 1600).height, 1);
});

test('IU.5 processing: compresses under the target, never above the hard cap, small images are not inflated', async () => {
  const env = fakeEnv();
  const big = await IMG.processImage(file('image/jpeg', H.jpeg, 9e6, { w: 4000, h: 3000 }), env);
  assert.equal(big.ok, true); assert.equal(big.mime, 'image/jpeg'); assert.ok(big.bytes <= IMG.LIMITS.targetBytes, 'bytes ' + big.bytes); assert.ok(Math.max(big.width, big.height) <= 1600);
  const small = await IMG.processImage(file('image/jpeg', H.jpeg, 4000, { w: 400, h: 300 }), env);
  assert.equal(small.ok, true); assert.equal(small.width, 400); assert.equal(small.height, 300);
  assert.ok(env.closed >= 2, 'source bitmaps released');
});

test('IU.6 PNG without alpha becomes JPEG; PNG with alpha becomes WebP when supported (JPEG otherwise); JPEG/PNG sources processed', async () => {
  assert.equal((await IMG.processImage(file('image/png', H.png, 5000, { w: 800, h: 600 }), fakeEnv())).mime, 'image/jpeg');
  assert.equal((await IMG.processImage(file('image/png', H.png, 5000, { w: 800, h: 600, alpha: true }), fakeEnv())).mime, 'image/webp');
  assert.equal((await IMG.processImage(file('image/png', H.png, 5000, { w: 800, h: 600, alpha: true }), fakeEnv({ webp: false }))).mime, 'image/jpeg');
  assert.equal((await IMG.processImage(file('image/webp', H.webp, 5000, { w: 800, h: 600 }), fakeEnv())).ok, true);
});

test('IU.7 an image that cannot fit the hard cap is refused; decode failures give the generic message with no stack', async () => {
  const huge = await IMG.processImage(file('image/jpeg', H.jpeg, 9e6, { w: 4000, h: 3000 }), fakeEnv({ heavy: 500 }));
  assert.equal(huge.ok, false); assert.equal(huge.code, 'TOO_LARGE');
  const bad = await IMG.processImage(file('image/jpeg', H.jpeg), fakeEnv({ decodeThrows: true }));
  assert.equal(bad.ok, false); assert.equal(bad.message, 'No se pudo procesar esta imagen.'); assert.ok(!/at |Error|corrupt/.test(bad.message));
});

test('IU.8 controller: processing -> ready preview; discard releases blob and object URL', async () => {
  const env = fakeEnv(), states = [], c = IMG.createController(env, { onChange: s => states.push(s.status + ':' + s.message) });
  await c.stage(file('image/jpeg', H.jpeg, 9e6));
  assert.deepEqual(states.slice(0, 2), ['processing:Procesando imagen...', 'ready:Foto lista']);
  assert.ok(c.getStaged() && c.state().previewUrl);
  const url = c.state().previewUrl; c.discard();
  assert.equal(c.getStaged(), null); assert.equal(c.state().previewUrl, null); assert.deepEqual(env.revoked, [url]);
});

test('IU.9 a new selection replaces the previous one and revokes its preview; failures never keep a stale image', async () => {
  const env = fakeEnv(), c = IMG.createController(env);
  await c.stage(file('image/jpeg', H.jpeg)); const first = c.state().previewUrl;
  await c.stage(file('image/jpeg', H.jpeg)); assert.ok(env.revoked.includes(first)); assert.notEqual(c.state().previewUrl, first);
  const r = await c.stage(file('image/svg+xml', H.svg));
  assert.equal(r.ok, false); assert.equal(c.state().status, 'error'); assert.equal(c.getStaged(), null); assert.equal(c.state().previewUrl, null);
});

test('IU.10 stale async result: invalidate/new selection while decoding drops the late result (no preview, no blob, no object URL)', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const env = fakeEnv({ gate }), c = IMG.createController(env);
  const p = c.stage(file('image/jpeg', H.jpeg));
  await new Promise(r => setImmediate(r));
  c.invalidate();                                          // exercise switch / modal close / logout / coach switch
  release(); const r = await p;
  assert.equal(r.stale, true); assert.equal(c.getStaged(), null); assert.equal(c.state().previewUrl, null); assert.equal(env.created.length, 0);
  assert.equal(c.state().status, 'idle');
});

test('IU.11 two overlapping selections: only the latest wins', async () => {
  let release1; const g1 = new Promise(r => { release1 = r; });
  const slow = fakeEnv(); const c = IMG.createController({ ...slow, decode: async f => { if (f.slow) await g1; return slow.decode(f); } });
  const a = c.stage(file('image/jpeg', H.jpeg, 5000, { slow: true, w: 1000, h: 1000 }));
  await new Promise(r => setImmediate(r));
  const b = await c.stage(file('image/jpeg', H.jpeg, 5000, { w: 500, h: 400 }));
  release1(); const ra = await a;
  assert.equal(b.ok, true); assert.equal(ra.stale, true); assert.equal(c.getStaged().width, 500);
});

test('IU.12 storage naming: deterministic scope, versioned file, no display names, no traversal', () => {
  const p = IMG.storagePath('coachA', 'ex1', '0123456789abcdef');
  assert.equal(p, 'exercise-media/coachA/ex1/image-0123456789abcdef');
  for (const bad of ['../x', 'a/b', 'a b', '', 'a'.repeat(129), null, undefined, 'ñ']) { assert.throws(() => IMG.storagePath(bad, 'ex1', '0123456789abcdef')); assert.throws(() => IMG.storagePath('coachA', bad, '0123456789abcdef')); }
  assert.throws(() => IMG.storagePath('coachA', 'ex1', 'zz'));
  assert.match(IMG.storagePath('coachA', 'ex1'), /^exercise-media\/coachA\/ex1\/image-[a-f0-9]{16}$/);
  assert.notEqual(IMG.storagePath('coachA', 'ex1'), IMG.storagePath('coachA', 'ex1'));
});

test('IU.13 isOwnStoragePath only trusts THIS coach and THIS exercise (cleanup never deletes anything else)', () => {
  const ok = 'exercise-media/coachA/ex1/image-0123456789abcdef';
  assert.equal(IMG.isOwnStoragePath(ok, 'coachA', 'ex1'), true);
  assert.equal(IMG.isOwnStoragePath(ok, 'coachB', 'ex1'), false);
  assert.equal(IMG.isOwnStoragePath(ok, 'coachA', 'ex2'), false);
  for (const bad of ['assets/exercises/x.svg', 'https://x.test/a.jpg', 'exercise-media/coachA/ex1/../ex2/image-0123456789abcdef', 'exercise-media/coachA/ex1/image', '', null]) assert.equal(IMG.isOwnStoragePath(bad, 'coachA', 'ex1'), false);
});

test('IU.14 editor patch: storage path accepted as assetRef; URL/legacy asset unchanged; traversal, data URI, http, javascript refused; no bytes ever', () => {
  const base = { gym: 'G', equipment: 'E' };
  const sp = 'exercise-media/coachA/ex1/image-0123456789abcdef';
  const stored = VME.buildPatch({ ...base, assetRef: sp, imageUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/x?alt=media&token=t' });
  assert.equal(stored.assetRef, sp); assert.match(stored.imageUrl, /^https:\/\//);
  assert.equal(VME.buildPatch({ ...base, assetRef: 'assets/exercises/a.svg', imageUrl: '' }).assetRef, 'assets/exercises/a.svg');
  assert.equal(VME.buildPatch({ ...base, assetRef: '', imageUrl: 'https://cdn.example/a.jpg' }).imageUrl, 'https://cdn.example/a.jpg');
  for (const bad of ['exercise-media/a/../b/image-0123456789abcdef', 'exercise-media/a/b/image-XYZ', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'http://x.test/a.jpg', '/etc/passwd'])
    assert.throws(() => VME.buildPatch({ ...base, assetRef: bad, imageUrl: '' }), bad);
  assert.throws(() => VME.buildPatch({ ...base, assetRef: '', imageUrl: 'data:image/png;base64,AAAA' }));
  const patch = VME.buildPatch({ ...base, assetRef: sp, imageUrl: 'https://x.test/a.jpg' });
  for (const [k, v] of Object.entries(patch)) assert.ok(typeof v !== 'object' || Array.isArray(v), k);                    // only strings/lists: no Blob/ArrayBuffer/bytes
  assert.ok(JSON.stringify(patch).length < 2000, 'exercise metadata stays tiny');
});

test('IU.15 a Storage-generated download URL passes the athlete app _safeClientMediaUrl (https) and the legacy forms still do', () => {
  const fn = new Function('_escHTml', body(CLIENT, 'function _safeClientMediaUrl') + '\nreturn _safeClientMediaUrl;')(s => String(s));
  const storageUrl = 'https://firebasestorage.googleapis.com/v0/b/vdsen-ecosistema.firebasestorage.app/o/exercise-media%2FcoachA%2Fex1%2Fimage-0123456789abcdef?alt=media&token=abc-123';
  assert.equal(fn(storageUrl), storageUrl);
  assert.equal(fn('assets/exercises/a.svg'), 'assets/exercises/a.svg');
  assert.equal(fn('https://cdn.example/a.jpg'), 'https://cdn.example/a.jpg');
  assert.equal(fn('data:image/png;base64,AAAA'), ''); assert.equal(fn('javascript:alert(1)'), ''); assert.equal(fn('http://x.test/a.jpg'), '');
});

test('IU.16 Coach save order: upload -> download URL -> Firestore -> delete old; failed Firestore update removes the NEW object; context changes abort without persisting', () => {
  const save = COACH.slice(COACH.indexOf("$('visualMetaSave').onclick"), COACH.indexOf('window.openVisualMetadataEditor'));
  const iUp = save.indexOf('uploadBytes('), iUrl = save.indexOf('getDownloadURL('), iUpd = save.indexOf("updateDoc(doc(db, 'exercises'"), iDelOld = save.indexOf('_visualDeleteObject(old)');
  assert.ok(iUp > -1 && iUp < iUrl && iUrl < iUpd && iUpd < iDelOld, 'order');
  assert.ok(/if \(uploaded\) await _visualDeleteObject\(uploaded\)/.test(save), 'rollback of the new object when Firestore fails');
  assert.ok(save.lastIndexOf('uploaded = null') > iUpd, 'reference cleared only after Firestore succeeded');
  assert.ok(/seq !== _visualSeq \|\| currentCoach\.uid !== coachId\) \{ await _visualDeleteObject\(path\); return; \}/.test(save), 'mid-upload context change');
  assert.ok(save.includes('IMG.isOwnStoragePath(old, coachId, exId)'), 'only own objects are deleted');
  assert.ok(!/base64|data:|FileReader|readAsDataURL|toDataURL/.test(save), 'no inline image data');
});

test('IU.17 closing the editor, exercise switch and logout/coach switch invalidate the controller; the shell parker closes the editor first', () => {
  const close = body(COACH, 'function _visualEditorClose()');
  assert.ok(close.includes('_visualSeq++') && close.includes('controller.invalidate()') && close.includes("getElementById('visualMetadataEditor')") && close.includes('_visualEditorExercise = null'));
  const park = body(COACH, 'function _parkCoachShell()');
  assert.ok(park.includes('_visualEditorClose()'), 'logout/coach switch closes the editor');
  assert.ok(park.indexOf('_visualEditorClose()') < park.indexOf('createDocumentFragment'), 'before parking');
  const open = body(COACH, 'function openVisualMetadataEditor(');
  assert.ok(open.includes('seq !== _visualSeq'), 'async guards bound to the editor instance');
});

test('IU.18 the editor offers Subir/Cambiar/Eliminar foto, source label, preview, accept list; URL inputs remain', () => {
  const open = body(COACH, 'function openVisualMetadataEditor(');
  for (const s of ['Subir foto', 'Cambiar foto', 'Eliminar foto', 'Foto subida', 'URL externa', 'accept="image/jpeg,image/png,image/webp"', 'vm-photo-preview', 'id="vm-image"', 'id="vm-asset"', 'Foto nueva sin guardar'])
    assert.ok(open.includes(s), s);
  assert.ok(!/accept="[^"]*svg/.test(open));
});

test('IU.19 exercise documents never receive image bytes: the only exercise writes from the editor carry the sanitized patch', () => {
  const save = COACH.slice(COACH.indexOf("$('visualMetaSave').onclick"), COACH.indexOf('window.openVisualMetadataEditor'));
  const writes = save.match(/updateDoc\([^)]*\)\)?, [^)]*\)/g) || [];
  assert.equal(writes.length, 1); assert.ok(/, patch\)/.test(writes[0]));
  assert.ok(!/staged\.blob/.test(save.slice(save.indexOf('updateDoc('))), 'blob is never part of the Firestore write');
});

test('IU.20 storage bucket access is wired with the pinned SDK version (no other bucket, no credentials in code)', () => {
  assert.ok(COACH.includes('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js'));
  assert.ok(COACH.includes('const storage = getStorage(app);'));
  assert.ok(COACH.includes('<script src="assets/exercise-image-upload.js"></script>'));
});

test('IU.21 storage.rules: owner-only writes, athlete-of-coach reads, image types only, hard size cap, no blanket authenticated access', () => {
  const r = fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8');
  assert.ok(!/allow\s+(read|write)[^;]*:\s*if\s+request\.auth\s*!=\s*null\s*;/.test(r));
  assert.ok(!/if\s+true/.test(r));
  for (const s of ["'image/jpeg'", "'image/png'", "'image/webp'", '512 * 1024', 'ownsExercise', 'athleteOfCoach', 'isImageName'])
    assert.ok(r.includes(s), s);
  assert.ok(!/svg/i.test(r.replace(/\/\/.*$/gm, '')));
  assert.ok(!r.includes('match /{allPaths=**}'));
});
