'use strict';
// T546: Express-mode EVIDENCE INTEGRITY on staging through the real Client UI (default express mode, disposable synthetic seed, cleaned up):
// prescribed values are never observed values -- untouched RIR / ICS / Pump are absent, an explicit tap persists exactly, and the final
// RIR is never copied onto the earlier Express sets. Also: reload / relogin, plan unchanged, no canonical fields written by the athlete.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-express-evidence.cjs [--shots dir] [--out file]
const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null);
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
async function clearTimer(p) { for (let i = 0; i < 6; i++) { if (!(await p.isVisible('#restTimerOverlay'))) return; const b = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (b) await b.click().catch(() => {}); else await p.mouse.click(10, 10); await p.waitForTimeout(350); } }
(async () => {
  const cfg = L.H.stagingConfig(); const seed = await L.H.seed(); const K = { athlete: seed.athlete, planId: seed.planId };
  const browser = await L.B.launch(); const S = async (p, n) => { if (shots) await p.screenshot({ path: L.path.join(shots, 'ex-' + n + '.png') }); };
  const read = async () => { const d = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + K.athlete.uid + '/mesos/' + K.planId); return d && d.fields ? d : null; };
  const entriesOf = d => Object.fromEntries(Object.entries((d && d.fields && d.fields.entries && d.fields.entries.mapValue && d.fields.entries.mapValue.fields) || {}).map(([k, v]) => [k, val(v)]));
  const waitEntry = async key => { for (let i = 0; i < 12; i++) { const e = entriesOf(await read()); if (e[key]) return e; await new Promise(r => setTimeout(r, 1000)); } return entriesOf(await read()); };
  const setOf = (ent, e, n) => Array.from({ length: n }, (_, s) => ent['log_1_0_' + e + '_s' + s]);
  const absent = x => x === undefined || x === null;
  try {
    const planBefore = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId);
    let { ctx, p, errs } = await L.openReal(browser, { W: 390, Hh: 844, K, expressOff: false });   // Express ON (T556: Express is now an explicit opt-in; detailed is the default)
    check('EXPRESS_MODE_IS_ON', !(await p.evaluate(() => isExpressDisabled())));
    await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(500);
    const plan = await p.evaluate(() => _EJERCICIOS_DIA.map(e => ({ pid: e.prescriptionExerciseId, n: e.exerciseName, sets: e.sets.length, rir: e.sets[0].rirTarget, tech: e.technique })));
    const nsets = plan.map(x => x.sets);
    // ================= scenario A: S1..S(n-1) without RIR, final set with an explicit RIR tap only =================
    await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500);
    const ui0 = await p.evaluate(() => ({ hidden: document.getElementById('xrir_val_0_0').value, sugg: !!document.querySelector('#xrir_0_0_' + _EJERCICIOS_DIA[0].sets[0].rirTarget + '.on.pre'), hint: !!document.getElementById('xrirpre_0_0') }));
    check('SUGGESTION_IS_VISUAL_ONLY_HIDDEN_VALUE_EMPTY', ui0.hidden === '' && ui0.sugg && ui0.hint, JSON.stringify(ui0)); await S(p, '01-suggestion');
    for (let s = 0; s < nsets[0] - 1; s++) { await p.click('.sets-rail button.setp >> nth=0'); await p.waitForTimeout(700); await clearTimer(p); }
    const mid = await p.evaluate(() => ({ rir: document.getElementById('xrir_val_0_0').value, logs: Object.keys(LOGS).filter(k => /^log_1_0_0_s/.test(k)).length, series: Object.keys(LOGS).filter(k => /^exseries_1_0_0_s/.test(k)).length }));
    check('EARLY_EXPRESS_SETS_CREATE_NO_OBSERVATION', mid.rir === '' && mid.logs === 0 && mid.series === nsets[0] - 1, JSON.stringify(mid));
    await p.fill('#xcarga_0_0', '80'); await p.fill('#xreps_0_0', '6'); await p.click('#xrir_0_0_1'); await S(p, '02-final-filled');
    const afterTap = await p.evaluate(() => ({ v: document.getElementById('xrir_val_0_0').value, pre: document.querySelectorAll('#xrir_0_0_0, #xrir_0_0_1, #xrir_0_0_2, #xrir_0_0_3, #xrir_0_0_4').length && !!document.querySelector('.rirb.pre'), hintHidden: getComputedStyle(document.getElementById('xrirpre_0_0')).display === 'none' }));
    check('EXPLICIT_TAP_CONFIRMS_RIR', afterTap.v === '1' && !afterTap.pre && afterTap.hintHidden, JSON.stringify(afterTap));
    await p.click('.set-save-primary'); await p.waitForTimeout(1500); await clearTimer(p);
    let ent = await waitEntry('exexpress_1_0_0'); const A = setOf(ent, 0, nsets[0]);
    check('A_PRIOR_SETS_NOT_FABRICATED', A.slice(0, -1).every(x => x && x.done === true && x.express === true && absent(x.rir_real) && absent(x.ics) && absent(x.pump)), JSON.stringify(A.slice(0, -1).map(x => x && [x.rir_real, x.ics, x.pump])));
    const fa = A[A.length - 1];
    check('A_FINAL_SET_HAS_EXPLICIT_RIR_EXACTLY', fa && fa.rir_real === 1 && fa.expressFinal === true && fa.express !== true && +fa.carga === 80 && +fa.reps === 6, JSON.stringify(fa && [fa.rir_real, fa.expressFinal, fa.carga, fa.reps]));
    check('A_ICS_PUMP_ABSENT_WHEN_UNTOUCHED', absent(fa.ics) && absent(fa.pump));
    check('A_PRESCRIBED_RIR_STAYS_IN_PRESCRIBED_SLOT', A.every(x => x.rir === plan[0].rir) && fa.rir_real !== fa.rir, 'rir=' + plan[0].rir + ' observed=' + fa.rir_real);
    check('A_PID_PRESERVED', A.every(x => x.prescriptionExerciseId === plan[0].pid));
    const recA = ent['exexpress_1_0_0']; check('A_EXPRESS_RECORD', recA && recA.rir_last === 1 && absent(recA.ics) && absent(recA.pump), JSON.stringify(recA && [recA.rir_last, recA.ics, recA.pump])); await S(p, '03-a-registered');
    // ================= scenario B: nothing touched at all =================
    await p.evaluate(() => setEjActivo(1)); await p.waitForTimeout(500);
    for (let s = 0; s < nsets[1] - 1; s++) { await p.click('.sets-rail button.setp >> nth=0'); await p.waitForTimeout(700); await clearTimer(p); }
    await p.fill('#xcarga_0_1', '30'); await p.fill('#xreps_0_1', '10'); await p.click('.set-save-primary'); await p.waitForTimeout(1500); await clearTimer(p);
    ent = await waitEntry('exexpress_1_0_1'); const B = setOf(ent, 1, nsets[1]);
    check('B_NOTHING_TOUCHED_NO_OBSERVATION_ANYWHERE', B.every(x => x && x.done === true && absent(x.rir_real) && absent(x.ics) && absent(x.pump)), JSON.stringify(B.map(x => x && [x.rir_real, x.ics, x.pump])));
    check('B_EXERCISE_STILL_REGISTERED_LOAD_REPS_KEPT', B.every(x => +x.carga === 30 && +x.reps === 10) && ent['exexpress_1_0_1'].done === true && absent(ent['exexpress_1_0_1'].rir_last));
    const bText = await p.evaluate(() => document.querySelector('#exPanel .setdone-m') ? document.querySelector('#exPanel .setdone-m').textContent : ''); check('B_SUMMARY_SHOWS_MISSING_RIR_AS_DASH', /RIR real —/.test(bText), bText); await S(p, '04-b-registered');
    // ================= scenario C: explicit RIR + ICS + Pump =================
    await p.evaluate(() => setEjActivo(2)); await p.waitForTimeout(500);
    for (let s = 0; s < nsets[2] - 1; s++) { await p.click('.sets-rail button.setp >> nth=0'); await p.waitForTimeout(700); await clearTimer(p); }
    await p.fill('#xcarga_0_2', '10'); await p.fill('#xreps_0_2', '15'); await p.click('#xrir_0_2_1'); await p.fill('#xics_0_2', '9'); await p.click('#xpump_0_2_2'); await S(p, '05-c-filled');
    await p.click('.set-save-primary'); await p.waitForTimeout(1500); await clearTimer(p);
    ent = await waitEntry('exexpress_1_0_2'); const C = setOf(ent, 2, nsets[2]); const fc = C[C.length - 1];
    check('C_EXPLICIT_RIR_ICS_PUMP_PERSIST_EXACTLY_ON_FINAL_SET', fc.rir_real === 1 && fc.ics === 9 && fc.pump === 2, JSON.stringify([fc.rir_real, fc.ics, fc.pump]));
    check('C_EARLIER_SETS_CARRY_NONE_OF_THEM', C.slice(0, -1).every(x => absent(x.rir_real) && absent(x.ics) && absent(x.pump)));
    // ================= persistence: reload / relogin =================
    const snapshot = JSON.stringify(Object.keys(ent).filter(k => /^(log|exexpress)_/.test(k)).sort().map(k => [k, ent[k]]));
    await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); });
    const rl = await p.evaluate(() => ({ a: LOGS['log_1_0_0_s0'], af: LOGS['log_1_0_0_s3'], b: LOGS['log_1_0_1_s2'], c: LOGS['log_1_0_2_s2'] }));
    check('RELOAD_EVIDENCE_UNCHANGED', absent(rl.a.rir_real) && rl.af.rir_real === 1 && absent(rl.b.rir_real) && absent(rl.b.ics) && rl.c.rir_real === 1 && rl.c.ics === 9 && rl.c.pump === 2, JSON.stringify([rl.a.rir_real, rl.af.rir_real, rl.b.rir_real, rl.c.rir_real]));
    await p.click('#nb4'); await p.waitForTimeout(500); await p.click('.logout-btn'); await p.waitForTimeout(800); const cb = await p.$('text=/^(Sí|Si|SALIR|Cerrar sesión|CERRAR SESIÓN|Confirmar)/i'); if (cb && !(await p.isVisible('#scrLogin'))) await cb.click().catch(() => {});
    await p.waitForSelector('#scrLogin.on', { timeout: 10000 }).catch(() => {});
    await p.fill('#liEmail', K.athlete.email); await p.fill('#liPass', K.athlete.password); await p.click('.login-btn'); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); });
    const after = await waitEntry('exexpress_1_0_2'); const snapshot2 = JSON.stringify(Object.keys(after).filter(k => /^(log|exexpress)_/.test(k)).sort().map(k => [k, after[k]]));
    const m1 = Object.fromEntries(JSON.parse(snapshot)), m2 = Object.fromEntries(JSON.parse(snapshot2)); const diff = [...new Set([...Object.keys(m1), ...Object.keys(m2)])].filter(k => stable(m1[k]) !== stable(m2[k]));
    check('RELOGIN_NO_DUPLICATE_OR_CHANGED_EVIDENCE', diff.length === 0, diff.slice(0, 3).map(k => k + ' ' + JSON.stringify(m1[k]) + ' => ' + JSON.stringify(m2[k])).join(' | ').slice(0, 300));
    const d = await read();
    check('NO_CANONICAL_FIELDS_WRITTEN_BY_ATHLETE', !!d && !d.fields.progressionApplications && !d.fields.nextExposureOverlays && !d.fields.progressionApplicationSummary);
    const planAfter = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId); check('PLAN_AND_PIDS_UNCHANGED', stable(planBefore.fields) === stable(planAfter.fields));
    check('NUMERIC_APPLY_ENABLED_FALSE', (await p.evaluate(() => (window.VDSEN_EFFECTIVE_PRESCRIPTION || {}).NUMERIC_APPLY_ENABLED)) === false);
    check('NO_UNCAUGHT_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 260)); }
  finally { await browser.close(); console.log('CLEANUP ' + JSON.stringify(await seed.cleanup())); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
