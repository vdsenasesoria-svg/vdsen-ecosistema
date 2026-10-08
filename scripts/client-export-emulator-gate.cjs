#!/usr/bin/env node
// PHASE 2 — controlled gate for the client-export suite against the REAL Firestore Emulator + rules.
//
// THE PROBLEM THIS SOLVES
// The suite PASSES (EM.1..EM.6 against the real emulator and firestore.rules) but the process never
// exits: after the tests complete, the web Firestore SDK leaves a Listen channel retrying, opening a
// new stream on every attempt, so the event loop never drains, tens of thousands of GrpcConnection
// lines are emitted and the emulator is eventually asphyxiated. In CI that looks like a workflow
// hanging to timeout, not a failure.
//
// Two fixes were tried on the test file and BOTH were reverted after measurement: terminate() on each
// database (loop persisted, 51,541 lines) and process.exit() from the after() hook (loop persisted,
// 52,532 lines, because node --test keeps its own handles). See
// docs/CLIENT_EXPORT_EMULATOR_ROOT_CAUSE.md and docs/T532_ACK_REVERT_CONTRACT.md for the method.
//
// So the containment lives HERE, in the parent, where it cannot mask a failure:
//   - the child must print an explicit completion sentinel ONLY after every assertion passed;
//   - the parent requires the sentinel, the expected test count and failures=0;
//   - only THEN may it kill the child tree, and it reports the controlled teardown as such.
// A missing sentinel, a count mismatch, a crash before the sentinel or any failure is a FAIL.
//
// This does NOT change any production exporter semantics.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PROJECT = 'demo-vdsen-export';
const JAR_NAME = 'cloud-firestore-emulator-v1.19.8.jar';
const JAR_SHA256 = '9d43599ed6151199e8d604dc87fac51218e49e5f3a48519b1ae560bbe5e3382d';
const TEST_PACKAGES = ['firebase@10.12.0', 'firebase-admin@13.10.0'];
const SUITE = path.join('tests', 'client-export-emulator.cjs');
const EXPECTED_TESTS = 11;                 // EM.1 .. EM.11
const SENTINEL = 'VDSEN_EXPORT_EMULATOR_COMPLETE';
const EMULATOR_START_GRACE_MS = 90 * 1000; // emulator boot + suite runtime
const POST_SENTINEL_GRACE_MS = 4000;       // natural-exit window before controlled teardown

const isWin = process.platform === 'win32';
const log = (s) => console.log('[gate] ' + s);

function sha256(buf) { return require('node:crypto').createHash('sha256').update(buf).digest('hex'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function portOpen(port) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function ensureJar(runtime) {
  const cached = path.join(os.homedir(), '.cache', 'firebase', 'emulators', JAR_NAME);
  if (fs.existsSync(cached)) {
    const got = sha256(fs.readFileSync(cached));
    if (got !== JAR_SHA256) throw new Error('cached emulator JAR checksum mismatch: ' + got);
    return cached;
  }
  const target = path.join(runtime, JAR_NAME);
  const url = 'https://storage.googleapis.com/firebase-preview-drop/emulator/' + JAR_NAME;
  const r = spawnSync(process.execPath, ['-e',
    'fetch(process.argv[1]).then(async r=>{if(!r.ok){console.error("HTTP "+r.status);process.exit(1)}' +
    'require("fs").writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e.message);process.exit(1)})',
    url, target], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0 || !fs.existsSync(target)) throw new Error('emulator download failed');
  if (sha256(fs.readFileSync(target)) !== JAR_SHA256) throw new Error('downloaded JAR checksum mismatch');
  return target;
}

// Locate npm's CLI script. require.resolve of npm/... fails because npm is not a dependency of this
// repo, and on Windows a .cmd cannot be spawned directly (Node >= 20 rejects it with EINVAL), so the
// script is run through the current Node binary. The usual install locations are checked explicitly.
function locateNpmCli() {
  const cands = [];
  try { cands.push(require.resolve('npm/bin/npm-cli.js')); } catch (e) { /* not a dependency */ }
  cands.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  cands.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}
function installTestPackages(runtime) {
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'vdsen-export-gate', private: true }, null, 2));
  // On Windows a .cmd cannot be spawned directly (Node >= 20 rejects it with EINVAL for security), so
  // invoke npm's CLI through the current Node binary instead of going through a shell.
  const npmCli = locateNpmCli();
  if (!npmCli) throw new Error('cannot locate npm-cli.js to install the test-only SDKs');
  const npmCmd = process.execPath, npmArgs = [npmCli];
  const r = spawnSync(npmCmd, npmArgs.concat(['install', '--no-audit', '--no-fund', ...TEST_PACKAGES]), { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not install the test-only SDKs (status=' + r.status + '): ' + String(r.stderr || r.error || '').slice(-600));
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); } }
}

