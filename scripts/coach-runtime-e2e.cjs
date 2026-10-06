#!/usr/bin/env node
'use strict';
// LOCAL browser regression for two Coach runtime defects, against the REAL Coach UI (vdsen-coach.html from the working tree), the Firebase AUTH EMULATOR and the
// FIRESTORE EMULATOR loaded with the repository firestore.rules. Synthetic data only; no internet, no production/staging contact.
//   BUG 1  login without reload: the logged-out screen replaced document.body for good, so signing in left the Coach shell destroyed (null innerHTML in initCoachUI).
//   BUG 2  stale activePlanId: reading a missing/unreadable plan is permission-denied under the rules and used to abort showClientDetail.
//   NODE_PATH=$(npm root -g) node scripts/coach-runtime-e2e.cjs [--out results.json]
// Same isolated approach as the other emulator runners: test-only packages go to a private temp dir (removed on exit), CDN assets are rebuilt locally
// (Firebase SDK 10.12.0 ESM via esbuild, Tailwind v3 CSS), the page's firebaseConfig is swapped in memory for a demo-* project wired to localhost.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const PROJECT = 'demo-vdsen-e2e';
const JAR_NAME = 'cloud-firestore-emulator-v1.19.8.jar';
const JAR_SHA256 = '9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d';
const JAR_URL = 'https://storage.googleapis.com/firebase-preview-drop/emulator/' + JAR_NAME;
const TEST_PACKAGES = ['firebase-admin@13.10.0', 'firebase-tools@13.35.1', 'firebase@10.12.0', 'esbuild@0.25.10', 'tailwindcss@3.4.17'];
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const outFile = arg('out', null);
// Test aid for RED/GREEN demonstrations: COACH_HTML=<path> serves another version of the Coach page (default: the working tree).
const COACH_FILE = process.env.COACH_HTML || path.join(repo, 'vdsen-coach.html');
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = p => new Promise(res => { const s = net.connect({ host: '127.0.0.1', port: p }); const d = v => { s.destroy(); res(v); }; s.setTimeout(500, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false)); });

let runtime = null; const procs = [];
function browserRuntime() {
  try { return require('playwright'); } catch (e) { return null; }
}
async function ensureJar() {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'emulators', JAR_NAME);
  if (fs.existsSync(cached) && sha256(cached) === JAR_SHA256) return cached;
  const target = path.join(runtime, JAR_NAME);
  // Downloaded by a child WITHOUT NODE_USE_ENV_PROXY (the public bucket rejects the sandbox proxy's injected credentials); sha256-verified below.
  const env = Object.assign({}, process.env); delete env.NODE_USE_ENV_PROXY;
  const r = spawnSync(process.execPath, ['-e', "fetch(process.argv[1]).then(async r=>{if(!r.ok){console.error('HTTP '+r.status);process.exit(1)}require('fs').writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))})", JAR_URL, target], { env, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(target)) throw new Error('Emulator download failed: ' + (r.stderr || '').trim().slice(0, 120));
  if (sha256(target) !== JAR_SHA256) throw new Error('Firestore Emulator JAR checksum mismatch');
  return target;
}
async function waitPort(p, what) { for (let i = 0; i < 200; i++) { if (await portOpen(p)) return; await sleep(250); } throw new Error(what + ' did not start on ' + p); }

