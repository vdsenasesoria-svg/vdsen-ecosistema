'use strict';
// Shared LOCAL harness for the Coach image-upload suites: Auth + Firestore + Cloud Storage emulators started by firebase-tools from the REPOSITORY rules
// (firestore.rules + storage.rules). Test-only packages go to a private temp dir (removed by cleanup()). Nothing here contacts production/staging.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const PROJECT = 'demo-vdsen-e2e';
const BUCKET = PROJECT + '.appspot.com';
const TEST_PACKAGES = ['firebase-admin@13.10.0', 'firebase-tools@13.35.1', 'firebase@10.12.0', 'esbuild@0.25.10', 'tailwindcss@3.4.17'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = p => new Promise(res => { const s = net.connect({ host: '127.0.0.1', port: p }); const d = v => { s.destroy(); res(v); }; s.setTimeout(500, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false)); });
async function waitPort(p, what) { for (let i = 0; i < 240; i++) { if (await portOpen(p)) return; await sleep(250); } throw new Error(what + ' did not start on ' + p); }

let runtime = null; const procs = [];
function installPackages() {
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-img-'));
  const inst = spawnSync('npm', ['install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', ...TEST_PACKAGES], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (inst.status !== 0) throw new Error('installing test packages failed');
  return runtime;
}
async function startStack() {
  const ports = { fs: await freePort(), auth: await freePort(), storage: await freePort(), hub: await freePort() };
  // firebase-tools only accepts rule files inside the project dir: run it from the temp runtime with verbatim COPIES of the repository rules.
  for (const f of ['firestore.rules', 'storage.rules']) fs.copyFileSync(path.join(repo, f), path.join(runtime, f));
  const cfg = {
    firestore: { rules: 'firestore.rules' },
    storage: { rules: 'storage.rules' },
    emulators: { auth: { host: '127.0.0.1', port: ports.auth }, firestore: { host: '127.0.0.1', port: ports.fs }, storage: { host: '127.0.0.1', port: ports.storage }, hub: { host: '127.0.0.1', port: ports.hub }, ui: { enabled: false }, singleProjectMode: true }
  };
  fs.writeFileSync(path.join(runtime, 'firebase.json'), JSON.stringify(cfg));
  procs.push(spawn(process.execPath, [path.join(runtime, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'), 'emulators:start', '--only', 'auth,firestore,storage', '--project', PROJECT, '--config', path.join(runtime, 'firebase.json')],
    { cwd: runtime, env: Object.assign({}, process.env, { CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' }), stdio: ['ignore', fs.openSync(path.join(runtime, 'emu.out'), 'w'), fs.openSync(path.join(runtime, 'emu.err'), 'w')] }));
  try { await waitPort(ports.auth, 'Auth Emulator'); await waitPort(ports.fs, 'Firestore Emulator'); await waitPort(ports.storage, 'Storage Emulator'); }
  catch (e) { for (const f of ['emu.out', 'emu.err']) { try { console.error('--- ' + f + '\n' + fs.readFileSync(path.join(runtime, f), 'utf8').slice(-1500)); } catch (x) { /* ignore */ } } throw e; }
  return ports;
}
async function stopAll() {
  for (const p of procs.splice(0)) { try { p.kill('SIGTERM'); await Promise.race([new Promise(r => p.once('exit', r)), sleep(8000)]); if (p.exitCode === null) p.kill('SIGKILL'); } catch (e) { /* ignore */ } }
}
async function cleanup() {
  await stopAll();
  try { if (runtime && path.basename(runtime).startsWith('vdsen-img-') && path.dirname(runtime) === fs.realpathSync(os.tmpdir())) fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
async function signUp(authPort, email, password) {
  const r = await fetch('http://127.0.0.1:' + authPort + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.localId) throw new Error('signUp failed ' + JSON.stringify(j)); return j.localId;
}
// Local replacements for the CDN assets (Firebase SDK 10.12.0 ESM via esbuild incl. storage, Tailwind v3 CSS).
function buildStaticAssets() {
  const bin = n => path.join(runtime, 'node_modules', '.bin', n), out = path.join(runtime, 'sdk');
  fs.mkdirSync(out, { recursive: true });
  spawnSync(process.execPath, [path.join(runtime, 'node_modules', 'esbuild', 'install.js')], { stdio: 'ignore' });
  const mods = [['e-app.js', 'firebase/app'], ['e-auth.js', 'firebase/auth'], ['e-fs.js', 'firebase/firestore'], ['e-st.js', 'firebase/storage']];
  for (const [f, mod] of mods) fs.writeFileSync(path.join(runtime, f), "export * from '" + mod + "';\n");
  let r = spawnSync(bin('esbuild'), mods.map(m => path.join(runtime, m[0])).concat(['--bundle', '--format=esm', '--splitting', '--platform=browser', '--minify', '--outdir=' + out]), { cwd: runtime, encoding: 'utf8' });
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
// In-memory patch of the Coach page: demo project + local emulators (Auth, Firestore, Storage). Emulator download URLs are http://127.0.0.1…, which the
// page's HTTPS-only validation rightly refuses, so getDownloadURL is rewritten (test harness only) to the SAME path on an https fake host that the browser
// harness proxies back to the Storage emulator (see FAKE_STORAGE_HOST). Production code in the repository is untouched.
const FAKE_STORAGE_HOST = 'storage-emulator.e2e.invalid';
function patchHtml(html, ports, css) {
  let h = html; const rep = (a, b) => { if (!h.includes(a)) throw new Error('patch anchor missing: ' + a); h = h.replace(a, () => b); };
  rep('<script src="https://cdn.tailwindcss.com"></script>', '<style>' + css + '</style>');
  rep('import { getAuth, signOut,', 'import { getAuth, connectAuthEmulator, signOut,');
  rep('import { getFirestore, doc,', 'import { getFirestore, connectFirestoreEmulator, doc,');
  rep('import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject }', 'import { getStorage, connectStorageEmulator, ref as storageRef, uploadBytes, getDownloadURL as _gdu, deleteObject }');
  rep('projectId: "vdsen-ecosistema"', 'projectId: "' + PROJECT + '"');
  rep('authDomain: "vdsen-ecosistema.firebaseapp.com"', 'authDomain: "' + PROJECT + '.firebaseapp.com"');
  rep('storageBucket: "vdsen-ecosistema.firebasestorage.app"', 'storageBucket: "' + BUCKET + '"');
  rep('const storage = getStorage(app);', 'const storage = getStorage(app);\n  const getDownloadURL = async r => { const u = new URL(await _gdu(r)); u.protocol = "https:"; u.host = "' + FAKE_STORAGE_HOST + '"; return u.toString(); };\n  window.__vdsenStorageHits = [];\n  connectStorageEmulator(storage, "127.0.0.1", ' + ports.storage + ');');
  rep('const db = getFirestore(app);', 'const db = getFirestore(app);\n  if (!/^demo-/.test(firebaseConfig.projectId)) throw new Error("E2E guard: not a demo project");\n  connectAuthEmulator(auth, "http://127.0.0.1:' + ports.auth + '", { disableWarnings: true });\n  connectFirestoreEmulator(db, "127.0.0.1", ' + ports.fs + ');');
  return h;
}
module.exports = { repo, PROJECT, BUCKET, FAKE_STORAGE_HOST, installPackages, startStack, stopAll, cleanup, signUp, buildStaticAssets, patchHtml, get runtime() { return runtime; } };