async function main() {
  const runtime = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vdsen-export-gate-'));
  const procs = [];
  let emulator = null, child = null;
  let verdict = { ok: false, sentinel: false, controlledTeardown: false, reason: '' };

  try {
    if (!fs.existsSync(path.join(REPO, SUITE))) throw new Error('missing suite: ' + SUITE);
    log('runtime=' + runtime);
    installTestPackages(runtime);
    const jar = ensureJar(runtime);
    const port = await freePort();
    log('project=' + PROJECT + ' emulator=127.0.0.1:' + port + ' rules=firestore.rules sha256=' + JAR_SHA256.slice(0, 12));

    emulator = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--rules', path.join(REPO, 'firestore.rules'), '--project_id', PROJECT],
      { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
    procs.push(emulator);
    let bootErr = '';
    emulator.stderr.on('data', (d) => { bootErr += d.toString(); });
    for (let i = 0; i < 60; i++) { if (await portOpen(port)) break; await sleep(1000); }
    if (!(await portOpen(port))) throw new Error('emulator did not start: ' + bootErr.slice(-300));

    const env = Object.assign({}, process.env, {
      NODE_PATH: path.join(runtime, 'node_modules'),
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:' + port,
      GCLOUD_PROJECT: PROJECT,
      METADATA_SERVER_DETECTION: 'none',
      CE_RULES_ENFORCED: '1',
      VDSEN_EXPORT_GATE_SENTINEL: SENTINEL,
    });
    for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GOOGLE_CLOUD_PROJECT',
      'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_PREFER_REST']) delete env[k];

    // Detached process group so the parent can kill the WHOLE tree (node --test spawns workers).
    child = spawn(process.execPath, ['--test', SUITE], { cwd: REPO, env, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    // Wait for the sentinel, or for the suite to fail/finish without it.
    const deadline = Date.now() + EMULATOR_START_GRACE_MS;
    let exited = null;
    child.once('exit', (code, sig) => { exited = { code, sig }; });
    while (Date.now() < deadline) {
      if (out.includes(SENTINEL)) break;
      if (exited) break;
      await sleep(250);
    }

    if (!out.includes(SENTINEL)) {
      verdict.reason = exited
        ? 'suite exited (code=' + exited.code + ') WITHOUT the completion sentinel'
        : 'timed out waiting for the completion sentinel';
      // Surface the tail so a real failure is diagnosable rather than mysterious.
      console.error('[gate] tail:\n' + out.split('\n').slice(-25).join('\n'));
      return verdict;
    }
    verdict.sentinel = true;
    log('sentinel observed: ' + SENTINEL);

    // Parse the reporter summary. A sentinel is necessary but NOT sufficient.
    const p = Number((out.match(/^# pass (\d+)/m) || [])[1] || 0);
    const f = Number((out.match(/^# fail (\d+)/m) || [])[1] || 0);
    log('reported: pass=' + p + ' fail=' + f + ' expected=' + EXPECTED_TESTS);
    if (f !== 0) { verdict.reason = 'reported failures=' + f; return verdict; }
    if (p !== EXPECTED_TESTS) { verdict.reason = 'expected ' + EXPECTED_TESTS + ' tests, got ' + p; return verdict; }
    // Every EM.x must be present and passing, so a silently skipped test cannot pass the gate.
    const missing = [];
    for (let i = 1; i <= EXPECTED_TESTS; i++) if (!new RegExp('EM\\.' + i + '\\b').test(out)) missing.push('EM.' + i);
    if (missing.length) { verdict.reason = 'missing test(s) in output: ' + missing.join(', '); return verdict; }

    // Only NOW may the parent release the child.
    await sleep(POST_SENTINEL_GRACE_MS);
    if (exited) {
      log('child exited naturally (code=' + exited.code + ')');
      verdict.ok = true;
      return verdict;
    }
    verdict.controlledTeardown = true;
    log('child still alive after the sentinel - known post-suite Listen retry; terminating the child tree');
    killTree(child);
    await sleep(1500);
    verdict.ok = true;
    return verdict;
  } catch (e) {
    verdict.reason = e.message;
    return verdict;
  } finally {
    try { killTree(child); } catch (e) { /* ignore */ }
    for (const p of procs) { try { killTree(p); } catch (e) { /* ignore */ } }
    try { fs.rmSync(runtime, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

if (require.main === module) {
  main().then((v) => {
    if (!v.ok) { console.error('[gate] FAIL: ' + v.reason); process.exitCode = 1; }
    else if (v.controlledTeardown) { console.log('[gate] PASS_WITH_CONTROLLED_POST_SUITE_TEARDOWN'); process.exitCode = 0; }
    else { console.log('[gate] PASS'); process.exitCode = 0; }
  }).catch((e) => { console.error('[gate] FATAL ' + e.message); process.exitCode = 2; });
}

module.exports = { main, SENTINEL, EXPECTED_TESTS };
