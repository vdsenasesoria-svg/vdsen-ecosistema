#!/usr/bin/env node
'use strict';
// T544: Coach import -> staging plan -> Client, end to end (synthetic *.invalid accounts, staging only, cleaned up).
// The plan is NOT seeded: it is created by the real Coach page code (parsePlanFromJSON preview + saveImportedPlan), read back from staging,
// round-tripped through the Coach editor / export, and then executed in the real Client page.
//   NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-coach-import.cjs [--width 390] [--height 844] [--shots dir] [--out file.json]
const fs = require('node:fs');
const path = require('node:path');
const H = require('./client-staging-harness.cjs');
const B = require('./client-browser-lib.cjs');
const { runPerformancePass, restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const W = +arg('width', 390), Hh = +arg('height', 844), shots = arg('shots', null), outFile = arg('out', null);
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };

const set = (i, extra) => Object.assign({ setIndex: i, repsTarget: 8, rirTarget: 2, load: 0, restSeconds: 90 }, extra || {});
const IMPORT = { schema: 'vdsen-plan-v2', entrenamiento: { weeks: 6, daysPerWeek: 1, days: [{ dayIndex: 0, label: 'Mixto · Fuerza y capacidad', exercises: [
  { exerciseName: 'Press banca con barra', technique: 'straight', sets: [set(0), set(1), set(2)] },
  { exerciseName: 'Bicicleta zona 2', exerciseType: 'cardio', modo: 'z2', duracionMin: 30, fcZonaMin: 120, fcZonaMax: 140, sets: [] },
  { exerciseName: 'Dominadas estrictas', exerciseType: 'calistenia', rpeTarget: 8, sets: [set(0, { rpeTarget: 8 }), set(1, { rpeTarget: 8 }), set(2, { rpeTarget: 8 })] },
  { exerciseName: 'Farmer carry', exerciseType: 'estacion', dosis: 50, dosisUnit: 'm', tiempoObjetivoSeg: 60, sets: [0, 1, 2].map(i => set(i, { repsTarget: 1, restSeconds: 60, dosis: 50 })) },
  { exerciseName: 'Finisher metabólico', exerciseType: 'circuito', estructura: 'AMRAP', roundsObjetivo: 4, timeCapMin: 10, movimientos: [{ nombre: 'Burpee', dosis: 10 }, { nombre: 'Remo con kettlebell', dosis: 12 }], sets: [] }
] }] } };
const norm = ex => ({ n: ex.exerciseName, t: ex.exerciseType || null, sets: (ex.sets || []).length });

