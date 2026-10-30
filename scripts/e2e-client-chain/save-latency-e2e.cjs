// T595-B — "GUARDAR SERIE" latency and integrity in the REAL Client, in real Chrome, against the Auth + Firestore Emulators (local only, synthetic athlete G, demo project).
//   node scripts/e2e-client-chain/save-latency-e2e.cjs [--root <worktree whose vdsen-cliente.html is measured>] [--reps 5] [--out result.json] [--chrome chrome.exe]
// METHOD: a real tap on the real button (driver.js fills the real fields). serve.cjs (E2E_COUNT_FS=1) wraps Firestore setDoc and logs a per-write timeline; faults/latency are injected there
//   (window.__fsInject: `delay` is added after the real emulator ack as a stand-in for server round-trip time; `fail` rejects without sending anything). Offline = CDP Network.emulateNetworkConditions.
//   Timeline per tap (performance.now of the page, ms after the tap): button busy, mesos write start/resolve, root write start/resolve, "✓ GUARDADO" / "GUARDADO LOCAL" badge, pending badge, error, panel refreshed.
// WHAT THIS IS NOT: the emulator has ~0 ms of its own latency and the "delay" is injected; the numbers describe how the Client's save pipeline reacts to given ack times, never production or phone/network speed.
// Use --root <older checkout> (with node_modules) to run the identical scenarios against a previous build; the seed/serve/driver files always come from this checkout.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const here = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', here)), REPS = Number(arg('reps', 5)), OUT = arg('out', null);
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = 5199, DEBUG = 9334, ORIGIN = 'http://localhost:' + PORT, PROJECT = 'demo-vdsen-client-e2e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];
// scenario: inject = window.__fsInject; offline / cdp = network condition; double = tap twice 30 ms apart
const SC = {
  normal: {}, latency600: { inject: { mesos: { delay: 600 }, root: { delay: 600 } } },
  'meso-slow': { inject: { mesos: { delay: 1500 }, root: { delay: 100 } } }, 'root-slow': { inject: { mesos: { delay: 100 }, root: { delay: 1500 } } },
  doubletap: { inject: { mesos: { delay: 400 }, root: { delay: 400 } }, double: true },
  'fail-root': { inject: { root: { fail: true, delay: 200 } } }, 'fail-meso': { inject: { mesos: { fail: true, delay: 200 } } },
  offline: { offline: true }, 'cdp-latency300': { cdp: { latency: 300 } },
  validation: { invalid: true },   // empty load: the Client rejects it BEFORE any write; the button must come back usable
};
const BOOT_A = ['normal', 'latency600', 'meso-slow', 'root-slow', 'doubletap', 'fail-root', 'validation'];
// network-disturbing scenarios go LAST: after an offline/throttled period the Firestore SDK reconnects with backoff, which would contaminate later "normal" taps
const BOOT_B = ['fail-meso', 'normal', 'latency600', 'root-slow', 'cdp-latency300', 'offline'];
const checks = [], rows = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail))); }
const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)], m = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, median: Math.round(q(0.5)), p95: Math.round(q(0.95)), min: Math.round(s[0]), max: Math.round(s[s.length - 1]), sd: Math.round(Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length)) }; };

async function session() {
  const target = await (await fetch('http://127.0.0.1:' + DEBUG + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  return { send, ev, ws, targetId: target.id, async nav(url) { await send('Page.navigate', { url }); for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev("document.readyState")) === 'complete') return; } },
    net: (c) => send('Network.emulateNetworkConditions', Object.assign({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, c || {})) };
}

