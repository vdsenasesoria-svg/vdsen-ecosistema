#!/usr/bin/env node
'use strict';
// VDSEN Image Upload v2 — repo-owned acceptance orchestrator.
//
// Runs EVERYTHING the Image Upload contract requires from a fresh clone of THIS repository, with no
// dependency on vdsen-operator-tools or any external workspace:
//
//   1. fixture server (server.cjs) over the real vdsen-coach.html, transformed in memory
//   2. Chromium with CDP (pinned Playwright browser build)
//   3. browser acceptance desktop  1280x800  -> DESKTOP_ACCEPTANCE=PASS
//   4. browser acceptance mobile    390x844  -> MOBILE_ACCEPTANCE=PASS
//   5. failure injection F01-F12 + deterministic POST_COMMIT_UI_ISOLATION (real barriers)
//   6. real-emulator positive E2E (Auth + Firestore + Storage, demo-vdsen-image-upload)
//
// TEST TOOLING IS NOT A PRODUCT DEPENDENCY: everything is installed into a disposable temp runtime
// (never package.json) and removed on exit. package.json stays byte-identical for check.cjs.
//
//   node scripts/image-upload-e2e/run-image-upload-acceptance.cjs [--skip-emulators] [--keep-runtime]
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const arg = (n) => process.argv.includes('--' + n);
const KEEP_RUNTIME = arg('keep-runtime');
const SKIP_EMULATORS = arg('skip-emulators');

// Pinned, exact: the product loads firebase 10.12.0 from the CDN, the workflow pins firebase-tools
// 15.32.1, and Playwright's version decides the Chromium build (reproducible browser).
const FIREBASE_SDK = '10.12.0';
const FIREBASE_TOOLS = '15.32.1';
const PLAYWRIGHT = '1.63.0';
const CDP_PORT = +(process.env.CDP_PORT || 9222);
const SERVER_PORT = +(process.env.HARNESS_PORT || 8789);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port: p }); const d = v => { s.destroy(); res(v); }; s.setTimeout(400, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false)); });
async function waitPort(p, what, tries = 100) { for (let i = 0; i < tries; i++) { if (await portOpen(p)) return; await sleep(250); } throw new Error(what + ' did not start on ' + p); }

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok, detail: detail || '' });
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? '  ' + detail : ''));
}

// npm is npm.cmd on Windows, which spawnSync cannot run without shell:true (and shell:true breaks
// arg quoting). Resolving the real npm-cli.js and running it with THIS node is portable and exact.
function npmBin() {
  if (process.platform === 'win32') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli] };
  }
  return { cmd: 'npm', prefix: [] };
}

