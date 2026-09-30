#!/usr/bin/env node
'use strict';
// T543: real-browser pass of the specialized performance-type cards against Firebase STAGING (synthetic accounts, cleaned up).
//   NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-performance.cjs [--width 390] [--height 844] [--light] [--shots dir] [--out file.json]
// The synthetic plan (client-staging-harness.cjs) has one day with cardio / calistenia / estacion / circuito exercises.
const fs = require('node:fs');
const path = require('node:path');
const H = require('./client-staging-harness.cjs');
const B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const W = +arg('width', 390), Hh = +arg('height', 844), shots = arg('shots', null), outFile = arg('out', null), light = process.argv.includes('--light');
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const tag = (light ? 'light' : 'dark') + '-' + W;

async function restGet(cfg, email, password, docPath) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.idToken) return null;
  const d = await fetch('https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/' + docPath, { headers: { authorization: 'Bearer ' + j.idToken } });
  return d.status === 200 ? d.json() : { status: d.status };
}
const stable = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const val = v => v && ('stringValue' in v ? v.stringValue : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, val(x)])) : 'arrayValue' in v ? (v.arrayValue.values || []).map(val) : null);

(async () => {
  const cfg = H.stagingConfig();
  const seed = await H.seed({ keepFile: process.env.VDSEN_UI_KEEP || null });
  const browser = await B.launch();
  try {
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const ctx = await B.newCtx(browser, { width: W, height: Hh, transform: h => H.buildStagingHtml(h) });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const S = async n => { if (shots) await p.screenshot({ path: path.join(shots, tag + '-' + n + '.png') }); };
    await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2000);
    if (await p.$('#wnModal')) await p.click('#wnModal button');
    if (light) await p.evaluate(() => document.documentElement.classList.add('light-mode'));
    await p.click('#nb1'); await p.waitForTimeout(600); await p.evaluate(() => selDia(3)); await p.waitForTimeout(600);

    const rt = await p.evaluate(() => _EJERCICIOS_DIA.map(e => ({ n: e.exerciseName, t: e.exerciseType, pid: e.prescriptionExerciseId })));
    check('RUNTIME_KEEPS_TYPE_AND_PID', JSON.stringify(rt.map(x => x.t)) === JSON.stringify(['cardio', 'calistenia', 'estacion', 'circuito']) && rt.every((x, i) => x.pid === 'pid-h-' + (12 + i)), JSON.stringify(rt.map(x => x.t)));

    const audit = async (type, i) => {
      await p.evaluate(i => setEjActivo(i), i); await p.waitForTimeout(500);
      const card = 'section.pf[data-extype="' + type + '"]';
      check(type + ':CARD_RENDERED', (await p.$$(card)).length === 1 && await p.isVisible(card));
      check(type + ':PRESCRIPTION_PLATE', /PRESCRIPCIÓN/.test(await p.textContent(card + ' .spec-cap')) && /COACH/.test(await p.textContent(card + ' .spec-cap')));
      check(type + ':EXECUTION_LABELLED', /REGISTRO/.test(await p.textContent(card + ' .pf-reg')));
      const a = await p.evaluate(sel => {
        const c = document.querySelector(sel); const iw = window.innerWidth; const out = { small: [], unlabeled: [], prefilled: [], overflow: [] };
        c.querySelectorAll('input:not([type=hidden]),textarea,button,summary').forEach(e => { const r = e.getBoundingClientRect(); if (!r.width || e.offsetParent === null) return;
          if (r.height < 43.5 || r.width < 43.5) out.small.push((e.id || e.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
          if (/^(INPUT|TEXTAREA)$/.test(e.tagName) && !(e.labels && e.labels.length) && !e.getAttribute('aria-label')) out.unlabeled.push(e.id);
          if (/^(INPUT|TEXTAREA)$/.test(e.tagName) && e.type !== 'hidden' && e.value !== '') out.prefilled.push(e.id + '=' + e.value); });
        c.querySelectorAll('*').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && r.right > iw + 1) out.overflow.push(e.className || e.tagName); });
        out.sw = document.documentElement.scrollWidth; out.iw = iw; return out; }, card);
      check(type + ':TOUCH_FLOOR_44', a.small.length === 0, a.small.slice(0, 4).join(','));
      check(type + ':INPUTS_LABELLED', a.unlabeled.length === 0, a.unlabeled.join(','));
      check(type + ':NO_PREFILL_FROM_PRESCRIPTION', a.prefilled.length === 0, a.prefilled.join(','));
      check(type + ':NO_HORIZONTAL_OVERFLOW', a.sw <= a.iw + 1 && a.overflow.length === 0, a.overflow.slice(0, 3).join(','));
      await p.evaluate(() => { document.getElementById('tabEntr').scrollTop = 380; }); await p.waitForTimeout(200); await S(type);
    };
    const closeTimer = async () => { if (await p.isVisible('#restTimerOverlay')) { await p.mouse.click(10, 10); await p.waitForTimeout(300); } };

    // ---- cardio (single log per exercise)
    await audit('cardio', 0);
    await p.fill('#card_dur_log_1_3_0', '32'); await p.fill('#card_dist_log_1_3_0', '6.1'); await p.fill('#card_rpe_log_1_3_0', '6');
    await p.click('section.pf .pf-cta'); await p.waitForTimeout(1200);
    check('cardio:COMPLETES', await p.isVisible('section.pf .pf-cta.done'));
    // ---- calistenia (per set)
    await audit('calistenia', 1);
    await p.fill('#cal_reps_log_1_3_1_s0', '8'); await p.fill('#cal_load_log_1_3_1_s0', '5'); await p.fill('#cal_rpe_log_1_3_1_s0', '8');
    await p.click('section.pf .pf-set >> nth=0 >> .pf-check'); await p.waitForTimeout(1000); await closeTimer();
    check('calistenia:SET_COMPLETES', await p.isVisible('section.pf .pf-set.done'));
    // ---- estacion (per round)
    await audit('estacion', 2);
    await p.fill('#est_dose_log_1_3_2_s0', '50'); await p.fill('#est_time_log_1_3_2_s0', '55'); await p.fill('#est_rpe_log_1_3_2_s0', '7');
    await p.click('section.pf .pf-set >> nth=0 >> .pf-check'); await p.waitForTimeout(1000); await closeTimer();
    check('estacion:ROUND_COMPLETES', await p.isVisible('section.pf .pf-set.done'));
    // ---- circuito (single log)
    await audit('circuito', 3);
    await p.fill('#cir_rds_log_1_3_3', '4'); await p.fill('#cir_time_log_1_3_3', '9.5'); await p.fill('#cir_rpe_log_1_3_3', '8');
    await p.click('section.pf .pf-cta'); await p.waitForTimeout(1200);
    check('circuito:COMPLETES', await p.isVisible('section.pf .pf-cta.done'));

    // ---- Coach-authored technique detail cannot break the layout (injected hostile HTML inside the real container)
    await p.evaluate(() => {
      const host = document.querySelector('#exPanel'); const d = document.createElement('div'); d.className = 'tq'; d.id = '__hostile';
      d.innerHTML = '<div class="tq-b"><div class="tq-d"><table style="width:1200px"><tr><td>' + 'x'.repeat(200) + '</td></tr></table><img alt="" style="width:1400px;height:40px" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><div id="__fx" style="position:fixed;top:0;left:0;width:900px;height:900px;background:red">fixed</div><p style="width:2000px">' + 'palabra'.repeat(80) + '</p></div></div>';
      host.appendChild(d); });
    await p.waitForTimeout(300);
    const hz = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, fx: getComputedStyle(document.getElementById('__fx')).position, tw: document.querySelector('#__hostile .tq-d').scrollWidth <= document.querySelector('#__hostile .tq-d').clientWidth + 1 || getComputedStyle(document.querySelector('#__hostile .tq-b')).overflow === 'hidden' }));
    check('TECHNIQUE_DETAIL_CONTAINED', hz.sw <= hz.iw + 1 && hz.fx === 'static' && hz.tw, JSON.stringify(hz));
    await p.evaluate(() => document.getElementById('__hostile').remove());

    // ---- persisted evidence + Coach authority untouched
    let doc = null; for (let i = 0; i < 8; i++) { await p.waitForTimeout(1000); const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId); if (d && d.fields) { const k = Object.keys(d.fields.entries.mapValue.fields || {}); if (k.includes('log_1_3_0') && k.includes('log_1_3_3') && k.includes('log_1_3_1_s0') && k.includes('log_1_3_2_s0')) { doc = d; break; } } }
    const ent = doc ? val(doc.fields.entries) : {};
    check('EVIDENCE_CARDIO', ent.log_1_3_0 && ent.log_1_3_0.exType === 'cardio' && ent.log_1_3_0.duracionMin === 32 && ent.log_1_3_0.done === true);
    check('EVIDENCE_CALISTENIA', ent.log_1_3_1_s0 && ent.log_1_3_1_s0.exType === 'calistenia' && ent.log_1_3_1_s0.reps === 8 && ent.log_1_3_1_s0.lastre === 5);
    check('EVIDENCE_ESTACION', ent.log_1_3_2_s0 && ent.log_1_3_2_s0.exType === 'estacion' && ent.log_1_3_2_s0.dosis === 50 && ent.log_1_3_2_s0.tiempoSeg === 55);
    check('EVIDENCE_CIRCUITO', ent.log_1_3_3 && ent.log_1_3_3.exType === 'circuito' && ent.log_1_3_3.rounds === 4);
    check('NO_PRESCRIPTION_IN_EVIDENCE', ['log_1_3_0', 'log_1_3_1_s0', 'log_1_3_2_s0', 'log_1_3_3'].every(k => ent[k] && !('prescriptionExerciseId' in ent[k]) && !('rirTarget' in ent[k]) && !('rirPrescribed' in ent[k])));
    check('NO_CANONICAL_FIELDS_WRITTEN_BY_ATHLETE', !!doc && !doc.fields.progressionApplications && !doc.fields.nextExposureOverlays && !doc.fields.progressionApplicationSummary);
    const plan = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'plans/' + seed.planId);
    const exs = plan && plan.fields ? val(plan.fields.days).find(d => d.dayIndex === 3).exercises : [];
    const want = H.syntheticPlan('x', 'y').days[3].exercises;
    check('PRESCRIPTION_AND_PID_UNCHANGED', exs.length === 4 && exs.every((e, i) => e.prescriptionExerciseId === want[i].prescriptionExerciseId && e.exerciseType === want[i].exerciseType && stable(e.sets) === stable(want[i].sets)));
    check('NO_UNCAUGHT_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) { check('HARNESS', false, e.message.slice(0, 220)); }
  finally {
    await browser.close();
    const cleanup = await seed.cleanup(); console.log('CLEANUP ' + JSON.stringify(cleanup));
    const summary = { project: seed.project, viewport: W + 'x' + Hh, theme: light ? 'light' : 'dark', checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), cleanup };
    if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0);
  }
})();
