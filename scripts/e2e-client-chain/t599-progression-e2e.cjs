'use strict';
// Real Client DOM -> Auth/Firestore emulators -> real authenticated server handler -> next exposure -> receipt/CONSUMED.
// Requires local emulators 9099/8085 with the repository rules; never uses a remote project or credentials.
// NODE_PATH may point to a scratch installation of playwright-core. No product dependency is introduced.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');
const ROOT = path.resolve(__dirname, '../..'), PROJECT = 'demo-vdsen-client-e2e';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'vdsen-t599-progression')));
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'; process.env.GCLOUD_PROJECT = PROJECT;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const admin = require(path.join(ROOT, 'node_modules/firebase-admin'));
const app = admin.initializeApp({ projectId: PROJECT }, 't599-browser'), db = app.firestore();
const checks = [], evidence = [], sleep = ms => new Promise(r => setTimeout(r, ms));
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + JSON.stringify(detail || '').slice(0, 350)); }
function must(name, ok, detail) { check(name, ok, detail); if (!ok) throw new Error(name); }
const state = async a => (await db.doc('logs/' + a.uid + '/mesos/' + a.planId).get()).data();
const ovs = m => Object.values(m.nextExposureOverlays || {});
const recs = m => Object.values(m.progressionApplications || {});
async function boot(browser, label, port = 5199) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('http://localhost:' + port + '/cliente'); await page.addScriptTag({ url: '/__driver.js' });
  await page.evaluate(who => window.__boot(who), label);
  await page.waitForFunction(() => typeof window.selDia === 'function');
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Ahora no/i.test(x.textContent) && x.offsetParent); if (b) b.click(); window.goTab(1); window.setEjActivo(0); });
  await sleep(1000); return { ctx, page };
}
async function trigger(a, port = 5200) {
  const auth = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: a.email, password: a.password, returnSecureToken: true }) });
  const token = (await auth.json()).idToken; if (!token) throw new Error('synthetic login failed');
  const r = await fetch('http://localhost:' + port + '/api/autonomous-progression-trigger', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ planId: a.planId }) });
  return { status: r.status, body: await r.json() };
}
// The real Client advances the week in BOTH log documents; moving only the root left the newer meso document (and its currentWeek) as log authority, so the athlete stayed in week 3.
async function week(a, n) { await db.doc('logs/' + a.uid).update({ currentWeek: n }); await db.doc('logs/' + a.uid + '/mesos/' + a.planId).update({ currentWeek: n }); }
const snapshot = page => page.evaluate(() => {
  window.setEjActivo(0); const row = document.querySelector('.workout-set-current'), ex = getSesiones()[0].exercises[0];
  return { target: row && row.querySelector('[data-effective-target]')?.innerText, authority: row && row.querySelector('.sp-authority')?.innerText,
    state: row && row.querySelector('[data-progression-state]')?.dataset.progressionState, history: row && row.querySelector('.sp-history-reference')?.innerText,
    effective: ex.sets, count: ex.numSeries, rows: document.querySelectorAll('[data-effective-target]').length, copy: row && row.querySelector('.pw-use')?.innerText,
    errors: window.__errs, progress: document.querySelector('.workout-progress')?.innerText };
});
async function shape(a, spec) {
  const ref = db.doc('plans/' + a.planId), p = (await ref.get()).data();
  // The Coach prescribes no numerical load; longitudinal history supplies 10 KG.
  p.days[0].exercises = p.days[0].exercises.slice(0, 1);
  const ex = p.days[0].exercises[0]; ex.rir = spec.rir; ex.muscleGroup = 'pectoral'; delete ex.repsRange;
  if (spec.range) ex.repsRange = { min: 8, max: 12 };
  ex.sets.forEach(s => { s.load = 0; s.rirTarget = spec.rir; s.repsTarget = 10; s.restSeconds = 150; });
  ex.numSeries = ex.sets.length;
  if (spec.dim === 'DELOAD') p.rirByWeek = { 1: spec.rir, 2: spec.rir, 3: 4, 4: spec.rir };
  await ref.set(p);
  const entries = { done_1_0: true };
  for (let s = 0; s < 3; s++) entries['log_1_0_0_s' + s] = { done: true, carga: '10', reps: '10', unit: 'KG', rir: spec.rir, rir_real: spec.priorRir ?? spec.real, ics: spec.ics, pump: 1, prescriptionExerciseId: a.pids[0], ts: Date.parse('2026-09-27T12:00:00Z') + s };
  await db.doc('logs/' + a.uid).set({ planId: a.planId, currentWeek: 2, entries });
  await db.doc('logs/' + a.uid + '/mesos/' + a.planId).set({ planId: a.planId, entries });
}
const specs = [
  { label: 'L', dim: 'LOAD', rir: 2, real: 4, ics: 7.5 },
  { label: 'R', dim: 'REPS', rir: 1, real: 3, ics: 7.5, range: true },
  { label: 'S', dim: 'SETS', rir: 2, real: 2, ics: 8.5 },
  { label: 'T', dim: 'REST', rir: 2, real: 2, ics: 7.5, reps: 8 },
  { label: 'D', dim: 'DELOAD', rir: 2, real: 2, ics: 7.5, post: { rpe: '10', sleep: '5' } },
  { label: 'F', dim: 'FREEZE', rir: 2, real: 0, priorRir: 2, ics: 7.5 }
];
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); const servers = []; let browser;
  try {
    for (const [port, numeric] of [[5199, '0'], [5200, '1']]) {
      const fd = fs.openSync(path.join(OUT, 'server-' + port + '.log'), 'w');
      const p = spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), ROOT, String(port)], { env: { ...process.env, E2E_NUMERIC: numeric }, stdio: ['ignore', fd, fd] }); servers.push(p);
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) { await sleep(250); try { ready = (await fetch('http://localhost:' + port + '/__trigger-log')).ok; } catch (_) {} }
      if (!ready) throw new Error('local test server not ready ' + port);
    }
    const seeded = spawnSync(process.execPath, [path.join(__dirname, 'seed.cjs'), ROOT, specs.map(s => s.label).concat('N').join(',')], { encoding: 'utf8' });
    if (seeded.status) throw new Error('seed failed: ' + seeded.stderr);
    const who = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'vdsen-client-e2e-creds.json'))).who;
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    for (const spec of specs) {
      const a = who[spec.label]; await shape(a, spec);
      let b = await boot(browser, spec.label);
      const logged = await b.page.evaluate(async s => window.__session(0, [0, 1, 2].map(si => [0, si, { carga: 10, reps: s.reps || 10, rir: s.real, ics: s.ics, pump: 1 }]), s.post), spec);
      let m = await state(a); const pending = recs(m).find(r => r.prescriptionExerciseId === a.pids[0] && r.nextExposure?.week === 3);
      must(spec.dim + ' real UI exposure confirmed in Firestore', [0, 1, 2].every(si => m.entries['log_2_0_0_s' + si]?.done), logged);
      must(spec.dim + ' server generates PENDING before numeric sandbox gate opens', pending?.state === 'PENDING' && !ovs(m).length, pending && { state: pending.state, magnitude: pending.magnitude, reason: pending.reasonCode });
      await b.ctx.close(); await week(a, 3); b = await boot(browser, spec.label);
      const pendUI = await snapshot(b.page);
      must(spec.dim + ' PENDING never changes effective prescription', pendUI.state === 'PENDING' && pendUI.effective.every(s => !s.load) && pendUI.effective.length === 3, pendUI);
      await b.ctx.close();
      const applied = await trigger(a); m = await state(a); const ov = ovs(m).find(o => o.target.week === 3);
      must(spec.dim + ' authenticated trusted handler produces APPLIED in sandbox', applied.status === 200 && ov?.status === 'APPLIED' && ov.dimension === spec.dim, { response: applied, overlay: ov });
      b = await boot(browser, spec.label, 5200); const ui = await snapshot(b.page);
      const eff = ui.effective, c = ov.components || {}, expectedN = spec.dim === 'SETS' ? ov.appliedValue : (c.SETS || 3);
      const targetNumbersMatch = eff.every(s => ui.target.includes(s.repsTarget + ' reps') && ui.target.includes('RIR ' + s.rirTarget) && ui.target.includes(expectedN + ' series') && ui.target.includes('Descanso ' + Math.floor(s.restSeconds / 60) + ':' + String(s.restSeconds % 60).padStart(2, '0')));
      must(spec.dim + ' athlete-visible numbers match the operational sets', targetNumbersMatch && (!['LOAD','FREEZE','DELOAD'].includes(spec.dim) || ui.target.includes('CARGA ' + eff[0].load + ' KG')), ui.target);
      must(spec.dim + ' real next-exposure DOM has exact server objective and row count', ui.state === 'APPLIED' && eff.length === expectedN && ui.rows === expectedN && /OBJETIVO DE ESTA SERIE/.test(ui.target) &&
        (['LOAD','FREEZE'].includes(spec.dim) ? eff.every(s => s.load === ov.appliedValue) : spec.dim === 'REPS' ? eff.every(s => s.repsTarget === ov.appliedValue) : spec.dim === 'REST' ? eff.every(s => s.restSeconds === ov.appliedValue) : spec.dim === 'DELOAD' ? eff.every(s => s.load === c.LOAD && s.rirTarget === c.RIR) : true), ui);
      await b.page.screenshot({ path: path.join(OUT, spec.dim.toLowerCase() + '-applied.png'), fullPage: true });
      const v = eff[0]; await b.page.evaluate(x => window.__logSet(0, 0, 0, x), { carga: v.load || 10, reps: v.repsTarget, rir: v.rirTarget, ics: 7.5, pump: 1 });
      const timer = await b.page.evaluate(() => ({ stored: Number(localStorage.getItem('vdsen_restTotal')), visible: document.getElementById('restTimerNum')?.innerText }));
      must(spec.dim + ' real save starts effective rest timer', timer.stored === v.restSeconds, timer);
      await trigger(a); await sleep(1000); m = await state(a);
      const stored = m.entries.log_3_0_0_s0, receipt = m.consumptionReceipts?.[ov.sourceRecordKey];
      must(spec.dim + ' real Client receipt + persisted PID execution become CONSUMED', !!receipt && m.nextExposureOverlays[ov.key].status === 'CONSUMED' && m.progressionApplications[ov.sourceRecordKey].state === 'CONSUMED' && stored.prescriptionExerciseId === a.pids[0] && Number(stored.carga) === (v.load || 10) && Number(stored.reps) === v.repsTarget && Number(stored.rir) === v.rirTarget, { receipt, stored });
      for (let si = 1; si < expectedN; si++) await b.page.evaluate(async x => { window.stopRestTimer(); return window.__logSet(0, 0, x.si, x.v); }, { si, v: { carga: eff[si].load || 10, reps: eff[si].repsTarget, rir: eff[si].rirTarget, ics: 7.5, pump: 1 } });
      m = await state(a); const rootLog = (await db.doc('logs/' + a.uid).get()).data();
      const executedKeys = Object.keys(m.entries).filter(k => /^log_3_0_0_s\d+$/.test(k) && m.entries[k].done);
      const progress = await b.page.evaluate(() => { window.stopRestTimer(); return document.body.innerText; });
      must(spec.dim + ' rendered count, completed session progress and both stored log documents agree', executedKeys.length === expectedN && executedKeys.every(k => rootLog.entries[k]?.done) && progress.includes(expectedN + '/' + expectedN), { expectedN, executedKeys, progressComplete: progress.includes(expectedN + '/' + expectedN) });
      await b.ctx.close(); b = await boot(browser, spec.label, 5200); const reloaded = await snapshot(b.page);
      must(spec.dim + ' consumed overlay remains effective after a new browser session', JSON.stringify(reloaded.effective) === JSON.stringify(eff), reloaded.state);
      await b.ctx.close(); await week(a, 4); b = await boot(browser, spec.label, 5200); const next = await snapshot(b.page);
      const carry = ['LOAD','REPS','SETS','REST'].includes(spec.dim);
      must(spec.dim + ' continuity respects carried vs exposure-scoped authority', carry ? JSON.stringify(next.effective) === JSON.stringify(eff) : next.effective.length === 3 && next.effective.every(s => s.load === 0), next.effective);
      evidence.push({ dimension: spec.dim, overlay: ov, pending: { state: pending.state, key: pending.key }, ui, timer, receipt, execution: stored, continuity: next.effective });
      await b.ctx.close();
    }
    const n = who.N; await shape(n, { rir: 3, real: 3, ics: 7.5 });
    const pr = db.doc('plans/' + n.planId), plan = (await pr.get()).data(); plan.days[0].exercises[0].sets.forEach(s => s.repsTarget = 8); await pr.set(plan);
    const b = await boot(browser, 'N'), before = await snapshot(b.page);
    must('Brave reported case: historical 10 KG remains separate from 3x8 RIR3 rest2:30, no invented adjustment', before.effective.length === 3 && before.effective.every(s => s.repsTarget === 8 && s.rirTarget === 3 && s.restSeconds === 150 && !s.load) && /10 KG/.test(before.history) && /Sin autoajuste aplicado/.test(before.authority), before);
    await b.page.screenshot({ path: path.join(OUT, 'no-authorized-adjustment.png'), fullPage: true });
    const copy = await b.page.evaluate(() => { const row = document.querySelector('.workout-set-current'), btn = row.querySelector('.pw-use'); const warning = row.innerText; btn.click(); return { warning, draft: row.querySelector('[id^="reps_"]').value, target: row.querySelector('[data-effective-target]').innerText }; });
    must('historical copy warns about 10 vs 8 reps; editable execution stays separate from objective', /Objetivo vigente: 8 reps/.test(copy.warning) && /No es una recomendación/.test(copy.warning) && copy.draft === '10' && /8/.test(copy.target), copy);
    await b.ctx.close();
  } catch (e) { check('full real-browser lifecycle completed', false, e.stack); }
  finally { if (browser) await browser.close(); servers.forEach(p => p.kill()); await app.delete(); }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ project: PROJECT, source: 'real Chrome mobile emulation + Auth/Firestore emulators + real server handler; no physical Brave claim', checks, evidence }, null, 2));
  const fail = checks.filter(c => !c.ok).length; console.log(`${checks.length - fail}/${checks.length} checks passed`); process.exit(fail ? 1 : 0);
})();
