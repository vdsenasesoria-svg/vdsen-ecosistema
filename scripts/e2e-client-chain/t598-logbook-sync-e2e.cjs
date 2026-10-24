// T598 — logbook load reference (T597) in REAL Chrome against the Auth + Firestore Emulators, synthetic athletes only (demo project, nothing remote).
//   node scripts/e2e-client-chain/t598-logbook-sync-e2e.cjs [--out result.json] [--chrome chrome.exe] [--root <checkout>]
// PART 1 (one browser): S1 SIN HISTORIAL · S2 first save 10x10 · S3 next set REFERENCIA DE BITÁCORA 10 KG, load input separate and editable · S4 new session / previous exposure persists ·
//   S5 record 15 vs last 10 · S6 correction recalculates · S7 identity (PID) isolation · S8 KG<->LB without duplicated references.
// PART 2 (TWO independent Chrome profiles, same synthetic athlete): A saves -> B syncs and recovers the reference -> A modifies -> B replaces it -> concurrent saves from stale views ->
//   B offline save is NOT announced as confirmed and is not remote until reconnection -> after reconnection both agree; a second athlete is never touched.
// This is browser-to-browser synchronisation through the emulator. It is NOT a two-physical-phones test.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const here = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', here)), OUT = arg('out', null), CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PORT = 5199, PROJECT = 'demo-vdsen-client-e2e', ORIGIN = 'http://localhost:' + PORT, DBG_A = 9334, DBG_B = 9336;
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'; process.env.GCLOUD_PROJECT = PROJECT;
const admin = require(path.join(here, 'node_modules', 'firebase-admin'));
const db = admin.firestore(admin.initializeApp({ projectId: PROJECT }, 't598-sync'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 420))); }
const creds = () => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')).who;
const T0 = Date.parse('2026-09-27T12:00:00.000Z');

