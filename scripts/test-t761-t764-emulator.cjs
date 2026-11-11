#!/usr/bin/env node
'use strict';
// Dedicated emulator runner for T761 (full autonomous cycle) & T764 (concurrent 10-client cohort).
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
const TEST_PACKAGES = ['firebase@10.12.0', 'firebase-admin@13.10.0'];
const isWin = process.platform === 'win32';
const JAVA_LOCALE_ARGS = [
  '-Duser.language=en',
  '-Duser.country=US',
  '-Duser.variant=',
  '-Dfile.encoding=UTF-8'
];

let runtime = null, port = null, emulator = null;
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function ensureJar() {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'emulators', JAR_NAME);
  if (fs.existsSync(cached) && sha256(cached) === JAR_SHA256) return cached;
  throw new Error('Jar not found in cache');
}

function installTestPackages() {
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm',
    ['install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit',
      '--no-fund', '--ignore-scripts', ...TEST_PACKAGES],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: isWin });
  if (r.status !== 0) throw new Error('Installing test packages failed');
}

async function startEmulator(jar) {
  port = await freePort();
  const out = fs.openSync(path.join(runtime, 'firestore-stdout.log'), 'w');
  const err = fs.openSync(path.join(runtime, 'firestore-stderr.log'), 'w');
  const rulesFile = 'firestore.t689.rules';
  emulator = spawn('java', [...JAVA_LOCALE_ARGS, '-jar', jar, '--host', '127.0.0.1', '--port', String(port),
    '--project_id', PROJECT, '--rules', path.join(repo, rulesFile),
    '--single_project_mode'], { cwd: repo, stdio: ['ignore', out, err], windowsHide: true });
  let exited = false;
  emulator.once('exit', () => { exited = true; });
  for (let i = 0; i < 150; i++) {
    if (exited) break;
    if (await portOpen(port) && await httpOk(port)) return;
    await sleep(200);
  }
  throw new Error('Firestore Emulator did not become ready');
}

async function stopEmulator() {
  if (!emulator) return;
  const child = emulator;
  emulator = null;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
    await Promise.race([exited, sleep(8000)]);
  }
}

function cleanRuntime() {
  if (runtime && fs.existsSync(runtime)) {
    try { fs.rmSync(runtime, { recursive: true, force: true }); } catch (_) {}
  }
}

async function main() {
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-t761-'));
  console.log('[T761/T764] Installing test packages in ' + runtime);
  installTestPackages();
  const jar = await ensureJar();
  console.log('[T761/T764] Starting Firestore emulator...');
  await startEmulator(jar);
  console.log('[T761/T764] Emulator ready at 127.0.0.1:' + port);

  const env = Object.assign({}, process.env, {
    NODE_PATH: path.join(runtime, 'node_modules'),
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:' + port,
    GCLOUD_PROJECT: PROJECT,
    METADATA_SERVER_DETECTION: 'none'
  });

  const suites = [
    { name: 'T761: Full Autonomous Cycle E2E', file: 'tests/t761-autonomous-e2e-cycle-emulator.cjs' },
    { name: 'T764: Concurrent Multi-Client Cohort', file: 'tests/t764-concurrent-multiclient-emulator.cjs' }
  ];

  let totalPass = 0, totalFail = 0, overallStatus = 0;
  for (const s of suites) {
    console.log('\n--- Running ' + s.name + ' ---');
    const r = spawnSync(process.execPath, ['--test', s.file], { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    const num = re => { const m = (r.stdout || '').match(re); return m ? Number(m[1]) : 0; };
    const p = num(/^(?:#|ℹ)\s*pass\s+(\d+)/m), f = num(/^(?:#|ℹ)\s*fail\s+(\d+)/m);
    totalPass += p; totalFail += f;
    if (r.status !== 0) overallStatus = r.status || 1;
  }

  console.log('\n========================================');
  console.log('[T761/T764] Total Pass: ' + totalPass + ' | Total Fail: ' + totalFail);
  console.log('========================================');
  return overallStatus;
}

main().then(async code => {
  await stopEmulator();
  cleanRuntime();
  process.exit(code);
}, async err => {
  console.error('[T761/T764 Error] ' + err.message);
  await stopEmulator();
  cleanRuntime();
  process.exit(1);
});