async function startEmulators() {
  const ports = { fs: await freePort(), auth: await freePort(), hub: await freePort() };
  const jar = await ensureJar();
  procs.push(spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(ports.fs), '--project_id', PROJECT, '--rules', path.join(repo, 'firestore.rules'), '--single_project_mode'],
    { cwd: repo, stdio: ['ignore', fs.openSync(path.join(runtime, 'fs.out'), 'w'), fs.openSync(path.join(runtime, 'fs.err'), 'w')] }));
  await waitPort(ports.fs, 'Firestore Emulator');
  fs.writeFileSync(path.join(runtime, 'firebase.json'), JSON.stringify({ emulators: { auth: { host: '127.0.0.1', port: ports.auth }, hub: { host: '127.0.0.1', port: ports.hub }, ui: { enabled: false }, singleProjectMode: true } }));
  procs.push(spawn(process.execPath, [path.join(runtime, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'), 'emulators:start', '--only', 'auth', '--project', PROJECT, '--config', path.join(runtime, 'firebase.json')],
    { cwd: runtime, env: Object.assign({}, process.env, { CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' }), stdio: ['ignore', fs.openSync(path.join(runtime, 'auth.out'), 'w'), fs.openSync(path.join(runtime, 'auth.err'), 'w')] }));
  await waitPort(ports.auth, 'Auth Emulator');
  return ports;
}
async function stopAll() {
  for (const p of procs.splice(0)) { try { p.kill('SIGTERM'); await Promise.race([new Promise(r => p.once('exit', r)), sleep(6000)]); if (p.exitCode === null) p.kill('SIGKILL'); } catch (e) { /* ignore */ } }
}
async function signUp(authPort, email, password) {
  const r = await fetch('http://127.0.0.1:' + authPort + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.localId) throw new Error('signUp failed ' + JSON.stringify(j)); return j.localId;
}

// Local replacements for the CDN assets (see header). Returns { local(url), css }.
function buildStaticAssets() {
  const bin = n => path.join(runtime, 'node_modules', '.bin', n), out = path.join(runtime, 'sdk');
  fs.mkdirSync(out, { recursive: true });
  spawnSync(process.execPath, [path.join(runtime, 'node_modules', 'esbuild', 'install.js')], { stdio: 'ignore' });
  for (const [f, mod] of [['e-app.js', 'firebase/app'], ['e-auth.js', 'firebase/auth'], ['e-fs.js', 'firebase/firestore'], ['e-st.js', 'firebase/storage']]) fs.writeFileSync(path.join(runtime, f), "export * from '" + mod + "';\n");
  let r = spawnSync(bin('esbuild'), [path.join(runtime, 'e-app.js'), path.join(runtime, 'e-auth.js'), path.join(runtime, 'e-fs.js'), path.join(runtime, 'e-st.js'), '--bundle', '--format=esm', '--splitting', '--platform=browser', '--minify', '--outdir=' + out], { cwd: runtime, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('esbuild failed: ' + (r.stderr || '').slice(0, 300));
  fs.writeFileSync(path.join(runtime, 'tw-in.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  r = spawnSync(bin('tailwindcss'), ['-i', path.join(runtime, 'tw-in.css'), '-o', path.join(runtime, 'tw.css'), '--content', path.join(repo, 'vdsen-coach.html')], { cwd: runtime, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tailwind build failed: ' + (r.stderr || '').slice(0, 300));
  const names = { 'firebase-app.js': 'e-app.js', 'firebase-auth.js': 'e-auth.js', 'firebase-firestore.js': 'e-fs.js', 'firebase-storage.js': 'e-st.js' };
  const base = 'https://www.gstatic.com/firebasejs/10.12.0/';
  const local = url => {
    if (url.startsWith(base)) { const n = url.slice(base.length).split('?')[0], f = names[n] || (/^chunk-[A-Za-z0-9]+\.js$/.test(n) ? n : null); if (f && fs.existsSync(path.join(out, f))) return { body: fs.readFileSync(path.join(out, f)), contentType: 'text/javascript' }; }
    if (/^https:\/\/(cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com)/.test(url)) return { body: '', contentType: 'text/javascript' };
    if (/^https:\/\/fonts\.googleapis\.com/.test(url)) return { body: '', contentType: 'text/css' };
    if (/^https:\/\/fonts\.gstatic\.com/.test(url)) return { body: '', contentType: 'font/woff2' };
    return null;
  };
  return { local, css: fs.readFileSync(path.join(runtime, 'tw.css'), 'utf8') };
}

// In-memory patch of the Coach page: swap the production config for a demo project wired to the local emulators (production code stays untouched).
function patchHtml(html, ports, css) {
  let h = html; const rep = (a, b) => { if (!h.includes(a)) throw new Error('patch anchor missing: ' + a); h = h.replace(a, () => b); };
  rep('<script src="https://cdn.tailwindcss.com"></script>', '<style>' + css + '</style>');
  rep('import { getAuth, signOut,', 'import { getAuth, connectAuthEmulator, signOut,');
  rep('import { getFirestore, doc,', 'import { getFirestore, connectFirestoreEmulator, doc,');
  rep('projectId: "vdsen-ecosistema"', 'projectId: "' + PROJECT + '"');
  rep('authDomain: "vdsen-ecosistema.firebaseapp.com"', 'authDomain: "' + PROJECT + '.firebaseapp.com"');
  rep('const db = getFirestore(app);', 'const db = getFirestore(app);\n  if (!/^demo-/.test(firebaseConfig.projectId)) throw new Error("E2E guard: not a demo project");\n  connectAuthEmulator(auth, "http://127.0.0.1:' + ports.auth + '", { disableWarnings: true });\n  connectFirestoreEmulator(db, "127.0.0.1", ' + ports.fs + ');');
  return h;
}


async function main() {
  const pw = browserRuntime();
  if (!pw) { console.log('BROWSER_E2E_BLOCKED_NO_RUNTIME (Playwright not resolvable; set NODE_PATH=$(npm root -g))'); return 2; }
  const B = require('./client-browser-lib.cjs');
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-cerun-'));
  const inst = spawnSync('npm', ['install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', ...TEST_PACKAGES], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (inst.status !== 0) throw new Error('installing test packages failed');
  const ports = await startEmulators();
  const assets = buildStaticAssets();
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + ports.fs; process.env.GCLOUD_PROJECT = PROJECT; process.env.METADATA_SERVER_DETECTION = 'none';
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_AUTH_EMULATOR_HOST']) delete process.env[k];
  const req = require('node:module').createRequire(path.join(runtime, 'noop.js'));
  const { initializeApp: initAdmin } = req('firebase-admin/app'), { getFirestore: adminFs } = req('firebase-admin/firestore');
  console.log('[e2e] project=' + PROJECT + ' firestore=127.0.0.1:' + ports.fs + ' auth=127.0.0.1:' + ports.auth + ' rules=firestore.rules');

  const PASS = 'E2e-pass-123', emailA = 'coach-a@e2e.invalid', emailB = 'coach-b@e2e.invalid';
  const uidA = await signUp(ports.auth, emailA, PASS), uidB = await signUp(ports.auth, emailB, PASS);
  const plan = (id, coach, client, label) => ({ coachId: coach, clientId: client, weeks: 4, daysPerWeek: 1, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    days: [{ dayIndex: 0, label, exercises: [{ exerciseName: 'Ejercicio-' + label, prescriptionExerciseId: id + '-p0', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2 }] }] }] });
  const base = {
    coaches: { coachA: { displayName: 'Coach A', email: emailA, role: 'coach' }, coachB: { displayName: 'Coach B', email: emailB, role: 'coach' } },
    clients: {
      cA1: { coachId: 'coachA', displayName: 'Ana Uno', email: 'ana@e2e.invalid', role: 'client', activePlanId: 'PA' },
      cA2: { coachId: 'coachA', displayName: 'Beto Dos', email: 'beto@e2e.invalid', role: 'client', activePlanId: 'PGONE' },
      cA3: { coachId: 'coachA', displayName: 'Carla Tres', email: 'carla@e2e.invalid', role: 'client', activePlanId: 'PFOREIGN' },
      cA4: { coachId: 'coachA', displayName: 'Dario Cuatro', email: 'dario@e2e.invalid', role: 'client', activePlanId: null },
      cB1: { coachId: 'coachB', displayName: 'Bruno Beta', email: 'bruno@e2e.invalid', role: 'client', activePlanId: 'PB1' }
    },
    plans: { PA: plan('PA', 'coachA', 'cA1', 'DiaAnaUno'), PFOREIGN: plan('PFOREIGN', 'coachB', 'cB1', 'DiaDeOtroCoach'), PB1: plan('PB1', 'coachB', 'cB1', 'DiaBruno') }
  };
  const seeded = JSON.parse(JSON.stringify(base).replace(/coachA/g, uidA).replace(/coachB/g, uidB));
  const adb = adminFs(initAdmin({ projectId: PROJECT }, 'e2e-seed'));
  for (const col of Object.keys(seeded)) for (const id of Object.keys(seeded[col])) await adb.doc(col + '/' + id).set(seeded[col][id]);
  const snapshotBefore = async () => JSON.stringify({ clients: (await adb.collection('clients').get()).docs.map(d => [d.id, d.data()]).sort(), plans: (await adb.collection('plans').get()).docs.map(d => [d.id, d.data()]).sort() });
  const before = await snapshotBefore();

  const browser = await B.launch();
  const http = require('node:http'), MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const appServer = http.createServer((rq, rs) => {
    const u = decodeURIComponent(new URL(rq.url, 'http://x').pathname), f = (u === '/' || u === '/vdsen-coach.html') ? COACH_FILE : path.join(repo, u);
    if ((f !== COACH_FILE && !f.startsWith(repo)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { rs.writeHead(404); return rs.end(); }
    let body = fs.readFileSync(f); if (f === COACH_FILE) body = Buffer.from(patchHtml(body.toString('utf8'), ports, assets.css));
    rs.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(body);
  });
  await new Promise(r => appServer.listen(0, '127.0.0.1', r)); const APP = 'http://127.0.0.1:' + appServer.address().port;
  procs.push({ kill: () => appServer.close(), once: (e, f) => f(), get exitCode() { return 0; } });
  const blocked = [];
  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.route(u => u.protocol !== 'http:' || u.hostname !== '127.0.0.1', async route => {
      const url = route.request().url(); if (/^data:|^blob:/.test(url)) return route.continue();
      const l = assets.local(url); if (l) return route.fulfill({ status: 200, contentType: l.contentType, headers: { 'access-control-allow-origin': '*' }, body: l.body });
      blocked.push(url); return route.abort();
    });
    const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    return { ctx, p };
  }
  const LIST = '#clientList button[onclick*="showClientDetail"]';
  const ids = async p => (await p.$$eval(LIST, bs => bs.map(b => (b.getAttribute('onclick').match(/showClientDetail\('([^']+)'\)/) || [])[1]))).filter(Boolean);
  const loginUi = async (p, email, pass) => { await p.fill('#loginEmail', email); await p.fill('#loginPass', pass); await p.click('#loginBtn'); };
  const logoutUi = async p => { await p.evaluate(() => window._vdsenSignOut()); await p.waitForSelector('#loginEmail'); };
  const bodyText = p => p.evaluate(() => document.body.innerText);
  const bodyHtml = p => p.evaluate(() => document.body.innerHTML);

  try {
    const { ctx, p } = await newPage();
    // ---------------- BUG 1: login without reload ----------------
    await p.goto(APP + '/vdsen-coach.html'); await p.waitForSelector('#loginEmail');
    await p.evaluate(() => { window.__noReloadMarker = 1; });
    check('L0_LOGGED_OUT_SCREEN', await p.isVisible('#loginBtn') && !(await p.$('#clientList')));
    // auth failure first: stays on the login screen with a message, no shell, no page error
    await loginUi(p, emailA, 'wrong-password-1');
    await p.waitForFunction(() => (document.getElementById('loginErr') || {}).textContent.trim().length > 0, null, { timeout: 15000 });
    check('L5_AUTH_FAILURE_BEHAVES', await p.isVisible('#loginEmail') && !(await p.$('#clientList')) && p.errors.length === 0, (await p.textContent('#loginErr')).trim().slice(0, 60));
    await loginUi(p, emailA, PASS);
    await p.waitForSelector(LIST, { timeout: 30000 });
    const l1 = await ids(p);
    check('L1_LOGIN_WITHOUT_RELOAD_RESTORES_SHELL', await p.evaluate(() => window.__noReloadMarker === 1) && l1.length > 0, 'page not reloaded (marker kept)');
    check('L2_CLIENT_LIST_RENDERS', ['cA1', 'cA2', 'cA3', 'cA4'].every(i => l1.includes(i)) && !l1.includes('cB1'), l1.join(','));
    check('L3_NO_PAGE_ERROR_AFTER_LOGIN', p.errors.length === 0, p.errors.join(' | ').slice(0, 200));
    // cycle 1: A -> logout -> A
    await logoutUi(p);
    check('L4a_LOGOUT_SHOWS_LOGIN_AND_HIDES_DATA', !(await bodyHtml(p)).includes('Ana Uno') && !(await p.$('#clientList')));
    await loginUi(p, emailA, PASS); await p.waitForSelector(LIST, { timeout: 30000 });
    check('L4b_SECOND_LOGIN_WITHOUT_RELOAD', (await ids(p)).includes('cA1') && await p.evaluate(() => window.__noReloadMarker === 1));
    // cycle 2: A -> logout -> B (another coach in the same tab): nothing of A may be visible
    await p.waitForTimeout(500); await p.evaluate(() => window.showClientDetail('cA1')); await p.waitForFunction(() => /Ana Uno/.test(document.getElementById('modalClientName').textContent));
    await logoutUi(p);
    await loginUi(p, emailB, PASS); await p.waitForSelector(LIST, { timeout: 30000 });
    const lb = await ids(p), html = await bodyHtml(p);
    const modalOpen = await p.evaluate(() => [...document.querySelectorAll('.modal-overlay')].some(m => getComputedStyle(m).display !== 'none'));
    check('L4c_OTHER_COACH_SAME_TAB_ISOLATED', lb.join(',') === 'cB1' && !/Ana Uno|Beto Dos|ana@e2e|cA1/.test(html) && !modalOpen, lb.join(',') + ' leak=' + (() => { const m = /Ana Uno|Beto Dos|ana@e2e|cA1/.exec(html); return m ? JSON.stringify(html.slice(Math.max(0, m.index - 80), m.index + 60)) : ''; })() + ' modalOpen=' + modalOpen);
    check('L4d_NO_PAGE_ERROR_ACROSS_CYCLES', p.errors.length === 0 && await p.evaluate(() => window.__noReloadMarker === 1), p.errors.join(' | ').slice(0, 200));
    await logoutUi(p); await loginUi(p, emailA, PASS); await p.waitForSelector(LIST, { timeout: 30000 });

    // ---------------- BUG 2: stale activePlanId ----------------
    const open = async id => { await p.evaluate(i => { const m = document.getElementById('clientModal'); m.style.display = 'none'; window.showClientDetail(i); }, id); await p.waitForSelector('#ctab_plan', { timeout: 20000 }); await p.waitForTimeout(400); };
    const planTab = async () => { await p.click('#ctab_plan'); await p.waitForTimeout(500); return p.evaluate(() => document.getElementById('clientDetailTabContent').innerText); };
    const errs0 = p.errors.length;
    await open('cA1'); const t1 = await planTab();
    check('S6_VALID_PLAN_WORKS', !/Referencia de plan rota/.test(t1) && /DiaAnaUno|Ejercicio-DiaAnaUno/.test(await p.evaluate(() => document.getElementById('clientDetailTabContent').innerHTML)), 'plan rendered');
    await open('cA2'); const t2 = await planTab(), m2 = await p.evaluate(() => document.getElementById('modalClientBody').innerText);
    check('S7_MISSING_PLAN_DEGRADES_GRACEFULLY', /Referencia de plan rota/.test(t2) && /beto@e2e\.invalid/.test(m2) && await p.evaluate(() => document.getElementById('modalClientName').textContent) === 'Beto Dos');
    await open('cA3'); const t3 = await planTab(), m3 = await p.evaluate(() => document.getElementById('modalClientBody').innerText);
    const h3 = await bodyHtml(p); check('S8_UNREADABLE_PLAN_DEGRADES_GRACEFULLY', /Referencia de plan rota/.test(t3) && /carla@e2e\.invalid/.test(m3) && !/DiaDeOtroCoach|Ejercicio-DiaDeOtroCoach/.test(h3), 'rota=' + /Referencia de plan rota/.test(t3) + ' carla=' + /carla@e2e\.invalid/.test(m3) + ' leak=' + /DiaDeOtroCoach|Ejercicio-DiaDeOtroCoach/.test(h3));
    check('S_NO_RAW_FIRESTORE_ERROR_IN_UI', !/permission|insufficient|FirebaseError|Missing or/i.test(await bodyText(p)));
    check('S_NO_PAGE_ERROR', p.errors.length === errs0, p.errors.slice(errs0).join(' | ').slice(0, 200));
    // other coach's client: fail closed, nothing rendered
    await p.evaluate(() => { document.getElementById('clientModal').style.display = 'none'; window.showClientDetail('cB1'); }); await p.waitForTimeout(2000);
    const mb = await p.evaluate(() => ({ body: document.getElementById('modalClientBody').innerText, title: document.getElementById('modalClientName').textContent }));
    check('S9_OTHER_COACH_CLIENT_FAILS_CLOSED', !/bruno|Bruno|DiaBruno|PB1/.test(mb.body + mb.title + await bodyHtml(p).then(h => h.includes('bruno@e2e') ? 'bruno' : '')) && /No se pudo abrir este cliente/.test(mb.body) && !/permission|FirebaseError/i.test(mb.body), mb.body.trim().slice(0, 60));
    check('S9b_NO_PAGE_ERROR_FOR_FOREIGN_CLIENT', p.errors.length === errs0, p.errors.slice(errs0).join(' | ').slice(0, 200));
    const after = await snapshotBefore();
    check('S10_NO_DATA_MUTATION_ACTIVEPLANID_UNCHANGED', after === before);
    check('S11_LOCAL_ONLY_NETWORK', blocked.length === 0, blocked.slice(0, 3).join(' , '));
    await ctx.close();
  } finally { await browser.close(); }
  const failed = results.filter(r => !r.pass);
  console.log('# pass ' + (results.length - failed.length)); console.log('# fail ' + failed.length);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  return failed.length ? 1 : 0;
}

async function shutdown() { await stopAll(); try { if (runtime && path.basename(runtime).startsWith('vdsen-cerun-') && path.dirname(runtime) === fs.realpathSync(os.tmpdir())) fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
for (const s of ['SIGINT', 'SIGTERM']) process.once(s, async () => { await shutdown(); process.exit(130); });
main().then(async code => { await shutdown(); process.exit(code); }, async e => { console.error('[e2e] ' + (e && e.stack || e)); await shutdown(); process.exit(1); });
