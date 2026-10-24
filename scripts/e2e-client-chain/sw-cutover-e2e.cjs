// Local-only E2E of the service-worker CUTOVER (Issue 115): a browser that already runs the OLD build must move to the new build-versioned worker and drop the old cache.
// when it next opens the app, without touching the signed-in session or the Firestore persistence. Real Chrome over DevTools; two app servers on the same origin, one after the other.
//   node scripts/e2e-client-chain/sw-cutover-e2e.cjs <oldRoot> [chrome.exe]     (oldRoot = checkout of the previous release, e.g. a git worktree of the commit before Issue 115's worker change)
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const newRoot = path.resolve(__dirname, '..', '..'), oldRoot = path.resolve(process.argv[2] || ''), CHROME = process.argv[3] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', PORT = 5199, DBG = 9335, ORIGIN = 'http://localhost:' + PORT;
if (!process.argv[2] || !fs.existsSync(path.join(oldRoot, 'sw.js'))) { console.error('usage: sw-cutover-e2e.cjs <oldRoot>'); process.exit(2); }
const buildOf = (root) => { const html = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8'); const m = /<meta name="vdsen-client-build" content="([^"]+)">/.exec(html); return m ? m[1] : 'legacy-v13'; };
const oldBuild = buildOf(oldRoot), newBuild = buildOf(newRoot), oldCache = 'vdsen-' + oldBuild, newWorker = 'sw.js?build=' + encodeURIComponent(newBuild);
if (oldBuild === newBuild) { console.error('oldRoot and newRoot have the same build identity; choose a prior build'); process.exit(2); }
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
    const before = await until((s) => s.active[0] && s.active[0].includes('build=' + encodeURIComponent(oldBuild)) && s.caches.includes(oldCache), 15000);
    rec('previous release: its explicit worker and cache are active', !!(before.active[0] && before.active[0].includes('build=' + encodeURIComponent(oldBuild)) && before.caches.includes(oldCache)), before);
    await stop(); await start(newRoot); await nav();
    const after = await until((s) => s.active[0] && s.active[0].includes(newWorker) && !s.caches.includes(oldCache) && s.caches.includes('vdsen-' + newBuild), 20000);
    rec('new release: the registration moved to the new build-versioned worker', !!(after.active[0] && after.active[0].includes(newWorker)), after);
    rec('the old build cache was dropped and the new cache remains', !!(!after.caches.includes(oldCache) && after.caches.includes('vdsen-' + newBuild)), after.caches);
    await nav(); const ctl = await until((s) => !!s.controller && s.controller.includes(newWorker), 8000);
    rec('after the next open the page is controlled by the new worker and still loads', !!(ctl.controller && ctl.controller.includes(newWorker)) && (await ev("typeof window.getVdsenRuntimeDiagnostics === 'function'")) === true, ctl.controller);
  } catch (e) { rec('harness error', false, String(e && e.message || e)); }
  finally { try { chrome.kill(); } catch (e) { /* ignore */ } await stop(); }
  const bad = res.filter((r) => !r.ok); console.log('\n' + (res.length - bad.length) + '/' + res.length + ' checks passed'); process.exit(bad.length ? 1 : 0);
})();