async function session(port, label) {
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(label + ': ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  return { send, ev, ws, label, async nav(url) { await send('Page.navigate', { url }); for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev('document.readyState')) === 'complete') return; } },
    net: (c) => send('Network.emulateNetworkConditions', Object.assign({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, c || {})) };
}
function launch(port) {
  const c = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t598-')), '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  return c;
}
// page helpers (identical in both browsers)
const PAGE = `
window.__ref = (ei) => { window.setEjActivo(ei); const cur = document.querySelector('.workout-set-current'); if (!cur) return null; const r = cur.querySelector('.sp-history-reference'), t = cur.querySelector('[data-effective-target]'), f = cur.querySelector('.sp-fields');
  const inp = [...cur.querySelectorAll('input')].find((i) => /^carga_/.test(i.id));
  return { set: cur.id, kind: r && r.dataset.loadReference, text: r && r.innerText, refTop: r && r.getBoundingClientRect().top, fieldsTop: f && f.getBoundingClientRect().top, target: t && t.innerText, hasPlanLoadText: /no prescrita/i.test(cur.innerText),
    input: inp ? { id: inp.id, value: inp.value, disabled: inp.disabled, readOnly: inp.readOnly, insideRef: !!(r && r.contains(inp)) } : null }; };
window.__forceSync = async () => { const real = Date.now; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
  Date.now = () => real.call(Date) + 31000; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); Date.now = real; await new Promise((r) => setTimeout(r, 1800)); };
window.__badges = () => { const ok = document.getElementById('saveOkBadge'), sp = document.getElementById('syncPendingBadge'); return { ok: ok && ok.style.opacity === '1' ? ok.textContent : '', pending: !!(sp && getComputedStyle(sp).display !== 'none'), err: (() => { const e = document.getElementById('saveErrBadge'); return !!(e && getComputedStyle(e).display !== 'none'); })() }; };`;

async function seed(names) {
  spawnSync(process.execPath, [path.join(here, 'scripts/e2e-client-chain/seed.cjs'), here, names.join(',')], { stdio: 'ignore' });
  const who = creds(), out = {};
  for (const n of names) out[n] = who[n];
  return out;
}
// ex0 (pid0) gets a week-1 history of 15 KG; ex1 (pid1) has NO history. Nothing else.
async function shapeHistory(a) {
  const e = {}; [0, 1, 2].forEach((s) => { e['log_1_0_0_s' + s] = { done: true, carga: '15', reps: '10', unit: 'KG', rir: 2, rir_real: 3, ics: 7, pump: 1, prescriptionExerciseId: a.pids[0], ts: T0 + s }; }); e.done_1_0 = true;
  for (const ref of [db.doc('logs/' + a.uid), db.doc('logs/' + a.uid + '/mesos/' + a.planId)]) await ref.set({ planId: a.planId, currentWeek: 2, entries: e });
}
const hist = async (a) => ((await db.doc('logs/' + a.uid).get()).data() || {}).exerciseHistory || {};
const entries = async (a, kind) => ((await db.doc(kind === 'mesos' ? 'logs/' + a.uid + '/mesos/' + a.planId : 'logs/' + a.uid).get()).data() || {}).entries || {};
const num = (s) => { const m = /(\d+(?:[.,]\d+)?)\s*(KG|LB)/i.exec(String(s || '')); return m ? { v: parseFloat(m[1].replace(',', '.')), u: m[2].toUpperCase() } : null; };
async function boot(p, who) {
  await p.nav(ORIGIN + '/cliente');
  await p.ev("(async()=>{const s=document.createElement('script');s.src='/__driver.js';document.head.appendChild(s);await new Promise(r=>s.onload=r);return window.__boot('" + who + "');})()");
  await p.ev("(async()=>{for(let i=0;i<150&&typeof window.selDia!=='function';i++)await new Promise(r=>setTimeout(r,200));const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent);b&&b.click();})()");
  await p.ev(PAGE); await p.ev('window.goTab(1)'); await sleep(500);
}
const save = (p, ei, si, carga) => p.ev("window.__logSet(0," + ei + "," + si + ",{carga:" + carga + ",reps:10,rir:2,ics:8,pump:1})");
const waitFor = async (fn, ms) => { const t = Date.now(); let v; while (Date.now() - t < (ms || 20000)) { v = await fn(); if (v) return v; await sleep(300); } return v; };

(async () => {
  const server = spawn(process.execPath, [path.join(here, 'scripts/e2e-client-chain/serve.cjs'), ROOT, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: '0' }), stdio: 'ignore' });
  await sleep(2500);
  const procs = [];
  try {
    // ───────────── PART 1 ─────────────
    const [g1] = Object.values(await seed(['G'])); await shapeHistory(g1);
    const chromeA = launch(DBG_A); procs.push(chromeA); await sleep(1800);
    let a = await session(DBG_A, 'A'); await boot(a, 'G');
    const P1 = g1.pids;
    let r = await a.ev('window.__ref(1)');
    check('S1 exercise with no history: SIN HISTORIAL before the editable fields; no invented load, no Coach number, empty load input', !!(r && r.kind === 'none' && /SIN HISTORIAL/.test(r.text) && r.refTop < r.fieldsTop && !r.hasPlanLoadText && !/\bCARGA\b/.test(r.target || '') && r.input && r.input.value === ''), r);
    r = await a.ev('window.__ref(0)');
    check('S4a previous exposure (week 1, 15 KG) is the reference of the new exposure; the Coach target shows structure only', !!(r && r.kind === 'logbook' && num(r.text) && num(r.text).v === 15 && num(r.text).u === 'KG' && /ESTRUCTURA COACH/.test(r.target) && !/CARGA/.test(r.target)), r);
    await save(a, 1, 0, 10);
    const eMeso = await entries(g1, 'mesos'), eRoot = await entries(g1, 'root');
    check('S2 first record 10 kg x 10 persisted once in the plan document and the root document', ['log_2_0_1_s0'].every((k) => eMeso[k] && eRoot[k] && eMeso[k].carga === '10' && eMeso[k].prescriptionExerciseId === P1[1]), { meso: !!eMeso.log_2_0_1_s0, root: !!eRoot.log_2_0_1_s0 });
    r = await a.ev('window.__ref(1)');
    check('S3 next set: REFERENCIA DE BITÁCORA, last valid load 10 KG; the executed-load input is separate, editable and not prefilled with the reference', !!(r && r.kind === 'logbook' && /REFERENCIA DE BITÁCORA/.test(r.text) && num(r.text).v === 10 && num(r.text).u === 'KG' && r.input && !r.input.disabled && !r.input.readOnly && !r.input.insideRef && r.input.value === '' && r.refTop < r.fieldsTop), r);
    // S4b: brand-new session of the same browser (reload + login again)
    await boot(a, 'G');
    r = await a.ev('window.__ref(1)');
    check('S4b a new session recovers the reference (10 KG) from the stored logbook', !!(r && r.kind === 'logbook' && num(r.text).v === 10), r);
    // S5: 10 x 10 today after a 15 KG exposure
    await save(a, 0, 0, 10);
    let h = await hist(g1), h0 = h['__pid__' + P1[0]];
    check('S5 personal best 15 KG stays separate from the last valid execution 10 KG (stored)', !!(h0 && h0.personalBest && h0.personalBest.load === '15' && h0.last && h0.last.load === '10'), h0);
    r = await a.ev('window.__ref(0)');
    check('S5 operational reference shown is 10 KG, not the 15 KG record', !!(r && num(r.text).v === 10), r);
    // S6: invalidate (editSet) -> recalculated from the remaining valid records
    await a.ev("window.editSet('log_2_0_0_s0')"); await sleep(1200);
    r = await a.ev('window.__ref(0)'); h0 = (await hist(g1))['__pid__' + P1[0]];
    check('S6a invalidating the last record recalculates the reference from the remaining valid ones (15 KG from week 1), in the UI and in the stored history', !!(r && r.kind === 'logbook' && num(r.text).v === 15 && h0 && h0.last && h0.last.load === '15'), { ui: r && r.text, stored: h0 && h0.last });
    await save(a, 0, 0, 12);
    r = await a.ev('window.__ref(0)'); h0 = (await hist(g1))['__pid__' + P1[0]];
    check('S6b the corrected record (12 KG) becomes the reference; the record stays 15 KG', !!(r && num(r.text).v === 12 && h0 && h0.last.load === '12' && h0.personalBest.load === '15'), { ui: r && r.text, stored: h0 });
    // S7 identity
    h = await hist(g1); const keys = Object.keys(h).sort();
    check('S7 identity: history keys are exactly the two PIDs; the exercise with a similar name never inherits the other load', JSON.stringify(keys) === JSON.stringify(['__pid__' + P1[0], '__pid__' + P1[1]].sort()) && h['__pid__' + P1[1]].last.load === '10' && h['__pid__' + P1[1]].personalBest.load === '10', keys.map((k) => [k, h[k].last.load, h[k].personalBest.load]));
    // S8 units
    await a.ev('window.toggleExUnit(0,1)'); await sleep(800); r = await a.ev('window.__ref(1)'); const lb = num(r && r.text);
    h = await hist(g1);
    check('S8a KG -> LB: reference converted (10 KG = 22.05 LB; shown with the app plate rounding, 22.5), one reference per PID', !!(lb && lb.u === 'LB' && Math.abs(lb.v - 22.05) <= 1.25) && Object.keys(h).length === 2, { text: r && r.text, keys: Object.keys(h).length });
    await a.ev('window.toggleExUnit(0,1)'); await sleep(800); r = await a.ev('window.__ref(1)'); const kg = num(r && r.text); h = await hist(g1);
    check('S8b LB -> KG: back to 10 KG without relevant precision loss and without duplicated references', !!(kg && kg.u === 'KG' && Math.abs(kg.v - 10) <= 0.1) && Object.keys(h).length === 2, { text: r && r.text, keys: Object.keys(h).length });
    a.ws.close(); chromeA.kill(); await sleep(900);

    // ───────────── PART 2 : two browsers ─────────────
    const both = await seed(['G', 'H']); const G = both.G, H = both.H; await shapeHistory(G);
    const hBefore = JSON.stringify([(await db.doc('logs/' + H.uid).get()).data(), (await db.doc('logs/' + H.uid + '/mesos/' + H.planId).get()).data()]);
    const cA = launch(DBG_A), cB = launch(DBG_B); procs.push(cA, cB); await sleep(2200);
    const A = await session(DBG_A, 'A'), B = await session(DBG_B, 'B'); await boot(A, 'G'); await boot(B, 'G');
    const pre = await B.ev('window.__ref(1)');
    check('P2-0 both browsers start from the same state (ex1 without history)', !!(pre && pre.kind === 'none'), pre);
    await save(A, 1, 0, 10);
    const ok1 = await waitFor(async () => (await entries(G, 'mesos')).log_2_0_1_s0 && (await entries(G, 'root')).log_2_0_1_s0, 15000);
    check('P2-1 A: first serie confirmed in the remote documents', !!ok1);
    // the app listens to logs/{uid}: B receives A's save on its own; the foreground-resync path is exercised right after as well
    const autoB = await waitFor(async () => { const x = await B.ev('window.__ref(1)'); return x && x.kind === 'logbook' && num(x.text).v === 10 ? x : null; }, 15000);
    check('P2-2 B recovers the reference created in A (10 KG) through the live listener, without any action', !!autoB, autoB && autoB.text);
    await B.ev('window.__forceSync()'); await sleep(500); let rB = await B.ev('window.__ref(1)');
    check('P2-3 B foreground resync keeps the same reference (10 KG)', !!(rB && rB.kind === 'logbook' && num(rB.text).v === 10), rB && rB.text);
    await A.ev("window.editSet('log_2_0_1_s0')"); await sleep(1000); await save(A, 1, 0, 12);
    const ok2 = await waitFor(async () => ((await entries(G, 'root')).log_2_0_1_s0 || {}).carga === '12', 15000);
    check('P2-4 A: the modified load (12 KG) is persisted', !!ok2);
    const autoB2 = await waitFor(async () => { const x = await B.ev('window.__ref(1)'); return x && x.kind === 'logbook' && num(x.text).v === 12 ? x : null; }, 15000);
    await B.ev('window.__forceSync()'); await sleep(500); rB = await B.ev('window.__ref(1)');
    check('P2-5 B REPLACES the previous reference (10 -> 12 KG), live and after foreground resync', !!(autoB2 && rB && num(rB.text).v === 12), { live: autoB2 && autoB2.text, resync: rB && rB.text });
    // true conflict: both browsers save the SAME set at the same moment with different loads
    await Promise.all([save(A, 1, 1, 13), save(B, 1, 1, 14)]);
    const conflict = await waitFor(async () => { const e = await entries(G, 'root'), m = await entries(G, 'mesos'); return e.log_2_0_1_s1 && m.log_2_0_1_s1 && e.log_2_0_1_s1.carga === m.log_2_0_1_s1.carga ? e.log_2_0_1_s1 : null; }, 20000);
    check('P2-6a simultaneous save of the SAME set from two browsers: one coherent winner (both documents agree)', !!(conflict && ['13', '14'].includes(conflict.carga)), conflict && conflict.carga);
    // different keys at the same moment: A ex1 s2, B ex0 s0: neither erases the other nor earlier entries
    await sleep(2500);
    await Promise.all([save(A, 1, 2, 15), save(B, 0, 0, 11)]);
    const both2 = await waitFor(async () => { const e = await entries(G, 'root'), m = await entries(G, 'mesos'); return e.log_2_0_1_s2 && e.log_2_0_0_s0 && m.log_2_0_1_s2 && m.log_2_0_0_s0; }, 20000);
    const eR = await entries(G, 'root');
    check('P2-6b simultaneous saves of DIFFERENT sets: neither device erased the other or earlier entries (per-entry persistence)', !!(both2 && eR.log_2_0_1_s0.carga === '12' && eR.log_2_0_1_s1 && eR.log_2_0_1_s2.carga === '15' && eR.log_2_0_0_s0.carga === '11'), Object.keys(eR).filter((k) => /^log_2_0_[01]/.test(k)).map((k) => [k, eR[k].carga, eR[k].ts]));
    await A.ev('window.__forceSync()'); await B.ev('window.__forceSync()'); await sleep(800);
    const e1 = Object.keys(eR).filter((k) => /^log_2_0_1/.test(k)).sort((x, y) => eR[y].ts - eR[x].ts), newest = e1[0];
    const stored1 = (await hist(G))['__pid__' + G.pids[1]];
    const [rA2, rB2] = [await A.ev('window.__ref(0)'), await B.ev('window.__ref(0)')];
    check('P2-7 timestamps decide: the stored reference of ex1 is its most recent execution, and after syncing both browsers show the same reference for ex0 (11 KG, B newest)', !!(stored1 && stored1.last.load === eR[newest].carga && rA2 && rB2 && num(rA2.text).v === 11 && num(rB2.text).v === 11), { newest, newestLoad: eR[newest].carga, stored: stored1 && stored1.last.load, A: rA2 && rA2.text, B: rB2 && rB2.text });
    // disconnection: B offline saves ex0 s0 (10) -> pending, not remote, not announced as confirmed
    await B.net({ offline: true }); await sleep(400);
    await save(B, 0, 1, 10); const bd = await B.ev('window.__badges()');
    const remoteDuring = (await entries(G, 'root')).log_2_0_0_s1;
    check('P2-8 offline: the local entry is NOT announced as confirmed ("✓ GUARDADO") and is NOT in the remote documents', !!(!/✓ GUARDADO/.test(bd.ok) && (bd.pending || /LOCAL/.test(bd.ok)) && !remoteDuring), { badges: bd, remote: !!remoteDuring });
    await A.ev('window.__forceSync()'); await sleep(600); const rAoff = await A.ev('window.__ref(0)');
    check('P2-9 while B is offline, A does not see its pending entry (A ex0 reference is still its own last execution, 11 KG)', !!(rAoff && num(rAoff.text).v === 11), rAoff && rAoff.text);
    await B.net({}); const rec = await waitFor(async () => ((await entries(G, 'root')).log_2_0_0_s1 || {}).carga === '10' && ((await entries(G, 'mesos')).log_2_0_0_s1 || {}).carga === '10', 40000);
    const cnt = Object.keys(await entries(G, 'root')).filter((k) => k === 'log_2_0_0_s1').length;
    check('P2-10 reconnection: B\'s entry reaches both documents exactly once', !!rec && cnt === 1);
    await A.ev('window.__forceSync()'); await sleep(800); const rAfter = await A.ev('window.__ref(0)');
    check('P2-11 after reconnection A recovers the reference created offline in B (ex0: 10 KG; record 15 KG stays separate)', !!(rAfter && num(rAfter.text).v === 10) && (await hist(G))['__pid__' + G.pids[0]].personalBest.load === '15', rAfter && rAfter.text);
    // isolation
    const hAfter = JSON.stringify([(await db.doc('logs/' + H.uid).get()).data(), (await db.doc('logs/' + H.uid + '/mesos/' + H.planId).get()).data()]);
    check('P2-12 another synthetic athlete is never touched by any of these writes', hBefore === hAfter);
    const errsA = await A.ev('window.__errs.slice()'), errsB = await B.ev('window.__errs.slice()');
    check('P2-13 no uncaught page errors in either browser', errsA.length === 0 && errsB.length === 0, { A: errsA, B: errsB });
  } catch (e) { check('harness completed', false, String(e && e.message || e)); }
  finally { procs.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } }); try { server.kill(); } catch (e) { /* ignore */ } }
  const failed = checks.filter((c) => !c.ok);
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ root: path.basename(ROOT), note: 'Browser-to-browser sync through the Firestore Emulator; not two physical phones.', checks }, null, 2)); }
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed'); process.exit(failed.length ? 1 : 0);
})();
