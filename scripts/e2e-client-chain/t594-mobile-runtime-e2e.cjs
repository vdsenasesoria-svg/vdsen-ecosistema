// Issue #115 local-only mobile runtime check. Requires Auth + Firestore
// emulators and synthetic athlete G seeded by seed.cjs. It drives the actual
// Client controls in Chromium mobile emulation; it never contacts production.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.resolve(__dirname, '..', '..');
const chromePath = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5199, DEBUG = 9334, origin = 'http://localhost:' + PORT;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
// Every run uses a FRESH synthetic athlete (a previous run leaves sets saved, which would hide the set card): seed it here.
require('child_process').spawnSync(process.execPath, [path.join(root, 'scripts/e2e-client-chain/seed.cjs'), root, 'G'], { stdio: 'ignore' });
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + JSON.stringify(detail) : '')); }

async function session() {
  const target = await (await fetch('http://127.0.0.1:' + DEBUG + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.onmessage = (message) => { const d = JSON.parse(message.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id:n, method, params:params || {} })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true }); if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'page evaluation failed'); return r.result && r.result.result && r.result.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:1 });
  return { send, ev, ws, async size(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:true, screenWidth:width, screenHeight:height }); }, async nav(url) { await send('Page.navigate', { url }); const t0 = Date.now(); while (Date.now() - t0 < 20000) { await sleep(300); const ready = await ev("document.readyState === 'complete' && !!document.getElementById('clientModuleSrc')").catch(() => false); if (ready === true) break; } await sleep(1500); } };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t594-mobile-'));
  let server, chrome;
  try {
    server = spawn(process.execPath, [path.join(root, 'scripts/e2e-client-chain/serve.cjs'), root, String(PORT)], { env:Object.assign({}, process.env, { E2E_NUMERIC:'0' }), stdio:'ignore' });
    await sleep(2500);
    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=' + DEBUG, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio:'ignore' });
    await sleep(1800);
    const p = await session(); await p.size(360, 740); console.log('INFO mobile runtime: opening local Client'); await p.nav(origin + '/cliente');
    // The harness keeps the production module inert until this explicit import;
    // the ensuing login/actions are the app's real DOM handlers.
    console.log('INFO mobile runtime: signing in synthetic athlete');
    await p.ev("(async()=>{const s=document.createElement('script');s.src='/__driver.js';document.head.appendChild(s);await new Promise(r=>s.onload=r);return window.__boot('G');})()").then((b) => console.log('INFO boot', JSON.stringify(b)));
    await p.ev("(async()=>{for(let i=0;i<150&&typeof window.selDia!=='function';i++)await new Promise(r=>setTimeout(r,200));const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent);if(b)b.click();window.selDia(0);await new Promise(r=>setTimeout(r,700));const s=document.createElement('script');s.src='/scripts/e2e-client-chain/mobile-audit.js';document.head.appendChild(s);await new Promise(r=>s.onload=r);})()");
    const sizes = [[320,640],[360,740],[360,780],[390,844],[430,932],[740,360],[360,320]];
    for (const [width, height] of sizes) { await p.size(width, height); await sleep(300); const audit = await p.ev('window.__auditCta(0,0)'); check('CTA flow ' + width + 'x' + height, !!(audit && audit.ok && audit.touchOk && !audit.docOverflow), audit); }
    const allScrollers = [];
    for (let tab=0; tab<5; tab++) { await p.ev('window.goTab(' + tab + ')'); await sleep(250); allScrollers.push(await p.ev('window.__auditScrollers()')); }
    check('no horizontal overflow in every tab scroller', allScrollers.every((r) => r && r.ok), allScrollers);
    // Negative control: the exact old sticky rule must be diagnosed as overlap.
    await p.size(360, 740); await p.ev("(()=>{const s=document.createElement('style');s.id='t594-old-sticky';s.textContent='.workout-set-current .set-actions{position:sticky!important;bottom:0!important;z-index:4!important;margin:6px -14px -14px!important;padding:12px 14px!important}';document.head.appendChild(s);window.goTab(1);})()"); await sleep(500);
    const old = await p.ev('window.__auditCta(0,0)'); check('negative sticky CSS reliably fails geometry audit', !!(old && !old.ok && old.steps.some((s) => s.hitsFields > 0)), old);
    await p.ev("document.getElementById('t594-old-sticky').remove()"); await sleep(300);
    const runtime = await p.ev('window.getVdsenRuntimeDiagnostics()');
    check('runtime diagnostics identifies current build and versioned worker', !!(runtime && runtime.build && runtime.serviceWorker.registrations.some((r) => /sw\.js\?build=/.test(r.active || ''))), runtime && { build:runtime.build, controller:runtime.serviceWorker.controller, registrations:runtime.serviceWorker.registrations, caches:runtime.serviceWorker.caches, viewport:runtime.viewport });
    await p.ev('window.goTab(1)'); await sleep(300);
    const keys = []; for (let set=0; set<3; set++) { keys.push(await p.ev("window.__logSet(0,0," + set + ",{carga:80,reps:10,rir:2,ics:8,pump:1})")); await sleep(900); }
    const creds = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')).who.G;
    const doc = await (await fetch('http://127.0.0.1:8085/v1/projects/demo-vdsen-client-e2e/databases/(default)/documents/logs/' + creds.uid + '/mesos/' + creds.planId, { headers:{ authorization:'Bearer owner' } })).json();
    const entries = (((doc.fields || {}).entries || {}).mapValue || {}).fields || {};
    const saved = Object.keys(entries).filter((k) => /^log_2_0_0_s[0-2]$/.test(k)).sort();
    check('three real UI saves persist once with stable per-set keys', JSON.stringify(keys) === JSON.stringify(['log_2_0_0_s0','log_2_0_0_s1','log_2_0_0_s2']) && JSON.stringify(saved) === JSON.stringify(keys), { keys, saved });
  } catch (error) { check('harness completed', false, String(error && error.message || error)); }
  finally { if (chrome) chrome.kill(); if (server) server.kill(); }
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(os.tmpdir(), 'vdsen-t594-mobile-runtime-result.json'), JSON.stringify(checks, null, 2));
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed'); process.exit(failed.length ? 1 : 0);
})();
