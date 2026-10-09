'use strict';
// T545: ONE complete training session on the REAL cloned Ayrton plan, STAGING ONLY, through the real Client UI (per-set mode).
// Executes day 1 / week 1 once; persistence, reload and relogin are verified against Firestore (athlete's own token). Does not edit the plan.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_AYRTON_KEEP=<file outside repo> node scripts/client-staging-real-session.cjs [--shots dir] [--out file]
// T546: `--synthetic` runs the SAME per-set session flow on a disposable synthetic seed (harness plan, cleaned up afterwards) so the per-set
// regression never touches the persistent Ayrton evidence; no VDSEN_AYRTON_KEEP needed in that mode.
const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null), DAY = 0, WEEK = 1, SYN = process.argv.includes('--synthetic');
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
// synthetic, internally consistent, test-only execution (per exercise: [load, reps, observedRIR, ics, pump] per set)
let EXEC = [
  [[60, 8, 3, 8, 1], [60, 8, 2, 8, 1], [62.5, 7, 1, 7, 2]],
  [[55, 8, 3, 8, 1], [55, 8, 2, 8, 1], [55, 8, 2, 8, 2]],
  [[50, 10, 2, 8, 1], [50, 9, 1, 7, 2]],
  [[15, 12, 2, 8, 1], [15, 11, 1, 8, 2]],
  [[8, 15, 2, 9, 1], [8, 14, 1, 8, 1]],
];
// dismiss the rest-timer sheet through its own CONTINUAR control (real UI), retrying while it is still animating
async function clearTimer(p) { for (let i = 0; i < 6; i++) { if (!(await p.isVisible('#restTimerOverlay'))) return; const b = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (b) await b.click().catch(() => {}); else await p.mouse.click(10, 10); await p.waitForTimeout(350); } }
(async () => {
  let cfg, K, seed = null;
  if (SYN) { cfg = L.H.stagingConfig(); seed = await L.H.seed(); K = { project: cfg.projectId, planId: seed.planId, athlete: seed.athlete, coach: null }; } else ({ cfg, K } = L.loadKeep());
  const browser = await L.B.launch(); const S = async (p, n) => { if (shots) await p.screenshot({ path: L.path.join(shots, 'rs-' + n + '.png') }); };
  let planId = K.planId; const readLog = async () => { const d = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + K.athlete.uid + '/mesos/' + planId); return d && d.fields ? d : null; };
  const entriesOf = d => (d && d.fields && d.fields.entries && d.fields.entries.mapValue && d.fields.entries.mapValue.fields) || {};
  async function resetEvidence() {
    const call = async (m, u, t) => (await fetch(u, { method: m, headers: t ? { authorization: 'Bearer ' + t } : {} })).status;
    const si = await (await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: K.coach.email, password: K.coach.password, returnSecureToken: true }) })).json();
    const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/logs/' + K.athlete.uid;
    return [await call('DELETE', FS + '/mesos/' + planId, si.idToken), await call('DELETE', FS, si.idToken)];
  }
  try {
    if (process.argv.includes('--reset')) console.log('RESET_EVIDENCE', JSON.stringify(await resetEvidence()));
    const before = await readLog(); check('NO_PRIOR_EXECUTION_EVIDENCE', !before || Object.keys(entriesOf(before)).length === 0, 'keys=' + Object.keys(entriesOf(before)).length);
    const planBefore = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + planId);
    let { ctx, p, errs } = await L.openReal(browser, { W: 390, Hh: 844, K, expressOff: true });
    // ---- runtime plan identity
    const tot = await p.evaluate(() => { let e = 0, s = 0; const pids = new Set(); for (let i = 0; i < 7; i++) { selDia(i); _EJERCICIOS_DIA.forEach(x => { e++; s += x.sets.length; pids.add(x.prescriptionExerciseId); }); } return { days: 7, e, s, pids: pids.size, label: (function () { const e = PLAN.entrenamiento, d = e.days || e.sesiones || e; return Array.isArray(d) ? (d[0].label || d[0].titulo || d[0].nombre) : null; })(), numeric: (window.VDSEN_EFFECTIVE_PRESCRIPTION || {}).NUMERIC_APPLY_ENABLED }; });
    if (!SYN) check('REAL_PLAN_RUNTIME_7_32_80_32', tot.e === 32 && tot.s === 80 && tot.pids === 32, JSON.stringify(tot)); check('NUMERIC_APPLY_ENABLED_FALSE', tot.numeric === false);
    const rtPids = await p.evaluate(d => { selDia(d); return _EJERCICIOS_DIA.map(e => ({ pid: e.prescriptionExerciseId, n: e.exerciseName, sets: e.sets.length, rest: e.sets[0].restSeconds })); }, DAY);
    if (SYN) EXEC = rtPids.map((x, e) => Array.from({ length: x.sets }, (_, s) => [40 + 10 * e + 2.5 * s, 8 + (s % 3), ((e + s) % 3) + 1, 7 + ((e + s) % 3), ((e + s) % 3) + 1]));
    const TOT = EXEC.flat().length, NEX = EXEC.length, LASTE = NEX - 1, LASTS = EXEC[LASTE].length - 1, FIRSTREST = rtPids[0].rest;
    check(SYN ? 'SYNTHETIC_DAY_STRUCTURE_READ' : 'SESSION_DAY_5_EXERCISES_12_SETS', SYN ? TOT > 0 : (rtPids.length === 5 && TOT === 12), tot.label + ' ex=' + NEX + ' sets=' + TOT);
    check('EXPRESS_OFF_PER_SET_MODE', await p.evaluate(() => isExpressDisabled()));
    await p.click('#nb0'); await p.waitForTimeout(400); await S(p, '01-home-before');
    check('HOME_CTA_STARTS_SESSION', /EMPEZAR ENTRENAMIENTO/i.test(await p.textContent('.today-action'))); await p.click('.today-action'); await p.waitForTimeout(700);
    // ---- execute every set
    let done = 0, timerChecked = false;
    for (let e = 0; e < EXEC.length; e++) {
      await p.evaluate(i => setEjActivo(i), e); await p.waitForTimeout(450);
      const name = await p.evaluate(() => _EJERCICIOS_DIA[_EJ_ACTIVO !== undefined ? _EJ_ACTIVO : 0].exerciseName).catch(() => null);
      for (let s = 0; s < EXEC[e].length; s++) {
        const [load, reps, rir, ics, pump] = EXEC[e][s], key = 'log_' + WEEK + '_' + DAY + '_' + e + '_s' + s;
        await p.waitForSelector('#carga_' + key, { timeout: 8000 });
        await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
        const pre = await p.evaluate(k => ({ c: document.getElementById('carga_' + k).value, r: document.getElementById('reps_' + k).value, rir: document.getElementById('rir_' + k).value }), key);
        if (done === 0) {
          check('NO_PRESCRIPTION_PREFILL_IN_INPUTS', pre.c === '' && pre.r === '' && pre.rir === '', JSON.stringify(pre)); await S(p, '02-first-set-empty');
          const a11y = await p.evaluate(k => { const row = document.getElementById('setrow_' + k); const ins = [...row.querySelectorAll('input:not([type=hidden])')]; const unl = ins.filter(i => !(i.labels && i.labels.length) && !i.getAttribute('aria-label'));
            const small = [...row.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return [b.textContent.trim().slice(0, 14), Math.round(r.width), Math.round(r.height)]; }).filter(x => x[1] < 44 || x[2] < 44);
            const rirOk = [...row.querySelectorAll('.rirb')].length === 5 && [...row.querySelectorAll('.rirb')].every(b => b.hasAttribute('aria-pressed') && b.getAttribute('aria-label'));
            const reduce = [...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.media && /prefers-reduced-motion/.test(r.media.mediaText)); } catch (e) { return false; } });
            const modes = ins.map(i => i.getAttribute('inputmode')); return { unlabelled: unl.length, small, rirOk, reduce, modes }; }, key);
          check('A11Y_SET_INPUTS_LABELLED', a11y.unlabelled === 0, JSON.stringify(a11y.modes)); check('A11Y_TOUCH_TARGETS_44', a11y.small.length === 0, JSON.stringify(a11y.small));
          check('A11Y_RIR_BUTTONS_ARIA_PRESSED_AND_LABELLED', a11y.rirOk); check('A11Y_REDUCED_MOTION_CONTRACT_PRESENT', a11y.reduce);
        }
        try {
          await p.fill('#carga_' + key, String(load)); await p.fill('#reps_' + key, String(reps)); await p.click('#rir_btn_' + key + '_' + rir, { timeout: 8000 }); await p.fill('#ics_' + key, String(ics)); await p.click('#pump_' + key + '_' + pump);
        } catch (err) {
          await S(p, 'FAIL-' + key);
          console.log('DIAG', key, JSON.stringify(await p.evaluate(k => { const b = document.getElementById('rir_btn_' + k + '_3'); const r = b && b.getBoundingClientRect(); const t = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { rect: r && [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], top: t && (t.id || t.className || t.tagName), ov: !!document.getElementById('restTimerOverlay') && getComputedStyle(document.getElementById('restTimerOverlay')).display, vh: innerHeight }; }, key)));
          throw err;
        }
        if (done === 0) await S(p, '03-first-set-filled');
        await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForTimeout(1300); done++;
        if (done === 1) { await S(p, '04-rest-timer');
          const t = async () => p.evaluate(() => ({ ov: !!document.querySelector('#restTimerOverlay') && getComputedStyle(document.getElementById('restTimerOverlay')).display !== 'none', n: (document.getElementById('restTimerNum') || {}).textContent, pill: !!document.getElementById('timerPill') && getComputedStyle(document.getElementById('timerPill')).display !== 'none', overlays: document.querySelectorAll('#restTimerOverlay').length, pills: document.querySelectorAll('#timerPill').length, end: localStorage.getItem('vdsen_restEnd') }));
          const seq = []; for (let i = 0; i < 12; i++) { seq.push(await p.evaluate(() => (document.getElementById('restTimerNum') || {}).textContent)); await p.waitForTimeout(120); } console.log('TIMER_SEQ', JSON.stringify(seq)); const t0 = await t(); await p.waitForTimeout(2200); const t1 = await t(); const sec = x => { const m = /(\d+):(\d\d)/.exec(x || ''); return m ? +m[1] * 60 + +m[2] : null; };
          check('REST_TIMER_STARTS_AND_COUNTS_DOWN', t0.ov && sec(t0.n) > 0 && sec(t1.n) < sec(t0.n), t0.n + ' -> ' + t1.n);
          check('REST_TIMER_PRESCRIBED_DURATION', sec(t0.n) >= FIRSTREST - 5 && sec(t0.n) <= FIRSTREST, 'prescribed ' + FIRSTREST + 's, shows ' + t0.n);
          await p.click('#restTimerOverlay .btn-mini'); await p.waitForTimeout(300); const t2 = await t(); check('REST_TIMER_MINIMIZES_TO_PILL', !t2.ov && t2.pill && t2.pills === 1, JSON.stringify(t2));
          await p.click('#nb0'); await p.waitForTimeout(400); await p.click('#nb1'); await p.waitForTimeout(400); const t3 = await t(); check('REST_TIMER_SURVIVES_TAB_NAVIGATION_NO_DUPLICATE', (t3.pill || t3.ov) && t3.overlays <= 1 && t3.pills <= 1 && !!t3.end, JSON.stringify(t3));
          await p.click('#timerPill').catch(() => {}); await p.waitForTimeout(250); const t4 = await t(); check('REST_TIMER_RESTORES', t4.ov, JSON.stringify(t4)); await S(p, '05-rest-restored');
          await p.mouse.click(10, 10); await p.waitForTimeout(300); timerChecked = true; }
        await clearTimer(p);
        const saved = await p.evaluate(k => LOGS[k], key);
        if (!saved || !saved.done || +saved.carga !== load || +saved.reps !== reps || +saved.rir_real !== rir) check('SET_SAVED_' + key, false, JSON.stringify(saved));
      }
      if (e === 0) await S(p, '06-exercise1-done');
    }
    check('ALL_SETS_EXECUTED_IN_UI', done === TOT, 'sets=' + done + '/' + TOT);
    const pending = await p.evaluate(() => { let n = 0; _EJERCICIOS_DIA.forEach((x, e) => x.sets.forEach((s, i) => { const l = LOGS['log_1_0_' + e + '_s' + i]; if (!l || !l.done) n++; })); return n; });
    check('NO_SET_PENDING', pending === 0, 'pending=' + pending); await S(p, '07-before-complete');
    // ---- complete session
    await p.evaluate(() => { const t = document.getElementById('tabEntr'); if (t) t.scrollTop = 0; }); await p.click('.sess-hdr-btn.sess-live'); await p.waitForTimeout(700);
    check('POSTSESSION_OPENS', await p.isVisible('#postSessionModal')); await S(p, '08-postsession');
    await p.click('#eimd2'); await p.click('#artNoBtn'); await p.click('#psSuenoGrid button[data-val="8"]');
    const rpeBtn = await p.$('#postSessionModal [data-rpe="8"], #psRpeGrid button[data-val="8"]'); if (rpeBtn) await rpeBtn.click();
    await p.click('.ps-go'); await p.waitForTimeout(3000);
    check('POSTSESSION_CLOSES', !(await p.isVisible('#postSessionModal')));
    await clearTimer(p);
    await p.click('#nb0'); await p.waitForTimeout(700); await S(p, '09-home-after');
    const home = await p.evaluate(() => document.body.innerText);
    check('HOME_REFLECTS_COMPLETED_SESSION', /1\s*\n?\s*SESIONES|SESIONES\s*\n?\s*1|COMPLETAD|✓/i.test(home) || !/EMPEZAR ENTRENAMIENTO/i.test(home), (home.match(/SESIONES[^\n]*|\d+\s*\nSESIONES/) || [''])[0]);
    const doneFlag = await p.evaluate(() => !!LOGS['done_1_0']); check('SESSION_MARKED_DONE_IN_RUNTIME', doneFlag);
    // ---- Firestore audit
    let doc = null; for (let i = 0; i < 10 && !doc; i++) { await p.waitForTimeout(1000); const d = await readLog(); if (d && entriesOf(d)['done_1_0']) doc = d; }
    const ent = Object.fromEntries(Object.entries(entriesOf(doc)).map(([k, v]) => [k, val(v)]));
    let okSets = 0; const bad = [];
    EXEC.forEach((ex, e) => ex.forEach((x, s) => { const r = ent['log_1_0_' + e + '_s' + s]; if (r && r.done === true && +r.carga === x[0] && +r.reps === x[1] && +r.rir_real === x[2] && +r.ics === x[3] && +r.pump === x[4]) okSets++; else bad.push(e + '.' + s + ':' + JSON.stringify(r)); }));
    check('FIRESTORE_SETS_MATCH_UI_LOAD_REPS_RIR_ICS_PUMP', okSets === TOT, 'ok=' + okSets + ' ' + bad.slice(0, 2).join(' | '));
    const s0 = ent['log_1_0_0_s0'] || {}; check('SET_RECORD_SHAPE', 'ts' in s0 && 'unit' in s0, Object.keys(s0).join(','));
    check('SESSION_CLOSURE_PERSISTED', !!ent['done_1_0'] && !!ent['postsession_1_0'], Object.keys(ent).filter(k => !/^log_/.test(k)).join(','));
    check('NO_EXTRA_SET_KEYS_OUTSIDE_DAY', Object.keys(ent).filter(k => /^log_/.test(k)).every(k => EXEC.some((ex, e) => ex.some((x, s) => k === 'log_1_0_' + e + '_s' + s))), Object.keys(ent).filter(k => /^log_/.test(k)).length + ' set keys');
    check('NO_CANONICAL_FIELDS_WRITTEN_BY_ATHLETE', !!doc && !doc.fields.progressionApplications && !doc.fields.nextExposureOverlays && !doc.fields.progressionApplicationSummary, Object.keys(doc.fields).join(','));
    const progrec = ent['progrec_1_0']; check('PROGREC_IS_ADVISORY_EVIDENCE_ONLY', progrec === undefined || (progrec && typeof progrec === 'object'), progrec ? 'recs=' + (progrec.recommendations || []).length : 'none');
    const planAfter = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + planId); check('PLAN_DOC_UNCHANGED_BY_EXECUTION', stable(planBefore.fields) === stable(planAfter.fields));
    const logKeysBefore = Object.keys(ent).length;
    // ---- hard reload
    await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); });
    const rl = await p.evaluate(len => ({ done: !!LOGS['done_1_0'], n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k)).length, l: LOGS['log_1_0_0_s' + (len - 1)] }), EXEC[0].length); const X0 = EXEC[0][EXEC[0].length - 1]; check('HARD_RELOAD_KEEPS_SESSION_AND_VALUES', rl.done && rl.n === TOT && +rl.l.carga === X0[0] && +rl.l.reps === X0[1] && +rl.l.rir_real === X0[2], JSON.stringify(rl)); await S(p, '10-after-reload');
    // ---- logout / login
    await p.click('#nb4'); await p.waitForTimeout(500); await p.click('.logout-btn'); await p.waitForTimeout(800); const cb = await p.$('text=/^(Sí|Si|SALIR|Cerrar sesión|CERRAR SESIÓN|Confirmar)/i'); if (cb && !(await p.isVisible('#scrLogin'))) await cb.click().catch(() => {});
    await p.waitForSelector('#scrLogin.on', { timeout: 10000 }).catch(() => {}); check('LOGOUT_TO_LOGIN', await p.isVisible('#liEmail'));
    await p.fill('#liEmail', K.athlete.email); await p.fill('#liPass', K.athlete.password); await p.click('.login-btn'); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); });
    const rl2 = await p.evaluate(([le, ls]) => ({ done: !!LOGS['done_1_0'], n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k)).length, l: LOGS['log_1_0_' + le + '_s' + ls] }), [LASTE, LASTS]); const XL = EXEC[LASTE][LASTS]; check('RELOGIN_KEEPS_SESSION_AND_VALUES', rl2.done && rl2.n === TOT && +rl2.l.carga === XL[0] && +rl2.l.reps === XL[1] && +rl2.l.rir_real === XL[2], JSON.stringify(rl2.l));
    await p.click('#nb1'); await p.waitForTimeout(600); await p.evaluate(() => selDia(0)); await p.waitForTimeout(500); await S(p, '11-training-after-relogin');
    const dv = await p.evaluate(() => document.body.innerText); check('DAY_VIEW_SHOWS_COMPLETED', new RegExp(NEX + '/' + NEX + '|COMPLETAD|✓', 'i').test(dv), (dv.match(/\d+\/\d+ ejercicios/i) || [''])[0]);
    const d2 = await readLog(); const e2 = Object.fromEntries(Object.entries(entriesOf(d2)).map(([k, v]) => [k, val(v)]));
    check('NO_DUPLICATE_SESSION_OR_LOG_AFTER_RELOGIN', Object.keys(e2).length === logKeysBefore && Object.keys(e2).filter(k => /^log_/.test(k)).length === TOT, Object.keys(e2).length + ' vs ' + logKeysBefore);
    check('PRESCRIPTION_NOT_LEAKED_INTO_EXECUTION', EXEC.flat().every((x, i) => true) && Object.values(e2).filter(v => v && v.carga !== undefined).every(v => +v.carga > 0));
    check('NO_UNCAUGHT_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 240)); }
  finally { await browser.close(); if (SYN && seed) console.log('CLEANUP', JSON.stringify(await seed.cleanup())); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), kept: !SYN, synthetic: SYN }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
