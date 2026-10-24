'use strict';
// T599-R — regression E2E of the progression chain (ex T600 audit harness, now asserting). It reproduces the T600 defects D-01/D-02/D-07 through the REAL Client; independent end-to-end audit of the progression chain, in REAL Chrome against the Auth + Firestore Emulators (synthetic athletes, demo project, nothing remote):
//   week-1 history (synthetic) -> week-2 session executed through the REAL Client UI (logbook + post-session + progrec by the Client's own v3.1 algorithm)
//   -> trusted server executor (the real /api/autonomous-progression-trigger handler served by scripts/e2e-client-chain/serve.cjs) -> record (PENDING/APPLIED/...) -> overlay
//   -> week-3 view in the Client -> first working set executed -> receipt -> CONSUMED.
// node scripts/e2e-t599r-independent/chain.cjs --numeric 1|0 [--only T1,T2] [--out file.json] [--shots dir] [--chrome path]
// --numeric 1 = SANDBOX server with numeric apply ON (emulator only); --numeric 0 = the production-like setting (numeric apply OFF: only PENDING may exist).
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const L = require('./lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const NUMERIC = arg('numeric', '1') === '1', ONLY = (arg('only', '') || '').split(',').filter(Boolean), OUT = arg('out', null), SHOTS = arg('shots', null);
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), PORT = 5199, DBG = 9334, ORIGIN = 'http://localhost:' + PORT;
const sleep = L.sleep;
const results = [];

