// Real-Chromium E2E of the PWA (local only): service worker registration, cache, OFFLINE re-open and sync after reconnect.
//   node scripts/e2e-client-chain/sw-offline-e2e.cjs [chrome.exe]      (needs the Auth + Firestore emulators and a seeded athlete G: seed-cardio.cjs)
// Headless Chrome is driven over the DevTools protocol with Node's built-in WebSocket (no extra packages). The app server is a CHILD process: killing it makes the static assets really
// unreachable (only the service worker can answer); the page-level network emulation also blocks the Firestore connection (so writes are held by the on-device queue). Synthetic data only.
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const root = path.resolve(__dirname, '..', '..');
const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', PORT = 5199, DBG = 9333, ORIGIN = 'http://localhost:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const rec = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + JSON.stringify(detail) : '')); };
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(root, 'scripts/e2e-client-chain/serve.cjs'), root, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: '0' }), stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('local Client E2E server exited before listening');
    try { const response = await fetch(ORIGIN + '/cliente'); if (response.ok) return; } catch (_) { /* wait for the child */ }
    await sleep(150);
  }
  throw new Error('local Client E2E server did not become reachable');
}
function stopServer() { if (server) { server.kill(); server = null; } return sleep(800); }
async function cdpSession() {
  const t = await (await fetch('http://127.0.0.1:' + DBG + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __error: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || 'error' }; return r.result && r.result.result && r.result.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  return { send, ev, ws, nav: async (u) => { await send('Page.navigate', { url: u }); await sleep(3500); } };
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-sw-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  try {
    await stopServer(); await startServer(); await sleep(2500);
    const p = await cdpSession();
    // 1 · online: the page registers its service worker
    await p.nav(ORIGIN + '/'); await sleep(2500); console.log('  [debug] ' + JSON.stringify(await p.ev('({href:location.href,title:document.title,secure:window.isSecureContext,sw:typeof navigator.serviceWorker})')));
    const reg = await p.ev("(async()=>{ for (let i = 0; i < 40; i++) { const r = await navigator.serviceWorker.getRegistration(); if (r && r.active && r.active.state === 'activated') return { scope: r.scope, active: true, state: r.active.state }; await new Promise(x => setTimeout(x, 500)); } const r = await navigator.serviceWorker.getRegistration(); return r ? { scope: r.scope, installing: !!r.installing, waiting: !!r.waiting, active: !!r.active } : null; })()");
    rec('service worker registered (Chromium)', !!(reg && reg.active), reg);
    await p.nav(ORIGIN + '/'); await sleep(1500);   // second load: now controlled
    rec('page controlled by the service worker', await p.ev('!!navigator.serviceWorker.controller') === true);
    const keys = await p.ev("(async()=>{ const ks = await caches.keys(); const c = await caches.open(ks[0]); const reqs = await c.keys(); return { caches: ks, n: reqs.length, hasHtml: reqs.some(r => /vdsen-cliente\\.html$|\\/cliente$|localhost:" + PORT + "\\/$/.test(r.url)) }; })()");
    rec('cache keyed by the current worker build holds the app shell', !!(keys && keys.caches && keys.caches.some((name) => /^vdsen-/.test(name)) && keys.n >= 5), keys);
    // 2 · online boot + a first set
    await p.ev("(async()=>{ const s=document.createElement('script'); s.src='/__driver.js'; document.head.appendChild(s); await new Promise(r=>s.onload=r); })()");
    const boot = await p.ev("window.__boot('G').then(r=>r.screen)"); rec('online login of the synthetic athlete', Array.isArray(boot) && boot.includes('scrApp'), boot);
    await p.ev("(async()=>{ const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent); b&&b.click(); window.selDia(0); await new Promise(r=>setTimeout(r,600)); })()");
    const k1 = await p.ev("window.__logSet(0,0,0,{carga:80,reps:10,rir:2,ics:8,pump:1})"); await sleep(1500); rec('online: set 1 saved with its current-week key', /^log_\d+_0_0_s0$/.test(k1 || ''), k1);
    await sleep(2000);   // let the service worker cache the Firebase modules / driver the page just used
    // 3 · OFFLINE: the app server is stopped (assets unreachable) and the page network is blocked (Firestore unreachable)
    await stopServer(); await p.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await p.nav(ORIGIN + '/'); await sleep(1500);
    const title = await p.ev('document.title'); rec('OFFLINE re-open: the page loads from the service worker cache', /VDSEN/.test(title || ''), title);
    // the page script of the athlete app is inline text; start it exactly as the harness does (without clearing storage: the session and the Firestore cache persist)
    const resumed = await p.ev("(async()=>{ const src=document.getElementById('clientModuleSrc'); if(!src) return 'no module'; await import(URL.createObjectURL(new Blob([src.textContent],{type:'text/javascript'}))); await new Promise(r=>setTimeout(r,6000)); return [...document.querySelectorAll('[id^=scr]')].filter(e=>getComputedStyle(e).display!=='none').map(e=>e.id); })()");
    rec('OFFLINE: the app opens signed-in (cached session + Firestore persistence)', Array.isArray(resumed) && resumed.includes('scrApp'), resumed);
    let k2 = null;
    if (Array.isArray(resumed) && resumed.includes('scrApp')) {
      await p.ev("(async()=>{ const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent); b&&b.click(); const sc=document.createElement('script'); sc.textContent=''; })()");
      const drv = await p.ev("(async()=>{ try { const r = await fetch('/__driver.js'); const t = await r.text(); (0,eval)(t); return typeof window.__logSet; } catch(e) { return 'driver not available offline: ' + e.message; } })()");
      rec('OFFLINE: cached assets answer (driver script served by the service worker)', drv === 'function', drv);
      if (drv === 'function') {
        const planShown = await p.ev("(async()=>{ window.selDia(0); await new Promise(r=>setTimeout(r,800)); return /Press de pecho/.test(document.body.innerText); })()");
        rec('OFFLINE: the plan renders from the on-device cache', planShown === true, planShown);
        k2 = await p.ev("window.__logSet(0,0,1,{carga:80,reps:9,rir:2,ics:8,pump:1})"); await sleep(1200);
        rec('OFFLINE: a set can be registered (held on the device)', /^log_\d+_0_0_s1$/.test(k2 || '') && k2.replace(/_s1$/, '') === k1.replace(/_s0$/, ''), k2);
        const badge = await p.ev("(document.getElementById('syncBadge')||{}).textContent || document.body.innerText.slice(0,0)"); results.push({ name: 'pending badge text (informational)', ok: true, detail: badge });
      }
    }
    // 4 · reconnect
    await startServer(); await p.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(9000);
    // 5 · the held write reached Firestore exactly once, next to the online one (read with the emulator owner token)
    const cr = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')).who.G;
    const doc = await (await fetch('http://127.0.0.1:8085/v1/projects/demo-vdsen-client-e2e/databases/(default)/documents/logs/' + cr.uid + '/mesos/' + cr.planId, { headers: { authorization: 'Bearer owner' } })).json();
    const logKeys = Object.keys(((doc.fields || {}).entries || { mapValue: { fields: {} } }).mapValue.fields || {}).filter((k) => k === k1 || k === k2).sort();
    rec('after reconnect: online + offline sets are in Firestore once each, same PID', !!k1 && !!k2 && JSON.stringify(logKeys) === JSON.stringify([k1, k2].sort()), logKeys);
    rec('sync badge cleared / no pending writes left', await p.ev("(async()=>{ await new Promise(r=>setTimeout(r,1500)); const b=document.getElementById('syncBadge'); return !b || getComputedStyle(b).display==='none' || !b.textContent.trim(); })()") === true);
    fs.writeFileSync(path.join(os.tmpdir(), 'vdsen-sw-e2e-result.json'), JSON.stringify(results, null, 2));
  } catch (e) { rec('harness error', false, String(e && e.message || e)); }
  finally { try { chrome.kill(); } catch (e) { /* ignore */ } await stopServer(); }
  const bad = results.filter((r) => !r.ok); console.log('\n' + (results.length - bad.length) + '/' + results.length + ' checks passed'); process.exit(bad.length ? 1 : 0);
})();
