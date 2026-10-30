// Reproducible performance measurements of the REAL Client in real Chrome (local only, synthetic athlete G from seed-cardio.cjs, Auth + Firestore Emulator, zero network latency).
//   node scripts/e2e-client-chain/perf-e2e.cjs [chrome.exe]
// METHOD: headless Chrome over the DevTools protocol; the app server runs with E2E_COUNT_FS=1 so every Firestore read / listener / write goes through a counting shim (window.__fsc).
//   1. login: time from the sign-in call until the app screen is visible.   2. warm start x5: reload + start the app with the persisted session; time to the app screen, reads and listeners.
//   3. navigation: 60 tab / day / exercise switches; listeners and used JS heap (after forced GC) before vs after.   4. console errors and uncaught exceptions during everything.
// Numbers describe CLIENT work on a fast local machine and an emulator with ~0 latency: they are not network or phone benchmarks. Nothing is invented: every value printed is measured here.
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const root = path.resolve(__dirname, '..', '..');
const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe', PORT = 5199, DBG = 9334, ORIGIN = 'http://localhost:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
(async () => {
  const server = spawn(process.execPath, [path.join(root, 'scripts/e2e-client-chain/serve.cjs'), root, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: '0', E2E_COUNT_FS: '1' }), stdio: 'ignore' }); await sleep(3000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-perf-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + profile, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  const out = { env: {}, login: {}, warmStarts: [], navigation: {}, consoleErrors: [] };
  try {
    await sleep(2500);
    const t = await (await fetch('http://127.0.0.1:' + DBG + '/json/new?about:blank', { method: 'PUT' })).json();
    out.env.browser = (await (await fetch('http://127.0.0.1:' + DBG + '/json/version')).json()).Browser; out.env.os = os.platform() + ' ' + os.release(); out.env.cpu = os.cpus()[0].model + ' x' + os.cpus().length; out.env.node = process.version;
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') out.consoleErrors.push(d.params.args.map((x) => String(x.value !== undefined ? x.value : (x.description || ''))).join(' ').slice(0, 900)); else if (d.method === 'Runtime.exceptionThrown') out.consoleErrors.push('EXCEPTION ' + String(d.params.exceptionDetails.text + ' ' + ((d.params.exceptionDetails.exception || {}).description || '')).slice(0, 160)); };
    const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    await send('Page.enable'); await send('Runtime.enable'); await send('HeapProfiler.enable');
    const nav = async (u) => { await send('Page.navigate', { url: u }); const t = Date.now(); while (Date.now() - t < 15000) { await sleep(250); const ok = await ev("document.readyState === 'complete' && !!document.getElementById('clientModuleSrc')"); if (ok === true) break; } await sleep(500); };
    const heap = async () => { await send('HeapProfiler.collectGarbage'); await sleep(300); await send('HeapProfiler.collectGarbage'); return (await send('Runtime.getHeapUsage')).result.usedSize; };
    const appVisible = "(()=>[...document.querySelectorAll('[id^=scr]')].some(e=>getComputedStyle(e).display!=='none'&&e.id==='scrApp'))()";
    const startAndTime = "(async()=>{ const t0 = performance.now(); const src=document.getElementById('clientModuleSrc'); await import(URL.createObjectURL(new Blob([src.textContent],{type:'text/javascript'}))); const tImport = performance.now() - t0; const vis = () => [...document.querySelectorAll('[id^=scr]')].some(e => e.id === 'scrApp' && getComputedStyle(e).display !== 'none'); while (!vis() && performance.now() - t0 < 40000) await new Promise(r => setTimeout(r, 15)); return { importMs: Math.round(tImport), toAppScreenMs: vis() ? Math.round(performance.now() - t0) : null }; })()";
    const waitApp = async (limit) => { const t0 = Date.now(); while (Date.now() - t0 < (limit || 20000)) { if (await ev(appVisible)) return Date.now() - t0; await sleep(50); } return null; };
    const dismiss = "(async()=>{ const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent); b&&b.click(); const m=document.getElementById('wnModal'); if(m){const e=[...m.querySelectorAll('button')].find(x=>/ENTENDIDO/i.test(x.innerText)); e&&e.click();} })()";
    const startApp = "(async()=>{ const src=document.getElementById('clientModuleSrc'); await import(URL.createObjectURL(new Blob([src.textContent],{type:'text/javascript'}))); })()";
    // 1 · cold login
    await nav(ORIGIN + '/');
    await ev("(async()=>{ await new Promise((res)=>{ const s=document.createElement('script'); s.src='/__driver.js'; s.onload=res; document.head.appendChild(s); }); })()");
    await ev(startApp); await sleep(2200);
    const cred = await ev("fetch('/__creds?who=G').then(r=>r.json())");
    const t0 = Date.now(); await ev("(async()=>{ document.getElementById('liEmail').value=" + JSON.stringify(cred.email) + "; document.getElementById('liPass').value=" + JSON.stringify(cred.password) + "; window.doLogin(); })()");
    out.login.msToAppScreen = await waitApp(30000); out.login.wallMs = Date.now() - t0; await ev(dismiss); await sleep(1500);
    out.login.firestore = await ev('JSON.stringify(window.__fsc)').then((x) => JSON.parse(x));
    // 2 · warm starts (persisted session + Firestore persistence)
    for (let i = 0; i < (Number(process.env.PERF_WARM) || 5); i++) {
      if (Number(process.env.PERF_BLANK)) { await send('Page.navigate', { url: 'about:blank' }); await sleep(Number(process.env.PERF_BLANK)); }   // optional: let the previous document release its connections before the next start
      await nav(ORIGIN + '/'); const tm = await ev(startAndTime); const ms = tm && tm.toAppScreenMs; await sleep(1800); await ev(dismiss);
      const slow = ms === null || ms > 2000 ? await ev("JSON.stringify(performance.getEntriesByType('resource').filter(r => r.duration > 1200).map(r => [r.name.slice(-70), Math.round(r.duration)]))") : null;
      const screens = ms === null || ms > 2000 ? await ev("JSON.stringify({ screens: [...document.querySelectorAll('[id^=scr]')].map(e => e.id + ':' + getComputedStyle(e).display), text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 60), timings: (window.__fsc || {}).timings })") : null;
      out.warmStarts.push({ msToAppScreen: ms, importMs: tm && tm.importMs, screens: screens && JSON.parse(screens), slowResources: slow && JSON.parse(slow), firestore: JSON.parse(await ev('JSON.stringify(window.__fsc)')) });
    }
    // 3 · navigation loop (a freshly started app)
    await nav(ORIGIN + '/'); await ev(startApp); await waitApp(30000); await sleep(1500); await ev(dismiss);
    await ev("(async()=>{ await new Promise((res)=>{ const s=document.createElement('script'); s.src='/__driver.js'; s.onload=res; document.head.appendChild(s); }); })()");
    const h0 = await heap(), f0 = JSON.parse(await ev('JSON.stringify(window.__fsc)'));
    await ev("(async()=>{ for (let n=0;n<60;n++){ window.goTab(n%5); await new Promise(r=>setTimeout(r,120)); if(n%5===1){ window.selDia(n%2); await new Promise(r=>setTimeout(r,120)); window.setEjActivo(0); await new Promise(r=>setTimeout(r,120)); } } window.goTab(1); })()");
    await sleep(1500); const h1 = await heap(), f1 = JSON.parse(await ev('JSON.stringify(window.__fsc)'));
    const rounds = [+(h1 / 1048576).toFixed(2)];   // two more rounds of 60 switches: a leak would keep growing, a warm-up would flatten
    for (let r = 0; r < 2; r++) { await ev("(async()=>{ for (let n=0;n<60;n++){ window.goTab(n%5); await new Promise(r=>setTimeout(r,120)); if(n%5===1){ window.selDia(n%2); await new Promise(r=>setTimeout(r,120)); window.setEjActivo(0); await new Promise(r=>setTimeout(r,120)); } } window.goTab(1); })()"); await sleep(1200); rounds.push(+((await heap()) / 1048576).toFixed(2)); }
    out.navigation = { switches: 60, heapBeforeMB: +(h0 / 1048576).toFixed(2), heapAfterMB: +(h1 / 1048576).toFixed(2), heapDeltaMB: +((h1 - h0) / 1048576).toFixed(2), listenersBefore: f0.activeListeners, listenersAfter: f1.activeListeners, readsDuringNavigation: { getDoc: f1.getDoc - f0.getDoc, getDocs: f1.getDocs - f0.getDocs }, writesDuringNavigation: f1.writes - f0.writes, heapMBAfterEachRoundOf60: rounds };
    out.summary = { warmStartMedianMs: med(out.warmStarts.map((w) => w.msToAppScreen)), warmStartMaxMs: Math.max(...out.warmStarts.map((w) => w.msToAppScreen)), warmReadsPerStart: out.warmStarts.map((w) => w.firestore.getDoc + w.firestore.getDocs), warmListenersPerStart: out.warmStarts.map((w) => w.firestore.activeListeners) };
    ws.close();
  } catch (e) { out.harnessError = String(e && e.message || e); }
  finally { try { chrome.kill(); } catch (e) { /* ignore */ } server.kill(); }
  fs.writeFileSync(path.join(os.tmpdir(), 'vdsen-perf-result.json'), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 2)); process.exit(out.harnessError ? 1 : 0);
})();
