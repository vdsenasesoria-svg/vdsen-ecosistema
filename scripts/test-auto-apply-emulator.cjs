#!/usr/bin/env node
// T478: portable, isolated runner for tests/t476-auto-apply-emulator.cjs.
// Cross-platform (Windows/Linux/macOS). Needs only node>=18, npm and java on PATH.
// Uses a demo Firebase project, the repo's firestore.rules and a localhost-only
// Firestore Emulator. Never contacts a production Firebase project and does not use
// the Auth Emulator. Temporary state (test SDKs, logs) lives in a private temp dir
// that is removed on exit.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const PROJECT = 'demo-vdsen-shadow';
const JAR_NAME = 'cloud-firestore-emulator-v1.19.8.jar';
const JAR_SHA256 = '9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d';
const JAR_URL = 'https://storage.googleapis.com/firebase-preview-drop/emulator/' + JAR_NAME;
// Test-only SDKs (not repo dependencies): the app-matched client SDK and the
// firebase-admin version T476 was validated with.
const TEST_PACKAGES = ['firebase@10.12.0', 'firebase-admin@13.10.0'];
// One entry per suite so the report keeps separate counts (portable T476 / lifecycle / Firestore rules security).
const SUITES = [
  { name: 'T476 portable', file: path.join('tests', 't476-auto-apply-emulator.cjs') },
  { name: 'lifecycle emulator', file: path.join('tests', 't532-lifecycle-emulator.cjs') },
  { name: 'rules security', file: path.join('tests', 't536-rules-security.cjs') },
  { name: 'tenant isolation', file: path.join('tests', 't538-tenant-isolation.cjs') },
  { name: 'coach authority', file: path.join('tests', 't539-coach-authority.cjs') },
  { name: 'active plan edit', file: path.join('tests', 't547-active-plan-edit.cjs') },
  { name: 'athlete note isolation', file: path.join('tests', 't549-note-isolation.cjs') },
  { name: 'plans create ownership', file: path.join('tests', 't552-plans-create-ownership.cjs') },
  { name: 'self-coach topology', file: path.join('tests', 't558-self-coach-topology.cjs') }
].filter(x => fs.existsSync(path.join(__dirname, '..', x.file)));
const ONLY = process.env.VDSEN_EMU_ONLY;   // e.g. "rules" to run a single suite (used for RED demonstrations)
const isWin = process.platform === 'win32';

let runtime = null;
let emulator = null;
let port = 0;

function fail(message) { throw new Error(message); }

function requireTool(cmd, args, hint) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: isWin });
  if (r.error || r.status !== 0) fail(hint);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close(() => resolve(p));
    });
  });
}

function portOpen(p) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: p });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function httpOk(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/', timeout: 1000 },
      res => { res.resume(); resolve(res.statusCode === 200); });
    req.once('error', () => resolve(false));
    req.once('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureJar() {
  // Reuse the jar firebase-tools already cached, if (and only if) its checksum matches.
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'emulators', JAR_NAME);
  if (fs.existsSync(cached) && sha256(cached) === JAR_SHA256) return cached;
  const target = path.join(runtime, JAR_NAME);
  const response = await fetch(JAR_URL);
  if (!response.ok) fail('Emulator download failed: HTTP ' + response.status);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  if (sha256(target) !== JAR_SHA256) fail('Firestore Emulator JAR checksum mismatch.');
  return target;
}

