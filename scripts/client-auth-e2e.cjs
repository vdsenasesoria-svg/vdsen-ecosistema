#!/usr/bin/env node
'use strict';

// QA-only authenticated Client acceptance. Product files are served from an
// immutable checkout and patched only in memory to use local demo emulators.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const productRoot = path.resolve(process.env.PRODUCT_ROOT || repo);
const clientFile = path.join(productRoot, 'vdsen-cliente.html');
const rulesFile = path.join(productRoot, 'firestore.rules');
const PROJECT = 'demo-vdsen-e2e';
const JAR_NAME = 'cloud-firestore-emulator-v1.19.8.jar';
const JAR_SHA256 = '9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d';
const JAR_URL = `https://storage.googleapis.com/firebase-preview-drop/emulator/${JAR_NAME}`;
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const outFile = arg('out', null);
const results = [];
const processes = [];
let runtime = null;

const check = (id, pass, note = '') => {
  results.push({ id, pass: !!pass, note });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}${note ? ` - ${note}` : ''}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(500, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});
async function waitPort(port, label) {
  for (let i = 0; i < 200; i++) { if (await portOpen(port)) return; await sleep(250); }
  throw new Error(`${label} did not start on ${port}`);
}

async function ensureJar() {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'emulators', JAR_NAME);
  if (fs.existsSync(cached) && sha256(cached) === JAR_SHA256) return cached;
  const target = path.join(runtime, JAR_NAME);
  const env = { ...process.env }; delete env.NODE_USE_ENV_PROXY;
  const download = spawnSync(process.execPath, ['-e', "fetch(process.argv[1]).then(async r=>{if(!r.ok)process.exit(2);require('fs').writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))})", JAR_URL, target], { env, encoding: 'utf8' });
  if (download.status !== 0 || !fs.existsSync(target)) throw new Error('Firestore Emulator download failed');
  if (sha256(target) !== JAR_SHA256) throw new Error('Firestore Emulator JAR checksum mismatch');
  return target;
}