// Page side: fills one set like the driver, taps once (or twice), and records a millisecond timeline until the outcome settles.
const PAGE = `
window.__measureSave = async (ei, si, v, opts) => {
  opts = opts || {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now();
  let inp = null; const rx = new RegExp('^carga_log_\\\\d+_0_' + ei + '_s' + si + '$');
  for (let t = 0; t < 40 && !inp; t++) { try { window.goTab(1); window.setEjActivo(ei); } catch (e) { /* app still booting */ } await sleep(350); inp = [...document.querySelectorAll('input')].find((i) => rx.test(i.id)); }
  if (!inp) throw new Error('no set input e' + ei + ' s' + si + ' | page: ' + document.body.innerText.replace(/\\\\s+/g, ' ').slice(0, 260));
  const key = inp.id.replace('carga_', ''), set = (id, val) => { const el = document.getElementById(id); el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  set('carga_' + key, v.carga === undefined ? 80 : v.carga); set('reps_' + key, v.reps); const rb = document.getElementById('rir_btn_' + key + '_' + v.rir); if (rb) { rb.click(); await sleep(120); } set('ics_' + key, v.ics);
  const pb = document.getElementById('pump_' + key + '_' + v.pump); if (pb) { pb.click(); await sleep(120); }
  const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('onclick') || '').startsWith("completeSet('" + key + "'")); if (!btn) throw new Error('no save button');
  { const ob = document.getElementById('saveOkBadge'); if (ob) { ob.style.opacity = '0'; ob.textContent = ''; } const eb = document.getElementById('saveErrBadge'); if (eb) eb.style.display = 'none'; const tt = document.getElementById('toast'); if (tt) tt.classList.remove('show'); await sleep(50); }
  window.__fsInject = opts.inject || {}; const log = (window.__fsc.writeLog = window.__fsc.writeLog || []), w0 = log.length;
  const tl = { key }, mark = (k) => { if (tl[k] === undefined) tl[k] = now() - tap; };
  const badge = (id) => document.getElementById(id), shown = (el) => el && getComputedStyle(el).display !== 'none';
  let tap = now(); btn.click(); if (opts.double) { await sleep(30); if (btn.isConnected) btn.click(); tl.secondTapSent = true; }
  const tEnd = tap + (opts.waitMs || 9000);
  while (now() < tEnd) {
    const ok = badge('saveOkBadge'), toast = document.getElementById('toast'), err = badge('saveErrBadge');
    if (btn.isConnected && btn.disabled && /GUARDANDO/.test(btn.textContent)) mark('busy');
    if (ok && ok.style.opacity === '1') { if (/✓ GUARDADO/.test(ok.textContent)) mark('okBadge'); else if (/LOCAL/.test(ok.textContent)) mark('localBadge'); }
    if (shown(badge('syncPendingBadge'))) mark('pendingBadge');
    if ((toast && toast.classList.contains('show') && toast.classList.contains('error')) || shown(err)) mark('errorShown');
    if (!btn.isConnected) mark('panelRefreshed');
    if (tl.panelRefreshed !== undefined || tl.errorShown !== undefined) { if (now() - tap > (tl.panelRefreshed || tl.errorShown) + 400) break; }
    await sleep(4);
  }
  const w = log.slice(w0); tl.writes = w.map((x) => ({ kind: x.kind, start: Math.round((x.t0 - tap) * 10) / 10, resolve: x.tResolve === null ? null : Math.round((x.tResolve - tap) * 10) / 10, ok: x.ok }));
  tl.btnAfter = btn.isConnected ? { disabled: btn.disabled, text: btn.textContent.trim() } : 'detached'; return tl;
};`;

async function seedAndBoot(p) {
  spawnSync(process.execPath, [path.join(here, 'scripts/e2e-client-chain/seed.cjs'), here, 'G'], { stdio: 'ignore' });
  await p.nav(ORIGIN + '/cliente');
  await p.ev("(async()=>{const s=document.createElement('script');s.src='/__driver.js';document.head.appendChild(s);await new Promise(r=>s.onload=r);return window.__boot('G');})()");
  await p.ev("(async()=>{for(let i=0;i<150&&typeof window.selDia!=='function';i++)await new Promise(r=>setTimeout(r,200));const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent);b&&b.click();})()");
  await p.ev(PAGE); await p.ev('window.goTab(1)'); await sleep(400);
  return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')).who.G;
}
const docEntries = async (c, kind) => { const u = 'http://127.0.0.1:8085/v1/projects/' + PROJECT + '/databases/(default)/documents/logs/' + c.uid + (kind === 'mesos' ? '/mesos/' + c.planId : ''); const d = await (await fetch(u, { headers: { authorization: 'Bearer owner' } })).json(); return Object.keys((((d.fields || {}).entries || {}).mapValue || {}).fields || {}); };