function installTestPackages() {
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm',
    ['install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit',
      '--no-fund', '--ignore-scripts', ...TEST_PACKAGES],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: isWin });
  if (r.status !== 0) fail('Installing test packages failed: ' + TEST_PACKAGES.join(', '));
  for (const pkg of TEST_PACKAGES) {
    const [name, version] = [pkg.slice(0, pkg.lastIndexOf('@')), pkg.slice(pkg.lastIndexOf('@') + 1)];
    const installed = JSON.parse(fs.readFileSync(
      path.join(runtime, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (installed !== version) fail(name + ' resolved to ' + installed + ', expected ' + version);
  }
}

async function startEmulator(jar) {
  port = await freePort();
  const out = fs.openSync(path.join(runtime, 'firestore-stdout.log'), 'w');
  const err = fs.openSync(path.join(runtime, 'firestore-stderr.log'), 'w');
  emulator = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port),
    '--project_id', PROJECT, '--rules', path.join(repo, 'firestore.rules'),
    '--single_project_mode'], { cwd: repo, stdio: ['ignore', out, err], windowsHide: true });
  let exited = false;
  emulator.once('exit', () => { exited = true; });
  for (let i = 0; i < 150; i++) {
    if (exited) break;
    if (await portOpen(port) && await httpOk(port)) return;
    await sleep(200);
  }
  const log = fs.existsSync(path.join(runtime, 'firestore-stderr.log'))
    ? fs.readFileSync(path.join(runtime, 'firestore-stderr.log'), 'utf8').split('\n').slice(-12).join('\n') : '';
  fail('Firestore Emulator did not become ready.\n' + log);
}

async function stopEmulator() {
  if (!emulator) return;
  const child = emulator;
  emulator = null;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
    const timeout = sleep(8000).then(() => 'timeout');
    if (await Promise.race([exited, timeout]) === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  }
  if (port && await portOpen(port)) fail('Emulator port ' + port + ' remained open after shutdown.');
}

function cleanRuntime() {
  // Only ever delete the private directory this process created.
  if (runtime && path.basename(runtime).startsWith('vdsen-t476-') &&
      path.dirname(runtime) === fs.realpathSync(os.tmpdir())) {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
  runtime = null;
}

async function main() {
  requireTool('node', ['--version'], 'Node.js is required.');
  requireTool('npm', ['--version'], 'npm is required to install the test SDKs.');
  requireTool('java', ['-version'], 'Java is required for the Firestore Emulator.');
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-t476-'));
  installTestPackages();
  const jar = await ensureJar();
  await startEmulator(jar);
  // Explicit environment: drop anything that could point the SDKs at a real project.
  const env = Object.assign({}, process.env, {
    NODE_PATH: path.join(runtime, 'node_modules'),
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:' + port,
    GCLOUD_PROJECT: PROJECT,
    METADATA_SERVER_DETECTION: 'none' // no GCE metadata/credential lookups
  });
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT',
    'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_PREFER_REST']) delete env[key];
  console.log('[t476] project=' + PROJECT + ' emulator=127.0.0.1:' + port +
    ' rules=firestore.rules jar=' + JAR_NAME + ' sha256=' + JAR_SHA256);
  let pass = 0, fail = 0, status = 0;
  for (const suite of SUITES.filter(x => !ONLY || x.name.includes(ONLY))) {
    const r = spawnSync(process.execPath, ['--test', suite.file], { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    const num = re => { const m = (r.stdout || '').match(re); return m ? Number(m[1]) : 0; };
    const p = num(/^# pass (\d+)/m), f = num(/^# fail (\d+)/m);
    console.log('[suite] ' + suite.name + ': pass=' + p + ' fail=' + f);
    pass += p; fail += f; if (r.status !== 0) status = r.status === null ? 1 : r.status;
  }
  console.log('# pass ' + pass); console.log('# fail ' + fail);
  return status;
}

async function shutdown() {
  let problem = null;
  try { await stopEmulator(); } catch (e) { problem = e; }
  try { cleanRuntime(); } catch (e) { problem = problem || e; }
  return problem;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await shutdown(); process.exit(130); });
}

main().then(async code => {
  const problem = await shutdown();
  if (problem) { console.error('[t476] ' + problem.message); process.exit(code || 1); }
  process.exit(code);
}, async error => {
  console.error('[t476] ' + error.message);
  await shutdown();
  process.exit(1);
});
