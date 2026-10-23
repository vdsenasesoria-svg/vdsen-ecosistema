// Local-only E2E of the service-worker CUTOVER (Issue 115): a browser that already runs the OLD worker (/sw.js, cache vdsen-v13) must move to the build-versioned worker and drop the old cache
// when it next opens the app, without touching the signed-in session or the Firestore persistence. Real Chrome over DevTools; two app servers on the same origin, one after the other.
//   node scripts/e2e-client-chain/sw-cutover-e2e.cjs <oldRoot> [chrome.exe]     (oldRoot = checkout of the previous release, e.g. a git worktree of the commit before Issue 115's worker change)
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const newRoot = path.resolve(__dirname, '..', '..'), oldRoot = path.resolve(process.argv[2] || ''), CHROME = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', PORT = 5199, DBG = 9335, ORIGIN = 'http://localhost:' + PORT;
if (!process.argv[2] || !fs.existsSync(path.join(oldRoot, 'sw.js'))) { console.error('usage: sw-cutover-e2e.cjs <oldRoot>'); process.exit(2); }
// the server needs node_modules (firebase-admin): borrow the new checkout's
if (!fs.existsSync(path.join(oldRoot, 'node_modules'))) fs.symlinkSync(path.join(newRoot, 'node_modules'), path.join(oldRoot, 'node_modules'), 'junction');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const res = []; const rec = (n, ok, d) => { res.push({ n, ok, d }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + JSON.stringify(d) : '')); };
let server = null; const start = (root) => { server = spawn(process.execPath, [path.join(newRoot, 'scripts/e2e-client-chain/serve.cjs'), root, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: '0' }), stdio: 'ignore' }); return sleep(2800); };
const stop = () => { if (server) { server.kill(); server = null; } return sleep(900); };
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-cut-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + profile, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    await sleep(2500);
    const t = await (await fetch('http://127.0.0.1:' + DBG + '/json/new?about:blank', { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
    const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.result.value;
    await send('Page.enable'); await send('Runtime.enable');
    const nav = async () => { await send('Page.navigate', { url: ORIGIN + '/' }); for (let i = 0; i < 60; i++) { await sleep(300); if (await ev("document.readyState === 'complete'").catch(() => false)) break; } await sleep(1500); };
    const state = "(async()=>{ const regs = await navigator.serviceWorker.getRegistrations(); return { active: regs.map(r => r.active && r.active.scriptURL), waiting: regs.map(r => r.waiting && r.waiting.scriptURL), caches: await caches.keys(), controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL }; })()";
    const until = async (pred, ms) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await ev(state); if (pred(s)) return s; await sleep(400); } return s; };
    await start(oldRoot); await nav(); await nav();
    const before = await until((s) => s.active[0] && !/build=/.test(s.active[0]) && s.caches.includes('vdsen-v13'), 15000);
    rec('previous release: legacy worker /sw.js active with cache vdsen-v13', !!(before.active[0] && !/build=/.test(before.active[0]) && before.caches.includes('vdsen-v13')), before);
    await stop(); await start(newRoot); await nav();
    const after = await until((s) => s.active[0] && /sw\.js\?build=/.test(s.active[0]) && !s.caches.includes('vdsen-v13'), 20000);
    rec('new release: the registration moved to the build-versioned worker', !!(after.active[0] && /sw\.js\?build=/.test(after.active[0])), after);
    rec('the old cache vdsen-v13 was dropped, only the build cache remains', !!(after.caches.length === 1 && /^vdsen-/.test(after.caches[0]) && after.caches[0] !== 'vdsen-v13'), after.caches);
    await nav(); const ctl = await until((s) => !!s.controller && /build=/.test(s.controller), 8000);
    rec('after the next open the page is controlled by the new worker and still loads', !!(ctl.controller && /build=/.test(ctl.controller)) && (await ev("typeof window.getVdsenRuntimeDiagnostics === 'function'")) === true, ctl.controller);
  } catch (e) { rec('harness error', false, String(e && e.message || e)); }
  finally { try { chrome.kill(); } catch (e) { /* ignore */ } await stop(); }
  const bad = res.filter((r) => !r.ok); console.log('\n' + (res.length - bad.length) + '/' + res.length + ' checks passed'); process.exit(bad.length ? 1 : 0);
})();