// ───────────── fixtures: every number is chosen so the EXPECTED outcome follows from the written policy (assets/progression-*.js) ─────────────
const w2 = (load, reps, rir, ics) => (si) => ({ carga: load, reps: Array.isArray(reps) ? reps[si] : reps, rir, ics, pump: 1 });
const CASES = {
  // LOAD (rule A), REPS (rule A, rir target 1), SETS (S-ADD), REST (rule C first occurrence): one session, four exercises
  T1: { desc: 'progression dimensions', post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [
      { name: 'Press T599R LOAD', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 3, ics: 7, rir: 2 }, w2: w2(100, 10, 4, 7),
        expect: { dimension: 'LOAD', ruleId: 'A', previous: 100, candidate: 105, applied: 105, unit: 'KG' } },
      { name: 'Curl T599R REPS', muscleGroup: 'biceps', repsRange: { min: 8, max: 12 }, sets: L.S(3, 10, 1, 90), w1: { load: 60, reps: 10, rirReal: 2, ics: 7, rir: 1 }, w2: w2(60, 10, 2, 7),
        expect: { dimension: 'REPS', ruleId: 'A', previous: 10, candidate: 11, applied: 11 } },
      { name: 'Remo T599R SETS', muscleGroup: 'dorsal_ancho', sets: L.S(3, 10, 2, 90), w1: { load: 80, reps: 10, rirReal: 2, ics: 8, rir: 2 }, w2: w2(80, 10, 2, 8),
        expect: { dimension: 'SETS', ruleId: 'S-ADD', previous: 3, candidate: 4, applied: 4 } },
      { name: 'Ext T599R REST', muscleGroup: 'triceps', sets: L.S(3, 10, 2, 90), w1: { load: 40, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: w2(40, [10, 10, 8], 2, 7),
        expect: { dimension: 'REST', ruleId: 'C', previous: 90, candidate: 120, applied: 120, rest: 120, note: 'D-01: natural rule-C evidence, the Client says "maintain"' } },
      { name: 'Ext T599R REST2', muscleGroup: 'triceps', sets: L.S(3, 10, 2, 90), w1: { load: 40, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: (si) => ({ carga: 40, reps: [10, 10, 8][si], rir: [4, 4, 2][si], ics: 7, pump: 1 }),
        expect: { dimension: 'REST', ruleId: 'C', previous: 90, candidate: 120, applied: 120, rest: 120, note: 'earlier sets easier but the LAST working set is C' } }] },
  T2: { desc: 'deload (>=2 fatigue signals: sleep 5 h + session RPE 10)', post: { eimd: 1, articular: 'no', sleep: '5', rpe: 10 },
    ex: [{ name: 'Sentadilla T599R DELOAD', muscleGroup: 'cuadriceps', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 2, ics: 8, rir: 2 }, w2: w2(100, 10, 2, 8),
      expect: { dimension: 'DELOAD', ruleId: 'S-DELOAD', previous: 3, candidate: 2, applied: 2, components: { SETS: 2, LOAD: 90 } } }] },
  T3: { desc: 'freeze / hard-twice', post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [
      { name: 'Press T599R FZERO', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: w2(100, 10, 0, 7), expect: { dimension: 'FREEZE', ruleId: 'S-FREEZE-ZERO', previous: 100, candidate: 100, applied: 100 } },
      { name: 'Remo T599R HARD2', muscleGroup: 'dorsal_ancho', sets: L.S(3, 10, 3, 90), w1: { load: 80, reps: 10, rirReal: 1, ics: 7, rir: 3 }, w2: w2(80, 10, 1, 7), expect: { dimension: 'LOAD', ruleId: 'S-HARD-TWICE', previous: 80, candidate: 76, applied: 76 } },
      { name: 'Curl T599R FHARD', muscleGroup: 'biceps', sets: L.S(3, 10, 3, 90), w1: { load: 30, reps: 10, rirReal: 3, ics: 7, rir: 3 }, w2: w2(30, 10, 1, 7), expect: { dimension: 'FREEZE', ruleId: 'S-FREEZE-HARD', previous: 30, candidate: 30, applied: 30 } }] },
  T4: { desc: 'safety: articular pain reported after the source session', post: { eimd: 1, articular: 'si', sleep: '8', rpe: 7 },
    ex: [{ name: 'Press T599R PAIN', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 3, ics: 7, rir: 2 }, w2: w2(100, 10, 4, 7), expect: { blocked: true, reason: 'SAFETY_CONFLICT' } }] },
  T5: { desc: 'no prior history at all (first ever execution)', noWeek1: true, post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [{ name: 'Press T599R FIRST', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w2: w2(10, 10, 2, 7), expect: { blocked: true, reason: 'INSUFFICIENT_COMPARABLE_EXPOSURES' } }] },
  T6: { desc: 'identity: the only prior evidence carries a PID that is NOT in the plan (same exercise name snapshot)', foreignW1Pid: true, post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [{ name: 'Press T599R PIDA', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 4, ics: 7, rir: 2 }, w2: w2(100, 10, 4, 7), expect: { blocked: true, reason: 'INSUFFICIENT_COMPARABLE_EXPOSURES' } }] },
  T7: { desc: 'deload with a plan-declared rirByWeek for the target week (RIR is Coach-owned; only a plan-declared value may be carried)', planExtra: { rirByWeek: { 3: 4 } }, post: { eimd: 1, articular: 'no', sleep: '5', rpe: 10 },
    ex: [{ name: 'Sentadilla T599R RIRW', muscleGroup: 'cuadriceps', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 2, ics: 8, rir: 2 }, w2: w2(100, 10, 2, 8), expect: { dimension: 'DELOAD', ruleId: 'S-DELOAD', previous: 3, candidate: 2, applied: 2, components: { SETS: 2, LOAD: 90, RIR: 4 } } }] },
  T9: { desc: 'safety: the Coach edits the plan AFTER the overlay was applied (target must fall back to the base plan)', post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 }, planEditAfterApply: true,
    ex: [{ name: 'Press T599R PLANEDIT', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 3, ics: 7, rir: 2 }, w2: w2(100, 10, 4, 7), expect: { dimension: 'LOAD', ruleId: 'A', previous: 100, candidate: 105, applied: 105, uiAfterPlanEdit: 'BASE' } }] },
  T10: { desc: 'soreness veto (EIMD 3) -> one set less', post: { eimd: 3, articular: 'no', sleep: '8', rpe: 7 },
    ex: [{ name: 'Press T599R EIMD3', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 2, ics: 8, rir: 2 }, w2: w2(100, 10, 2, 8), expect: { dimension: 'SETS', ruleId: 'S-EIMD3', previous: 3, candidate: 2, applied: 2 } }] },
  T11: { desc: 'technique: average ICS < 6 -> load x0.85 ; ICS < 7 -> x0.90', post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [{ name: 'Press T599R ICS5', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: w2(100, 10, 2, 5), expect: { dimension: 'LOAD', ruleId: 'S-ICS-LT6', previous: 100, candidate: 85, applied: 85 } },
      { name: 'Remo T599R ICS65', muscleGroup: 'dorsal_ancho', sets: L.S(3, 10, 2, 90), w1: { load: 80, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: w2(80, 10, 2, 6.5), expect: { dimension: 'LOAD', ruleId: 'S-ICS-LT7', previous: 80, candidate: 72, applied: 72 } }] },
  T12: { desc: 'rules D / E: effort harder than prescribed, or reps incomplete without RIR -> COACH REVIEW only (no numeric candidate)', post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [{ name: 'Press T599R RULE-D', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 1, ics: 7, rir: 2 }, w2: w2(100, 10, 1, 7), expect: { review: 'D' } },
      { name: 'Remo T599R RULE-E', muscleGroup: 'dorsal_ancho', sets: L.S(3, 10, 2, 90), w1: { load: 80, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: (si) => ({ carga: 80, reps: [10, 10, 7][si], ics: 7, pump: 1 }), expect: { review: 'E', note: 'D-01: reps incomplete without RIR -> Coach review' } }] },
  T13: { desc: 'double progression at the ceiling of a real range (DP) vs fixed reps (MAINTAIN)', post: { eimd: 1, articular: 'no', sleep: '8', rpe: 7 },
    ex: [{ name: 'Curl T599R DP', muscleGroup: 'biceps', repsRange: { min: 8, max: 12 }, sets: L.S(3, 12, 2, 90), w1: { load: 20, reps: 12, rirReal: 2, ics: 7, rir: 2 }, w2: w2(20, 12, 2, 7), expect: { dimension: 'LOAD', ruleId: 'DP', previous: 20, candidate: 20.5, applied: 20.5 } },
      { name: 'Press T599R FIXED', muscleGroup: 'pectoral', sets: L.S(3, 10, 2, 90), w1: { load: 100, reps: 10, rirReal: 2, ics: 7, rir: 2 }, w2: w2(100, 10, 2, 7), expect: { review: null, reason: 'NO_ADJUSTMENT_NEEDED' } }] }
};

