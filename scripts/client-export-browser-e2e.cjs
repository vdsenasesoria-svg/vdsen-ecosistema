#!/usr/bin/env node
'use strict';
// LOCAL browser E2E of the Coach "Exportar cliente" flow: the REAL Coach UI (vdsen-coach.html, served from the working tree) in headless Chromium,
// logged in through the Firebase AUTH EMULATOR, reading from the FIRESTORE EMULATOR loaded with the repository's firestore.rules. Synthetic data only.
//   NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-export-browser-e2e.cjs [--shots <dir>] [--out <results.json>]
// Needs: Playwright + Chromium (existing tooling, see scripts/client-browser-lib.cjs), java, node>=18, npm. Test-only packages (firebase-admin, firebase-tools for the
// Auth emulator) are installed into a private temp dir that is removed on exit -- nothing is added to the repo. Never contacts a real Firebase project:
// the page's firebaseConfig is swapped in memory for a demo-* project wired to localhost, and every non-allow-listed network request is aborted and fails the run.
// No internet at all: the CDN assets the page boots from are rebuilt locally -- Firebase JS SDK 10.12.0 ESM (esbuild bundles of the npm package, served at the gstatic URLs the page imports),
// Tailwind v3 CSS generated from vdsen-coach.html (replaces the CDN script), empty stubs for jsPDF/pdf.js/fonts. Layout fidelity caveat: web fonts fall back to system fonts.
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
const shots = arg('shots', null), outFile = arg('out', null);
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
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-cebrowser-'));
  const inst = spawnSync('npm', ['install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', ...TEST_PACKAGES], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (inst.status !== 0) throw new Error('installing test packages failed');
  const ports = await startEmulators();
  const assets = buildStaticAssets();
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + ports.fs; process.env.GCLOUD_PROJECT = PROJECT; process.env.METADATA_SERVER_DETECTION = 'none';
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_AUTH_EMULATOR_HOST']) delete process.env[k];
  const req = require('node:module').createRequire(path.join(runtime, 'noop.js'));
  const { initializeApp: initAdmin } = req('firebase-admin/app'), { getFirestore: adminFs } = req('firebase-admin/firestore');
  const fx = require('../tests/helpers/client-export-fixture.js'), UIT = require('../assets/client-export/ui.js');
  console.log('[e2e] project=' + PROJECT + ' firestore=127.0.0.1:' + ports.fs + ' auth=127.0.0.1:' + ports.auth + ' rules=firestore.rules');

  // ---- synthetic identities + data (Coach-facing topology: clients/{id}.coachId == coach uid)
  const PASS = 'E2e-pass-123', emailA = 'coach-a@e2e.invalid', emailB = 'coach-b@e2e.invalid';
  const uidA = await signUp(ports.auth, emailA, PASS), uidB = await signUp(ports.auth, emailB, PASS);
  const base = fx.build();
  base.clients.clientLong = { coachId: 'coachA', displayName: 'Nombre-Extremadamente-Largo-Sin-Espacios-Ñandú-' + 'x'.repeat(100), role: 'client', activePlanId: null };
  base.clients.clientStale = { coachId: 'coachA', displayName: 'Cliente Plan Eliminado', role: 'client', activePlanId: 'PDELETED' };
  base.logs.clientStale = { planId: 'PDELETED', currentWeek: 1, updatedAt: 1700000000000, entries: { log_1_0_0_s0: { carga: 10, reps: 5, unit: 'kg', done: true, ts: '2026-02-01T10:00:00.000Z' } } };
  const seeded = JSON.parse(JSON.stringify(base).replace(/coachA/g, uidA).replace(/coachB/g, uidB));
  const adb = adminFs(initAdmin({ projectId: PROJECT }, 'e2e-seed'));
  for (const col of Object.keys(seeded)) for (const id of Object.keys(seeded[col])) await adb.doc(col + '/' + id).set(seeded[col][id]);
  const NOW_DAY = new Date();
  const pad = n => (n < 10 ? '0' : '') + n, today = NOW_DAY.getFullYear() + '-' + pad(NOW_DAY.getMonth() + 1) + '-' + pad(NOW_DAY.getDate());

  const browser = await B.launch();
  // The Coach page is served from a plain-HTTP loopback server (same address space as the emulators: no mixed-content / private-network issues).
  const http = require('node:http'), MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const appServer = http.createServer((rq, rs) => {
    const u = decodeURIComponent(new URL(rq.url, 'http://x').pathname), f = path.join(repo, u === '/' ? 'vdsen-coach.html' : u);
    if (!f.startsWith(repo) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { rs.writeHead(404); return rs.end(); }
    let body = fs.readFileSync(f); if (path.basename(f) === 'vdsen-coach.html') body = Buffer.from(patchHtml(body.toString('utf8'), ports, assets.css));
    rs.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); rs.end(body);
  });
  await new Promise(r => appServer.listen(0, '127.0.0.1', r)); const APP = 'http://127.0.0.1:' + appServer.address().port;
  procs.push({ kill: () => appServer.close(), once: (e, f) => f(), get exitCode() { return 0; } });
  const blocked = [], nonLocal = [];
  async function newPage(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, serviceWorkers: 'block' });
    // Only http://127.0.0.1 is reachable. https (CDN) requests are answered from local builds or aborted and recorded.
    await ctx.route(u => u.protocol !== 'http:' || u.hostname !== '127.0.0.1', async route => {
      const url = route.request().url();
      if (/^data:|^blob:/.test(url)) return route.continue();
      const l = assets.local(url);
      if (l) return route.fulfill({ status: 200, contentType: l.contentType, headers: { 'access-control-allow-origin': '*' }, body: l.body });
      blocked.push(url); return route.abort();
    });
    if (process.env.E2E_DEBUG) await ctx.addInitScript(() => { window.addEventListener('error', e => console.error('ERR@ ' + e.filename + ':' + e.lineno + ':' + e.colno + ' ' + e.message)); });
    await ctx.addInitScript(() => { window.__urls = { created: 0, revoked: 0 }; const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL); URL.createObjectURL = o => { window.__urls.created++; return c(o); }; URL.revokeObjectURL = u => { window.__urls.revoked++; return r(u); }; });
    const p = await ctx.newPage(); p.setDefaultTimeout(30000);
    p.on('request', r => { const u = r.url(); if (r.method() !== 'GET' && !/^http:\/\/127\.0\.0\.1:/.test(u)) nonLocal.push(r.method() + ' ' + u); });
    p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    if (process.env.E2E_DEBUG) { const cdp = await ctx.newCDPSession(p); await cdp.send('Runtime.enable'); cdp.on('Runtime.exceptionThrown', e => { const d = e.exceptionDetails; console.log('[exc]', (d.exception && d.exception.description || d.text || '').split('\n').slice(0, 5).join(' | ').slice(0, 600), d.url || '', d.lineNumber + ':' + d.columnNumber); }); }
    if (process.env.E2E_DEBUG) { p.on('console', m => { if (m.type() === 'error') console.log('[browser]', m.text().slice(0, 220)); }); p.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 220))); p.on('requestfailed', r => console.log('[reqfail]', r.url().slice(0, 140))); }
    p.downloads = []; p.on('download', d => p.downloads.push(d));
    return { ctx, p };
  }
  const shot = async (p, n) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await p.screenshot({ path: path.join(shots, n + '.png') }); } };
  async function login(p, email) {
    await p.goto(APP + '/vdsen-coach.html'); await p.waitForSelector('#loginEmail');
    await p.fill('#loginEmail', email); await p.fill('#loginPass', PASS); await p.click('#loginBtn');
    // Pre-existing Coach behaviour (not export code): the logged-out screen replaces document.body, so right after an in-page sign-in the shell is gone
    // (initCoachUI hits null elements). A reload restores the persisted session and renders the real Coach shell, which is what we exercise.
    await sleep(2500); await p.reload(); await p.waitForSelector('#clientList', { state: 'attached', timeout: 30000 });
    try { await p.waitForSelector('#clientList button[onclick*="showClientDetail"]', { timeout: 45000 }); }
    catch (e) { const t = await p.evaluate(() => ({ err: (document.getElementById('loginErr') || {}).textContent, list: (document.getElementById('clientList') || {}).innerHTML, body: document.body.innerText.slice(0, 300) })); console.log('[login-debug]', JSON.stringify(t).slice(0, 700)); if (process.env.E2E_DEBUG) console.log('[probe]', await p.evaluate(async u => { try { const r = await fetch(u); return r.status + ' ' + (await r.text()).slice(0, 60); } catch (e) { return 'ERR ' + e.message; } }, 'http://127.0.0.1:' + ports.auth + '/')); await shot(p, 'login-failed'); throw e; }
  }
  async function openClient(p, id) {
    await p.click('#clientList button[onclick^="showClientDetail(\'' + id + '\')"]');
    await p.waitForFunction(() => { const b = document.getElementById('modalExportClientBtn'); return b && b.style.display !== 'none' && !!b.onclick; }, null, { timeout: 30000 });
  }
  async function closeModal(p) { await p.evaluate(() => { const m = document.getElementById('clientModal'); if (m) m.style.display = 'none'; const d = document.getElementById('clientExportDialog'); if (d) d.remove(); }); }
  const dialogText = p => p.evaluate(() => (document.getElementById('clientExportDialog') || { textContent: '' }).textContent);
  const clickIn = (p, label) => p.evaluate(l => { const b = [...document.querySelectorAll('#clientExportDialog button')].find(x => x.textContent.trim() === l); b.click(); }, label);
  async function exportViaUi(p, id, { double = false } = {}) {
    await openClient(p, id);
    await p.click('#modalExportClientBtn'); await p.waitForSelector('#clientExportDialog');
    await p.evaluate(() => { window.__status = []; const st = document.querySelector('#clientExportDialog [aria-live]'); new MutationObserver(() => window.__status.push(st.textContent)).observe(st, { childList: true, characterData: true, subtree: true }); });
    const before = p.downloads.length;
    const dl = p.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await p.evaluate(d => { const b = [...document.querySelectorAll('#clientExportDialog button')].find(x => x.textContent.trim() === 'Exportar'); b.click(); if (d) { b.click(); b.click(); } }, double);
    const d = await dl; await sleep(700);
    return { download: d, count: p.downloads.length - before, status: await p.evaluate(() => window.__status.slice()) };
  }
  async function readDownload(d) { const f = path.join(runtime, 'dl-' + crypto.randomBytes(4).toString('hex') + '.zip'); await d.saveAs(f); const buf = fs.readFileSync(f); const files = fx.readZip(buf); return { buf, files, json: n => JSON.parse(files[n].toString('utf8')), text: Object.keys(files).filter(n => !n.startsWith('media/')).map(n => files[n].toString('utf8')).join('\n') }; }

  try {
    // ======================= DESKTOP =======================
    const { ctx, p } = await newPage(1280, 800);
    await login(p, emailA); await shot(p, 'desktop-01-dashboard');
    check('COACH_LOGIN_VIA_AUTH_EMULATOR', await p.isVisible('#clientList'), 'signed in as coachA (' + uidA.slice(0, 6) + '…)');
    const listHtml = await p.innerHTML('#clientList');
    check('CLIENT_LIST_SHOWS_OWN_CLIENTS_ONLY', ['clientA1', 'clientA2', 'clientLong', 'clientStale'].every(i => listHtml.includes("showClientDetail('" + i + "')")) && !listHtml.includes('clientB1') && !listHtml.includes('clientSameNameB'));
    await openClient(p, 'clientA1'); await shot(p, 'desktop-02-client');
    check('EXPORT_BUTTON_IN_SELECTED_CLIENT', await p.isVisible('#modalExportClientBtn') && /Exportar cliente/.test(await p.textContent('#modalExportClientBtn')));
    // cancel flow
    await p.click('#modalExportClientBtn'); await p.waitForSelector('#clientExportDialog'); await shot(p, 'desktop-03-confirm');
    const dtxt = await dialogText(p);
    check('CONFIRM_DIALOG_TEXT', dtxt.includes('Exportar cliente') && dtxt.includes('Ana Pérez') && dtxt.includes(UIT.TEXT.message) && /datos sensibles/.test(dtxt) && /farmacolog/i.test(dtxt));
    const noDl = p.waitForEvent('download', { timeout: 2500 }).then(() => false, () => true);
    await clickIn(p, 'Cancelar'); const cancelledNoDownload = await noDl;
    check('CANCEL_NO_DOWNLOAD', cancelledNoDownload && p.downloads.length === 0 && !(await p.$('#clientExportDialog')));
    // export (double click) from the same, still-open client
    await closeModal(p);
    const ex = await exportViaUi(p, 'clientA1', { double: true });
    check('PROGRESS_STATE_SHOWN', ex.status.includes('Preparando exportación...'), JSON.stringify(ex.status));
    check('DUPLICATE_CLICK_ONE_DOWNLOAD', ex.count === 1, 'downloads=' + ex.count);
    check('ACTUAL_BROWSER_DOWNLOAD', !!ex.download);
    const name = ex.download && ex.download.suggestedFilename();
    check('DOWNLOAD_FILENAME', name === 'VDSEN_Ana-Perez_' + today + '_export.zip', name);
    const z = await readDownload(ex.download); const m = z.json('manifest.json'), c = z.json('vdsen-client-export-v1.json');
    for (const n of ['manifest.json', 'vdsen-client-export-v1.json', 'cliente.json', 'ficha360.json', 'biomecanica.json', 'metricas_corporales.json', 'entrenamiento.json', 'mesociclos.json', 'sesiones.json', 'rendimiento.json', 'adherencia.json', 'recuperacion.json', 'notas.json', 'nutricion.json', 'suplementos.json', 'rendimiento_sesiones.csv', 'adherencia.csv', 'metricas_corporales.csv', 'media/media-001.png']) if (!z.files[n]) check('ZIP_HAS_' + n, false);
    check('ZIP_IDS', m.client_id === 'clientA1' && m.coach_id === uidA && c.export_metadata.client_id === 'clientA1' && c.export_metadata.coach_id === uidA, 'coach_id=' + m.coach_id.slice(0, 6) + '…');
    check('ZIP_VALID_JSON_CSV_CRC_UNICODE', (() => { for (const n of Object.keys(z.files)) if (n.endsWith('.json')) JSON.parse(z.files[n].toString('utf8')); const t = fx.parseCsv(z.files['rendimiento_sesiones.csv'].toString('utf8')); return t.length === 12 && t.every(r => r.length === t[0].length) && /Tracción/.test(z.text) && /ñandú/.test(z.text) && c.client.display_name === 'Ana Pérez'; })());
    check('ZIP_COUNTS_AND_ORDER', JSON.stringify(c.training.sessions.map(s => s.session_id)) === JSON.stringify(['P1:w1:d0', 'P1:w1:d1', 'P1:w2:d0', 'P2:w1:d0', 'P2:w1:d1', 'P2:w2:d0', 'P2:w2:d1']) && m.record_counts.exercise_logs === 11 && m.record_counts.mesocycles === 2 && m.complete === true);
    check('ZIP_SENSITIVE_SECTIONS_AND_MEDIA', JSON.stringify(m.sensitive_sections) === '["pharmacology"]' && m.media_status.status === 'PARTIAL');
    check('ZIP_NO_OTHER_CLIENT_OR_SECRETS', !/CLIENT_B_ONLY_SECRET_TEXT|clientB1|clientSameNameB|SECRET-FCM|SECRET-API|SECRET-AT|BEGIN PRIVATE KEY/.test(z.buf.toString('latin1')) && /CLIENT_A_ONLY_SECRET_TEXT/.test(z.text));
    await p.waitForFunction(() => document.body.innerText.includes('Cliente exportado correctamente'), null, { timeout: 8000 }).then(() => check('SUCCESS_MESSAGE', true), () => check('SUCCESS_MESSAGE', false));
    check('DIALOG_CLOSED_AFTER_SUCCESS', !(await p.$('#clientExportDialog')));
    await sleep(4800);
    const urls = await p.evaluate(() => window.__urls); check('OBJECT_URL_RELEASED', urls.created === 1 && urls.revoked === urls.created, JSON.stringify(urls));
    await closeModal(p);

    // same-name UI
    const ex2 = await exportViaUi(p, 'clientA2'); const z2 = await readDownload(ex2.download), m2 = z2.json('manifest.json');
    check('SAME_NAME_UI_ISOLATION', m2.client_id === 'clientA2' && /NOTA-DE-A2-NO-FILTRAR/.test(z2.text) && !/clientA1|ana1@example\.test|Meso activo|CLIENT_A_ONLY_SECRET_TEXT|CLIENT_B_ONLY|clientSameNameB|clientB1/.test(z2.buf.toString('latin1')), ex2.download.suggestedFilename());
    await closeModal(p);

    // referenced plan missing (real rules answer permission-denied for a missing plan)
    const ex3 = await exportViaUi(p, 'clientStale');
    const z3 = ex3.download ? await readDownload(ex3.download) : null;
    check('REFERENCED_PLAN_WARNING_VIA_UI', !!z3 && z3.json('manifest.json').warnings.some(w => w.code === 'REFERENCED_PLAN_UNREADABLE' && w.id === 'PDELETED') && z3.json('manifest.json').complete === true);
    check('NO_STACK_IN_UI_AFTER_WARNING_EXPORT', !/Error|stack|\bat \w+ \(/.test(await p.evaluate(() => document.body.innerText.slice(0, 200000)).then(t => t.split('\n').filter(l => /exporta/i.test(l)).join('\n'))));
    const staleErrors = p.errors.filter(e => /permission|insufficient/i.test(e));
    await closeModal(p);

    // cross-coach: not visible; direct invocation fails closed
    const dlBefore = p.downloads.length;
    await p.evaluate(() => { window.showClientDetail('clientB1'); }); await sleep(2500);
    const btnState = await p.evaluate(() => { const b = document.getElementById('modalExportClientBtn'); return { display: b.style.display, bound: !!b.onclick }; });
    check('CROSS_COACH_DIRECT_NAV_NO_EXPORT_BINDING', btnState.display === 'none' && !btnState.bound, JSON.stringify(btnState));
    await closeModal(p);
    await p.evaluate(() => window._vdsenOpenClientExport('clientB1', 'Ana Pérez')); await p.waitForSelector('#clientExportDialog');
    const noDl2 = p.waitForEvent('download', { timeout: 3000 }).then(() => false, () => true);
    await clickIn(p, 'Exportar'); await p.waitForFunction(() => /no pudo completarse/.test((document.getElementById('clientExportDialog') || { textContent: '' }).textContent), null, { timeout: 15000 });
    const errTxt = await dialogText(p); await shot(p, 'desktop-04-permission-error');
    check('PERMISSION_FAILURE_FAILS_CLOSED_NO_DOWNLOAD', (await noDl2) && p.downloads.length === dlBefore);
    check('PERMISSION_FAILURE_FRIENDLY_MESSAGE', /La exportación no pudo completarse\. No tienes permiso para leer todos los datos de este cliente\./.test(errTxt) && !/Error:|permission-denied|FirebaseError|at \w+|\.js|stack/i.test(errTxt), errTxt.replace(/\s+/g, ' ').slice(-120));
    check('PERMISSION_FAILURE_DIALOG_REUSABLE', await p.evaluate(() => [...document.querySelectorAll('#clientExportDialog button')].every(b => !b.disabled)));
    await closeModal(p);
    await p.evaluate(() => window._vdsenOpenClientExport('noCoach', 'Sin coach')); await p.waitForSelector('#clientExportDialog'); await clickIn(p, 'Exportar');
    await p.waitForFunction(() => /no pudo completarse/.test((document.getElementById('clientExportDialog') || { textContent: '' }).textContent), null, { timeout: 15000 });
    check('MISSING_OWNERSHIP_FAILS_CLOSED', p.downloads.length === dlBefore && !/Error:|FirebaseError/.test(await dialogText(p)));
    await closeModal(p);
    check('NO_UNEXPECTED_PAGE_ERRORS_EXPORT', p.errors.filter(e => /export|VDSEN_C/i.test(e)).length === 0, p.errors.length ? 'pre-existing page errors: ' + [...new Set(p.errors.map(e => e.slice(0, 80)))].join(' | ') : '');

    // coachB can only see/export its own
    const b = await newPage(1280, 800); await login(b.p, emailB);
    const lb = await b.p.innerHTML('#clientList');
    check('COACH_B_LIST_ISOLATED', lb.includes("showClientDetail('clientB1')") && lb.includes("showClientDetail('clientSameNameB')") && !lb.includes('clientA1') && !lb.includes('clientA2'));
    const exb = await exportViaUi(b.p, 'clientB1'); const zb = await readDownload(exb.download);
    check('COACH_B_EXPORTS_OWN_CLIENT_ONLY', zb.json('manifest.json').client_id === 'clientB1' && /CLIENT_B_ONLY_SECRET_TEXT/.test(zb.text) && !/CLIENT_A_ONLY|clientA1|clientA2/.test(zb.buf.toString('latin1')));
    await b.ctx.close();

    // ======================= MOBILE / RESPONSIVE =======================
    await ctx.close();
    const mob = await newPage(390, 844); const mp = mob.p; await login(mp, emailA); await shot(mp, 'mobile-01-dashboard');
    const fits = async (sel) => mp.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(), iw = window.innerWidth, ih = window.innerHeight; return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), iw, ih, ok: r.left >= 0 && r.right <= iw + 0.5 && r.top >= 0 && r.bottom <= ih + 0.5, sw: document.documentElement.scrollWidth }; }, sel);
    await openClient(mp, 'clientA1'); await shot(mp, 'mobile-02-client');
    const bf = await fits('#modalExportClientBtn');
    check('MOBILE_EXPORT_BUTTON_VISIBLE_IN_VIEWPORT', bf && bf.ok, JSON.stringify(bf));
    await mp.click('#modalExportClientBtn'); await mp.waitForSelector('#clientExportDialog'); await shot(mp, 'mobile-03-dialog');
    const df = await fits('#clientExportDialog > div'), cancelF = await mp.evaluate(() => { const bs = [...document.querySelectorAll('#clientExportDialog button')].map(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.width > 30; }); return bs.length === 2 && bs.every(Boolean); });
    check('MOBILE_DIALOG_FITS_AND_BUTTONS_VISIBLE', df && df.ok && cancelF && df.sw <= df.iw, JSON.stringify(df));
    await clickIn(mp, 'Cancelar'); await closeModal(mp);
    await openClient(mp, 'clientLong'); await mp.click('#modalExportClientBtn'); await mp.waitForSelector('#clientExportDialog'); await shot(mp, 'mobile-04-long-name');
    const lf = await fits('#clientExportDialog > div'), longBtns = await mp.evaluate(() => [...document.querySelectorAll('#clientExportDialog button')].every(b => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight; }));
    check('MOBILE_LONG_NAME_NO_OVERFLOW', lf && lf.ok && longBtns && lf.sw <= lf.iw, JSON.stringify(lf));
    await clickIn(mp, 'Cancelar'); await closeModal(mp);
    const mex = await exportViaUi(mp, 'clientA1'); const mz = mex.download ? await readDownload(mex.download) : null;
    check('MOBILE_EXPORT_DOWNLOADS', !!mz && mz.json('manifest.json').client_id === 'clientA1');
    await mob.ctx.close();

    // ======================= NETWORK GUARANTEE =======================
    check('LOCAL_ONLY_NO_BLOCKED_REQUESTS', blocked.length === 0, blocked.slice(0, 5).join(' , '));
    check('NO_NON_LOCAL_WRITES_OR_UPLOADS', nonLocal.length === 0, nonLocal.slice(0, 5).join(' , '));
    if (staleErrors.length) console.log('NOTE pre-existing Coach behaviour (not export code): opening a client whose activePlanId points to a missing plan raises: ' + staleErrors[0].slice(0, 120));
  } finally { await browser.close(); }
  const failed = results.filter(r => !r.pass);
  console.log('# pass ' + (results.length - failed.length)); console.log('# fail ' + failed.length);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  return failed.length ? 1 : 0;
}

async function shutdown() { await stopAll(); try { if (runtime && path.basename(runtime).startsWith('vdsen-cebrowser-') && path.dirname(runtime) === fs.realpathSync(os.tmpdir())) fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
for (const s of ['SIGINT', 'SIGTERM']) process.once(s, async () => { await shutdown(); process.exit(130); });
main().then(async code => { await shutdown(); process.exit(code); }, async e => { console.error('[e2e] ' + (e && e.stack || e)); await shutdown(); process.exit(1); });