async function startEmulators() {
  const ports = { firestore: await freePort(), auth: await freePort(), hub: await freePort() };
  const jar = await ensureJar();
  processes.push(spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(ports.firestore), '--project_id', PROJECT, '--rules', rulesFile, '--single_project_mode'], {
    cwd: productRoot, stdio: ['ignore', fs.openSync(path.join(runtime, 'firestore.out'), 'w'), fs.openSync(path.join(runtime, 'firestore.err'), 'w')]
  }));
  await waitPort(ports.firestore, 'Firestore Emulator');
  const config = path.join(runtime, 'firebase.json');
  fs.writeFileSync(config, JSON.stringify({ emulators: { auth: { host: '127.0.0.1', port: ports.auth }, hub: { host: '127.0.0.1', port: ports.hub }, ui: { enabled: false }, singleProjectMode: true } }));
  const firebaseCli = path.join(repo, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  processes.push(spawn(process.execPath, [firebaseCli, 'emulators:start', '--only', 'auth', '--project', PROJECT, '--config', config], {
    cwd: runtime, env: { ...process.env, CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' },
    stdio: ['ignore', fs.openSync(path.join(runtime, 'auth.out'), 'w'), fs.openSync(path.join(runtime, 'auth.err'), 'w')]
  }));
  await waitPort(ports.auth, 'Auth Emulator');
  return ports;
}

async function stopAll() {
  for (const child of processes.splice(0)) {
    try {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(6000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch (_) {}
  }
}

async function signUp(authPort, email, password) {
  const response = await fetch(`http://127.0.0.1:${authPort}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const body = await response.json();
  if (!body.localId) throw new Error(`Synthetic signup failed (${response.status})`);
  return body.localId;
}

function buildFirebaseSdk() {
  const out = path.join(runtime, 'sdk');
  fs.mkdirSync(out, { recursive: true });
  for (const [file, moduleName] of [['app.js', 'firebase/app'], ['auth.js', 'firebase/auth'], ['firestore.js', 'firebase/firestore']]) fs.writeFileSync(path.join(runtime, file), `export * from '${moduleName}';\n`);
  const esbuild = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  const build = spawnSync(esbuild, [path.join(runtime, 'app.js'), path.join(runtime, 'auth.js'), path.join(runtime, 'firestore.js'), '--bundle', '--format=esm', '--splitting', '--platform=browser', '--minify', `--outdir=${out}`], { cwd: repo, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`esbuild failed: ${(build.stderr || '').slice(0, 300)}`);
  return out;
}

function patchClientHtml(html, ports) {
  let patched = html;
  const replace = (from, to) => {
    if (!patched.includes(from)) throw new Error(`Patch anchor missing: ${from.slice(0, 90)}`);
    patched = patched.replace(from, to);
  };
  replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js', '/sdk/app.js');
  replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js', '/sdk/auth.js');
  replace('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js', '/sdk/firestore.js');
  replace('getAuth, signInWithEmailAndPassword,', 'getAuth, connectAuthEmulator, signInWithEmailAndPassword,');
  replace('initializeFirestore, persistentLocalCache, doc,', 'initializeFirestore, connectFirestoreEmulator, persistentLocalCache, doc,');
  replace('projectId: "vdsen-ecosistema"', `projectId: "${PROJECT}"`);
  replace('authDomain: "vdsen-ecosistema.firebaseapp.com"', `authDomain: "${PROJECT}.firebaseapp.com"`);
  replace('const db = initializeFirestore(app, { localCache: persistentLocalCache() });',
    `const db = initializeFirestore(app, { localCache: persistentLocalCache() });\n` +
    `if (firebaseConfig.projectId !== '${PROJECT}') throw new Error('E2E guard: non-demo project');\n` +
    `connectAuthEmulator(auth, 'http://127.0.0.1:${ports.auth}', { disableWarnings: true });\n` +
    `connectFirestoreEmulator(db, '127.0.0.1', ${ports.firestore});`);
  replace('window._fbReady = true;',
    `window.__qaSnapshotStats = { active: 0, created: 0, unsubscribed: 0, maxActive: 0 };\n` +
    `const __qaRawOnSnapshot = window._fb.onSnapshot;\n` +
    `window._fb.onSnapshot = function(){ const args = arguments; const stats = window.__qaSnapshotStats; stats.active++; stats.created++; stats.maxActive = Math.max(stats.maxActive, stats.active); const rawUnsub = __qaRawOnSnapshot.apply(null, args); let live = true; return function(){ if (live) { live = false; stats.active--; stats.unsubscribed++; } return rawUnsub(); }; };\n` +
    `window._fbReady = true;`);
  replace('function renderNutricion() {', 'function renderNutricion() { window.__qaNutritionRenders = (window.__qaNutritionRenders || 0) + 1;');
  return patched;
}

const canonical = value => JSON.stringify(value, (_, current) => {
  if (!current || Array.isArray(current) || typeof current !== 'object') return current;
  return Object.keys(current).sort().reduce((sorted, key) => { sorted[key] = current[key]; return sorted; }, {});
});

async function main() {
  if (!fs.existsSync(clientFile) || !fs.existsSync(rulesFile)) throw new Error('Immutable product checkout is incomplete');
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-client-e2e-'));
  const ports = await startEmulators();
  process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${ports.firestore}`;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${ports.auth}`;
  process.env.GCLOUD_PROJECT = PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
  process.env.METADATA_SERVER_DETECTION = 'none';
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.FIREBASE_CONFIG;

  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const { chromium } = require('playwright');
  const adminApp = initializeApp({ projectId: PROJECT }, 'client-auth-e2e');
  const db = getFirestore(adminApp);
  const sdk = buildFirebaseSdk();
  const password = 'Synthetic-pass-123';
  const accountA = { email: 'athlete-a@e2e.invalid', uid: await signUp(ports.auth, 'athlete-a@e2e.invalid', password), name: 'Atleta Alfa' };
  const accountB = { email: 'athlete-b@e2e.invalid', uid: await signUp(ports.auth, 'athlete-b@e2e.invalid', password), name: 'Atleta Beta' };
  const plan = (uid, id, exercise) => ({ coachId: 'synthetic-coach', clientId: uid, schema: 'vdsen-plan-v2', status: 'active', weeks: 4, daysPerWeek: 1, updatedAt: '2026-10-14T00:00:00.000Z', days: [{ dayIndex: 0, label: `Día ${id}`, exercises: [{ exerciseName: exercise, prescriptionExerciseId: `${id}-exercise-1`, sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2 }] }] }] });
  const nutrition = marker => ({ calorias: 2200, proteina: 160, carbos: 240, grasas: 70, texto: `COMIDA 1\n${marker}\nMacros: 40P / 60C / 15G / 535 kcal` });
  const seed = async (account, suffix) => {
    const planId = `plan-${suffix}`;
    await db.doc(`clients/${account.uid}`).set({ coachId: 'synthetic-coach', displayName: account.name, email: account.email, role: 'client', activePlanId: planId, objetivo: 'QA', profileType: 'hipertrofia', phoneConfirmedAt: 1, nutritionPlan: nutrition(`NUTRITION_${suffix}_INITIAL`), supplementPlan: { texto: `SUPPLEMENTS_${suffix}_INITIAL` } });
    await db.doc(`plans/${planId}`).set(plan(account.uid, suffix, `Sentadilla ${suffix}`));
    await db.doc(`logs/${account.uid}`).set({ planId, currentWeek: 1, entries: {}, updatedAt: 1 });
    return planId;
  };
  const planA = await seed(accountA, 'ALFA');
  const planB = await seed(accountB, 'BETA');
  const readProtected = async (account, planId) => {
    const [planSnap, logSnap, mesoSnap] = await Promise.all([db.doc(`plans/${planId}`).get(), db.doc(`logs/${account.uid}`).get(), db.doc(`logs/${account.uid}/mesos/${planId}`).get()]);
    return { plan: planSnap.data(), log: logSnap.data(), mesoExists: mesoSnap.exists };
  };
  const protectedBefore = { A: await readProtected(accountA, planA), B: await readProtected(accountB, planB) };

  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    let file;
    if (pathname.startsWith('/sdk/')) file = path.join(sdk, pathname.slice(5));
    else file = pathname === '/' || pathname === '/vdsen-cliente.html' ? clientFile : path.join(productRoot, pathname.slice(1));
    const allowedRoot = pathname.startsWith('/sdk/') ? sdk : productRoot;
    if (!file.startsWith(allowedRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); return response.end(); }
    let body = fs.readFileSync(file);
    if (file === clientFile) body = Buffer.from(patchClientHtml(body.toString('utf8'), ports));
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  processes.push({ kill: () => server.close(), once: (_, fn) => fn(), get exitCode() { return 0; } });

  const appUrl = `http://127.0.0.1:${server.address().port}/vdsen-cliente.html`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const externalRequests = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1:') || /^data:|^blob:/.test(url)) return route.continue();
    externalRequests.push(url);
    return route.fulfill({ status: 200, contentType: url.includes('.css') || url.includes('fonts.googleapis') ? 'text/css' : 'text/javascript', body: '' });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(`pageerror:${error.message}`));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(`console:${message.text()}`); });
  const login = async account => {
    await page.fill('#liEmail', account.email); await page.fill('#liPass', password); await page.click('.login-btn');
    await page.waitForFunction(expected => document.getElementById('scrApp')?.classList.contains('on') && PLAN?.nombre === expected && PLAN?.entrenamiento?.sesiones?.length === 1, account.name);
  };

  try {
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#liEmail'); await login(accountA);
    check('C01', await page.evaluate(() => !!USER && USER.email === 'athlete-a@e2e.invalid'), 'authenticated synthetic Client');
    check('C02', browserErrors.length === 0 && await page.isVisible('#scrApp'), browserErrors.join(' | ').slice(0, 300));
    const nav = await page.evaluate(() => { goTab(0); const home = getComputedStyle(document.getElementById('tabResumen')).display !== 'none'; goTab(1); const training = getComputedStyle(document.getElementById('tabEntr')).display !== 'none' && document.getElementById('tabEntr').innerText.includes('Sentadilla ALFA'); goTab(2); const nutrition = getComputedStyle(document.getElementById('tabNutr')).display !== 'none'; return { home, training, nutrition }; });
    check('C03', nav.home && nav.training && nav.nutrition, JSON.stringify(nav));
    check('C04', (await page.textContent('#tabNutr')).includes('NUTRITION_ALFA_INITIAL'), 'initial nutrition rendered');

    await page.evaluate(() => goTab(1));
    const hiddenBefore = await page.evaluate(() => window.__qaNutritionRenders || 0);
    await db.doc(`clients/${accountA.uid}`).update({ nutritionPlan: nutrition('NUTRITION_ALFA_HIDDEN') });
    await page.waitForFunction(() => PLAN?.nutricion?.texto?.includes('NUTRITION_ALFA_HIDDEN'));
    check('C05', await page.evaluate(() => getComputedStyle(document.getElementById('tabNutr')).display === 'none'), 'snapshot received while Nutrition hidden');
    check('C06', await page.evaluate(() => PLAN.nutricion.texto.includes('NUTRITION_ALFA_HIDDEN')), 'internal model updated');
    const hiddenAfter = await page.evaluate(() => window.__qaNutritionRenders || 0);
    check('C07', hiddenAfter === hiddenBefore, `renders ${hiddenBefore}->${hiddenAfter}`);

    await page.evaluate(() => goTab(2));
    check('C08', (await page.textContent('#tabNutr')).includes('NUTRITION_ALFA_HIDDEN'), 'current hidden update rendered on entry');
    const visibleBefore = await page.evaluate(() => window.__qaNutritionRenders || 0);
    await db.doc(`clients/${accountA.uid}`).update({ nutritionPlan: nutrition('NUTRITION_ALFA_VISIBLE') });
    await page.waitForFunction(() => document.getElementById('tabNutr').innerText.includes('NUTRITION_ALFA_VISIBLE'));
    const visibleAfter = await page.evaluate(() => window.__qaNutritionRenders || 0);
    check('C09', visibleAfter > visibleBefore, `renders ${visibleBefore}->${visibleAfter}`);

    await db.doc(`clients/${accountA.uid}`).update({ supplementPlan: { texto: 'SUPPLEMENTS_ALFA_UPDATED' } });
    await page.waitForFunction(() => document.getElementById('tabNutr').innerText.includes('SUPPLEMENTS_ALFA_UPDATED'));
    const nutritionText = await page.textContent('#tabNutr');
    check('C10', nutritionText.includes('NUTRITION_ALFA_VISIBLE') && nutritionText.includes('SUPPLEMENTS_ALFA_UPDATED'), 'nutrition and supplements current');

    const listenersBeforeTabs = await page.evaluate(() => ({ ...window.__qaSnapshotStats }));
    await page.evaluate(() => { for (let i = 0; i < 15; i++) goTab(i % 3); });
    const listenersAfterTabs = await page.evaluate(() => ({ ...window.__qaSnapshotStats }));
    check('C11', listenersAfterTabs.active === 3 && listenersAfterTabs.created === listenersBeforeTabs.created, `before=${JSON.stringify(listenersBeforeTabs)} after=${JSON.stringify(listenersAfterTabs)}`);

    await page.evaluate(() => doLogout());
    await page.waitForFunction(() => document.getElementById('scrLogin')?.classList.contains('on') && window.__qaSnapshotStats.active === 0);
    await login(accountB); await page.evaluate(() => goTab(2));
    const sessionB = await page.evaluate(() => ({ name: PLAN?.nombre, nutrition: PLAN?.nutricion?.texto, supplements: PLAN?.suplementacion?.texto, active: window.__qaSnapshotStats.active, body: document.getElementById('scrApp').innerText }));
    check('C12', sessionB.name === 'Atleta Beta' && sessionB.nutrition.includes('NUTRITION_BETA_INITIAL') && sessionB.supplements.includes('SUPPLEMENTS_BETA_INITIAL') && sessionB.active === 3 && !/ALFA/.test(sessionB.body + sessionB.nutrition + sessionB.supplements), JSON.stringify({ name: sessionB.name, active: sessionB.active }));

    const protectedAfter = { A: await readProtected(accountA, planA), B: await readProtected(accountB, planB) };
    check('C13', canonical(protectedAfter) === canonical(protectedBefore), 'plans, prescriptions and execution logs unchanged');
    check('C14', browserErrors.length === 0, browserErrors.join(' | ').slice(0, 500));
    const firebaseExternal = externalRequests.filter(url => /firebase|firestore|googleapis\.com\/identitytoolkit|vdsen-ecosistema/i.test(url));
    check('C15', firebaseExternal.length === 0 && process.env.GCLOUD_PROJECT === PROJECT, firebaseExternal.join(' , ').slice(0, 500) || 'Firebase traffic local; demo project enforced');
  } finally {
    await context.close(); await browser.close(); await deleteApp(adminApp);
  }
  const failed = results.filter(result => !result.pass);
  console.log(`# pass ${results.length - failed.length}`); console.log(`# fail ${failed.length}`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  return failed.length ? 1 : 0;
}

async function shutdown() {
  await stopAll();
  try { if (runtime && path.basename(runtime).startsWith('vdsen-client-e2e-') && path.dirname(runtime) === fs.realpathSync(os.tmpdir())) fs.rmSync(runtime, { recursive: true, force: true }); } catch (_) {}
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await shutdown(); process.exit(130); });
main().then(async code => { await shutdown(); process.exit(code); }, async error => { console.error('[client-auth-e2e]', error && error.stack || error); await shutdown(); process.exit(1); });
