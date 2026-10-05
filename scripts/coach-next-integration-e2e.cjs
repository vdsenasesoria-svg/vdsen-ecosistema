#!/usr/bin/env node
'use strict';
// LOCAL browser INTEGRATION suite for the combined Coach candidate (runtime hardening + Exportar cliente): REAL Coach UI (vdsen-coach.html from the working tree), Firebase AUTH EMULATOR and the
// FIRESTORE EMULATOR loaded with the repository firestore.rules. Synthetic data only; no internet, no production/staging contact.
//   Interactions covered: logout/login cycles and coach switches with an export dialog/binding open, same-name clients across coaches, stale activePlanId + export.
//   NODE_PATH=$(npm root -g) node scripts/coach-next-integration-e2e.cjs [--out results.json]
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
  for (const [f, mod] of [['e-app.js', 'firebase/app'], ['e-auth.js', 'firebase/auth'], ['e-fs.js', 'firebase/firestore']]) fs.writeFileSync(path.join(runtime, f), "export * from '" + mod + "';\n");
  let r = spawnSync(bin('esbuild'), [path.join(runtime, 'e-app.js'), path.join(runtime, 'e-auth.js'), path.join(runtime, 'e-fs.js'), '--bundle', '--format=esm', '--splitting', '--platform=browser', '--minify', '--outdir=' + out], { cwd: runtime, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('esbuild failed: ' + (r.stderr || '').slice(0, 300));
  fs.writeFileSync(path.join(runtime, 'tw-in.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  r = spawnSync(bin('tailwindcss'), ['-i', path.join(runtime, 'tw-in.css'), '-o', path.join(runtime, 'tw.css'), '--content', path.join(repo, 'vdsen-coach.html')], { cwd: runtime, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tailwind build failed: ' + (r.stderr || '').slice(0, 300));
  const names = { 'firebase-app.js': 'e-app.js', 'firebase-auth.js': 'e-auth.js', 'firebase-firestore.js': 'e-fs.js' };
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
  const fx = require('../tests/helpers/client-export-fixture.js');
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-cenext-'));
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
  const base = fx.build();
  base.clients.clientStale = { coachId: 'coachA', displayName: 'Cliente Plan Eliminado', email: 'stale@e2e.invalid', role: 'client', activePlanId: 'PDELETED' };
  base.logs.clientStale = { planId: 'PDELETED', currentWeek: 1, updatedAt: 1700000000000, entries: { log_1_0_0_s0: { carga: 10, reps: 5, unit: 'kg', done: true, ts: '2026-02-01T10:00:00.000Z' } } };
  const seeded = JSON.parse(JSON.stringify(base).replace(/coachA/g, uidA).replace(/coachB/g, uidB));
  const adb = adminFs(initAdmin({ projectId: PROJECT }, 'e2e-seed'));
  for (const col of Object.keys(seeded)) for (const id of Object.keys(seeded[col])) await adb.doc(col + '/' + id).set(seeded[col][id]);
  const snap = async () => JSON.stringify({ clients: (await adb.collection('clients').get()).docs.map(d => [d.id, d.data()]).sort(), plans: (await adb.collection('plans').get()).docs.map(d => [d.id, d.data()]).sort(), logs: (await adb.collection('logs').get()).docs.map(d => [d.id, d.data()]).sort() });
  const before = await snap();

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
  const blocked = [], nonLocal = [];
  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, serviceWorkers: 'block' });
    await ctx.route(u => u.protocol !== 'http:' || u.hostname !== '127.0.0.1', async route => {
      const url = route.request().url(); if (/^data:|^blob:/.test(url)) return route.continue();
      const l = assets.local(url); if (l) return route.fulfill({ status: 200, contentType: l.contentType, headers: { 'access-control-allow-origin': '*' }, body: l.body });
      blocked.push(url); return route.abort();
    });
    const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('request', r => { const u = r.url(); if (r.method() !== 'GET' && !/^http:\/\/127\.0\.0\.1:/.test(u)) nonLocal.push(r.method() + ' ' + u); });
    p.errors = []; p.on('pageerror', e => p.errors.push(e.message)); p.downloads = []; p.on('download', d => p.downloads.push(d));
    return { ctx, p };
  }
  const LIST = '#clientList button[onclick*="showClientDetail"]';
  const ids = async p => [...new Set((await p.$$eval(LIST, bs => bs.map(b => (b.getAttribute('onclick').match(/showClientDetail\('([^']+)'\)/) || [])[1]))).filter(Boolean))];
  const loginUi = async (p, email) => { await p.fill('#loginEmail', email); await p.fill('#loginPass', PASS); await p.click('#loginBtn'); await p.waitForSelector(LIST, { timeout: 30000 }); };
  const logoutUi = async p => { await p.evaluate(() => window._vdsenSignOut()); await p.waitForSelector('#loginEmail'); };
  const openClient = async (p, id) => { await p.evaluate(i => { document.getElementById('clientModal').style.display = 'none'; window.showClientDetail(i); }, id); await p.waitForFunction(() => { const b = document.getElementById('modalExportClientBtn'); return b && b.style.display !== 'none' && !!b.onclick; }, null, { timeout: 30000 }); await p.waitForTimeout(300); };
  const dialogText = p => p.evaluate(() => (document.getElementById('clientExportDialog') || { textContent: '' }).textContent);
  async function exportViaUi(p, id) {
    await openClient(p, id); await p.click('#modalExportClientBtn'); await p.waitForSelector('#clientExportDialog');
    const before = p.downloads.length, dl = p.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await p.evaluate(() => { [...document.querySelectorAll('#clientExportDialog button')].find(x => x.textContent.trim() === 'Exportar').click(); });
    const d = await dl; await B_sleep(600); return { download: d, count: p.downloads.length - before };
  }
  const B_sleep = ms => new Promise(r => setTimeout(r, ms));
  async function readDownload(d) { const f = path.join(runtime, 'dl-' + crypto.randomBytes(4).toString('hex') + '.zip'); await d.saveAs(f); const buf = fs.readFileSync(f), files = fx.readZip(buf); return { buf, files, json: n => JSON.parse(files[n].toString('utf8')), text: buf.toString('latin1') + Object.keys(files).filter(n => !n.startsWith('media/')).map(n => files[n].toString('utf8')).join('\n') }; }
  // everything that identifies coach A / its clients, for hidden-DOM scans
  const A_MARKERS = ['clientA1', 'clientA2', 'clientStale', 'ana1@example.test', 'ana2@example.test', 'stale@e2e.invalid', 'Cliente Plan Eliminado', uidA, 'Meso activo', 'CLIENT_A_ONLY_SECRET_TEXT', 'Revisar rodilla', emailA];
  const leaks = (html, markers) => markers.filter(m => html.includes(m));
  const fullDom = p => p.evaluate(() => document.documentElement.outerHTML);
  const stashDom = p => p.evaluate(() => { const s = window._vdsenShellStash; if (!s) return null; const d = document.createElement('div'); d.appendChild(s.cloneNode(true)); return d.innerHTML; });

  try {
    const { ctx, p } = await newPage();
    await p.goto(APP + '/vdsen-coach.html'); await p.waitForSelector('#loginEmail');
    await p.evaluate(() => { window.__noReloadMarker = 1; });

    // ======== CASE A: coachA selects clientA1, opens the export dialog, logs out; coachB logs in ========
    await loginUi(p, emailA);
    check('A0_LOGIN_WITHOUT_RELOAD', (await ids(p)).includes('clientA1'));
    await openClient(p, 'clientA1'); await p.click('#modalExportClientBtn'); await p.waitForSelector('#clientExportDialog');
    await logoutUi(p);
    check('A1_EXPORT_DIALOG_DOES_NOT_SURVIVE_LOGOUT', !(await p.$('#clientExportDialog')));
    const stash = await stashDom(p);
    check('A2_PARKED_SHELL_HOLDS_NO_COACH_A_DATA', stash !== null && leaks(stash, A_MARKERS.filter(m => m !== 'Ana Pérez')).length === 0, leaks(stash || '', A_MARKERS).map(m => m + ' @ ' + JSON.stringify((stash || '').slice(Math.max(0, stash.indexOf(m) - 90), stash.indexOf(m) + 50))).join(' ;; ').slice(0, 1500));
    check('A2b_LOGIN_SCREEN_HOLDS_NO_COACH_A_DATA', leaks(await fullDom(p), A_MARKERS).length === 0);
    await loginUi(p, emailB);
    const idsB = await ids(p), domB = await fullDom(p);
    check('A3_COACH_B_SEES_ONLY_OWN_CLIENTS', idsB.slice().sort().join(',') === 'clientB1,clientSameNameB', idsB.join(','));
    check('A4_NO_COACH_A_DATA_IN_DOM_AFTER_SWITCH', leaks(domB, A_MARKERS).length === 0, leaks(domB, A_MARKERS).join(','));
    const st = await p.evaluate(() => { const b = document.getElementById('modalExportClientBtn'), d = document.getElementById('modalDeleteClientBtn'); return { exp: b.style.display + '|' + !!b.onclick, del: d.style.display + '|' + !!d.onclick, title: document.getElementById('modalClientName').textContent, body: document.getElementById('modalClientBody').innerHTML.trim(), dialog: !!document.getElementById('clientExportDialog'), modalOpen: [...document.querySelectorAll('.modal-overlay')].some(m => getComputedStyle(m).display !== 'none') }; });
    check('A5_EXPORT_AND_DELETE_BINDINGS_CLEARED_AND_MODAL_RESET', st.exp === 'none|false' && st.del === 'none|false' && st.title === '—' && st.body === '' && !st.dialog && !st.modalOpen, JSON.stringify(st));
    // coachB tries to drive an export for coachA's client through the dialog: fails closed
    const dlB0 = p.downloads.length;
    await p.evaluate(() => window._vdsenOpenClientExport('clientA1', 'Ana Pérez')); await p.waitForSelector('#clientExportDialog');
    await p.evaluate(() => { [...document.querySelectorAll('#clientExportDialog button')].find(x => x.textContent.trim() === 'Exportar').click(); });
    await p.waitForFunction(() => /no pudo completarse/.test((document.getElementById('clientExportDialog') || { textContent: '' }).textContent), null, { timeout: 20000 });
    const errTxt = await dialogText(p);
    check('A6_COACH_B_CANNOT_EXPORT_COACH_A_CLIENT', p.downloads.length === dlB0 && /No tienes permiso/.test(errTxt) && !/FirebaseError|permission-denied|Error:/.test(errTxt));
    await p.evaluate(() => { const d = document.getElementById('clientExportDialog'); if (d) d.remove(); });

    // ======== CASE C: coachB (same-name clients) in the same tab; authoritative clientId isolation ========
    const c1 = await exportViaUi(p, 'clientB1'); const zc1 = await readDownload(c1.download);
    check('C1_COACH_B_EXPORT_CLIENTB1_ONLY', zc1.json('manifest.json').client_id === 'clientB1' && zc1.json('manifest.json').coach_id === uidB && /CLIENT_B_ONLY_SECRET_TEXT/.test(zc1.text) && leaks(zc1.text, A_MARKERS).length === 0, leaks(zc1.text, A_MARKERS).join(','));
    const c2 = await exportViaUi(p, 'clientSameNameB'); const zc2 = await readDownload(c2.download);
    check('C2_SAME_NAME_CLIENT_ISOLATED_AFTER_COACH_SWITCH', zc2.json('manifest.json').client_id === 'clientSameNameB' && !/ana3@example\.test|Plan de B1|clientB1/.test(zc2.text) && leaks(zc2.text, A_MARKERS).length === 0 && zc1.json('manifest.json').client_id !== zc2.json('manifest.json').client_id);

    // ======== CASE B: coachA exports clientA1, logs out, logs back in WITHOUT reload, exports clientA2 ========
    await logoutUi(p); await loginUi(p, emailA);
    check('B0_RELOGIN_WITHOUT_RELOAD', await p.evaluate(() => window.__noReloadMarker === 1) && (await ids(p)).includes('clientA2'));
    const b1 = await exportViaUi(p, 'clientA1'); const zb1 = await readDownload(b1.download);
    check('B1_FIRST_EXPORT_CLIENTA1', zb1.json('manifest.json').client_id === 'clientA1' && b1.count === 1 && /CLIENT_A_ONLY_SECRET_TEXT/.test(zb1.text));
    await logoutUi(p); await loginUi(p, emailA);
    const b2 = await exportViaUi(p, 'clientA2'); const zb2 = await readDownload(b2.download);
    check('B2_SECOND_EXPORT_AFTER_LOGOUT_LOGIN_CONTAINS_ONLY_CLIENTA2', zb2.json('manifest.json').client_id === 'clientA2' && /NOTA-DE-A2-NO-FILTRAR/.test(zb2.text) && !/ana1@example\.test|Meso activo|CLIENT_A_ONLY_SECRET_TEXT|clientA1|CLIENT_B_ONLY/.test(zb2.buf.toString('latin1') + zb2.text) && b2.count === 1);

    // ======== STALE activePlanId + export ========
    await openClient(p, 'clientStale');
    await p.click('#ctab_plan'); await p.waitForTimeout(500);
    const planTxt = await p.evaluate(() => document.getElementById('clientDetailTabContent').innerText);
    check('S1_STALE_PLAN_DETAIL_OPENS_WITH_BROKEN_REFERENCE_STATE', /Referencia de plan rota/.test(planTxt) && /Cliente Plan Eliminado/.test(await p.evaluate(() => document.getElementById('modalClientName').textContent)));
    check('S2_EXPORT_BUTTON_AVAILABLE_FOR_OWNED_STALE_CLIENT', await p.isVisible('#modalExportClientBtn'));
    const s3 = await exportViaUi(p, 'clientStale'); const zs = s3.download ? await readDownload(s3.download) : null;
    const ms = zs && zs.json('manifest.json');
    check('S3_EXPORT_SUCCEEDS_WITH_REFERENCED_PLAN_UNREADABLE_WARNING', !!ms && ms.client_id === 'clientStale' && ms.complete === true && ms.warnings.some(w => w.code === 'REFERENCED_PLAN_UNREADABLE' && w.id === 'PDELETED') && zs.json('entrenamiento.json').plans.length === 0);
    const uiText = await p.evaluate(() => document.body.innerText);
    check('S4_NO_RAW_FIRESTORE_ERROR_IN_UI', !/FirebaseError|permission-denied|Missing or insufficient/i.test(uiText));
    check('S5_NO_DATA_MUTATION_NO_FAKE_PLAN_ACTIVEPLANID_UNCHANGED', (await snap()) === before);

    check('Z1_NO_PAGE_ERRORS_WHOLE_RUN', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
    check('Z2_LOCAL_ONLY_NETWORK', blocked.length === 0 && nonLocal.length === 0, blocked.concat(nonLocal).slice(0, 3).join(' , '));
    await ctx.close();
  } finally { await browser.close(); }
  const failed = results.filter(r => !r.pass);
  console.log('# pass ' + (results.length - failed.length)); console.log('# fail ' + failed.length);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  return failed.length ? 1 : 0;
}

async function shutdown() { await stopAll(); try { if (runtime && path.basename(runtime).startsWith('vdsen-cenext-') && path.dirname(runtime) === fs.realpathSync(os.tmpdir())) fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
for (const s of ['SIGINT', 'SIGTERM']) process.once(s, async () => { await shutdown(); process.exit(130); });
main().then(async code => { await shutdown(); process.exit(code); }, async e => { console.error('[e2e] ' + (e && e.stack || e)); await shutdown(); process.exit(1); });
