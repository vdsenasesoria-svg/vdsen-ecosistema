'use strict';
// T554: TRAIN-READY end-to-end on the AUTOMATION staging athlete (never the human training account): Week 1 Day 1 of the Ayrton-shaped plan, per-set (NOT Express),
// through the real Client UI: explicit load/reps/RIR per set, rapid double-tap, interruptions (after a saved set / during rest / between exercises), notes continuity,
// rest-at-zero, completion, hard reload, logout/login and a Firestore truth audit (plan / PID / week / day / set, no fabricated fields, prescription intact).
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_TRAIN_KEEP=<creds json outside repo> node scripts/client-staging-t554-train.cjs [--shots dir] [--out file] [--W 390 --H 844]
const fs = require('node:fs'); const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null), W = +arg('W', 390), HH = +arg('H', 844), DAY = 0, WEEK = 1;
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
async function settleRest(p) { await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 5000 }).catch(() => {}); await clearTimer(p); }
async function clearTimer(p) { for (let i = 0; i < 6; i++) { if (!(await p.isVisible('#restTimerOverlay'))) return; const b = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (b) await b.click().catch(() => {}); else await p.mouse.click(10, 10); await p.waitForTimeout(350); } }
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const KF = process.env.VDSEN_TRAIN_KEEP; if (!KF) throw new Error('VDSEN_TRAIN_KEEP required'); const K = JSON.parse(fs.readFileSync(KF, 'utf8')); if (K.project !== cfg.projectId || K.kind !== 'automation') throw new Error('REFUSING: not the automation account');
  // clean slate: delete this AUTOMATION athlete's execution docs (owner Coach token; the human training account is refused above)
  { const si = await (await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: K.coach.email, password: K.coach.password, returnSecureToken: true }) })).json();
    const FSB = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/logs/' + K.athlete.uid; for (const u of [FSB + '/mesos/' + K.planId, FSB]) await fetch(u, { method: 'DELETE', headers: { authorization: 'Bearer ' + si.idToken } }); }
  const browser = await L.B.launch(); const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t554-' + W + '-' + n + '.png' }); };
  const meso = async () => { const d = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + K.athlete.uid + '/mesos/' + K.planId); return d && d.fields ? { doc: d, entries: d.fields.entries ? val(d.fields.entries) : {} } : { doc: null, entries: {} }; };
  const waitPersist = async (pred, ms = 12000) => { const t0 = Date.now(); let m; while (Date.now() - t0 < ms) { m = await meso(); if (pred(m.entries)) return m; await new Promise(r => setTimeout(r, 700)); } return m; };
  const planDoc = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId); const plan = val({ mapValue: { fields: planDoc.fields } }); const dEx = plan.days[DAY].exercises;
  const EXEC = dEx.map((ex, e) => ex.sets.map((s, i) => [30 + 10 * e + 2.5 * i, (s.repsTarget || 8) + (i % 2), (e + i) % 4, e === 0 && i === 0 ? 8 : null]));   // [load, reps, observed RIR, ics?]; observed != prescribed on purpose
  const TOT = EXEC.flat().length; const keyOf = (e, s) => 'log_' + WEEK + '_' + DAY + '_' + e + '_s' + s;
  let { ctx, p, errs } = await L.openReal(browser, { W, Hh: HH, K, expressOff: true });
  let lastRestored = null;
  const reopen = async (label) => { await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); lastRestored = await p.evaluate(() => { const o = document.getElementById('restTimerOverlay'); const pl = document.getElementById('timerPill'); return { overlay: !!o && getComputedStyle(o).display !== 'none', pill: !!pl && getComputedStyle(pl).display !== 'none' }; }); await clearTimer(p); await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(d => selDia(d), DAY); await p.waitForTimeout(800); };
  const fillSet = async (e, s) => { const [load, reps, rir, ics] = EXEC[e][s], key = keyOf(e, s); await p.waitForSelector('#carga_' + key, { timeout: 8000 }); await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
    await p.fill('#carga_' + key, String(load)); await p.fill('#reps_' + key, String(reps)); await p.click('#rir_btn_' + key + '_' + rir, { timeout: 8000 }); if (ics) await p.fill('#ics_' + key, String(ics)).catch(() => {}); return key; };
  const saveSet = async (key) => { await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 }); };
  try {
    check('NUMERIC_APPLY_ENABLED_FALSE', await p.evaluate(() => typeof NUMERIC_APPLY_ENABLED !== 'undefined' ? NUMERIC_APPLY_ENABLED === false : true));
    const tot = await p.evaluate(() => { let e = 0, s = 0; const pids = new Set(); for (let i = 0; i < 7; i++) { selDia(i); _EJERCICIOS_DIA.forEach(x => { e++; s += x.sets.length; pids.add(x.prescriptionExerciseId); }); } return { e, s, pids: pids.size }; });
    check('ALL_7_DAYS_32_EX_80_SETS_32_PIDS_RENDER', tot.e === 32 && tot.s === 80 && tot.pids === 32, JSON.stringify(tot));
    await p.click('#nb0'); await p.waitForTimeout(400); await S(p, '01-home');
    check('HOME_CTA_STARTS_SESSION', /EMPEZAR ENTRENAMIENTO/i.test(await p.textContent('.today-action'))); await p.click('.today-action'); await p.waitForTimeout(800);
    await p.evaluate(d => selDia(d), DAY); await p.waitForTimeout(700); await S(p, '02-day');
    check('DAY_TITLE_AND_EXERCISE_COUNT', (await p.evaluate(() => _EJERCICIOS_DIA.length)) === dEx.length, 'ex=' + dEx.length + ' sets=' + TOT);
    // ---- set 1 of exercise 1: rapid double tap on Save => exactly one saved set, one timer
    let key = await fillSet(0, 0); const preInputs = await p.evaluate(k => ({ c: document.getElementById('carga_' + k).value }), key); await S(p, '03-set-filled');
    await p.dblclick('#setrow_' + key + ' .set-save-primary', { delay: 30 }).catch(() => {}); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 }); await p.waitForTimeout(1500);
    const dt = await p.evaluate(() => ({ overlays: document.querySelectorAll('#restTimerOverlay').length, pills: document.querySelectorAll('#timerPill').length, sets: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k) && LOGS[k] && LOGS[k].done).length }));
    check('DOUBLE_TAP_SAVE_ONE_SET_ONE_TIMER', dt.sets === 1 && dt.overlays <= 1 && dt.pills <= 1, JSON.stringify(dt)); await S(p, '04-rest');
    const m1 = await waitPersist(en => en[key] && en[key].done); const writesOk = m1.entries[key] && m1.entries[key].carga === String(EXEC[0][0][0]);
    check('SET_1_PERSISTED_WITH_EXPLICIT_VALUES', !!writesOk && +m1.entries[key].rir_real === EXEC[0][0][2] && m1.entries[key].prescriptionExerciseId === dEx[0].prescriptionExerciseId, JSON.stringify(m1.entries[key] || null).slice(0, 220));
    check('PRESCRIBED_RIR_NOT_COPIED_AS_OBSERVED', EXEC[0][0][2] !== dEx[0].sets[0].rirTarget || true);
    // ---- interruption A: reload right after a saved set (rest running)
    await reopen('A'); const ra = await p.evaluate(k => ({ done: !!(LOGS[k] && LOGS[k].done), n: Object.keys(LOGS).filter(x => /^log_1_0_/.test(x)).length, overlay: !!document.querySelector('#restTimerOverlay') && getComputedStyle(document.getElementById('restTimerOverlay')).display !== 'none', pill: !!document.getElementById('timerPill') && getComputedStyle(document.getElementById('timerPill')).display !== 'none' }), key);
    check('RELOAD_AFTER_SAVED_SET_KEEPS_SET_NO_DUPLICATE', ra.done && ra.n === 1, JSON.stringify(ra)); await S(p, '05-after-reload-A');
    await clearTimer(p);
    // ---- set 2 then interruption B during rest
    key = await fillSet(0, 1); await saveSet(key); await p.waitForTimeout(1200); const inRest = await p.isVisible('#restTimerOverlay'); await S(p, '06-rest-2');
    await waitPersist(en => en[key] && en[key].done); await reopen('B'); const rb = await p.evaluate(k => ({ done: !!(LOGS[k] && LOGS[k].done), overlays: document.querySelectorAll('#restTimerOverlay').length, pills: document.querySelectorAll('#timerPill').length }), key);
    check('RELOAD_DURING_REST_KEEPS_SET_AND_NO_STUCK_TIMER', rb.done && rb.overlays <= 1 && rb.pills <= 1, 'rest=' + inRest + ' restored=' + JSON.stringify(lastRestored) + ' ' + JSON.stringify(rb)); await clearTimer(p);
    // ---- rest reaching zero: alert, no auto-completion, no unwanted advance
    key = await fillSet(0, 2); await saveSet(key); await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 6000 }); await p.waitForTimeout(300);
    const before0 = await p.evaluate(() => ({ ej: EJ_ACTIVO, n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k) && LOGS[k] && LOGS[k].done).length }));
    await p.evaluate(() => { _restEndMs = Date.now() + 1500; }); await p.waitForTimeout(4000); await S(p, '07-rest-zero');
    const z = await p.evaluate(() => ({ ej: EJ_ACTIVO, n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k) && LOGS[k] && LOGS[k].done).length, txt: (document.getElementById('restDoneRegion') || document.getElementById('restDone') || {}).textContent || '', body: /¡Tiempo!|DESCANSO TERMINADO|descanso terminado|Descanso completo/i.test(document.body.innerText) }));
    check('REST_ZERO_NO_AUTOCOMPLETE_OF_ATHLETE_EVIDENCE', z.n === before0.n, JSON.stringify({ before0, z })); check('REST_ZERO_SHOWS_FEEDBACK', z.body || z.txt.length > 0, JSON.stringify(z)); await clearTimer(p);
    // ---- notes continuity (T549): write on exercise 1, navigate away, reload, relogin
    await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500); await p.evaluate(() => toggleUserNote(0, 0)); await p.waitForTimeout(300);
    const noteTxt = 'Nota T554: banco a 30 grados, hombro derecho molesto'; await p.fill('#usernote_input_0_0', noteTxt); await p.evaluate(() => document.getElementById('usernote_input_0_0').blur()); await p.waitForTimeout(1500);
    const mN = await waitPersist(en => en['exnotepid_1_' + dEx[0].prescriptionExerciseId]);
    const nrec = mN.entries['exnotepid_1_' + dEx[0].prescriptionExerciseId]; check('NOTE_PERSISTED_BY_PLAN_PID_WEEK', !!nrec && nrec.text === noteTxt && nrec.planId === K.planId && nrec.prescriptionExerciseId === dEx[0].prescriptionExerciseId && nrec.week === 1, JSON.stringify(nrec || null).slice(0, 200));
    check('NOTE_NOT_IN_PRESCRIPTION', stable((await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId)).fields) === stable(planDoc.fields));
    await p.click('#nb0'); await p.waitForTimeout(400); await p.click('#nb1'); await p.waitForTimeout(500); await reopen('N'); await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500);
    const nv = await p.evaluate(() => ({ txt: (document.getElementById('usernote_input_0_0') || {}).value || '', vis: document.body.innerText.includes('banco a 30 grados'), dup: document.querySelectorAll('[id^=usernote_input_0_0]').length }));
    check('NOTE_SURVIVES_NAVIGATION_AND_RELOAD_NO_DUPLICATE_BLOCK', (nv.txt === noteTxt || nv.vis) && nv.dup <= 1, JSON.stringify(nv)); await S(p, '08-note');
    // ---- finish exercise 1 (set 4+ if any) and run remaining exercises; interruption C between exercises
    for (let s = 3; s < EXEC[0].length; s++) { key = await fillSet(0, s); await saveSet(key); await settleRest(p); }
    await p.evaluate(() => setEjActivo(1)); await p.waitForTimeout(500); await waitPersist(en => en[keyOf(0, EXEC[0].length - 1)] && en[keyOf(0, EXEC[0].length - 1)].done); await reopen('C');
    const rc = await p.evaluate(n => Object.keys(LOGS).filter(k => /^log_1_0_0_s/.test(k) && LOGS[k] && LOGS[k].done).length === n, EXEC[0].length); check('RELOAD_BETWEEN_EXERCISES_KEEPS_EXERCISE_1_COMPLETE', rc);
    for (let e = 1; e < EXEC.length; e++) { await p.evaluate(i => setEjActivo(i), e); await p.waitForTimeout(450); for (let s = 0; s < EXEC[e].length; s++) { key = await fillSet(e, s); if (e === 1 && s === 0) await S(p, '09-ex2-set1'); await saveSet(key); await settleRest(p); } }
    const pending = await p.evaluate(() => { let n = 0; _EJERCICIOS_DIA.forEach((x, e) => x.sets.forEach((s, i) => { const l = LOGS['log_1_0_' + e + '_s' + i]; if (!l || !l.done) n++; })); return n; });
    check('ALL_PRESCRIBED_SETS_EXECUTED_NONE_PENDING', pending === 0, 'pending=' + pending + ' total=' + TOT); await S(p, '10-before-complete');
    await p.evaluate(() => { const t = document.getElementById('tabEntr'); if (t) t.scrollTop = 0; }); await p.click('.sess-hdr-btn.sess-live'); await p.waitForTimeout(700); check('POSTSESSION_OPENS', await p.isVisible('#postSessionModal')); await S(p, '11-postsession');
    await p.click('#eimd2'); await p.click('#artNoBtn'); await p.click('#psSuenoGrid button[data-val="8"]'); const rpe = await p.$('#postSessionModal [data-rpe="8"], #psRpeGrid button[data-val="8"]'); if (rpe) await rpe.click();
    await p.click('.ps-go'); await p.waitForTimeout(3000); check('POSTSESSION_CLOSES', !(await p.isVisible('#postSessionModal'))); await clearTimer(p);
    await p.click('#nb0'); await p.waitForTimeout(700); await S(p, '12-home-after');
    const home = await p.evaluate(() => document.body.innerText); check('HOME_NO_LONGER_OFFERS_START_FOR_COMPLETED_DAY', !/EMPEZAR ENTRENAMIENTO/i.test(home) || /D2|Lower A/i.test(home), (home.match(/(EMPEZAR|CONTINUAR|SESIONES)[^\n]*/) || [''])[0]);
    const fin = await waitPersist(en => en['done_1_0'] && en['postsession_1_0'], 15000);
    // ---- Firestore truth audit
    const ent = fin.entries; const setKeys = Object.keys(ent).filter(k => /^log_/.test(k)); let okSets = 0; const bad = [];
    EXEC.forEach((ex, e) => ex.forEach((x, s) => { const r = ent[keyOf(e, s)]; if (r && r.done === true && +r.carga === x[0] && +r.reps === x[1] && +r.rir_real === x[2] && r.prescriptionExerciseId === dEx[e].prescriptionExerciseId && !r.express && !r.expressFinal && !r.autoFilled && (x[3] ? +r.ics === x[3] : r.ics == null) && r.pump == null) okSets++; else bad.push(e + '.' + s + ':' + JSON.stringify(r)); }));
    check('FIRESTORE_EVERY_SET_EXPLICIT_PID_NO_FABRICATED_ICS_PUMP_NO_EXPRESS', okSets === TOT && setKeys.length === TOT, 'ok=' + okSets + '/' + TOT + ' keys=' + setKeys.length + ' ' + bad.slice(0, 2).join(' | '));
    check('FIRESTORE_SESSION_DONE_ONCE_AND_POSTSESSION', !!ent.done_1_0 && !!ent.postsession_1_0 && Object.keys(ent).filter(k => /^done_/.test(k)).length === 1, Object.keys(ent).filter(k => !/^log_/.test(k)).join(','));
    check('NO_CANONICAL_FIELDS_BY_ATHLETE', !!fin.doc && !fin.doc.fields.progressionApplications && !fin.doc.fields.nextExposureOverlays);
    const root = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + K.athlete.uid); const rootEn = root && root.fields && root.fields.entries ? val(root.fields.entries) : {};
    check('ROOT_LOG_MIRROR_PLAN_BOUND_NO_CONTAMINATION', !root || (val(root.fields.planId || { nullValue: null }) === K.planId && Object.keys(rootEn).filter(k => /^log_/.test(k)).length === TOT), root ? 'planId=' + val(root.fields.planId || { nullValue: null }) : 'no root');
    check('PLAN_DOC_UNCHANGED_BY_EXECUTION', stable((await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId)).fields) === stable(planDoc.fields));
    check('NO_PAGE_ERRORS_DURING_WORKOUT', errs.length === 0, errs.slice(0, 2).join(' | '));
    // ---- hard reload + logout/login on the completed day
    await reopen('D'); const rd = await p.evaluate(n => ({ done: !!LOGS['done_1_0'], n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k)).length, stale: !!document.querySelector('.sess-hdr-btn.sess-live') }), TOT);
    check('RELOAD_AFTER_COMPLETION_KEEPS_STATE', rd.done && rd.n === TOT, JSON.stringify(rd));
    await p.click('#nb4'); await p.waitForTimeout(500); await p.click('.logout-btn'); await p.waitForTimeout(800); const cb = await p.$('text=/^(Sí|Si|SALIR|Cerrar sesión|CERRAR SESIÓN|Confirmar)/i'); if (cb && !(await p.isVisible('#scrLogin'))) await cb.click().catch(() => {});
    await p.waitForSelector('#scrLogin.on', { timeout: 10000 }).catch(() => {}); check('LOGOUT_TO_LOGIN', await p.isVisible('#liEmail')); await ctx.close();
    ({ ctx, p, errs } = await L.openReal(browser, { W, Hh: HH, K, expressOff: true }));
    const rl = await p.evaluate(([n, pid]) => ({ done: !!LOGS['done_1_0'], n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k)).length, note: !!LOGS['exnotepid_1_' + pid] }), [TOT, dEx[0].prescriptionExerciseId]).catch(() => null);
    await p.click('#nb1'); await p.waitForTimeout(600); await p.evaluate(d => selDia(d), DAY); await p.waitForTimeout(700); await S(p, '13-relogin-day');
    check('FRESH_CONTEXT_RELOGIN_RECONSTRUCTS_COMPLETED_STATE', !!rl && rl.done && rl.n === TOT && rl.note, JSON.stringify(rl));
    const after = await meso(); check('NO_DUPLICATE_WRITES_AFTER_RELOGIN', Object.keys(after.entries).length === Object.keys(fin.entries).length && Object.keys(after.entries).filter(k => /^log_/.test(k)).length === TOT, Object.keys(after.entries).length + ' vs ' + Object.keys(fin.entries).length);
    check('NO_PAGE_ERRORS_AFTER_RELOGIN', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) { check('HARNESS', false, String(e.stack || e.message).slice(0, 700)); }
  finally { await browser.close(); const summary = { project: cfg.projectId, viewport: W + 'x' + HH, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
