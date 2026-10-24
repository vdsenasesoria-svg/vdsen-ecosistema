'use strict';
// T601 — the SAME scripted athlete session against a build root (production b5f53af or the candidate), real Chrome, Auth + Firestore EMULATORS only (synthetic athlete, demo project).
//   node scripts/t601/compare.cjs --root <checkout> --label prod|cand --out file.json [--shots dir]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const here = path.resolve(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', here)), LABEL = arg('label', 'cand'), OUT = arg('out', null), SHOTS = arg('shots', null);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe', PORT = 5199, DBG = 9334, DBG2 = 9336, ORIGIN = 'http://localhost:' + PORT, PROJECT = 'demo-vdsen-client-e2e';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'; process.env.GCLOUD_PROJECT = PROJECT;
const admin = require(path.join(here, 'node_modules', 'firebase-admin'));
const db = admin.firestore(admin.initializeApp({ projectId: PROJECT }, 't601-' + LABEL));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const row = (area, check, ok, detail) => { rows.push({ area, check, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + LABEL + ' · ' + area + ' · ' + check + (ok ? '' : ' — ' + JSON.stringify(detail).slice(0, 260))); };
const creds = () => JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json'), 'utf8')).who.G;
async function session(port, label) {
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(label + ': ' + JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 240)); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  return { send, ev, ws, size: (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true, screenWidth: w, screenHeight: h }),
    net: (c) => send('Network.emulateNetworkConditions', Object.assign({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, c || {})),
    async nav(u) { await send('Page.navigate', { url: u }); for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev('document.readyState')) === 'complete') return; } },
    async shot(f) { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, LABEL + '-' + f), Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 })).result.data, 'base64')); } };
}
function launch(port) { return spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t601-')), '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' }); }
async function boot(p) {
  await p.nav(ORIGIN + '/cliente');
  await p.ev("(async()=>{const s=document.createElement('script');s.src='/__driver.js';document.head.appendChild(s);await new Promise(r=>s.onload=r);return window.__boot('G');})()");
  await p.ev("(async()=>{for(let i=0;i<150&&typeof window.selDia!=='function';i++)await new Promise(r=>setTimeout(r,200));const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent);b&&b.click();})()");
  await p.ev('window.goTab(1)'); await sleep(700);
}
const entries = async (a) => ((await db.doc('logs/' + a.uid + '/mesos/' + a.planId).get()).data() || {}).entries || {};
const rootEntries = async (a) => ((await db.doc('logs/' + a.uid).get()).data() || {}).entries || {};
const SNAP = `(() => { const t = (e) => e ? e.innerText.replace(/\\s+/g, ' ').trim() : ''; const cur = document.querySelector('.workout-set-current'), tab = document.getElementById('tabEntr');
  const prog = /(\\d+)\\/(\\d+)\\s*SERIES/.exec(t(tab)) || [];
  return { hasCurrent: !!cur, curId: cur && cur.id, inputs: cur ? { carga: !!cur.querySelector('input[id^=carga_]'), reps: !!cur.querySelector('input[id^=reps_]'), rir: cur.querySelectorAll('[id^=rir_btn_]').length, ics: !!cur.querySelector('input[id^=ics_]'), pump: cur.querySelectorAll('[id^=pump_]').length,
    save: [...cur.querySelectorAll('button')].filter((b) => /completeSet/.test(b.getAttribute('onclick') || '')).map((b) => t(b))[0] || null } : null,
    progress: prog.length ? [Number(prog[1]), Number(prog[2])] : null, tabText: t(tab).slice(0, 2500), exNames: [...(t(tab).match(/(Press de pecho E2E|Curl predicador E2E)/g) || [])], overflowX: document.documentElement.scrollWidth > innerWidth, bodyLen: document.body.innerText.length,
    prevWeek: /ÚLTIMA SEM/i.test(t(tab)), useBtn: /USAR CARGA/i.test(t(tab)), obj: /OBJETIVO DE ESTA SERIE/.test(t(tab)), ref: /REFERENCIA DE BIT/.test(t(tab)), estructura: /ESTRUCTURA COACH/.test(t(tab)), legacyCoach: /PRESCRIPCI.N\\s*COACH/i.test(t(tab)), sug: /SUGERIDO PARA HOY/.test(t(tab)) }; })()`;

(async () => {
  console.log('== ' + LABEL + ' build at ' + ROOT);
  const server = spawn(process.execPath, [path.join(here, 'scripts/e2e-client-chain/serve.cjs'), ROOT, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: '0' }), stdio: 'ignore' });
  await sleep(2500); const procs = [];
  try {
    spawnSync(process.execPath, [path.join(here, 'scripts/e2e-client-chain/seed.cjs'), here, 'G'], { stdio: 'ignore' }); const a = creds();
    let c = launch(DBG); procs.push(c); await sleep(1800); let p = await session(DBG, 'A'); await boot(p);
    const build = await p.ev('window.VDSEN_CLIENT_BUILD || null'); row('Identidad', 'build identificado', !!build, build);
    for (const [tab, name] of [[0, 'Inicio'], [1, 'Entrenamiento'], [2, 'Nutrición'], [3, 'Check-in'], [4, 'Perfil']]) {
      await p.ev('window.goTab(' + tab + ')'); await sleep(450); const sn = await p.ev(SNAP);
      row('Navegación', name + ' renderiza contenido sin desbordar horizontalmente', sn.bodyLen > 120 && !sn.overflowX, { len: sn.bodyLen, overflowX: sn.overflowX });
    }
    await p.ev('window.goTab(1)'); await sleep(600); let s = await p.ev(SNAP); await p.shot('01-entreno.jpg');
    row('Entrenamiento', 'lista los 2 ejercicios del plan', s.exNames.includes('Press de pecho E2E') && s.exNames.includes('Curl predicador E2E'), s.exNames);
    row('Entrenamiento', 'serie actual con carga, reps, RIR 0-5, ICS, pump y botón GUARDAR', s.hasCurrent && s.inputs && s.inputs.carga && s.inputs.reps && s.inputs.rir >= 5 && s.inputs.ics && s.inputs.pump === 3 && /GUARDAR/.test(s.inputs.save || ''), s.inputs);
    row('Entrenamiento', 'contador de series de la sesión', !!s.progress && s.progress[1] === 6, s.progress);
    row('Historial', 'bloque «Última semana» con USAR CARGA/REPS', s.prevWeek && s.useBtn, { prevWeek: s.prevWeek, use: s.useBtn });
    const before = s.progress && s.progress[0];
    await p.ev("window.__logSet(0,0,0,{carga:80,reps:10,rir:2,ics:8,pump:1})"); await sleep(500);
    const e1 = await entries(a), k = 'log_2_0_0_s0';
    row('Guardado', 'la serie se persiste (documento del plan y raíz) con carga/reps/RIR/ICS/pump', e1[k] && (await rootEntries(a))[k] && e1[k].carga === '80' && e1[k].reps === '10' && String(e1[k].rir_real) === '2' && Number(e1[k].ics) === 8 && Number(e1[k].pump) === 1 && e1[k].done === true, e1[k]);
    s = await p.ev(SNAP); row('Progreso', 'el contador avanza al guardar', !!s.progress && s.progress[0] === before + 1, s.progress);
    row('Descanso', 'se inicia el temporizador de descanso (90 s del plan)', (await p.ev("parseInt(localStorage.getItem('vdsen_restTotal')||'0')||0")) === 90, null);
    await p.ev("window.stopRestTimer && window.stopRestTimer(); window.editSet('" + k + "')"); await sleep(800);
    s = await p.ev(SNAP); row('Corrección', 'reabrir la serie la devuelve a edición (no cuenta como hecha)', (await entries(a))[k].done === false && s.progress[0] === before, s.progress);
    await p.ev("window.__logSet(0,0,0,{carga:82.5,reps:9,rir:1,ics:7,pump:2})"); await sleep(500);
    const e2 = await entries(a); row('Corrección', 'la corrección reemplaza el valor sin duplicar (82.5 × 9)', e2[k].carga === '82.5' && e2[k].reps === '9' && e2[k].done === true, e2[k]);
    await p.ev("window.stopRestTimer && window.stopRestTimer(); window.__logSet(0,0,1,{carga:82.5,reps:9,rir:1,ics:7,pump:2})");
    p.ws.close(); c.kill(); await sleep(900); c = launch(DBG); procs.push(c); await sleep(1800); p = await session(DBG, 'A2'); await boot(p); s = await p.ev(SNAP);
    row('Reanudación', 'una sesión nueva conserva las 2 series guardadas', !!s.progress && s.progress[0] === 2 && s.hasCurrent, s.progress);
    await p.ev('window.setEjActivo(0)'); await sleep(400); await p.net({ offline: true }); await sleep(400);
    await p.ev("window.stopRestTimer && window.stopRestTimer(); window.__logSet(0,0,2,{carga:82.5,reps:8,rir:1,ics:7,pump:1})");
    const badge = await p.ev("(()=>{const ok=document.getElementById('saveOkBadge'),sp=document.getElementById('syncPendingBadge');return {ok: ok&&ok.style.opacity==='1'?ok.textContent:'',pending:!!(sp&&getComputedStyle(sp).display!=='none')}})()");
    const remoteDuring = (await entries(a)).log_2_0_0_s2;
    row('Offline', 'sin red no se anuncia «✓ GUARDADO» y se avisa que está pendiente / local', !/✓ GUARDADO/.test(badge.ok) && (badge.pending || /LOCAL/.test(badge.ok)) && !remoteDuring, { badge, remote: !!remoteDuring });
    await p.net({}); let ok = false; for (let i = 0; i < 40 && !ok; i++) { await sleep(500); const e = await entries(a); ok = e.log_2_0_0_s2 && e.log_2_0_0_s2.carga === '82.5' && (await rootEntries(a)).log_2_0_0_s2; }
    row('Offline', 'al reconectar la serie llega a ambos documentos', !!ok, null);
    const c2 = launch(DBG2); procs.push(c2); await sleep(2000); const p2 = await session(DBG2, 'B'); await boot(p2); const sB = await p2.ev(SNAP);
    row('Sincronización', 'un segundo navegador ve las 3 series ya guardadas', !!sB.progress && sB.progress[0] === 3, sB.progress); p2.ws.close(); c2.kill();
    for (const [w, h] of [[320, 640], [360, 740], [390, 844], [430, 932], [740, 360]]) { await p.size(w, h); await sleep(400); await p.ev('window.goTab(1)'); await sleep(400); const sv = await p.ev(SNAP);
      row('Móvil ' + w + 'x' + h, 'entrenamiento sin desbordamiento horizontal, con serie actual y botón GUARDAR', !sv.overflowX && sv.hasCurrent && /GUARDAR/.test((sv.inputs && sv.inputs.save) || ''), { overflowX: sv.overflowX, save: sv.inputs && sv.inputs.save }); }
    // GUARDAR visible sin desplazar (lo que el propietario aprobó en producción): parte alta de la tarjeta, tras restablecer el scroll
    for (const [w, h] of [[360, 740], [390, 844], [430, 932]]) { await p.size(w, h); await sleep(400); await p.ev('window.goTab(1); window.setEjActivo(1); (function(){var sc=document.querySelector(".scroll"); if(sc) sc.scrollTop=0;})()'); await sleep(500);
      const v = await p.ev("(()=>{const cur=document.querySelector('.workout-set-current');const b=cur&&[...cur.querySelectorAll('button')].find((x)=>/completeSet/.test(x.getAttribute('onclick')||''));if(!b)return null;const r=b.getBoundingClientRect(),nav=document.querySelector('.bnav'),navTop=nav?nav.getBoundingClientRect().top:innerHeight;const cr=cur.getBoundingClientRect();const h=(q)=>{const e=cur.querySelector(q);return e?Math.round(e.getBoundingClientRect().height):0};return {top:Math.round(r.top),bottom:Math.round(r.bottom),navTop:Math.round(navTop),cardH:Math.round(cr.height),parts:{target:h('.sp-target')||h('[data-effective-target]'),ref:h('.sp-history-reference'),auth:h('.sp-authority'),reuse:h('.pw-use')}}})()");
      row('Visibilidad ' + w + 'x' + h, 'GUARDAR SERIE queda visible sin desplazar al abrir el ejercicio (altura de tarjeta ' + (v && v.cardH) + ' px)', !!v && v.bottom <= v.navTop, v); }
    await p.size(390, 844); await sleep(300);
    await p.ev("(async()=>{for(const [ei,si] of [[0,3],[1,0],[1,1],[1,2]]){try{window.stopRestTimer&&window.stopRestTimer();}catch(e){} try{await window.__logSet(0,ei,si,{carga:60,reps:10,rir:2,ics:8,pump:1});}catch(e){return String(e.message)} } return 'ok'})()").catch(() => 'x');
    const s2 = await p.ev(SNAP); const fin = await p.ev("(()=>{const b=[...document.querySelectorAll('button')].find((x)=>(x.getAttribute('onclick')||'').startsWith('markSessionDone(0)'));return !!b})()");
    row('Finalización', 'tras completar las series aparece COMPLETAR', fin, s2.progress);
    const r = await p.ev("(async()=>{try{return JSON.stringify(await window.__finish(0,{eimd:1,articular:'no',sleep:'8',rpe:7}))}catch(e){return 'ERR '+e.message}})()");
    const root = (await db.doc('logs/' + a.uid).get()).data() || {};
    row('Finalización', 'el post-sesión se persiste y la semana avanza', !!(root.entries && root.entries.postsession_2_0) && root.currentWeek === 3, { week: root.currentWeek, r: String(r).slice(0, 80) });
    row('Errores', 'sin errores de página no capturados', !(await p.ev('window.__errs.length')), await p.ev('window.__errs.slice(0,3)'));
    p.ws.close();
  } catch (e) { row('Arnés', 'completó', false, String(e && e.message || e)); }
  finally { procs.forEach((x) => { try { x.kill(); } catch (e) { /* ignore */ } }); try { server.kill(); } catch (e) { /* ignore */ } }
  const failed = rows.filter((x) => !x.ok); console.log(LABEL + ': ' + (rows.length - failed.length) + '/' + rows.length + ' checks passed');
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, root: ROOT, rows }, null, 1)); }
  process.exit(0);
})();
