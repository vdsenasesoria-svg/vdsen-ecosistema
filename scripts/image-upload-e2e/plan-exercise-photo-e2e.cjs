#!/usr/bin/env node
'use strict';
// VDSEN Coach 3.0 — Real Chromium + Local Firebase Emulator (Auth, Firestore, Storage) E2E
// accrediting the full active-plan exercise photo workflow from Coach (`vdsen-coach.html`)
// through Client visualization (`vdsen-cliente.html`).
//
// Usage:
//   node scripts/image-upload-e2e/plan-exercise-photo-e2e.cjs [--screenshots-dir <dir>] [--keep-runtime]
//
// Never modifies package.json or any product source file on disk: all HTML/Firebase rewrites
// happen strictly in memory on the ephemeral localhost harness server against `demo-*` emulators.

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-vdsen-image-upload';
const AUTH_HOST = '127.0.0.1:9099';
const FS_HOST = '127.0.0.1';
const FS_PORT = 8080;
const ST_HOST = '127.0.0.1';
const ST_PORT = 9199;
const PASSWORD = 'local-plan-photo-e2e-1';

const FIREBASE_SDK = '10.12.0';
const FIREBASE_TOOLS = '15.32.1';
const PLAYWRIGHT = '1.63.0';

function getArg(name, fallback) {
  const idx = process.argv.indexOf('--' + name);
  return idx > 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes('--' + name);

function npmBin() {
  if (process.platform === 'win32') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli] };
  }
  return { cmd: 'npm', prefix: [] };
}