(async () => {
  const cfg = H.stagingConfig();
  const seed = await H.seed({ noPlan: true });
  const browser = await B.launch();
  try {
    if (shots) fs.mkdirSync(shots, { recursive: true });
    // ================= COACH =================
    const cctx = await B.newCtx(browser, { width: 1100, height: 900, transform: h => H.buildStagingHtml(h) });
    const c = await cctx.newPage(); c.on('framenavigated', f => { if (f === c.mainFrame()) console.log('NAV', f.url()); }); c.on('crash', () => console.log('CRASH')); c.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); }); const cerrs = []; c.on('pageerror', e => cerrs.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join('|')));
    await c.goto(B.APP + '/vdsen-coach.html'); await c.waitForSelector('#loginEmail');
    await c.fill('#loginEmail', seed.coach.email); await c.fill('#loginPass', seed.coach.password); await c.click('#loginBtn');
    // the page swaps <body> for the login card on the initial signed-out auth event; a reload re-renders the app shell with the persisted session
    await c.waitForTimeout(4000); await c.reload(); await c.waitForTimeout(1500); cerrs.length = 0; /* errors before this point come from the signed-out body swap, not the plan flow */
    try { await c.waitForSelector('[data-section="crearPlan"]', { state: 'visible', timeout: 30000 }); } catch (e) {
      if (shots) await c.screenshot({ path: shots + '/coach-login-fail.png' });
      console.log('DIAG', JSON.stringify({ err: await c.evaluate(() => (document.getElementById('loginErr') || {}).textContent), vis: await c.evaluate(() => Array.from(document.querySelectorAll('[data-section="crearPlan"]')).map(e => e.offsetParent !== null)), pe: cerrs.slice(0, 3), all: cerrs.length })); throw e; } await c.waitForTimeout(1500);
    await c.click('[data-section="crearPlan"]'); await c.waitForTimeout(800);
    await c.waitForFunction(id => { const s = document.getElementById('planClientSelect'); return s && Array.from(s.options).some(o => o.value === id); }, seed.athlete.uid, { timeout: 20000 });
    await c.selectOption('#planClientSelect', seed.athlete.uid);
    await c.evaluate(() => document.getElementById('jsonModeBtn').click()); await c.waitForSelector('#planJsonInput');
    await c.fill('#planJsonInput', JSON.stringify(IMPORT));
    await c.evaluate(() => parsePlanFromJSON()); await c.waitForSelector('#saveImportedPlanBtn', { timeout: 10000 });
    const pv = await c.evaluate(() => ({ ex: window._importedPlan.days[0].exercises.map(e => ({ n: e.exerciseName, t: e.exerciseType || null, sets: e.sets.length, dur: e.duracionMin, dose: e.dosis, cap: e.timeCapMin })), txt: document.getElementById('parsedPlanPreview').innerText }));
    check('COACH_PREVIEW_KEEPS_ALL_EXERCISES', pv.ex.length === 5 && ['cardio', 'calistenia', 'estacion', 'circuito'].every((t, i) => pv.ex[i + 1].t === t) && /Bicicleta zona 2/.test(pv.txt) && /Finisher/.test(pv.txt), JSON.stringify(pv.ex.map(x => x.t)));
    check('COACH_PREVIEW_KEEPS_PRESCRIPTION', pv.ex[1].dur === 30 && pv.ex[3].dose === 50 && pv.ex[4].cap === 10);
    if (shots) await c.screenshot({ path: path.join(shots, 'coach-preview.png') });
    await c.click('#saveImportedPlanBtn'); await c.waitForTimeout(1200);
    let clientDoc = null; for (let i = 0; i < 20; i++) { await c.waitForTimeout(1000); clientDoc = await restGet(cfg, seed.coach.email, seed.coach.password, 'clients/' + seed.athlete.uid); if (clientDoc && clientDoc.fields && clientDoc.fields.activePlanId && clientDoc.fields.activePlanId.stringValue) break; }
    const planId = clientDoc && clientDoc.fields && clientDoc.fields.activePlanId && clientDoc.fields.activePlanId.stringValue;
    check('COACH_SAVED_AND_ACTIVATED_PLAN', !!planId);
    seed.planId = planId;
    const readPlan = async (who = 'coach') => { const d = await restGet(cfg, seed[who].email, seed[who].password, 'plans/' + planId); return d && d.fields ? { doc: d, plan: Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, val(v)])) } : null; };
    const saved = await readPlan();
    const sx = saved ? saved.plan.days[0].exercises : [];
    check('SAVED_PLAN_STATUS_AND_OWNERSHIP', saved && saved.plan.status === 'active' && saved.plan.coachId === seed.coach.uid && saved.plan.clientId === seed.athlete.uid && saved.plan.schema !== 'x');
    check('SAVED_PLAN_KEEPS_TYPES', sx.length === 5 && sx.map(e => e.exerciseType || null).join() === ',cardio,calistenia,estacion,circuito'.replace(/^,/, 'null,').split(',').map(x => x === 'null' ? '' : x).join(',') || sx.map(e => e.exerciseType || '').join() === ',cardio,calistenia,estacion,circuito', sx.map(e => e.exerciseType || '-').join());
    check('SAVED_PLAN_KEEPS_PRESCRIPTION', sx[1] && sx[1].duracionMin === 30 && sx[1].fcZonaMin === 120 && sx[1].fcZonaMax === 140 && sx[1].modo === 'z2' && sx[2].rpeTarget === 8 && sx[2].sets[1].rpeTarget === 8 && sx[3].dosis === 50 && sx[3].dosisUnit === 'm' && sx[3].sets[2].dosis === 50 && sx[4].estructura === 'AMRAP' && sx[4].timeCapMin === 10 && sx[4].movimientos.length === 2);
    check('SAVED_PLAN_STRENGTH_UNCHANGED', sx[0] && !sx[0].exerciseType && sx[0].sets.length === 3 && sx[0].sets.every(s => s.repsTarget === 8 && s.rirTarget === 2 && s.restSeconds === 90) && !['modo', 'duracionMin', 'dosis', 'estructura'].some(k => k in sx[0]));
    check('SAVED_PLAN_EMPTY_SETS_KEPT_FOR_CARDIO_CIRCUITO', sx[1] && sx[4] && sx[1].sets.length === 0 && sx[4].sets.length === 0);
    const pids = sx.map(e => e.prescriptionExerciseId); check('SAVED_PIDS_UNIQUE_AND_PRESENT', pids.every(Boolean) && new Set(pids).size === 5);
    check('SAVED_ORDER_PRESERVED', sx.map(e => e.exerciseName).join('|') === IMPORT.entrenamiento.days[0].exercises.map(e => e.exerciseName).join('|'));
    const snapshot = stable(sx);

    // ---- editor round trip: open the real editor for this plan and save it untouched
    await c.evaluate(id => showClientDetail(id, { tab: 'plan' }), seed.athlete.uid); await c.waitForTimeout(2000);
    const opened = await c.evaluate(() => { const b = document.querySelector('[onclick*="toggleTrainingEditor"]'); if (b) { b.click(); return true; } return false; });
    await c.waitForTimeout(800);
    const rows = await c.evaluate(() => document.querySelectorAll('.exrow-item').length);
    check('EDITOR_OPENS_WITH_ALL_ROWS', opened && rows === 5, 'opened=' + opened + ' rows=' + rows);
    if (rows === 5) {
      await c.evaluate(() => { window.__sv = saveTrainingPlan(); return 1; }); await c.waitForTimeout(4500);
      const afterEdit = await readPlan(); const ax = afterEdit ? afterEdit.plan.days[0].exercises : [];
      check('EDIT_SAVE_KEEPS_TYPES_AND_PRESCRIPTION', ax.length === 5 && ax[1].exerciseType === 'cardio' && ax[1].duracionMin === 30 && ax[1].sets.length === 0 && ax[2].exerciseType === 'calistenia' && ax[2].sets[0].rpeTarget === 8 && ax[3].exerciseType === 'estacion' && ax[3].sets[1].dosis === 50 && ax[4].exerciseType === 'circuito' && ax[4].movimientos.length === 2 && !ax[0].exerciseType);
      check('EDIT_SAVE_KEEPS_PIDS', ax.map(e => e.prescriptionExerciseId).join() === pids.join());
    }

    // ---- export -> re-import round trip
    const exported = await c.evaluate(async ({ cid, pid }) => { let text = null; const orig = URL.createObjectURL; URL.createObjectURL = b => { b.text().then(t => { window.__exp = t; }); return orig.call(URL, b); }; await exportActivePlanJSON(cid, pid); await new Promise(r => setTimeout(r, 500)); text = window.__exp || null; return text; }, { cid: seed.athlete.uid, pid: planId });
    const ex = exported ? JSON.parse(exported).days[0].exercises : [];
    check('EXPORT_KEEPS_TYPES_AND_PRESCRIPTION', ex.length === 5 && ex[1].exerciseType === 'cardio' && ex[1].duracionMin === 30 && ex[3].sets[0].dosis === 50 && ex[4].movimientos.length === 2);
    await c.evaluate(() => document.getElementById('jsonModeBtn') && 0);
    check('NO_COACH_PAGE_ERRORS', cerrs.length === 0, cerrs.slice(0, 2).join(' | '));
    await cctx.close();

    // ================= CLIENT =================
    const S2 = async n => { if (shots) await p.screenshot({ path: path.join(shots, 'client-' + W + '-' + n + '.png') }); };
    const ctx = await B.newCtx(browser, { width: W, height: Hh, transform: h => H.buildStagingHtml(h) });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2200);
    await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); await p.waitForTimeout(500);
    try { await p.click('#nb1', { timeout: 8000 }); } catch (e) { if (shots) await p.screenshot({ path: path.join(shots, 'client-nb1-fail.png') }); console.log('DIAGNB', await p.evaluate(() => JSON.stringify({ on: !!document.querySelector('#scrApp.on'), url: location.href, top: (document.elementFromPoint(100, innerHeight - 20) || {}).id, vis: Array.from(document.querySelectorAll('.scr,[id^=scr]')).filter(e => e.offsetParent).map(e => e.id) }))); throw e; } await p.waitForTimeout(700);
    await runPerformancePass(p, { cfg, seed, S: S2, check, errs, day: 0, first: 1, storedExercises: async () => { const r = await readPlan('athlete'); return r.plan.days[0].exercises; } });
    // ---- strength exercise imported through the Coach behaves exactly as before
    await p.evaluate(() => selDia(0)); await p.waitForTimeout(500); await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500);
    check('FUERZA_STILL_STANDARD_CARD', await p.isVisible('#exPanel .setpanel') && (await p.$$('section.pf')).length === 0);
  } catch (e) { console.log('STACK', String(e.stack).split('\n').filter(l => /coach-import/.test(l)).slice(0, 2).join(' | ')); check('HARNESS', false, e.message.slice(0, 260)); }
  finally {
    await browser.close();
    const cleanup = await seed.cleanup(); console.log('CLEANUP ' + JSON.stringify(cleanup));
    const summary = { project: seed.project, viewport: W + 'x' + Hh, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), cleanup };
    if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0);
  }
})();
