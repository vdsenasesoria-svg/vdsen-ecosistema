#!/usr/bin/env node
'use strict';
// LOCAL browser E2E for the Coach direct photo upload (Firebase Storage): REAL Coach UI (vdsen-coach.html from the working tree), Auth + Firestore (firestore.rules)
// + Cloud STORAGE emulators (storage.rules). Synthetic images only; no internet, no production/staging contact, no bucket/rules deployment.
//   NODE_PATH=$(npm root -g) node scripts/coach-image-upload-e2e.cjs [--out results.json]
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const L = require('./storage-emulator-lib.cjs');
const repo = L.repo;
const argi = process.argv.indexOf('--out'); const outFile = argi > 0 ? process.argv[argi + 1] : null;
const COACH_FILE = process.env.COACH_HTML || path.join(repo, 'vdsen-coach.html');
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

async function main() {
  let pw; try { pw = require('playwright'); } catch (e) { console.log('BROWSER_E2E_BLOCKED_NO_RUNTIME (set NODE_PATH=$(npm root -g))'); return 2; }
  const B = require('./client-browser-lib.cjs');
  const fx = require('../tests/helpers/client-export-fixture.js');
  L.installPackages();
  const ports = await L.startStack();
  const assets = L.buildStaticAssets();
  const runtime = L.runtime;
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + ports.fs; process.env.GCLOUD_PROJECT = L.PROJECT; process.env.METADATA_SERVER_DETECTION = 'none';
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_AUTH_EMULATOR_HOST']) delete process.env[k];
  const req = require('node:module').createRequire(path.join(runtime, 'noop.js'));
  const { initializeApp: initAdmin } = req('firebase-admin/app'), { getFirestore: adminFs } = req('firebase-admin/firestore');
  console.log('[e2e] project=' + L.PROJECT + ' firestore=' + ports.fs + ' auth=' + ports.auth + ' storage=' + ports.storage);

  const PASS = 'E2e-pass-123', emailA = 'coach-a@e2e.invalid', emailB = 'coach-b@e2e.invalid';
  const uidA = await L.signUp(ports.auth, emailA, PASS), uidB = await L.signUp(ports.auth, emailB, PASS);
  const base = fx.build();
  base.exercises = {
    EXA: { coachId: 'coachA', name: 'EJ_A_FOTO', motorPattern: 'push', muscleType: 'chest', equipment: 'barbell', fatigueCost: 3, resistanceCurve: 'flat' },
    EXA2: { coachId: 'coachA', name: 'EJ_A_SEGUNDO', motorPattern: 'pull', muscleType: 'back', equipment: 'cable', fatigueCost: 2, resistanceCurve: 'flat' },
    EXAURL: { coachId: 'coachA', name: 'EJ_A_URL_LEGADO', motorPattern: 'push', muscleType: 'chest', equipment: 'barbell', fatigueCost: 2, resistanceCurve: 'flat', imageUrl: 'https://cdn.example.test/legacy.jpg' },
    EXB: { coachId: 'coachB', name: 'EJ_B_UNICO', motorPattern: 'push', muscleType: 'chest', equipment: 'barbell', fatigueCost: 3, resistanceCurve: 'flat' }
  };
  const seeded = JSON.parse(JSON.stringify(base).replace(/coachA/g, uidA).replace(/coachB/g, uidB));
  const adb = adminFs(initAdmin({ projectId: L.PROJECT }, 'e2e-seed'));
  for (const col of Object.keys(seeded)) for (const id of Object.keys(seeded[col])) await adb.doc(col + '/' + id).set(seeded[col][id]);
  const exDoc = async id => (await adb.doc('exercises/' + id).get()).data();
  const OWNER = { headers: { authorization: 'Bearer owner' } };   // emulator admin bypass: test-side inspection only (the rules deny LIST to everyone)
  const listObjects = async prefix => { const r = await fetch('http://127.0.0.1:' + ports.storage + '/v0/b/' + L.BUCKET + '/o?prefix=' + encodeURIComponent(prefix), OWNER); const j = await r.json(); if (process.env.E2E_DEBUG) console.log('LIST', prefix, JSON.stringify(j).slice(0, 300)); return j.items || []; };
  const objectsOf = async (uid, ex) => listObjects('exercise-media/' + uid + '/' + ex + '/');
  const objMeta = async (name) => (await (await fetch('http://127.0.0.1:' + ports.storage + '/v0/b/' + L.BUCKET + '/o/' + encodeURIComponent(name), OWNER)).json());

  const browser = await B.launch();
  // ---- synthetic source images (generated in a clean page, written to temp files) ----
  const gen = await (await browser.newContext()).newPage();
  const mk = (mime, w, h, alpha, noise) => gen.evaluate(async ({ mime, w, h, alpha, noise }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#2a6'); g.addColorStop(1, '#a24'); if (!alpha) { x.fillStyle = g; x.fillRect(0, 0, w, h); }
    x.fillStyle = '#fc0'; for (let i = 0; i < 40; i++) { x.beginPath(); x.arc((i * 137) % w, (i * 89) % h, 60 + (i % 7) * 20, 0, 6.3); x.fill(); }
    if (noise) { const d = x.getImageData(0, 0, w, h), a = d.data; for (let i = 0; i < a.length; i += 4) { const n = (Math.random() * 60) | 0; a[i] ^= n; a[i + 1] ^= n; a[i + 2] ^= n; } x.putImageData(d, 0, 0); }
    const blob = await new Promise(r => c.toBlob(r, mime, 0.95)); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s);
  }, { mime, w, h, alpha, noise });
  const tmp = path.join(runtime, 'src'); fs.mkdirSync(tmp, { recursive: true });
  const save = async (name, b64) => { const f = path.join(tmp, name); fs.writeFileSync(f, Buffer.from(b64, 'base64')); return f; };
  const F = {
    jpeg: await save('foto.jpg', await mk('image/jpeg', 3600, 2400, false, true)),
    jpeg2: await save('foto2.jpg', await mk('image/jpeg', 1200, 900, false, false)),
    png: await save('logo.png', await mk('image/png', 1000, 800, true, false)),
    webp: await save('foto.webp', await mk('image/webp', 1400, 1000, false, false)),
    svg: path.join(tmp, 'x.svg'), fakejpg: path.join(tmp, 'svg-as.jpg'), big: path.join(tmp, 'big.jpg'), corrupt: path.join(tmp, 'corrupt.png')
  };
  fs.writeFileSync(F.svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  fs.writeFileSync(F.fakejpg, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  fs.writeFileSync(F.big, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16 * 1024 * 1024, 1)]));
  fs.writeFileSync(F.corrupt, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png')]));
  console.log('[e2e] source sizes: jpeg=' + fs.statSync(F.jpeg).size + ' png=' + fs.statSync(F.png).size + ' webp=' + fs.statSync(F.webp).size);
  await gen.context().close();

  const appServer = http.createServer((rq, rs) => {
    const u = decodeURIComponent(new URL(rq.url, 'http://x').pathname), f = (u === '/' || u === '/vdsen-coach.html') ? COACH_FILE : path.join(repo, u);
    if ((f !== COACH_FILE && !f.startsWith(repo)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { rs.writeHead(404); return rs.end(); }
    let body = fs.readFileSync(f); if (f === COACH_FILE) body = Buffer.from(L.patchHtml(body.toString('utf8'), ports, assets.css));
    rs.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(body);
  });
  await new Promise(r => appServer.listen(0, '127.0.0.1', r)); const APP = 'http://127.0.0.1:' + appServer.address().port;
  const blocked = [], nonLocal = [], storageHits = [];
  async function newPage(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w || 1280, height: h || 800 }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { window.__blobs = { created: [], revoked: [] }; const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL); URL.createObjectURL = o => { const u = c(o); window.__blobs.created.push(u); return u; }; URL.revokeObjectURL = u => { window.__blobs.revoked.push(u); return r(u); }; });
    await ctx.route(u => u.protocol !== 'http:' || u.hostname !== '127.0.0.1', async route => {
      const url = route.request().url(); if (/^data:|^blob:/.test(url)) return route.continue();
      const l = assets.local(url); if (l) return route.fulfill({ status: 200, contentType: l.contentType, headers: { 'access-control-allow-origin': '*' }, body: l.body });
      if (new URL(url).hostname === L.FAKE_STORAGE_HOST) {   // Storage-generated https download URL -> served by the Storage emulator
        const u = new URL(url); storageHits.push(u.pathname); const res = await fetch('http://127.0.0.1:' + ports.storage + u.pathname + u.search);
        return route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' }, body: Buffer.from(await res.arrayBuffer()) });
      }
      blocked.push(url); return route.abort();
    });
    const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('request', r => { const u = r.url(); if (r.method() !== 'GET' && !/^http:\/\/127\.0\.0\.1:/.test(u)) nonLocal.push(r.method() + ' ' + u); });
    p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    return { ctx, p };
  }
  const LIST = '#clientList button[onclick*="showClientDetail"]';
  const loginUi = async (p, email) => { await p.fill('#loginEmail', email); await p.fill('#loginPass', PASS); await p.click('#loginBtn'); await p.waitForSelector(LIST, { timeout: 30000, state: 'attached' }); };
  const logoutUi = async p => { await p.evaluate(() => window._vdsenSignOut()); await p.waitForSelector('#loginEmail'); };
  const openCatalog = async p => { await p.evaluate(() => window.showSection('catalogo')); await p.waitForFunction(() => /EJ_/.test(document.getElementById('exerciseCatalog').textContent), null, { timeout: 30000 }); };
  const openEditor = async (p, name) => {
    await openCatalog(p);
    await p.evaluate(n => { const row = [...document.querySelectorAll('#exerciseCatalog > *')].find(r => r.textContent.includes(n) && [...r.querySelectorAll('button')].some(b => b.textContent === 'Visual')); [...row.querySelectorAll('button')].find(b => b.textContent === 'Visual').click(); }, name);
    await p.waitForSelector('#visualMetadataEditor');
  };
  const photoState = p => p.evaluate(() => ({ source: document.getElementById('vm-photo-source').textContent, status: document.getElementById('vm-photo-status').textContent, pick: document.getElementById('vm-photo-pick').textContent, removeShown: document.getElementById('vm-photo-remove').style.display !== 'none', cancelShown: document.getElementById('vm-photo-cancel').style.display !== 'none', previewShown: document.getElementById('vm-photo-preview').style.display !== 'none', previewSrc: document.getElementById('vm-photo-preview').getAttribute('src') || '', saveDisabled: document.getElementById('visualMetaSave').disabled, assetDisabled: document.getElementById('vm-asset').disabled, imageDisabled: document.getElementById('vm-image').disabled }));
  const choose = async (p, file) => { await p.setInputFiles('#vm-photo-file', file); };
  const waitStatus = (p, re) => p.waitForFunction(r => new RegExp(r).test(document.getElementById('vm-photo-status').textContent), re.source, { timeout: 30000 });
  const saveEditor = async p => { await p.click('#visualMetaSave'); await p.waitForSelector('#visualMetadataEditor', { state: 'detached', timeout: 30000 }); await p.waitForTimeout(500); };
  const previewLoads = p => p.evaluate(async () => { const i = document.getElementById('vm-photo-preview'); if (!i.getAttribute('src')) return null; if (!i.complete) await new Promise(r => { i.onload = r; i.onerror = r; }); return { w: i.naturalWidth, h: i.naturalHeight }; });
  const REF = new RegExp('^exercise-media/' + uidA + '/EXA/image-[a-f0-9]{16}$');
  // Markup scans ignore <script> source text (it legitimately names these ids); only live DOM nodes count.
  const fullDom = p => p.evaluate(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll('script,style').forEach(x => x.remove()); return c.outerHTML; });
  const stashDom = p => p.evaluate(() => { const s = window._vdsenShellStash; if (!s) return ''; const d = document.createElement('div'); d.appendChild(s.cloneNode(true)); d.querySelectorAll('script,style').forEach(x => x.remove()); return d.innerHTML; });
  const blobsOutstanding = p => p.evaluate(() => window.__blobs.created.filter(u => !window.__blobs.revoked.includes(u)));

  try {
    // ======================= desktop session: Coach A =======================
    const { ctx, p } = await newPage();
    await p.goto(APP + '/vdsen-coach.html'); await p.waitForSelector('#loginEmail');
    await loginUi(p, emailA);
    await openEditor(p, 'EJ_A_FOTO');
    let s = await photoState(p);
    check('E01_EDITOR_OPENS_FROM_CATALOGO_NO_PHOTO', /Sin foto/.test(s.source) && s.pick === 'Subir foto' && !s.removeShown && !s.previewShown, JSON.stringify(s));
    const acc = await p.getAttribute('#vm-photo-file', 'accept');
    check('E02_FILE_INPUT_ACCEPTS_JPEG_PNG_WEBP_ONLY', acc === 'image/jpeg,image/png,image/webp', acc);

    // ---- JPEG: process -> preview -> nothing persisted before Save ----
    await choose(p, F.jpeg); await waitStatus(p, /Foto lista/);
    s = await photoState(p); const pv = await previewLoads(p);
    check('E03_JPEG_PROCESSED_PREVIEW_SHOWN', s.previewShown && /^blob:/.test(s.previewSrc) && pv && pv.w > 0 && Math.max(pv.w, pv.h) <= 1600 && pv.w / pv.h > 1.4 && pv.w / pv.h < 1.6, JSON.stringify(pv));
    check('E04_SELECTION_DOES_NOT_MUTATE_FIRESTORE_OR_STORAGE', !(await exDoc('EXA')).imageUrl && !(await exDoc('EXA')).assetRef && (await objectsOf(uidA, 'EXA')).length === 0);
    check('E05_STAGED_PHOTO_LABELLED_UNSAVED', /Foto nueva sin guardar/.test(s.source) && s.cancelShown && s.pick === 'Cambiar foto');
    await saveEditor(p);
    let d = await exDoc('EXA'), objs = await objectsOf(uidA, 'EXA');
    check('E06_SAVE_UPLOADS_AND_PERSISTS_REF_AND_URL', REF.test(d.assetRef || '') && new RegExp('^https://' + L.FAKE_STORAGE_HOST + '/').test(d.imageUrl || '') && objs.length === 1 && decodeURIComponent(objs[0].name) === d.assetRef, JSON.stringify({ assetRef: d.assetRef, n: objs.length, name: objs[0] && objs[0].name }));
    let meta = await objMeta(d.assetRef);
    check('E07_STORED_OBJECT_IS_PROCESSED_JPEG_UNDER_CAP', meta.contentType === 'image/jpeg' && Number(meta.size) <= 480 * 1024 && Number(meta.size) > 1000, JSON.stringify({ type: meta.contentType, size: meta.size }));
    const jpegRef1 = d.assetRef;
    check('E08_FIRESTORE_HAS_ONLY_URL_AND_REFERENCE_NO_BYTES', (() => { const all = JSON.stringify(d); return !/data:|base64/i.test(all) && all.length < 3000 && typeof d.imageUrl === 'string' && typeof d.assetRef === 'string'; })(), 'doc bytes=' + JSON.stringify(d).length);
    await openEditor(p, 'EJ_A_FOTO'); s = await photoState(p);
    const pv2 = await previewLoads(p);
    check('E09_REOPEN_SHOWS_UPLOADED_PHOTO_RENDERS', /Foto subida/.test(s.source) && s.pick === 'Cambiar foto' && s.removeShown && pv2 && pv2.w > 0 && s.assetDisabled && s.imageDisabled && storageHits.some(h => h.includes('image-')), JSON.stringify({ s: s.source, pv2 }));

    // ---- Cambiar foto (PNG with transparency) ----
    await choose(p, F.png); await waitStatus(p, /Foto lista/);
    await saveEditor(p);
    d = await exDoc('EXA'); objs = await objectsOf(uidA, 'EXA'); meta = await objMeta(d.assetRef);
    check('E10_CHANGE_PHOTO_NEW_VERSION_PERSISTED_OLD_OBJECT_REMOVED', REF.test(d.assetRef) && d.assetRef !== jpegRef1 && objs.length === 1 && decodeURIComponent(objs[0].name) === d.assetRef, JSON.stringify({ n: objs.length, old: jpegRef1.split('/').pop(), now: d.assetRef.split('/').pop() }));
    check('E11_PNG_WITH_ALPHA_STORED_AS_WEBP', meta.contentType === 'image/webp' && Number(meta.size) <= 480 * 1024, meta.contentType + ' ' + meta.size);

    // ---- WebP source ----
    await openEditor(p, 'EJ_A_FOTO'); await choose(p, F.webp); await waitStatus(p, /Foto lista/); await saveEditor(p);
    d = await exDoc('EXA'); objs = await objectsOf(uidA, 'EXA'); meta = await objMeta(d.assetRef);
    check('E12_WEBP_SOURCE_ACCEPTED_AND_STORED', REF.test(d.assetRef) && objs.length === 1 && /^image\/(jpeg|webp)$/.test(meta.contentType) && Number(meta.size) <= 480 * 1024, meta.contentType + ' ' + meta.size);

    // ---- rejections ----
    await openEditor(p, 'EJ_A_FOTO'); const refBefore = (await exDoc('EXA')).assetRef;
    await choose(p, F.svg); await p.waitForTimeout(400); s = await photoState(p);
    check('E13_SVG_REJECTED_NO_PREVIEW', /Formato no admitido/.test(s.status) && !/^blob:/.test(s.previewSrc) && !s.cancelShown, s.status);
    await choose(p, F.fakejpg); await p.waitForTimeout(400); s = await photoState(p);
    check('E14_RENAMED_SVG_AS_JPG_REJECTED', /No se pudo procesar esta imagen\./.test(s.status) && !/^blob:/.test(s.previewSrc), s.status);
    await choose(p, F.corrupt); await p.waitForTimeout(600); s = await photoState(p);
    check('E15_CORRUPT_IMAGE_GENERIC_MESSAGE_NO_STACK', /No se pudo procesar esta imagen\./.test(s.status) && !/Error|at |stack/i.test(s.status), s.status);
    await choose(p, F.big); await p.waitForTimeout(600); s = await photoState(p);
    check('E16_OVERSIZED_SOURCE_REJECTED_WITH_MESSAGE', s.status === 'La imagen es demasiado grande. Intenta con otra foto.' && !/^blob:/.test(s.previewSrc), s.status);
    await p.click('#visualMetaSave'); await p.waitForSelector('#visualMetadataEditor', { state: 'detached' }); await p.waitForTimeout(400);
    check('E17_SAVING_AFTER_REJECTION_CHANGES_NOTHING', (await exDoc('EXA')).assetRef === refBefore && (await objectsOf(uidA, 'EXA')).length === 1);

    // ---- cancel paths ----
    await openEditor(p, 'EJ_A_FOTO'); await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/);
    await p.click('#vm-photo-cancel'); s = await photoState(p);
    check('E18_DISCARD_SELECTION_CLEARS_PREVIEW_NO_WRITE', !/^blob:/.test(s.previewSrc) && !s.cancelShown && (await exDoc('EXA')).assetRef === refBefore && (await objectsOf(uidA, 'EXA')).length === 1);
    await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/); await p.click('#visualMetaClose');
    check('E19_CLOSE_WITH_STAGED_PHOTO_DISCARDS_EVERYTHING', !(await p.$('#visualMetadataEditor')) && (await exDoc('EXA')).assetRef === refBefore && (await objectsOf(uidA, 'EXA')).length === 1 && (await blobsOutstanding(p)).length === 0, JSON.stringify(await blobsOutstanding(p)));

    // ---- exercise switch: nothing staged for A leaks to A2 ----
    await openEditor(p, 'EJ_A_FOTO'); await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/);
    await p.click('#visualMetaClose'); await openEditor(p, 'EJ_A_SEGUNDO'); s = await photoState(p);
    check('E20_EXERCISE_SWITCH_HAS_NO_STAGED_PHOTO', /Sin foto/.test(s.source) && !s.previewShown && !s.cancelShown);
    await p.click('#visualMetaSave'); await p.waitForSelector('#visualMetadataEditor', { state: 'detached' }); await p.waitForTimeout(400);
    check('E21_SAVE_OF_OTHER_EXERCISE_UPLOADS_NOTHING', (await objectsOf(uidA, 'EXA2')).length === 0 && !(await exDoc('EXA2')).assetRef && (await objectsOf(uidA, 'EXA')).length === 1);

    // ---- stale async: close right after choosing (decode of a large file still running) ----
    await openEditor(p, 'EJ_A_FOTO'); await choose(p, F.jpeg); await p.click('#visualMetaClose'); await p.waitForTimeout(2500);
    check('E22_LATE_RESULT_AFTER_CLOSE_LEAVES_NO_EDITOR_PREVIEW_OR_BLOB', !(await p.$('#visualMetadataEditor')) && (await blobsOutstanding(p)).length === 0 && (await p.$$('[src^="blob:"]')).length === 0);

    // ---- legacy URL image keeps working ----
    await openEditor(p, 'EJ_A_URL_LEGADO'); s = await photoState(p);
    check('E23_LEGACY_URL_LABELLED_EXTERNAL_AND_EDITABLE', /URL externa/.test(s.source) && !s.assetDisabled && !s.imageDisabled && (await p.inputValue('#vm-image')) === 'https://cdn.example.test/legacy.jpg');
    await p.click('#visualMetaSave'); await p.waitForSelector('#visualMetadataEditor', { state: 'detached' }); await p.waitForTimeout(400);
    check('E24_LEGACY_URL_UNCHANGED_BY_SAVE_AND_NO_STORAGE_WRITE', (await exDoc('EXAURL')).imageUrl === 'https://cdn.example.test/legacy.jpg' && !(await exDoc('EXAURL')).assetRef && (await objectsOf(uidA, 'EXAURL')).length === 0);
    // replace a URL photo with an upload: legacy URL is overwritten, nothing deleted from outside Storage
    await openEditor(p, 'EJ_A_URL_LEGADO'); await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/); await saveEditor(p);
    d = await exDoc('EXAURL');
    check('E25_UPLOAD_REPLACES_LEGACY_URL', new RegExp('^exercise-media/' + uidA + '/EXAURL/image-[a-f0-9]{16}$').test(d.assetRef) && d.imageUrl.startsWith('https://' + L.FAKE_STORAGE_HOST + '/'), JSON.stringify(d));

    // ---- Eliminar foto ----
    await openEditor(p, 'EJ_A_FOTO'); await p.click('#vm-photo-remove'); s = await photoState(p);
    check('E26_REMOVE_MARKS_PENDING_NOTHING_DELETED_YET', /se eliminará al guardar/.test(s.source) && (await objectsOf(uidA, 'EXA')).length === 1 && !!(await exDoc('EXA')).assetRef);
    await saveEditor(p); d = await exDoc('EXA');
    check('E27_REMOVE_CLEARS_FIELDS_AND_DELETES_OBJECT', !d.assetRef && !d.imageUrl && (await objectsOf(uidA, 'EXA')).length === 0, JSON.stringify({ a: d.assetRef, i: d.imageUrl }));
    await openEditor(p, 'EJ_A_FOTO'); s = await photoState(p);
    check('E28_REOPEN_AFTER_REMOVE_SHOWS_NO_PHOTO', /Sin foto/.test(s.source) && !s.previewShown && s.pick === 'Subir foto');
    // remove then change your mind
    await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/); await p.click('#visualMetaClose');

    // ---- Coach A: stage a photo, then log out ----
    await openEditor(p, 'EJ_A_FOTO'); await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/);
    const before = await objectsOf(uidA, 'EXA');
    await logoutUi(p);
    const full = await fullDom(p), stash = await stashDom(p);
    check('E29_LOGOUT_REMOVES_EDITOR_PREVIEW_AND_BLOBS_EVERYWHERE', !full.includes('visualMetadataEditor') && !stash.includes('visualMetadataEditor') && !/src="blob:/.test(full + stash) && !/EJ_A_FOTO|vm-photo/.test(full + stash) && (await blobsOutstanding(p)).length === 0, JSON.stringify({ editor: full.includes('visualMetadataEditor') || stash.includes('visualMetadataEditor'), blob: /src="blob:/.test(full + stash), name: /EJ_A_FOTO/.test(full + stash), vm: (full + stash).match(/.{60}vm-photo.{40}/) }));
    check('E30_LOGOUT_UPLOADS_NOTHING', (await objectsOf(uidA, 'EXA')).length === before.length && !(await exDoc('EXA')).assetRef);

    // ---- Coach B on the same page ----
    await loginUi(p, emailB);
    await openCatalog(p).catch(() => {});
    const domB = await fullDom(p);
    check('E31_COACH_B_SEES_NO_COACH_A_EDITOR_OR_EXERCISES', !domB.includes('EJ_A_') && !/vm-photo-preview" [^>]*src="blob:/.test(domB) && !(await p.$('#visualMetadataEditor')));
    await openEditor(p, 'EJ_B_UNICO'); s = await photoState(p);
    check('E32_COACH_B_EDITOR_STARTS_CLEAN', /Sin foto/.test(s.source) && !s.previewShown && !s.cancelShown);
    await choose(p, F.jpeg2); await waitStatus(p, /Foto lista/); await saveEditor(p);
    d = await exDoc('EXB');
    check('E33_COACH_B_UPLOAD_LANDS_UNDER_OWN_SCOPE_ONLY', new RegExp('^exercise-media/' + uidB + '/EXB/image-[a-f0-9]{16}$').test(d.assetRef) && (await objectsOf(uidB, 'EXB')).length === 1 && (await objectsOf(uidA, 'EXA')).length === 0 && (await objectsOf(uidA, 'EXA2')).length === 0);
    // A -> B -> A: A's data untouched
    await logoutUi(p); await loginUi(p, emailA);
    check('E34_COACH_A_RELOGIN_STATE_CLEAN', !(await p.$('#visualMetadataEditor')) && !(await fullDom(p)).includes('EJ_B_UNICO') && (await blobsOutstanding(p)).length === 0);
    check('E35_NO_PAGE_ERRORS_DESKTOP', p.errors.length === 0, p.errors.slice(0, 3).join(' | '));
    await ctx.close();

    // ======================= mobile viewport =======================
    const m = await newPage(390, 844);
    await m.p.goto(APP + '/vdsen-coach.html'); await m.p.waitForSelector('#loginEmail'); await loginUi(m.p, emailA);
    await m.p.evaluate(() => window.showSection('catalogo')).catch(() => {});
    await m.p.waitForFunction(() => /EJ_/.test(document.getElementById('exerciseCatalog').textContent), null, { timeout: 30000 });
    await m.p.evaluate(() => { const row = [...document.querySelectorAll('#exerciseCatalog > *')].find(r => r.textContent.includes('EJ_A_SEGUNDO') && [...r.querySelectorAll('button')].some(b => b.textContent === 'Visual')); [...row.querySelectorAll('button')].find(b => b.textContent === 'Visual').click(); });
    await m.p.waitForSelector('#visualMetadataEditor');
    await choose(m.p, F.jpeg); await waitStatus(m.p, /Foto lista/);
    const lay = await m.p.evaluate(() => { const box = document.querySelector('#visualMetadataEditor > div').getBoundingClientRect(), pr = document.getElementById('vm-photo-preview').getBoundingClientRect(); return { vw: window.innerWidth, sw: document.documentElement.scrollWidth, boxRight: Math.round(box.right), prRight: Math.round(pr.right), prW: Math.round(pr.width) }; });
    check('E36_MOBILE_EDITOR_FITS_VIEWPORT_NO_HORIZONTAL_SCROLL', lay.sw <= lay.vw && lay.boxRight <= lay.vw && lay.prRight <= lay.vw && lay.prW > 100, JSON.stringify(lay));
    await m.p.screenshot({ path: path.join(runtime, 'mobile.png') });
    await saveEditor(m.p);
    d = await exDoc('EXA2');
    check('E37_MOBILE_UPLOAD_PERSISTED', new RegExp('^exercise-media/' + uidA + '/EXA2/image-[a-f0-9]{16}$').test(d.assetRef || '') && (await objectsOf(uidA, 'EXA2')).length === 1);
    check('E38_NO_PAGE_ERRORS_MOBILE', m.p.errors.length === 0, m.p.errors.slice(0, 3).join(' | '));
    await m.ctx.close();

    // ======================= global invariants =======================
    const allEx = (await adb.collection('exercises').get()).docs.map(x => x.data());
    check('E39_NO_EXERCISE_DOC_HOLDS_IMAGE_BYTES', allEx.every(x => !/data:|base64,/i.test(JSON.stringify(x)) && JSON.stringify(x).length < 4000 && Object.values(x).every(v => typeof v !== 'object' || v === null || Array.isArray(v) || v.constructor === Object)));
    check('E40_NO_NON_LOCAL_WRITE_REQUESTS', nonLocal.length === 0, nonLocal.slice(0, 3).join(' | '));
    check('E41_NO_UNEXPECTED_EXTERNAL_HOSTS', blocked.every(u => /cdn\.example\.test/.test(u)), blocked.filter(u => !/cdn\.example\.test/.test(u)).slice(0, 4).join(' | '));
    const orphans = [uidA, uidB].length && (await listObjects('exercise-media/')).map(o => o.name);
    console.log('[e2e] remaining objects: ' + orphans.length);
    check('E42_NO_ORPHANED_OBJECTS_REMAIN', orphans.length === 3, JSON.stringify(orphans));   // EXAURL (upload over legacy URL) + EXA2 (mobile) + EXB
  } catch (e) { console.error(e); check('E00_UNEXPECTED_ERROR', false, String(e && e.message).slice(0, 300)); }
  await browser.close(); appServer.close();
  const failed = results.filter(r => !r.pass).length;
  console.log('\nBROWSER E2E: ' + (results.length - failed) + '/' + results.length + ' passed');
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  return failed ? 1 : 0;
}
main().then(async c => { await L.cleanup(); process.exit(c); }, async e => { console.error(e); await L.cleanup(); process.exit(1); });