function runOuter() {
  let runtime = null;
  let tempShotDir = null;
  const keepRuntime = hasFlag('keep-runtime');
  const screenshotsDir = getArg('screenshots-dir', '') || (() => {
    tempShotDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-plan-photo-shots-'));
    return tempShotDir;
  })();
  fs.mkdirSync(screenshotsDir, { recursive: true });

  try {
    runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-plan-photo-e2e-'));
    console.log('[plan-photo-e2e] installing pinned packages into disposable runtime:', runtime);
    const npm = npmBin();
    const inst = spawnSync(
      npm.cmd,
      [...npm.prefix, 'install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
        '--ignore-scripts', 'playwright@' + PLAYWRIGHT, 'firebase-tools@' + FIREBASE_TOOLS, 'firebase@' + FIREBASE_SDK],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    );
    if (inst.status !== 0) throw new Error('npm install into disposable runtime failed');

    const pwCli = path.join(runtime, 'node_modules', 'playwright', 'cli.js');
    const plat = process.platform === 'linux' ? ['install', '--with-deps', 'chromium'] : ['install', 'chromium'];
    const dl = spawnSync(process.execPath, [pwCli, ...plat], { stdio: ['ignore', 'inherit', 'inherit'], env: Object.assign({}, process.env) });
    if (dl.status !== 0) throw new Error('playwright chromium install failed');

    const fbCli = path.join(runtime, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
    const workerCmd = [
      JSON.stringify(process.execPath),
      JSON.stringify(__filename),
      '--worker',
      '--runtime', JSON.stringify(runtime),
      '--screenshots-dir', JSON.stringify(screenshotsDir),
    ].join(' ');

    const res = spawnSync(
      process.execPath,
      [fbCli, 'emulators:exec', '--config', 'firebase.image-upload-emulator.json', '--project', PROJECT, '--only', 'auth,firestore,storage', workerCmd],
      {
        cwd: REPO,
        env: Object.assign({}, process.env, {
          GCLOUD_PROJECT: PROJECT,
          NODE_PATH: path.join(runtime, 'node_modules'),
          JAVA_TOOL_OPTIONS: '-Duser.language=en -Duser.country=US',
        }),
        stdio: 'inherit',
      }
    );
    if (res.status !== 0) process.exitCode = res.status || 1;
  } finally {
    if (!keepRuntime && runtime && path.basename(runtime).startsWith('vdsen-plan-photo-e2e-')) {
      try { fs.rmSync(runtime, { recursive: true, force: true }); } catch (_) {}
    }
    if (!keepRuntime && tempShotDir && path.basename(tempShotDir).startsWith('vdsen-plan-photo-shots-')) {
      try { fs.rmSync(tempShotDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// Inner E2E Worker (runs inside active Firebase Auth + Firestore + Storage Emulators)
// ---------------------------------------------------------------------------

function requireDemoProject() {
  if (!PROJECT.startsWith('demo-') || /vdsen-ecosistema(?:-staging)?$/i.test(PROJECT)) {
    throw new Error('ABORT: project must be non-production demo-*');
  }
}

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) fields[k] = toFsValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fsRequest(method, reqPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const raw = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const headers = { authorization: 'Bearer owner' };
    if (raw) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = raw.length;
    }
    const req = http.request({ hostname: FS_HOST, port: FS_PORT, path: reqPath, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (raw) req.end(raw);
    else req.end();
  });
}

async function seedFirestoreDocs(rows) {
  const writes = rows.map(([docPath, obj]) => ({
    update: {
      name: `projects/${PROJECT}/databases/(default)/documents/${docPath}`,
      fields: toFsValue(obj).mapValue.fields,
    },
  }));
  const res = await fsRequest('POST', `/v1/projects/${PROJECT}/databases/(default)/documents:commit`, { writes });
  if (res.status !== 200) throw new Error('Firestore seed failed: ' + res.status + ' ' + res.text);
}

async function readRawFirestoreDoc(docPath) {
  const res = await fsRequest('GET', `/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`);
  if (res.status !== 200) throw new Error('Firestore raw read failed for ' + docPath + ': ' + res.status + ' ' + res.text);
  return res.text;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function transformHtml(html, enableUpload) {
  let out = html;
  for (const mod of ['app', 'auth', 'firestore', 'storage']) {
    const re = new RegExp('https://www\\.gstatic\\.com/firebasejs/[^/\'"]+/firebase-' + mod + '\\.js', 'g');
    out = out.replace(re, `/__emu__/firebase-${mod}.js`);
  }
  const cfgRe = /const firebaseConfig = \{[\s\S]*?\};/;
  assert.ok(cfgRe.test(out), 'firebaseConfig anchor missing');
  out = out.replace(cfgRe, `const firebaseConfig = {
  apiKey: "demo-e2e-key", authDomain: "${PROJECT}.firebaseapp.com", projectId: "${PROJECT}",
  storageBucket: "${PROJECT}.appspot.com", messagingSenderId: "0", appId: "1:0:web:e2e" };`);
  if (enableUpload) {
    assert.ok(/var COACH_IMAGE_UPLOAD_ENABLED = false;/.test(out), 'COACH_IMAGE_UPLOAD_ENABLED = false anchor missing');
    out = out.replace(/var COACH_IMAGE_UPLOAD_ENABLED = false;/, 'var COACH_IMAGE_UPLOAD_ENABLED = true;');
  }
  return out;
}

const EMU_STUBS = {
  'firebase-app.js': `export * from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-app.js";`,
  'firebase-auth.js': `
export * from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-auth.js";
import { getAuth as _getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-auth.js";
const _wired = new WeakSet();
export function getAuth(app) {
  const a = _getAuth(app);
  if (!_wired.has(a)) { _wired.add(a); connectAuthEmulator(a, "http://${AUTH_HOST}", { disableWarnings: true }); }
  return a;
}`,
  'firebase-firestore.js': `
export * from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-firestore.js";
import { getFirestore as _getFirestore, initializeFirestore as _initializeFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-firestore.js";
const _wired = new WeakSet();
function _w(db) { if (!_wired.has(db)) { _wired.add(db); connectFirestoreEmulator(db, "${FS_HOST}", ${FS_PORT}); } return db; }
export function getFirestore(app, id) { return _w(_getFirestore(app, id)); }
export function initializeFirestore(app, settings, id) { return _w(_initializeFirestore(app, settings, id)); }`,
  'firebase-storage.js': `
export * from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-storage.js";
import { getStorage as _getStorage, connectStorageEmulator, getDownloadURL as _getDownloadURL } from "https://www.gstatic.com/firebasejs/${FIREBASE_SDK}/firebase-storage.js";
const _wired = new WeakSet();
export function getStorage(app, url) {
  const s = _getStorage(app, url);
  if (!_wired.has(s)) { _wired.add(s); connectStorageEmulator(s, "${ST_HOST}", ${ST_PORT}); }
  return s;
}
export async function getDownloadURL(r) {
  const raw = await _getDownloadURL(r);
  const u = new URL(raw);
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
    return "https://storage-emulator.e2e.invalid" + u.pathname + u.search;
  }
  return raw;
}`,
};

function startHarnessServer() {
  const coachRaw = fs.readFileSync(path.join(REPO, 'vdsen-coach.html'), 'utf8');
  const clientRaw = fs.readFileSync(path.join(REPO, 'vdsen-cliente.html'), 'utf8');
  const coachEnabledHtml = transformHtml(coachRaw, true);
  const coachDisabledHtml = transformHtml(coachRaw, false);
  const clientHtml = transformHtml(clientRaw, false);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/coach') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(coachEnabledHtml);
    }
    if (u.pathname === '/coach-disabled') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(coachDisabledHtml);
    }
    if (u.pathname === '/cliente') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(clientHtml);
    }
    if (u.pathname.startsWith('/__emu__/')) {
      const key = u.pathname.slice('/__emu__/'.length);
      if (EMU_STUBS[key]) {
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
        return res.end(EMU_STUBS[key]);
      }
      res.writeHead(404);
      return res.end('missing emu stub');
    }
    const rel = path.normalize(u.pathname.replace(/^\/+/, ''));
    const full = path.join(REPO, rel);
    if (full.startsWith(REPO + path.sep) && !rel.includes('..') && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404);
    return res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

async function generateNoisyPngBuffer(page, opts) {
  const b64 = await page.evaluate(({ label, bgA, bgB, w, h }) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    // Deterministic high-entropy pattern so lossless PNG exceeds 2 MiB cleanly
    let seed = (label.charCodeAt(0) * 16777619) >>> 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const p = (y * w + x) * 4;
        const half = x < w / 2;
        d[p] = ((half ? bgA[0] : bgB[0]) + (seed & 0x3f)) & 0xff;
        d[p + 1] = ((half ? bgA[1] : bgB[1]) + ((seed >> 8) & 0x3f)) & 0xff;
        d[p + 2] = ((half ? bgA[2] : bgB[2]) + ((seed >> 16) & 0x3f)) & 0xff;
        d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#09090b';
    ctx.fillRect(60, 60, 820, 180);
    ctx.fillStyle = '#C6FF00';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText(label, 96, 175);
    return c.toDataURL('image/png').split(',')[1];
  }, opts);
  return Buffer.from(b64, 'base64');
}

async function installStorageBridgeRoute(context) {
  await context.route('https://storage-emulator.e2e.invalid/**', async (route) => {
    const u = new URL(route.request().url());
    const localUrl = `http://${ST_HOST}:${ST_PORT}${u.pathname}${u.search}`;
    const r = await fetch(localUrl);
    const body = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    await route.fulfill({ status: r.status, contentType, body });
  });
}

async function runWorker() {
  requireDemoProject();
  const runtime = getArg('runtime', '');
  const screenshotsDir = getArg('screenshots-dir', os.tmpdir());
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const reqFromRuntime = (m) => require(path.join(runtime, 'node_modules', m));
  const { chromium } = reqFromRuntime('playwright');
  const { initializeApp, deleteApp } = reqFromRuntime('firebase/app');
  const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } = reqFromRuntime('firebase/auth');
  const { getFirestore, connectFirestoreEmulator, doc, getDoc, updateDoc } = reqFromRuntime('firebase/firestore');
  const { getStorage, connectStorageEmulator, ref, uploadBytes, getBytes } = reqFromRuntime('firebase/storage');
  const pathsMod = require('../../assets/coach-image-upload/paths.js');
  const sniffMod = require('../../assets/coach-image-upload/sniff.js');

  function makeSdk(name) {
    const app = initializeApp({
      apiKey: 'demo-e2e-key',
      authDomain: `${PROJECT}.firebaseapp.com`,
      projectId: PROJECT,
      storageBucket: `${PROJECT}.appspot.com`,
    }, name);
    const auth = getAuth(app); connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
    const db = getFirestore(app); connectFirestoreEmulator(db, FS_HOST, FS_PORT);
    const storage = getStorage(app); connectStorageEmulator(storage, ST_HOST, ST_PORT);
    return { app, auth, db, storage };
  }

  async function ensureUser(ctx, email) {
    try { return await createUserWithEmailAndPassword(ctx.auth, email, PASSWORD); }
    catch (e) {
      if (e && e.code === 'auth/email-already-in-use') return signInWithEmailAndPassword(ctx.auth, email, PASSWORD);
      throw e;
    }
  }

  const coachASdk = makeSdk('e2e-coach-a');
  const coachBSdk = makeSdk('e2e-coach-b');
  const athleteASdk = makeSdk('e2e-athlete-a');
  const athleteBSdk = makeSdk('e2e-athlete-b');

  const results = [];
  const stepRec = (name, detail) => {
    results.push({ name, detail });
    console.log('  OK  ' + name.padEnd(36) + ' ' + detail);
  };

  let harness = null;
  let browser = null;

  try {
    const ca = await ensureUser(coachASdk, 'coach.a.photo@harness.invalid');
    const cb = await ensureUser(coachBSdk, 'coach.b.photo@harness.invalid');
    const aa = await ensureUser(athleteASdk, 'ana.espejo@harness.invalid');
    const ab = await ensureUser(athleteBSdk, 'otro.cliente@harness.invalid');
    const coachAUid = ca.user.uid;
    const coachBUid = cb.user.uid;
    const athleteAUid = aa.user.uid;
    const athleteBUid = ab.user.uid;

    const PLAN_ID = 'pMirrorActive1';
    const EX_CATALOGED_ID = 'exPressBancaA';

    await seedFirestoreDocs([
      [`coaches/${coachAUid}`, { role: 'coach', email: 'coach.a.photo@harness.invalid', displayName: 'Coach E2E' }],
      [`coaches/${coachBUid}`, { role: 'coach', email: 'coach.b.photo@harness.invalid', displayName: 'Coach B E2E' }],
      [`clients/${athleteAUid}`, {
        coachId: coachAUid,
        displayName: 'Ana Espejo',
        email: 'ana.espejo@harness.invalid',
        phone: '+525500000001',
        phoneConfirmedAt: 1759320000000,
        activePlanId: PLAN_ID,
        status: 'active',
        gimnasio: 'Smart Fit San Diego',
      }],
      [`clients/${athleteBUid}`, {
        coachId: coachBUid,
        displayName: 'Atleta B',
        email: 'otro.cliente@harness.invalid',
        activePlanId: null,
        status: 'active',
      }],
      [`plans/${PLAN_ID}`, {
        coachId: coachAUid,
        clientId: athleteAUid,
        status: 'active',
        weeks: 6,
        daysPerWeek: 1,
        startDate: '2026-10-01',
        activatedAt: '2026-10-01T12:00:00Z',
        gym: 'Smart Fit San Diego',
        days: [{
          name: 'Día 1 Empuje y Brazos',
          label: 'Día 1 Empuje y Brazos',
          exercises: [
            {
              prescriptionExerciseId: 'pid-press-banca-1',
              exerciseId: 'ex-press-banca-logical',
              exerciseName: 'Press Banca',
              sets: [
                { setIndex: 0, repsTarget: 10, rirTarget: 2, load: 60, restSeconds: 90 },
                { setIndex: 1, repsTarget: 10, rirTarget: 2, load: 60, restSeconds: 90 },
                { setIndex: 2, repsTarget: 10, rirTarget: 2, load: 60, restSeconds: 90 },
              ],
              reps: 10,
              repsTarget: '8-10',
              load: 60,
              rir: 2,
              muscleGroup: 'Pecho',
            },
            {
              prescriptionExerciseId: 'pid-curl-martillo-2',
              exerciseName: 'Curl Martillo',
              sets: [
                { setIndex: 0, repsTarget: 12, rirTarget: 1, load: 14, restSeconds: 60 },
                { setIndex: 1, repsTarget: 12, rirTarget: 1, load: 14, restSeconds: 60 },
                { setIndex: 2, repsTarget: 12, rirTarget: 1, load: 14, restSeconds: 60 },
              ],
              reps: 12,
              repsTarget: '10-12',
              load: 14,
              rir: 1,
              muscleGroup: 'Bíceps',
            },
          ],
        }],
      }],
      [`logs/${athleteAUid}`, {
        coachId: coachAUid,
        planId: PLAN_ID,
        activePlanId: PLAN_ID,
        currentWeek: 2,
        lastWorkout: '2026-10-14',
        entries: { '1_0_0': { carga: 60, reps: 10, rir: 2 } },
        logs: { '0': { date: '2026-10-08', sets: [{ kg: 60, reps: 10 }] } },
      }],
      [`logs/${athleteAUid}/mesos/${PLAN_ID}`, {
        coachId: coachAUid,
        planId: PLAN_ID,
        activePlanId: PLAN_ID,
        currentWeek: 2,
        updatedAt: '2026-10-14T10:00:00Z',
      }],
      [`exercises/${EX_CATALOGED_ID}`, {
        coachId: coachAUid,
        exerciseId: 'ex-press-banca-logical',
        name: 'Press Banca',
        gym: 'Smart Fit San Diego',
        equipment: 'Barra y banco plano',
        instructions: 'Mantener retracción escapular y pies firmes',
        setup: 'Banco horizontal bajo rack',
        execution: 'Bajar controlado al pecho y empujar explosivo',
      }],
    ]);

    const snapshotPlanBefore = await readRawFirestoreDoc(`plans/${PLAN_ID}`);
    const snapshotRootLogBefore = await readRawFirestoreDoc(`logs/${athleteAUid}`);
    const snapshotMesoLogBefore = await readRawFirestoreDoc(`logs/${athleteAUid}/mesos/${PLAN_ID}`);
    const snapshotClientBefore = await readRawFirestoreDoc(`clients/${athleteAUid}`);

    async function assertVisualOnlyInvariants(label) {
      assert.equal(await readRawFirestoreDoc(`plans/${PLAN_ID}`), snapshotPlanBefore, `plans/${PLAN_ID} mutated during ${label}`);
      assert.equal(await readRawFirestoreDoc(`logs/${athleteAUid}`), snapshotRootLogBefore, `logs root mutated during ${label}`);
      assert.equal(await readRawFirestoreDoc(`logs/${athleteAUid}/mesos/${PLAN_ID}`), snapshotMesoLogBefore, `logs meso mutated during ${label}`);
      assert.equal(await readRawFirestoreDoc(`clients/${athleteAUid}`), snapshotClientBefore, `client doc mutated during ${label}`);
    }

    harness = await startHarnessServer();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });

    // -------------------------------------------------------------------------
    // Coach mobile session (412x915, Samsung S25 Ultra width)
    // -------------------------------------------------------------------------
    const coachCtx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
    await installStorageBridgeRoute(coachCtx);
    const coachPage = await coachCtx.newPage();
    coachPage.on('pageerror', (e) => { throw new Error('Coach pageerror: ' + e.message); });

    await coachPage.goto(`${harness.baseUrl}/coach`, { waitUntil: 'domcontentloaded' });
    await coachPage.waitForSelector('#loginEmail');
    await coachPage.fill('#loginEmail', 'coach.a.photo@harness.invalid');
    await coachPage.fill('#loginPass', PASSWORD);
    await coachPage.click('#loginBtn');

    // Navigate Clientes -> Ana Espejo -> Plan activo
    await coachPage.waitForSelector('.nav-item-mobile[data-section="clientes"]', { state: 'visible', timeout: 25000 });
    await coachPage.click('.nav-item-mobile[data-section="clientes"]');
    await coachPage.waitForSelector('._client-row', { state: 'visible', timeout: 15000 });
    await coachPage.locator('._client-row', { hasText: 'Ana Espejo' }).locator('button:has-text("Expediente")').click();
    await coachPage.waitForSelector('#ctab_plan', { state: 'visible', timeout: 15000 });
    await coachPage.click('#ctab_plan');
    await coachPage.waitForSelector('.vdsen-plan-ex-row', { state: 'visible', timeout: 15000 });

    const listMetrics = await coachPage.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.vdsen-plan-ex-row'));
      const btns = Array.from(document.querySelectorAll('.vdsen-ex-photo-btn')).map((b) => {
        const r = b.getBoundingClientRect();
        return { h: Math.round(r.height), w: Math.round(r.width), text: b.textContent.trim() };
      });
      return {
        rowCount: rows.length,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        btns,
      };
    });
    assert.equal(listMetrics.rowCount, 2, 'Expected 2 active plan exercises');
    assert.equal(listMetrics.overflowX, 0, 'Zero horizontal overflow on Coach active plan list');
    for (const b of listMetrics.btns) assert.ok(b.h >= 44, `Photo button height ${b.h} < 44px`);
    await coachPage.evaluate(() => {
      const rows = document.querySelectorAll('.vdsen-plan-ex-row');
      if (rows.length) rows[rows.length - 1].scrollIntoView({ block: 'end' });
    });
    await coachPage.screenshot({ path: path.join(screenshotsDir, 'qa-plan-ex-list-412x915.png') });
    stepRec('COACH_PLAN_LIST_412x915', `rows=${listMetrics.rowCount} overflowX=0 btnH=${listMetrics.btns.map(x => x.h).join(',')}`);

    // Generate two distinct > 2 MiB images + 1 invalid SVG
    const cameraPng = await generateNoisyPngBuffer(coachPage, { label: 'CAM-A', bgA: [180, 40, 20], bgB: [220, 120, 30], w: 2200, h: 1500 });
    const galleryPngB = await generateNoisyPngBuffer(coachPage, { label: 'GAL-B', bgA: [25, 115, 200], bgB: [70, 170, 40], w: 2200, h: 1500 });
    assert.ok(cameraPng.length > 2 * 1024 * 1024, `Camera PNG (${cameraPng.length} bytes) must exceed 2 MiB to test resize`);
    assert.ok(galleryPngB.length > 2 * 1024 * 1024, `Gallery PNG (${galleryPngB.length} bytes) must exceed 2 MiB`);

    // 1) Camera capture upload on cataloged exercise (Press Banca)
    await coachPage.locator('.vdsen-ex-photo-btn[data-plan-ex-photo="0:0"]').click();
    await coachPage.waitForSelector('#vm-photo-camera-btn', { state: 'visible', timeout: 15000 });
    const camAttrs = await coachPage.evaluate(() => {
      const cIn = document.getElementById('vm-photo-camera');
      const gIn = document.getElementById('vm-photo-file');
      const cBtn = document.getElementById('vm-photo-camera-btn').getBoundingClientRect();
      const gBtn = document.getElementById('vm-photo-pick').getBoundingClientRect();
      return {
        camCapture: cIn.getAttribute('capture'),
        camAccept: cIn.getAttribute('accept'),
        galHasCapture: gIn.hasAttribute('capture'),
        cBtnH: Math.round(cBtn.height),
        gBtnH: Math.round(gBtn.height),
      };
    });
    assert.equal(camAttrs.camCapture, 'environment');
    assert.equal(camAttrs.galHasCapture, false);
    assert.ok(camAttrs.cBtnH >= 44 && camAttrs.gBtnH >= 44, 'Camera and gallery buttons >= 44px');

    await coachPage.setInputFiles('#vm-photo-camera', { name: 'camera-press.png', mimeType: 'image/png', buffer: cameraPng });
    await coachPage.waitForSelector('#vm-photo-preview img[src^="blob:"]', { state: 'visible', timeout: 15000 });
    await coachPage.waitForFunction(() => /Foto lista/.test((document.getElementById('vm-photo-status') || {}).textContent || ''));
    const prepMeta = await coachPage.locator('#vm-photo-meta').textContent();
    assert.match(prepMeta, /×.*KiB \(procesada\)/);
    await coachPage.screenshot({ path: path.join(screenshotsDir, 'qa-plan-ex-photo-sheet-412x915.png') });

    await coachPage.click('#planPhotoSaveBtn');
    await coachPage.waitForSelector('#planExercisePhotoModal', { state: 'detached', timeout: 20000 });
    await coachPage.waitForSelector('.vdsen-ex-photo-btn[data-plan-ex-photo="0:0"].has-photo', { timeout: 15000 });

    const exDocAfterCam = (await getDoc(doc(coachASdk.db, 'exercises', EX_CATALOGED_ID))).data();
    assert.equal(pathsMod.isManagedPathFor(exDocAfterCam.assetRef, coachAUid, EX_CATALOGED_ID), true, 'Managed path matches Coach A + Doc ID');
    assert.match(exDocAfterCam.imageUrl, /^https:\/\/storage-emulator\.e2e\.invalid\//);
    assert.equal(exDocAfterCam.equipment, 'Barra y banco plano', 'Catalog equipment preserved');
    assert.equal(exDocAfterCam.instructions, 'Mantener retracción escapular y pies firmes', 'Catalog instructions preserved');
    const storedBytesA = new Uint8Array(await getBytes(ref(coachASdk.storage, exDocAfterCam.assetRef)));
    assert.ok(storedBytesA.length > 0 && storedBytesA.length <= 480 * 1024, `Uploaded processed image ${storedBytesA.length} <= 480 KiB`);
    const sniffedA = sniffMod.sniff(storedBytesA);
    assert.equal(sniffedA.ok, true, 'Uploaded bytes must pass real image magic-byte sniff');
    assert.ok(['image/webp', 'image/jpeg', 'image/png'].includes(sniffedA.type), 'Unexpected processed type: ' + sniffedA.type);
    await assertVisualOnlyInvariants('camera_upload_cataloged');
    stepRec('CAMERA_UPLOAD_CATALOGED', `assetRef=${exDocAfterCam.assetRef} (${Math.round(storedBytesA.length / 1024)} KiB ${sniffedA.type})`);

    // 2) Gallery upload on UNCATALOGED exercise (Curl Martillo) -> auto-create in `exercises` + upload
    await coachPage.locator('.vdsen-ex-photo-btn[data-plan-ex-photo="0:1"]').click();
    await coachPage.waitForSelector('#vm-photo-pick', { state: 'visible', timeout: 15000 });
    await coachPage.setInputFiles('#vm-photo-file', { name: 'curl-martillo.png', mimeType: 'image/png', buffer: galleryPngB });
    await coachPage.waitForSelector('#vm-photo-preview img[src^="blob:"]', { state: 'visible', timeout: 15000 });
    await coachPage.waitForFunction(() => /Foto lista/.test((document.getElementById('vm-photo-status') || {}).textContent || ''));
    await coachPage.click('#planPhotoSaveBtn');
    await coachPage.waitForSelector('#planExercisePhotoModal', { state: 'detached', timeout: 20000 });
    await coachPage.waitForSelector('.vdsen-ex-photo-btn[data-plan-ex-photo="0:1"].has-photo', { timeout: 15000 });

    const curlThumbSrc = await coachPage.locator('.vdsen-plan-ex-row[data-ex-idx="1"] .vdsen-ex-thumb img').getAttribute('src');
    assert.match(curlThumbSrc, /^https:\/\/storage-emulator\.e2e\.invalid\//);
    const curlMatch = curlThumbSrc.match(/exercise-media%2F([^%]+)%2F([^%?]+)/);
    assert.ok(curlMatch, 'Created Curl Martillo Storage path inside Coach A namespace');
    const curlDocId = decodeURIComponent(curlMatch[2]);
    const curlDoc = (await getDoc(doc(coachASdk.db, 'exercises', curlDocId))).data();
    assert.equal(curlDoc.coachId, coachAUid);
    assert.equal(curlDoc.source, 'plan_photo');
    assert.equal(curlDoc.name, 'Curl Martillo');
    await assertVisualOnlyInvariants('uncataloged_gallery_upload');
    stepRec('GALLERY_UPLOAD_UNCATALOGED', `created exercises/${curlDocId} -> ${curlDoc.assetRef}`);

    async function openClientSession() {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('vdsen_wn_v7', '1');
          localStorage.setItem('vdsen_bitacora_info_seen', '1');
        } catch (_) {}
      });
      await installStorageBridgeRoute(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { throw new Error('Client pageerror: ' + e.message); });
      page.on('console', (msg) => { if (msg.type() === 'error') console.error('[client console.error]', msg.text()); });

      await page.goto(`${harness.baseUrl}/cliente`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#scrLogin.on, #liEmail', { timeout: 25000 });
      await page.fill('#liEmail', 'ana.espejo@harness.invalid');
      await page.fill('#liPass', PASSWORD);
      await page.click('.login-btn');
      await page.waitForSelector('#scrApp.on', { state: 'visible', timeout: 25000 });
      await page.waitForSelector('.exercise-name-trigger', { state: 'visible', timeout: 15000 });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        ['wnModal', 'biModal', 'phoneConfirmOverlay'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.remove();
        });
      });
      return { ctx, page };
    }

    // 3) Client app (`390x844`) renders BOTH Coach photos without altering Week 2
    const { ctx: clientCtx, page: clientPage } = await openClientSession();

    // Confirm Week 2 preserved in Client UI / state
    const weekInfo = await clientPage.evaluate(() => ({
      CURRENT_WEEK: typeof CURRENT_WEEK !== 'undefined' ? CURRENT_WEEK : null,
      bodyText: document.body.innerText.slice(0, 600),
    }));
    assert.equal(weekInfo.CURRENT_WEEK, 2, 'Client active plan preserved CURRENT_WEEK === 2');

    // Open Press Banca visual sheet in Client
    await clientPage.locator('.exercise-name-trigger', { hasText: 'Press Banca' }).first().click();
    await clientPage.waitForSelector('#exerciseSheetOverlay.open, #exerciseSheetBody img', { state: 'visible', timeout: 15000 });
    await clientPage.waitForFunction(() => {
      const img = document.querySelector('#exerciseSheetBody img');
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 15000 });
    const clientPressImg = await clientPage.evaluate(() => {
      const img = document.querySelector('#exerciseSheetBody img');
      return { src: img ? img.src : '', naturalWidth: img ? img.naturalWidth : 0, title: document.getElementById('exerciseSheetTitle').textContent };
    });
    assert.equal(clientPressImg.src, exDocAfterCam.imageUrl, 'Client renders exact uploaded Press Banca URL');
    assert.ok(clientPressImg.naturalWidth > 0, 'Client image actually loaded pixel dimensions');
    assert.equal(/pending-license\.svg/.test(clientPressImg.src), false);
    await clientPage.screenshot({ path: path.join(screenshotsDir, 'qa-client-ex-photo-390x844.png') });
    await clientPage.click('#exerciseSheetClose');

    // Open Curl Martillo visual sheet in Client (click trigger if visible, else fallback to direct sheet handler)
    const curlTrig = clientPage.locator('.exercise-name-trigger', { hasText: 'Curl Martillo' }).first();
    if ((await curlTrig.count()) > 0 && (await curlTrig.isVisible())) {
      await curlTrig.click();
    } else {
      await clientPage.evaluate(() => window.openExerciseVisualSheet(0, 1));
    }
    await clientPage.waitForFunction(() => {
      const img = document.querySelector('#exerciseSheetBody img');
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 15000 });
    const clientCurlSrc = await clientPage.locator('#exerciseSheetBody img').getAttribute('src');
    assert.equal(clientCurlSrc, curlDoc.imageUrl, 'Client renders newly auto-cataloged Curl Martillo photo');
    await clientPage.click('#exerciseSheetClose');
    stepRec('CLIENT_RENDER_INITIAL', `week=2 press=${clientPressImg.naturalWidth}px curl=rendered`);

    // 4) Replace Press Banca photo in active plan via gallery -> old Storage deleted, Client updates
    await coachPage.locator('.vdsen-ex-photo-btn[data-plan-ex-photo="0:0"]').click();
    await coachPage.waitForSelector('#vm-photo-preview img', { state: 'visible', timeout: 15000 });
    const prevShownSrc = await coachPage.locator('#vm-photo-preview img').getAttribute('src');
    assert.equal(prevShownSrc, exDocAfterCam.imageUrl, 'Reopening displays persisted Coach image before replacement');
    await coachPage.setInputFiles('#vm-photo-file', { name: 'replace-press.png', mimeType: 'image/png', buffer: galleryPngB });
    await coachPage.waitForSelector('#vm-photo-preview img[src^="blob:"]', { state: 'visible', timeout: 15000 });
    await coachPage.waitForFunction(() => /Foto lista/.test((document.getElementById('vm-photo-status') || {}).textContent || ''));
    await coachPage.click('#planPhotoSaveBtn');
    await coachPage.waitForSelector('#planExercisePhotoModal', { state: 'detached', timeout: 20000 });

    const exDocAfterRep = (await getDoc(doc(coachASdk.db, 'exercises', EX_CATALOGED_ID))).data();
    assert.notEqual(exDocAfterRep.assetRef, exDocAfterCam.assetRef, 'Replacement generated new immutable Storage path');
    assert.notEqual(exDocAfterRep.imageUrl, exDocAfterCam.imageUrl);
    let oldDeleted = false;
    try { await getBytes(ref(coachASdk.storage, exDocAfterCam.assetRef)); }
    catch (e) { oldDeleted = /object-not-found|404/i.test(String(e && (e.code || e.message))); }
    assert.equal(oldDeleted, true, 'Old Press Banca Storage object deleted after replacement publish');
    await assertVisualOnlyInvariants('replace_active_plan_photo');

    // Fresh Client session checks updated Press Banca photo
    const { ctx: clientCtx2, page: cp2 } = await openClientSession();
    await cp2.locator('.exercise-name-trigger', { hasText: 'Press Banca' }).first().click();
    await cp2.waitForFunction(() => {
      const img = document.querySelector('#exerciseSheetBody img');
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 15000 });
    const replacedClientSrc = await cp2.locator('#exerciseSheetBody img').getAttribute('src');
    assert.equal(replacedClientSrc, exDocAfterRep.imageUrl, 'Client sees updated replaced photo');
    await clientCtx2.close();
    stepRec('REPLACE_AND_CLIENT_REFRESH', `old=${exDocAfterCam.assetRef.slice(-12)} -> new=${exDocAfterRep.assetRef.slice(-12)}`);

    // 5) Remove Press Banca photo -> cleared in Firestore, deleted from Storage, clean fallback in Client
    await coachPage.locator('.vdsen-ex-photo-btn[data-plan-ex-photo="0:0"]').click();
    await coachPage.waitForSelector('#vm-photo-remove', { state: 'visible', timeout: 15000 });
    await coachPage.click('#vm-photo-remove');
    await coachPage.waitForFunction(() => /eliminará al guardar/.test((document.getElementById('vm-photo-status') || {}).textContent || ''));
    await coachPage.click('#planPhotoSaveBtn');
    await coachPage.waitForSelector('#planExercisePhotoModal', { state: 'detached', timeout: 20000 });
    await coachPage.waitForFunction(() => {
      const btn = document.querySelector('.vdsen-ex-photo-btn[data-plan-ex-photo="0:0"]');
      return btn && !btn.classList.contains('has-photo');
    }, { timeout: 15000 });

    const exDocAfterRem = (await getDoc(doc(coachASdk.db, 'exercises', EX_CATALOGED_ID))).data();
    assert.equal(exDocAfterRem.imageUrl, '');
    assert.equal(exDocAfterRem.assetRef, '');
    let repDeleted = false;
    try { await getBytes(ref(coachASdk.storage, exDocAfterRep.assetRef)); }
    catch (e) { repDeleted = /object-not-found|404/i.test(String(e && (e.code || e.message))); }
    assert.equal(repDeleted, true, 'Replaced object removed cleanly after removeImage');
    await assertVisualOnlyInvariants('remove_active_plan_photo');

    const { ctx: clientCtx3, page: cp3 } = await openClientSession();
    await cp3.locator('.exercise-name-trigger', { hasText: 'Press Banca' }).first().click();
    await cp3.waitForSelector('#exerciseSheetOverlay.open', { state: 'visible', timeout: 15000 });
    await cp3.waitForFunction(() => /Press Banca/i.test((document.getElementById('exerciseSheetTitle') || {}).textContent || ''));
    const removedSheet = await cp3.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('#exerciseSheetBody img')).map(i => i.getAttribute('src'));
      return { imgs, text: document.getElementById('exerciseSheetBody').textContent };
    });
    assert.equal(removedSheet.imgs.some(s => /storage-emulator/.test(s || '')), false, 'Removed Storage URL no longer rendered in Client');
    await clientCtx3.close();
    await clientCtx.close();
    stepRec('REMOVE_AND_CLIENT_FALLBACK', 'Firestore cleared + Storage deleted + Client clean fallback');

    // 6) Ownership & Storage/Firestore security matrix + SVG spoof defense
    // Curl Martillo still holds Coach A's active photo (`curlDoc.assetRef` under `curlDocId`).
    let coachBFsDenied = false;
    try { await updateDoc(doc(coachBSdk.db, 'exercises', EX_CATALOGED_ID), { imageUrl: 'https://evil.invalid/x.jpg' }); }
    catch (e) { coachBFsDenied = /permission|denied|unauthorized/i.test(String(e && (e.code || e.message))); }
    assert.equal(coachBFsDenied, true, 'Coach B denied Firestore update on Coach A exercise');

    let coachBStDenied = false;
    const validSmallJpeg = new Uint8Array(64);
    validSmallJpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    validSmallJpeg[62] = 0xff; validSmallJpeg[63] = 0xd9;
    try {
      await uploadBytes(ref(coachBSdk.storage, pathsMod.newPath(coachAUid, EX_CATALOGED_ID)), validSmallJpeg, { contentType: 'image/jpeg' });
    } catch (e) { coachBStDenied = /unauthorized|permission|403/i.test(String(e && (e.code || e.message))); }
    assert.equal(coachBStDenied, true, 'Coach B denied Storage upload into Coach A exercise namespace');

    let athleteBReadDenied = false;
    try { await getBytes(ref(athleteBSdk.storage, curlDoc.assetRef)); }
    catch (e) { athleteBReadDenied = /unauthorized|permission|403/i.test(String(e && (e.code || e.message))); }
    assert.equal(athleteBReadDenied, true, 'Athlete of Coach B denied reading Coach A exercise media');

    const athleteABytes = new Uint8Array(await getBytes(ref(athleteASdk.storage, curlDoc.assetRef)));
    assert.ok(athleteABytes.length > 0, 'Athlete of Coach A allowed reading Coach A exercise media');

    // Spoofed SVG rejected pre-upload in Coach UI
    await coachPage.locator('.vdsen-ex-photo-btn[data-plan-ex-photo="0:1"]').click();
    await coachPage.waitForSelector('#vm-photo-pick', { state: 'visible', timeout: 15000 });
    await coachPage.setInputFiles('#vm-photo-file', {
      name: 'spoof.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    await coachPage.waitForFunction(() => /válida|SVG|permitidos/i.test((document.getElementById('vm-photo-status') || {}).textContent || ''));
    const curlAfterSpoof = (await getDoc(doc(coachASdk.db, 'exercises', curlDocId))).data();
    assert.equal(curlAfterSpoof.assetRef, curlDoc.assetRef, 'Spoofed SVG left Firestore untouched');
    await coachPage.keyboard.press('Escape');
    await coachPage.waitForSelector('#planExercisePhotoModal', { state: 'detached', timeout: 10000 });
    stepRec('OWNERSHIP_SECURITY_MATRIX', 'CoachB_FS=DENY CoachB_ST=DENY AthleteB_Read=DENY AthleteA_Read=ALLOW SVG=REJECTED');

    // 7) Disabled production gate (`COACH_IMAGE_UPLOAD_ENABLED=false`) + PR #259 `#planMoreMenu` regression check
    await coachCtx.close();
    const disCtx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
    await installStorageBridgeRoute(disCtx);
    const disPage = await disCtx.newPage();
    disPage.on('pageerror', (e) => { throw new Error('Coach disabled pageerror: ' + e.message); });

    await disPage.goto(`${harness.baseUrl}/coach-disabled`, { waitUntil: 'domcontentloaded' });
    await disPage.waitForSelector('#loginEmail', { timeout: 25000 });
    await disPage.fill('#loginEmail', 'coach.a.photo@harness.invalid');
    await disPage.fill('#loginPass', PASSWORD);
    await disPage.click('#loginBtn');
    await disPage.waitForSelector('.nav-item-mobile[data-section="clientes"]', { state: 'visible', timeout: 25000 });
    await disPage.click('.nav-item-mobile[data-section="clientes"]');
    await disPage.waitForSelector('._client-row', { state: 'visible', timeout: 15000 });
    await disPage.locator('._client-row', { hasText: 'Ana Espejo' }).locator('button:has-text("Expediente")').click();
    await disPage.waitForSelector('#ctab_plan', { state: 'visible', timeout: 15000 });
    await disPage.click('#ctab_plan');
    await disPage.waitForSelector('.vdsen-ex-photo-btn[data-plan-ex-photo="0:1"]', { state: 'visible', timeout: 15000 });

    await disPage.locator('.vdsen-ex-photo-btn[data-plan-ex-photo="0:1"]').click();
    await disPage.waitForSelector('#planPhotoDisabledPreview', { state: 'visible', timeout: 15000 });
    await disPage.waitForFunction(() => {
      const im = document.querySelector('#planPhotoDisabledPreview img');
      return im && im.complete && im.naturalWidth > 0;
    }, { timeout: 15000 });
    const disState = await disPage.evaluate(() => ({
      hasVmSection: !!document.getElementById('vm-photo-section'),
      saveDisplay: getComputedStyle(document.getElementById('planPhotoSaveBtn')).display,
      notice: document.getElementById('planPhotoDisabledPreview').textContent,
      imgSrc: (document.querySelector('#planPhotoDisabledPreview img') || {}).src || '',
    }));
    assert.equal(disState.hasVmSection, false, 'Disabled gate must not mount upload controls');
    assert.equal(disState.saveDisplay, 'none');
    assert.match(disState.notice, /COACH_IMAGE_UPLOAD_ENABLED=false/);
    assert.equal(disState.imgSrc, curlDoc.imageUrl, 'Disabled gate still previews existing photo read-only');
    await disPage.screenshot({ path: path.join(screenshotsDir, 'qa-plan-ex-photo-disabled-412x915.png') });

    // Escape closes photo modal without closing #clientModal
    await disPage.keyboard.press('Escape');
    await disPage.waitForSelector('#planExercisePhotoModal', { state: 'detached', timeout: 10000 });
    const modalStillOpen = await disPage.evaluate(() => getComputedStyle(document.getElementById('clientModal')).display === 'flex');
    assert.equal(modalStillOpen, true, 'Escape closes photo modal while keeping #clientModal open');

    // PR #259 responsive menu regression check (`#planMoreMenuBtn` -> `#vdsenMenuHost[data-mode="sheet"]`)
    await disPage.click('#planMoreMenuBtn');
    await disPage.waitForSelector('#vdsenMenuHost[data-mode="sheet"]', { state: 'visible', timeout: 10000 });
    assert.equal(await disPage.evaluate(() => !!(window._vdsenMenu && window._vdsenMenu.isOpen())), true, 'PR #259 menu reports open');
    const menuCheck = await disPage.evaluate(() => {
      const host = document.getElementById('vdsenMenuHost');
      const items = Array.from(host.querySelectorAll('.vdsen-menu-portaled button'));
      const minH = items.reduce((m, el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none') return m;
        return Math.min(m, el.getBoundingClientRect().height);
      }, 999);
      return { visibleCount: items.filter(el => getComputedStyle(el).display !== 'none').length, minH: Math.round(minH) };
    });
    assert.ok(menuCheck.visibleCount > 0 && menuCheck.minH >= 44, 'PR #259 sheet items >= 44px');
    await disPage.keyboard.press('Escape');
    await disPage.waitForFunction(() => !(window._vdsenMenu && window._vdsenMenu.isOpen()));
    await disCtx.close();
    stepRec('DISABLED_GATE_AND_PR259_MENU', `notice=OK escapeOrder=OK sheetItems=${menuCheck.visibleCount}`);

    console.log('\nPLAN_EXERCISE_PHOTO_E2E_STEPS=' + results.length + '/' + results.length);
    console.log('PLAN_EXERCISE_PHOTO_E2E=PASS');
  } finally {
    const withTimeout = (p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    if (browser) await withTimeout(browser.close());
    if (harness && harness.server) try { harness.server.close(); } catch (_) {}
    await Promise.all([coachASdk, coachBSdk, athleteASdk, athleteBSdk].map(async (sdk) => {
      await withTimeout(signOut(sdk.auth));
      await withTimeout(deleteApp(sdk.app));
    }));
  }
}

if (hasFlag('worker')) {
  runWorker().then(
    () => process.exit(0),
    (err) => {
      console.error('[plan-photo-e2e worker FAILED]', err && err.stack || err);
      process.exit(1);
    }
  );
} else {
  runOuter();
}
