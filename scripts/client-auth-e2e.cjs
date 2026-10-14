#!/usr/bin/env node
'use strict';

// PR47 QA-only authenticated browser acceptance. It runs exclusively against
// Firebase Auth/Firestore emulators and patches the production config in memory.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const repo = path.resolve(__dirname, '..');
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (projectId !== 'demo-vdsen-e2e' || !firestoreHost || !authHost) {
  throw new Error('REFUSING: demo-vdsen-e2e Auth and Firestore emulators are required');
}

const results = [];
const check = (id, pass, note = '') => {
  results.push({ id, pass: !!pass, note });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${note ? ` - ${note}` : ''}`);
};
const waitFor = async (fn, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timeout: ${label}`);
};

function buildFirebaseSdk(runtime) {
  const out = path.join(runtime, 'sdk');
  fs.mkdirSync(out, { recursive: true });
  for (const [file, mod] of [['app.js', 'firebase/app'], ['auth.js', 'firebase/auth'], ['firestore.js', 'firebase/firestore']]) {
    fs.writeFileSync(path.join(runtime, file), `export * from '${mod}';\n`);
  }
  const esbuild = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  const r = spawnSync(esbuild, [path.join(runtime, 'app.js'), path.join(runtime, 'auth.js'), path.join(runtime, 'firestore.js'), '--bundle', '--format=esm', '--splitting', '--platform=browser', '--outdir=' + out], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`esbuild failed: ${(r.stderr || '').slice(0, 300)}`);
  return out;
}

function patchClientHtml(html) {
  let h = html;
  const replace = (from, to) => {
    if (!h.includes(from)) throw new Error(`patch anchor missing: ${from.slice(0, 80)}`);
    h = h.replace(from, to);
  };
  replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js', '/sdk/app.js');
  replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js', '/sdk/auth.js');
  replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js', '/sdk/firestore.js');
  replace('getAuth, signInWithEmailAndPassword,', 'getAuth, connectAuthEmulator, signInWithEmailAndPassword,');
  replace('initializeFirestore, persistentLocalCache, doc,', 'initializeFirestore, connectFirestoreEmulator, persistentLocalCache, doc,');
  replace('projectId: "vdsen-ecosistema"', 'projectId: "demo-vdsen-e2e"');
  replace('authDomain: "vdsen-ecosistema.firebaseapp.com"', 'authDomain: "demo-vdsen-e2e.firebaseapp.com"');
  replace('const db = initializeFirestore(app, { localCache: persistentLocalCache() });',
    `const db = initializeFirestore(app, { localCache: persistentLocalCache() });\n` +
    `if (firebaseConfig.projectId !== 'demo-vdsen-e2e') throw new Error('E2E guard: not demo');\n` +
    `connectAuthEmulator(auth, 'http://${authHost}', { disableWarnings: true });\n` +
    `connectFirestoreEmulator(db, '${firestoreHost.split(':')[0]}', ${Number(firestoreHost.split(':')[1])});`);
  replace('function renderNutricion() {', 'function renderNutricion() { window.__qaNutritionRenders = (window.__qaNutritionRenders || 0) + 1;');
  return h;
}