let runtime = null;
const procs = [];
function spawnTracked(cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  procs.push(p);
  return p;
}
async function stopAll() {
  for (const p of procs.splice(0)) {
    try { p.kill('SIGTERM'); await Promise.race([new Promise(r => p.once('exit', r)), sleep(4000)]); if (p.exitCode === null) p.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }
}

function ensureRuntime() {
  runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-image-e2e-'));
  const marker = path.join(runtime, 'node_modules', 'playwright', 'package.json');
  if (!fs.existsSync(marker)) {
    console.log('[acceptance] installing pinned test packages into disposable runtime...');
    const npm = npmBin();
    const inst = spawnSync(npm.cmd, [...npm.prefix, 'install', '--prefix', runtime, '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
      '--ignore-scripts', 'playwright@' + PLAYWRIGHT, 'firebase-tools@' + FIREBASE_TOOLS, 'firebase@' + FIREBASE_SDK], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (inst.status !== 0) throw new Error('installing pinned test packages failed');
  }
  // Browser download is explicit and idempotent; the local ms-playwright cache is reused when the
  // revision already matches this Playwright version.
  const cli = path.join(runtime, 'node_modules', 'playwright', 'cli.js');
  const plat = process.platform === 'linux' ? ['install', '--with-deps', 'chromium'] : ['install', 'chromium'];
  const dl = spawnSync(process.execPath, [cli, ...plat], { stdio: ['ignore', 'inherit', 'inherit'], env: Object.assign({}, process.env) });
  if (dl.status !== 0) throw new Error('playwright install chromium failed');
}
function launchChromium() {
  const { chromium } = require(path.join(runtime, 'node_modules', 'playwright'));
  const exe = chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) throw new Error('Chromium executable not found: ' + exe);
  const profile = path.join(runtime, 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-background-networking', '--disable-component-update',
    '--no-sandbox', '--window-size=1280,800', 'about:blank',
  ];
  const log = fs.openSync(path.join(runtime, 'chrome.log'), 'w');
  spawnTracked(exe, args, { stdio: ['ignore', log, log] });
  return exe;
}

function runNode(scriptArgs, envExtra) {
  const r = spawnSync(process.execPath, scriptArgs, {
    cwd: repo,
    env: Object.assign({}, process.env, envExtra || {}),
    stdio: 'inherit',
  });
  return r.status === 0;
}

function runEmulatorE2E() {
  const cli = path.join(runtime, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  const script = path.join(__dirname, 'emulator-e2e.cjs');
  if (!fs.existsSync(cli) || !fs.existsSync(script)) return false;
  const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(script);
  const r = spawnSync(process.execPath, [cli, 'emulators:exec', '--config', 'firebase.image-upload-emulator.json', '--project', 'demo-vdsen-image-upload', '--only', 'auth,firestore,storage', command], {
    cwd: repo,
    env: Object.assign({}, process.env, {
      GCLOUD_PROJECT: 'demo-vdsen-image-upload',
      NODE_PATH: path.join(runtime, 'node_modules'),
    }),
    stdio: 'inherit',
  });
  return r.status === 0;
}

async function main() {
  console.log('=== VDSEN IMAGE UPLOAD ACCEPTANCE (repo-owned) ===');
  ensureRuntime();

  // 1) fixture server
  spawnTracked(process.execPath, [path.join(__dirname, 'server.cjs'), '--port', String(SERVER_PORT)], { cwd: repo, stdio: 'inherit' });
  await waitPort(SERVER_PORT, 'fixture server');
  step('FIXTURE_SERVER', true, 'http://127.0.0.1:' + SERVER_PORT);

  // 2) Chromium with CDP
  const exe = launchChromium();
  await waitPort(CDP_PORT, 'Chromium CDP', 120);
  step('CHROMIUM_CDP', true, path.basename(exe) + ' :' + CDP_PORT);

  const env = { HARNESS_URL: 'http://127.0.0.1:' + SERVER_PORT, CDP_URL: 'http://127.0.0.1:' + CDP_PORT };

  // 3) desktop acceptance
  const desktop = runNode([path.join(__dirname, 'browser-acceptance.cjs'), '--view', '1280x800'], env);
  step('DESKTOP_ACCEPTANCE_1280x800', desktop);

  // 4) mobile acceptance (fresh page load; same browser, different metrics)
  const mobile = runNode([path.join(__dirname, 'browser-acceptance.cjs'), '--view', '390x844'], env);
  step('MOBILE_ACCEPTANCE_390x844', mobile);

  // 5) deterministic failure injection + POST_COMMIT_UI_ISOLATION barriers
  const failures = runNode([path.join(__dirname, 'failure-injection.cjs')], env);
  step('FAILURE_INJECTION_F01_F12', failures);

  // 6) real-emulator positive path (Auth + Firestore + Storage, storage.rules enforced)
  let emulator = true;
  if (SKIP_EMULATORS) {
    console.log('  SKIP emulator E2E (--skip-emulators)');
  } else {
    emulator = runEmulatorE2E();
    step('EMULATOR_POSITIVE_E2E', emulator);
  }

  const bad = steps.filter(s => !s.ok);
  console.log('');
  console.log('IMAGE_UPLOAD_STEPS=' + (steps.length - bad.length) + '/' + steps.length);
  if (bad.length === 0 && (SKIP_EMULATORS || emulator)) {
    console.log('IMAGE_UPLOAD_ACCEPTANCE=PASS');
  } else {
    console.log('IMAGE_UPLOAD_ACCEPTANCE=FAIL');
    bad.forEach(b => console.log('  failed step: ' + b.name + ' ' + b.detail));
  }
  return bad.length ? 1 : 0;
}

async function shutdown() {
  await stopAll();
  try { if (runtime && !KEEP_RUNTIME && path.basename(runtime).startsWith('vdsen-image-e2e-')) fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
for (const s of ['SIGINT', 'SIGTERM']) process.once(s, async () => { await shutdown(); process.exit(130); });
main().then(async code => { await shutdown(); process.exit(code); }, async e => { console.error('[acceptance] ' + (e && e.stack || e)); await shutdown(); process.exit(2); });