(async () => {
  console.log('INFO measuring build at ' + ROOT);
  const server = spawn(process.execPath, [path.join(here, 'scripts/e2e-client-chain/serve.cjs'), ROOT, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: '0', E2E_COUNT_FS: '1' }), stdio: 'ignore' });
  await sleep(2500);
  // A FRESH browser (new profile) per boot: a tab left behind by the previous boot kept the Firestore persistence lease / streams and delayed the first writes of the next boot by 2-5 s
  // (observed with a shared browser: odd boots stalled on their first tap). That was a harness artifact, not Client behaviour.
  let chrome = null;
  const launch = async () => { chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DEBUG, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t595b-lat-')), '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' }); await sleep(1800); };
  const stopChrome = async () => { try { chrome.kill(); } catch (e) { /* ignore */ } await sleep(800); };
  await launch(); const env = { browser: (await (await fetch('http://127.0.0.1:' + DEBUG + '/json/version')).json()).Browser, os: os.platform() + ' ' + os.release(), cpu: os.cpus()[0].model, build: path.basename(ROOT) }; await stopChrome();
  try {
    const plan = [];
    for (let r = 0; r < REPS; r++) { plan.push(BOOT_A); plan.push(BOOT_B); }
    for (let b = 0; b < plan.length; b++) {
      await launch(); const p = await session(); const creds = await seedAndBoot(p); console.log('INFO boot ' + (b + 1) + '/' + plan.length);
      for (let i = 0; i < plan[b].length; i++) {
        const name = plan[b][i], sc = SC[name], [ei, si] = name === 'validation' ? SETS[5] : SETS[i];
        if (sc.cdp) await p.net(sc.cdp); if (sc.offline) { await p.net({ offline: true }); await sleep(300); }
        const tl = await p.ev("window.__measureSave(" + ei + "," + si + ",{carga:" + (sc.invalid ? "''" : "80") + ",reps:10,rir:2,ics:8,pump:1}," + JSON.stringify({ inject: sc.inject, double: !!sc.double, waitMs: sc.offline ? 3500 : (sc.cdp ? 7500 : 9000) }) + ")");
        const row = { scenario: name, boot: b + 1, set: tl.key, tl };
        if (sc.offline || sc.cdp) {
          const tRe = Date.now(); await p.net({ offline: false });
          for (let t = 0; t < 40; t++) { await sleep(500); const m = await docEntries(creds, 'mesos'), r2 = await docEntries(creds, 'root'); if (m.includes(tl.key) && r2.includes(tl.key)) { row.reconnectToPersistedMs = Date.now() - tRe; break; } }
        }
        await sleep(sc.inject ? 1800 : 600);   // let injected delays on the second write finish before the next scenario
        row.mesosHas = (await docEntries(creds, 'mesos')).filter((k) => k === tl.key).length; row.rootHas = (await docEntries(creds, 'root')).filter((k) => k === tl.key).length;
        row.errs = await p.ev('window.__errs.slice()'); rows.push(row);
      }
      p.ws.close(); await stopChrome();
    }
  } catch (e) { check('harness completed', false, String(e && e.message || e)); }
  finally { try { chrome && chrome.kill(); server.kill(); } catch (e) { /* ignore */ } }

  // ── summary and integrity verdicts ──
  const by = {}; rows.forEach((r) => { (by[r.scenario] = by[r.scenario] || []).push(r); });
  const summary = {};
  for (const [name, rs] of Object.entries(by)) {
    const pick = (f) => rs.map(f).filter((x) => typeof x === 'number');
    const w = (r, k, f) => { const x = r.tl.writes.find((y) => y.kind === k); return x ? x[f] : undefined; };
    summary[name] = { n: rs.length, busyMs: stat(pick((r) => r.tl.busy)), okBadgeMs: stat(pick((r) => r.tl.okBadge)), localBadgeMs: stat(pick((r) => r.tl.localBadge)), panelRefreshedMs: stat(pick((r) => r.tl.panelRefreshed)),
      errorMs: stat(pick((r) => r.tl.errorShown)), mesosStartMs: stat(pick((r) => w(r, 'mesos', 'start'))), mesosResolveMs: stat(pick((r) => w(r, 'mesos', 'resolve'))), rootStartMs: stat(pick((r) => w(r, 'root', 'start'))), rootResolveMs: stat(pick((r) => w(r, 'root', 'resolve'))),
      reconnectToPersistedMs: stat(pick((r) => r.reconnectToPersistedMs)) };
  }
  const all = (name, f) => (by[name] || []).length > 0 && (by[name] || []).every(f);
  const wr = (r, k) => r.tl.writes.filter((y) => y.kind === k);
  check('every set tapped gives an immediate visual response (button busy within 100 ms) in all online scenarios', rows.filter((r) => r.scenario !== 'offline' && r.scenario !== 'validation').every((r) => typeof r.tl.busy === 'number' && r.tl.busy < 100), rows.filter((r) => r.scenario !== 'offline' && r.scenario !== 'validation' && !(typeof r.tl.busy === 'number' && r.tl.busy < 100)).map((r) => [r.scenario, r.tl.busy]));
  check('normal / latency / slow-write scenarios persist the set once in BOTH documents and confirm only after both writes resolved', ['normal', 'latency600', 'meso-slow', 'root-slow'].every((n) => all(n, (r) => r.mesosHas === 1 && r.rootHas === 1 && typeof r.tl.okBadge === 'number'
    && r.tl.writes.every((x) => x.resolve !== null && r.tl.okBadge >= x.resolve - 1))), ['normal', 'latency600', 'meso-slow', 'root-slow'].map((n) => (by[n] || []).filter((r) => !(r.mesosHas === 1 && r.rootHas === 1 && typeof r.tl.okBadge === 'number')).map((r) => [n, r.mesosHas, r.rootHas, r.tl.okBadge, r.tl.pendingBadge, r.tl.panelRefreshed])));
  check('CDP 300 ms network latency: never confirmed before persisted; ends persisted once in both documents (state at the tap is reported in the summary, not asserted)', all('cdp-latency300', (r) => r.mesosHas === 1 && r.rootHas === 1 && (r.tl.okBadge === undefined || r.tl.writes.every((x) => x.resolve !== null && r.tl.okBadge >= x.resolve - 1))), (by['cdp-latency300'] || []).map((r) => [r.tl.okBadge, r.tl.pendingBadge, r.tl.panelRefreshed, r.mesosHas, r.rootHas]));
  check('double tap: exactly one mesos write and one root write, key persisted once', all('doubletap', (r) => wr(r, 'mesos').length === 1 && wr(r, 'root').length === 1 && r.mesosHas === 1 && r.rootHas === 1), (by.doubletap || []).map((r) => r.tl.writes.length));
  check('root write failure: NEVER confirmed (no "✓ GUARDADO"), error shown, button usable again, nothing persisted in the root document', all('fail-root', (r) => r.tl.okBadge === undefined && typeof r.tl.errorShown === 'number' && r.tl.btnAfter && r.tl.btnAfter.disabled === false && r.rootHas === 0), (by['fail-root'] || []).map((r) => [r.tl.okBadge, r.tl.errorShown, r.tl.btnAfter, r.rootHas]));
  check('mesos-only failure stays non-fatal by design: the set is confirmed and the root document holds it', all('fail-meso', (r) => typeof r.tl.okBadge === 'number' && r.rootHas === 1 && r.mesosHas === 0), (by['fail-meso'] || []).map((r) => [r.tl.okBadge, r.rootHas, r.mesosHas]));
  check('offline: never claims a confirmed save ("✓ GUARDADO"), shows pending/local state, and after reconnection persists the set once in both documents', all('offline', (r) => r.tl.okBadge === undefined && (typeof r.tl.pendingBadge === 'number' || typeof r.tl.localBadge === 'number') && r.mesosHas === 1 && r.rootHas === 1 && typeof r.reconnectToPersistedMs === 'number'), (by.offline || []).map((r) => [r.tl.okBadge, r.tl.pendingBadge, r.tl.localBadge, r.mesosHas, r.rootHas, r.reconnectToPersistedMs]));
  check('invalid input (empty load) is rejected before any write and the button comes back usable with its original label', all('validation', (r) => r.tl.writes.length === 0 && r.tl.btnAfter && r.tl.btnAfter.disabled === false && /GUARDAR/.test(r.tl.btnAfter.text) && !/GUARDANDO/.test(r.tl.btnAfter.text)), (by.validation || []).map((r) => [r.tl.writes.length, r.tl.btnAfter]));
  check('root write failure restores the original button label (not "GUARDANDO…")', all('fail-root', (r) => r.tl.btnAfter && /GUARDAR/.test(r.tl.btnAfter.text) && !/GUARDANDO/.test(r.tl.btnAfter.text)), (by['fail-root'] || []).map((r) => r.tl.btnAfter));
  check('no uncaught page errors', rows.every((r) => !r.errs || r.errs.length === 0), rows.filter((r) => r.errs && r.errs.length).map((r) => [r.scenario, r.errs]));
  // write ordering: informational (parallel after PR #126, serial before)
  const mode = (by.normal || []).concat(by['meso-slow'] || []).map((r) => { const m = wr(r, 'mesos')[0], x = wr(r, 'root')[0]; return m && x ? (x.start < m.resolve - 5 ? 'parallel' : 'serial') : 'n/a'; });
  const result = { env, root: path.basename(ROOT), reps: REPS, writeStartMode: [...new Set(mode)], summary, rows, checks, notes: 'Emulator + injected delay; not production or network latency.' };
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('\nwrite start mode: ' + result.writeStartMode.join(','));
  for (const [n, s] of Object.entries(summary)) console.log(n.padEnd(15), 'n=' + s.n, 'busy', JSON.stringify(s.busyMs && s.busyMs.median), 'ok', s.okBadgeMs ? s.okBadgeMs.median + '/p95 ' + s.okBadgeMs.p95 : '-', 'refreshed', s.panelRefreshedMs ? s.panelRefreshedMs.median : '-', 'err', s.errorMs ? s.errorMs.median : '-');
  const failed = checks.filter((c) => !c.ok); console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed'); process.exit(failed.length ? 1 : 0);
})();