// ───────────── browser plumbing ─────────────
async function session(label, port) {
  port = port || DBG;
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params: params || {} })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) throw new Error(label + ': ' + JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails).slice(0, 300)); return r.result && r.result.result ? r.result.result.value : undefined; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  return { send, ev, ws, async nav(url) { await send('Page.navigate', { url }); for (let i = 0; i < 60; i++) { await sleep(250); if ((await ev('document.readyState')) === 'complete') return; } },
    async shot(file) { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.result.data, 'base64')); } };
}
const PAGE = `
window.__view = async (ei) => { window.setEjActivo(ei); await new Promise((r) => setTimeout(r, 600)); const txt = (e) => e ? e.innerText.replace(/\\s+/g, ' ').trim() : null;
  const rows = [...document.querySelectorAll('[id^="setrow_log_"]')].filter((e) => new RegExp('^setrow_log_\\\\d+_0_' + ei + '_s\\\\d+$').test(e.id));
  const cur = document.querySelector('.workout-set-current'), adj = document.querySelector('[data-autoadjust]'), tg = [...document.querySelectorAll('[data-effective-target]')];
  const chips = adj ? [...adj.querySelectorAll('.chip')].map((c) => c.innerText) : [];
  return { setRows: rows.length, setRowIds: rows.map((r) => r.id), autoadjust: txt(adj), autoadjustMain: txt(adj && adj.querySelector('.autoadj-main')), autoadjustNote: txt(adj && adj.querySelector('.autoadj-t')), chips,
    targets: tg.map((t) => ({ source: t.dataset.targetSource, text: txt(t) })), current: cur ? { id: cur.id, reference: txt(cur.querySelector('.sp-history-reference')), hasReference: !!cur.querySelector('.sp-history-reference') } : null,
    authority: txt(cur && cur.querySelector('.sp-authority')), authorityState: cur && cur.querySelector('[data-progression-state]') ? cur.querySelector('[data-progression-state]').dataset.progressionState : null, reference: txt(cur && cur.querySelector('.sp-history-reference')),
    exerciseName: txt(document.querySelector('.tr-title') || document.querySelector('[data-exname]')), pageText: (txt(document.getElementById('tabEntr')) || '').slice(0, 1800) }; };
window.__forceSync = async () => { const real = Date.now; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
  Date.now = () => real.call(Date) + 31000; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); Date.now = real; await new Promise((r) => setTimeout(r, 1800)); };
window.__scrollTop = () => { const sc = document.querySelector('.scroll'); if (sc) sc.scrollTop = 0; return true; };
window.__restTotal = () => { try { return parseInt(localStorage.getItem('vdsen_restTotal') || '0') || 0; } catch (e) { return -1; } };`;
async function bootAs(p, label) {
  await p.nav(ORIGIN + '/cliente');
  await p.ev("(async()=>{const s=document.createElement('script');s.src='/__driver.js';document.head.appendChild(s);await new Promise(r=>s.onload=r);return window.__boot('" + label + "');})()");
  await p.ev("(async()=>{for(let i=0;i<150&&typeof window.selDia!=='function';i++)await new Promise(r=>setTimeout(r,200));const b=[...document.querySelectorAll('button')].find(x=>/Ahora no/i.test(x.textContent)&&x.offsetParent);b&&b.click();})()");
  await p.ev(PAGE); await p.ev('window.goTab(1)'); await sleep(600);
}
const waitFor = async (fn, ms) => { const t = Date.now(); let v; while (Date.now() - t < (ms || 25000)) { v = await fn(); if (v) return v; await sleep(400); } return v; };