async function main() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-client-auth-e2e-'));
  const sdk = buildFirebaseSdk(runtime);
  const email = 'athlete@demo-vdsen-e2e.invalid';
  const password = 'Synthetic-pass-123';
  const signup = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const account = await signup.json();
  if (!account.localId) throw new Error(`synthetic signup failed: ${signup.status}`);
  const uid = account.localId;

  const adminApp = initializeApp({ projectId }, 'client-auth-e2e');
  const db = getFirestore(adminApp);
  const planId = 'plan-client-auth-e2e';
  await db.doc(`clients/${uid}`).set({
    coachId: 'synthetic-coach', displayName: 'Atleta Sintético', email, role: 'client',
    activePlanId: planId, objetivo: 'QA', profileType: 'hipertrofia', phoneConfirmedAt: Date.now(),
    nutritionPlan: { calorias: 2200, proteina: 160, carbos: 240, grasas: 70, texto: 'NUTRITION_INITIAL' },
    supplementPlan: { texto: 'SUPPLEMENTS_INITIAL' }
  });
  await db.doc(`plans/${planId}`).set({
    coachId: 'synthetic-coach', clientId: uid, schema: 'vdsen-plan-v2', status: 'active',
    weeks: 4, daysPerWeek: 1, updatedAt: '2026-10-14T00:00:00.000Z',
    days: [{ dayIndex: 0, label: 'Día QA', exercises: [{ exerciseName: 'Sentadilla QA', prescriptionExerciseId: 'qa-ex-1', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2 }] }] }]
  });
  await db.doc(`logs/${uid}`).set({ planId, currentWeek: 1, entries: {}, updatedAt: Date.now() });

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file;
    if (pathname.startsWith('/sdk/')) file = path.join(sdk, pathname.slice('/sdk/'.length));
    else file = path.join(repo, pathname === '/' ? 'vdsen-cliente.html' : pathname.slice(1));
    if (!file.startsWith(pathname.startsWith('/sdk/') ? sdk : repo) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    let body = fs.readFileSync(file);
    if (file.endsWith('vdsen-cliente.html')) body = Buffer.from(patchClientHtml(body.toString('utf8')));
    const ext = path.extname(file), types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${server.address().port}/vdsen-cliente.html`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const external = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:')) return route.continue();
    if (/^data:|^blob:/.test(url)) return route.continue();
    external.push(url);
    const contentType = url.includes('fonts.googleapis.com') ? 'text/css' : 'text/javascript';
    return route.fulfill({ status: 200, contentType, body: '' });
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', e => browserErrors.push(`pageerror:${e.message}`));
  page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(`console:${msg.text()}`); });

  try {
    await page.goto(appUrl);
    await page.waitForSelector('#liEmail');
    await page.fill('#liEmail', email);
    await page.fill('#liPass', password);
    await page.click('.login-btn');
    await page.waitForFunction(() => document.getElementById('scrApp')?.classList.contains('on') && PLAN?.entrenamiento?.sesiones?.length === 1, null, { timeout: 30000 });
    check('CLIENT_LOGIN', true);
    check('CLIENT_LISTENERS_SINGLE_SET', await page.evaluate(() => typeof _liveUnsubClient === 'function' && typeof _liveUnsubPlan === 'function' && typeof _liveUnsubLogs === 'function'));

    await page.evaluate(() => goTab(0));
    check('NAV_HOME', await page.isVisible('#tabResumen'));
    await page.evaluate(() => goTab(1));
    check('NAV_TRAINING', await page.isVisible('#tabEntr') && (await page.textContent('#tabEntr')).includes('Sentadilla QA'));
    const beforeHidden = await page.evaluate(() => window.__qaNutritionRenders || 0);
    await db.doc(`clients/${uid}`).update({ nutritionPlan: { calorias: 2250, proteina: 165, carbos: 245, grasas: 70, texto: 'NUTRITION_HIDDEN_CURRENT' } });
    await waitFor(() => page.evaluate(() => PLAN?.nutricion?.texto === 'NUTRITION_HIDDEN_CURRENT'), 'hidden nutrition model update');
    const afterHidden = await page.evaluate(() => window.__qaNutritionRenders || 0);
    check('HIDDEN_MODEL_UPDATED', afterHidden === beforeHidden, `${beforeHidden}->${afterHidden}`);

    await page.evaluate(() => goTab(2));
    await page.waitForFunction(() => document.getElementById('tabNutr')?.innerText.includes('NUTRITION_HIDDEN_CURRENT'));
    check('NAV_NUTRITION_CURRENT', true);
    const beforeVisible = await page.evaluate(() => window.__qaNutritionRenders || 0);
    await db.doc(`clients/${uid}`).update({ nutritionPlan: { calorias: 2300, proteina: 170, carbos: 250, grasas: 70, texto: 'NUTRITION_VISIBLE_CURRENT' } });
    await page.waitForFunction(() => document.getElementById('tabNutr')?.innerText.includes('NUTRITION_VISIBLE_CURRENT'));
    const afterVisible = await page.evaluate(() => window.__qaNutritionRenders || 0);
    check('VISIBLE_UPDATE_RENDERED', afterVisible > beforeVisible, `${beforeVisible}->${afterVisible}`);
    await page.evaluate(() => { goTab(1); goTab(2); });
    check('NUTRITION_REENTRY_PERSISTS', (await page.textContent('#tabNutr')).includes('NUTRITION_VISIBLE_CURRENT'));
    check('TRAINING_FLOW_INTACT', await page.evaluate(() => { goTab(1); return document.getElementById('tabEntr').innerText.includes('Sentadilla QA'); }));
    check('BROWSER_CONSOLE', browserErrors.length === 0, browserErrors.join(' | ').slice(0, 500));
    check('PRODUCTION_CONTACT', external.every(u => !/firebaseio|googleapis\.com\/v1\/projects|vdsen-ecosistema/.test(u)), external.join(',').slice(0, 500));
  } finally {
    await context.close(); await browser.close(); await new Promise(r => server.close(r)); await deleteApp(adminApp);
  }
  const failed = results.filter(x => !x.pass);
  console.log(`CLIENT_AUTH_E2E=${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(e => { console.error('[client-auth-e2e]', e && e.stack || e); process.exitCode = 1; });