async function runCase(label, def) {
  const rec = { case: label, desc: def.desc, numericServer: NUMERIC, exercises: [] };
  const a = await L.seedAthlete(label, def.ex.map((e) => ({ name: e.name, muscleGroup: e.muscleGroup, repsRange: e.repsRange, sets: e.sets, w1: e.w1 })), { noWeek1: def.noWeek1, foreignW1Pid: def.foreignW1Pid, planExtra: def.planExtra });
  // a FRESH browser per session: a tab left behind keeps the Firestore persistence lease and stalls the next boot ("Cargando tu plan")
  let chrome = null, chromeB = null;
  const launch = async () => { chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t599r-')), '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' }); await sleep(1800); };
  const stop = async () => { try { chrome.kill(); } catch (e) { /* ignore */ } try { chromeB && chromeB.kill(); } catch (e) { /* ignore */ } await sleep(900); };
  try {
    await launch(); let p = await session(label); await bootAs(p, label);
    const weekAtStart = (await L.root_(a)).currentWeek;
    if (label === 'T5') {   // CASE A: first execution, no history: SIN HISTORIAL -> save 10x10 -> next set shows the athlete's own load
      rec.caseA = { before: await p.ev('window.__view(0)') };
      await p.ev("window.__logSet(0,0,0,{carga:10,reps:10,rir:2,ics:7,pump:1})"); await sleep(600);
      rec.caseA.afterFirstSave = await p.ev('window.__view(0)'); await p.shot(label + '-A-second-set-reference.jpg');
      await p.ev("window.__logSet(0,0,1,{carga:10,reps:10,rir:2,ics:7,pump:1})"); await p.ev("window.__logSet(0,0,2,{carga:10,reps:10,rir:2,ics:7,pump:1})");
      await p.ev("window.__finish(0," + JSON.stringify(def.post) + ")");
    } else {
      const specs = []; def.ex.forEach((e, ei) => e.sets.forEach((s, si) => specs.push([ei, si, e.w2(si)])));
      await p.ev("window.__session(0," + JSON.stringify(specs.map(([ei, si, v]) => [ei, si, v])) + "," + JSON.stringify(def.post) + ")");
    }
    await sleep(2500);
    const afterRoot = await L.root_(a);
    rec.weekAtStart = weekAtStart; rec.weekAfterSession = afterRoot.currentWeek;
    // wait for the trusted executor (the Client notifies it after the confirmed write); PENDING/REJECTED records appear after materialization
    const m1 = await waitFor(async () => { const m = await L.meso(a); return L.recordsOf(m).length ? m : null; }, 25000) || await L.meso(a);
    await sleep(NUMERIC ? 3000 : 1000);
    const mAfter = await L.meso(a);
    rec.progrecSeenByClient = (afterRoot.entries && afterRoot.entries['progrec_' + (weekAtStart) + '_0'] && afterRoot.entries['progrec_' + weekAtStart + '_0'].recommendations || []).map((r) => ({ exerciseName: r.exerciseName, action: r.action, newLoad: r.newLoad, newReps: r.newReps, newSets: r.newSets, prescriptionExerciseId: r.prescriptionExerciseId }));
    rec.deloadTriggers = (afterRoot.entries && afterRoot.entries['progrec_' + weekAtStart + '_0'] || {}).deloadTriggers || null;
    rec.summary = mAfter.progressionApplicationSummary || null;
    rec.postsession = afterRoot.entries && afterRoot.entries['postsession_' + weekAtStart + '_0'];
    if (def.planEditAfterApply) { await L.db.doc('plans/' + a.planId).set({ updatedAt: new Date().toISOString(), coachNote: 'T599R plan edit after apply' }, { merge: true }); rec.planEditedAfterApply = true; }
    // ── week-3 view, in a brand-new browser session ──
    p.ws.close(); await stop(); await launch(); p = await session(label); await bootAs(p, label);
    for (let ei = 0; ei < def.ex.length; ei++) {
      const e = def.ex[ei], pid = a.pids[ei], records = L.recFor(mAfter, pid).map(L.slim), overlays = L.ovFor(mAfter, pid).map(L.slimOv);
      const view = await p.ev('window.__view(' + ei + ')'); await p.ev('window.__scrollTop()'); await sleep(250); await p.shot(label + '-ex' + ei + '-week-view-top.jpg');
      rec.exercises.push({ name: e.name, pid: 'pid#' + ei, expect: e.expect, records, overlays, view });
    }
    // CASE J: a SECOND independent browser (own profile) of the same athlete must show the SAME effective prescription
    const norm = (v) => ({ adj: v.autoadjustMain, note: v.autoadjustNote, chips: (v.chips || []).join(','), targets: (v.targets || []).map((t) => t.text).join('|'), sheet: ((/SERIES (\d+) REPS (\d+) RIR (\d+) DESCANSO ([\d:]+)/.exec(v.pageText || '') || []).slice(1)).join(',') });
    let pB = null;
    if (label === 'T1') {
      chromeB = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9336', '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t599rb-')), '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' }); await sleep(2000);
      pB = await session(label + '-B', 9336); await bootAs(pB, label);
      const vb = []; for (let ei = 0; ei < def.ex.length; ei++) vb.push(norm(await pB.ev('window.__view(' + ei + ')')));
      const va = rec.exercises.map((x) => norm(x.view));
      rec.twoBrowsers = { beforeConsume: { equal: JSON.stringify(va) === JSON.stringify(vb), A: va, B: vb } };
    }
    // ── execute the first working set of each exercise in the target exposure with a load DIFFERENT from the suggestion, then check the receipt/consumption ──
    if (NUMERIC) {
      for (let ei = 0; ei < def.ex.length; ei++) {
        const ov = rec.exercises[ei].overlays[0]; if (!ov) continue;
        const exec = ov.dimension === 'LOAD' ? Number(ov.appliedValue) - 2.5 : Number(def.ex[ei].w1 ? def.ex[ei].w1.load : 50);
        try { await p.ev("window.__logSet(0," + ei + ",0,{carga:" + exec + ",reps:10,rir:2,ics:7,pump:1})"); } catch (err) { rec.exercises[ei].executeError = String(err.message).slice(0, 160); continue; }
        rec.exercises[ei].restTotalAfterFirstSet = await p.ev('window.__restTotal()'); rec.exercises[ei].executedLoad = exec;
        await sleep(1500); { const va = await p.ev('window.__view(' + ei + ')'); rec.exercises[ei].viewAfterFirstSet = { autoadjust: va.autoadjust, authorityState: va.authorityState, authority: va.authority, chips: va.chips, targets: va.targets.map((t) => t.text), sheet: ((/SERIES (\d+) REPS (\d+) RIR (\d+) DESCANSO ([\d:]+)/.exec(va.pageText || '') || []).slice(1)).join(',') }; await p.ev('window.__scrollTop()'); await p.shot(label + '-ex' + ei + '-after-first-set.jpg'); }
      }
      await sleep(4500);
      const mC = await L.meso(a);
      rec.exercises.forEach((x, ei) => { x.recordsAfterExecution = L.recFor(mC, a.pids[ei]).map((r) => ({ state: r.state, reasonCode: r.reasonCode })); x.overlaysAfterExecution = L.ovFor(mC, a.pids[ei]).map((o) => ({ status: o.status, appliedValue: o.appliedValue })); });
      rec.receipts = Object.keys(mC.consumptionReceipts || {}).length;
      if (pB) try { await pB.ev('window.__forceSync()'); await sleep(800); const vb2 = []; const va2 = []; for (let ei = 0; ei < def.ex.length; ei++) { vb2.push(norm(await pB.ev('window.__view(' + ei + ')'))); va2.push(norm(await p.ev('window.__view(' + ei + ')'))); }
        rec.twoBrowsers.afterConsume = { equalIgnoringProgressOfExecutedSet: JSON.stringify(vb2.map((x) => [x.adj, x.chips, x.targets])) === JSON.stringify(va2.map((x) => [x.adj, x.chips, x.targets])), A: va2, B: vb2 }; } catch (err) { rec.twoBrowsers.afterConsumeError = String(err.message).slice(0, 200); }
    }
    rec.errors = await p.ev('window.__errs.slice()');
    p.ws.close();
  } finally { await stop(); }
  return rec;
}

(async () => {
  const server = spawn(process.execPath, [path.join(L.root, 'scripts/e2e-client-chain/serve.cjs'), L.root, String(PORT)], { env: Object.assign({}, process.env, { E2E_NUMERIC: NUMERIC ? '1' : '0' }), stdio: 'ignore' });
  await sleep(2500);
  try {
    for (const label of Object.keys(CASES)) { if (ONLY.length && ONLY.indexOf(label) < 0) continue; console.log('CASE ' + label + ' — ' + CASES[label].desc + (NUMERIC ? ' [numeric sandbox ON]' : ' [numeric OFF]')); results.push(await runCase(label, CASES[label])); }
  } catch (e) { console.log('HARNESS ERROR', e && e.stack || e); results.push({ harnessError: String(e && e.message || e) }); }
  finally { try { server.kill(); } catch (e) { /* ignore */ } }
  // ───────────── assertions (the audit harness became a regression gate) ─────────────
  const checks = [];
  const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' — ' + JSON.stringify(detail).slice(0, 360))); };
  const sheetRest = (v) => { const m = /DESCANSO ([\d:]+)/.exec(v.pageText || ''); return m ? (() => { const [a, b] = m[1].split(':').map(Number); return a * 60 + b; })() : null; };
  for (const r of results) {
    if (r.harnessError) { ck('harness completed', false, r.harnessError); continue; }
    const def = CASES[r.case];
    r.exercises.forEach((x) => {
      const e = x.expect || {}, q = x.records[0], ov = x.overlays[0], tag = r.case + '/' + x.name, st = x.view.authorityState, applied = ov && ov.status === 'APPLIED';
      if (e.dimension) {
        if (NUMERIC) {
          ck(tag + ' APPLIED by policy with the expected dimension and value', q && q.state === 'APPLIED' && ov && ov.dimension === e.dimension && Number(ov.appliedValue) === e.applied, { q: q && [q.state, q.reasonCode], ov });
          ck(tag + ' record.dimension = applied dimension (D-07)', q && q.dimension === e.dimension, q && q.dimension);
          if (def && def.planEditAfterApply) return;
          ck(tag + ' Client says AUTOAJUSTE APLICADO (not "sugerido") and Coach structure is not relabelled', st === 'APPLIED' && /AUTOAJUSTE APLICADO/.test(x.view.authority || '') && !/SUGERIDO/.test(x.view.pageText || '') && !/PRESCRIPCI.N\s*COACH/i.test(x.view.pageText || ''), { st, authority: x.view.authority });
          ck(tag + ' Client explains the change with a plain-language reason', /Motivo:/.test(x.view.authority || ''), x.view.authority);
          if (x.recordsAfterExecution) ck(tag + ' CONSUMED after the real first working set', x.recordsAfterExecution[0] && x.recordsAfterExecution[0].state === 'CONSUMED', x.recordsAfterExecution);
          if (e.rest) ck(tag + ' rest on the sheet and the operating timer are the same effective value', sheetRest(x.view) === e.rest && x.restTotalAfterFirstSet === e.rest, { sheet: sheetRest(x.view), timer: x.restTotalAfterFirstSet });
        } else {
          ck(tag + ' numeric OFF: PENDING only, no overlay, never APPLIED, athlete told it is pending', q && q.state === 'PENDING' && !x.overlays.length && (st === 'PENDING') && /PENDIENTE/.test(x.view.authority || ''), { q: q && [q.state, q.magnitude && q.magnitude.eligible], st });
        }
      } else if (e.review) {
        ck(tag + ' Coach review required (rule ' + e.review + ') on a PENDING record; no overlay; athlete sees REVISIÓN REQUERIDA', q && q.state === 'PENDING' && q.magnitude && q.magnitude.coachReviewRequired === e.review && !x.overlays.length && st === 'COACH_REVIEW', { q: q && [q.state, q.magnitude && q.magnitude.coachReviewRequired], st });
      } else if (e.blocked || e.reason) {
        ck(tag + ' no authorized adjustment (' + (e.reason || 'blocked') + '): no overlay, never APPLIED/CONSUMED', !x.overlays.length && !(q && /APPLIED|CONSUMED/.test(q.state)) && st !== 'APPLIED' && st !== 'CONSUMED', { q: q && q.state, st });
      }
    });
    if (def && def.planEditAfterApply && NUMERIC) {
      const x = r.exercises[0], av = x.viewAfterFirstSet || {};
      ck(r.case + ' D-02: an overlay invalidated by a plan edit shows the base plan before AND after the first set', st0(x) && av.authorityState !== 'APPLIED' && av.authorityState !== 'CONSUMED' && !/AUTOAJUSTE APLICADO/.test(av.authority || '') && !(av.autoadjust || ''), { before: x.view.authorityState, after: av });
      ck(r.case + ' D-02: no receipt and the record is NOT turned into CONSUMED', r.receipts === 0 && x.recordsAfterExecution && x.recordsAfterExecution[0].state === 'APPLIED' && x.overlaysAfterExecution[0].status === 'APPLIED', { receipts: r.receipts, rec: x.recordsAfterExecution });
    }
    if (r.twoBrowsers) ck(r.case + ' two browsers show the same effective prescription' + (NUMERIC ? ' before and after consumption' : ''), r.twoBrowsers.beforeConsume.equal && (!NUMERIC || (r.twoBrowsers.afterConsume && r.twoBrowsers.afterConsume.equalIgnoringProgressOfExecutedSet)), r.twoBrowsers);
    ck(r.case + ' no uncaught page errors', !(r.errors && r.errors.length), r.errors);
  }
  function st0(x) { return x.view.authorityState !== 'APPLIED' && x.view.authorityState !== 'CONSUMED'; }
  const out = { sha: require('child_process').execSync('git rev-parse HEAD', { cwd: L.root }).toString().trim(), numericSandbox: NUMERIC, note: 'Emulator only; synthetic athletes; week-2 session executed through the real Client UI.', results, checks };
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); }
  results.forEach((r) => { if (r.harnessError) return; console.log('\n== ' + r.case + ' (week ' + r.weekAtStart + ' -> ' + r.weekAfterSession + ') progrec: ' + JSON.stringify(r.progrecSeenByClient));
    r.exercises.forEach((x) => console.log('  ' + x.name + ' | expect ' + JSON.stringify(x.expect) + '\n    records ' + JSON.stringify(x.records.map((q) => [q.state, q.reasonCode, q.magnitude && q.magnitude.ruleId, q.magnitude && q.magnitude.candidates.map((c) => c.dimension + ':' + c.finalCandidate)])) +
      '\n    overlays ' + JSON.stringify(x.overlays.map((o) => [o.dimension, o.previousValue, o.appliedValue, o.status])) + '\n    ui ' + JSON.stringify({ rows: x.view.setRows, adj: x.view.autoadjustMain || x.view.autoadjust, chips: x.view.chips }) + (x.recordsAfterExecution ? '\n    after-execution ' + JSON.stringify(x.recordsAfterExecution) + ' rest=' + x.restTotalAfterFirstSet : '')));
  });
  const failed = checks.filter((c) => !c.ok); console.log(String.fromCharCode(10) + (checks.length - failed.length) + '/' + checks.length + ' checks passed'); process.exit(failed.length ? 1 : 0);
})();
