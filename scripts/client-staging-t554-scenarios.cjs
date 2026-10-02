'use strict';
// T554: scenario matrix on the AUTOMATION staging athlete (never the human account), real Client build + staging rules:
//  S1 Week 2 reference / USAR CARGA-REPS (same PID; Express-only; same-name wrong PID; same-position wrong PID; different plan) - no write before an explicit save, RIR/ICS/Pump/note never copied
//  S2 substitution safety (no prior-performance block for a substituted exposure; reload coherent)
//  S3 offline / degraded: an unsaved set is never reported as saved; it persists once back online
//  S4 six phone widths: active set usable (no horizontal overflow, GUARDAR reachable above the nav, rest sheet fits)
//  S5 all 7 days: every exercise / set renders, no overflow, technique fields readable
//  S6 long session: DOM / timers do not grow with repeated interaction
//  S7 gym-rapid interaction: quick RIR taps, navigate away right after Save, Corregir (edit a saved set) - no duplicate sets, no stale state
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_TRAIN_KEEP=<creds json outside repo> node scripts/client-staging-t554-scenarios.cjs [--only S1,S3] [--shots dir] [--out file]
const fs = require('node:fs'), crypto = require('node:crypto'); const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null), only = (arg('only', '') || '').split(',').filter(Boolean); const want = id => !only.length || only.includes(id);
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
async function call(m, u, t, b) { const r = await fetch(u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}), body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch (e) { /* non-json */ } return { s: r.status, b: j }; }
async function clearTimer(p) { for (let i = 0; i < 6; i++) { if (!(await p.isVisible('#restTimerOverlay'))) return; const b = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (b) await b.click().catch(() => {}); else await p.mouse.click(10, 10); await p.waitForTimeout(350); } }
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const K = JSON.parse(fs.readFileSync(process.env.VDSEN_TRAIN_KEEP, 'utf8')); if (K.project !== cfg.projectId || K.kind !== 'automation') throw new Error('REFUSING: not the automation account');
  const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents', AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
  const tok = async u => (await call('POST', AUTH + 'signInWithPassword?key=' + cfg.apiKey, null, { email: u.email, password: u.password, returnSecureToken: true })).b.idToken; const T = await tok(K.coach), TA = await tok(K.athlete); const uid = K.athlete.uid;
  const planDoc = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId); const plan = val({ mapValue: { fields: planDoc.fields } }); const D0 = plan.days[0].exercises, D1 = plan.days[1].exercises;
  const reset = async () => { for (const u of [FS + '/logs/' + uid + '/mesos/' + K.planId, FS + '/logs/' + uid]) await call('DELETE', u, T); };
  const putDoc = async (path, data) => { const r = await call('PATCH', FS + '/' + path, TA, { fields: enc(data).mapValue.fields }); if (r.s !== 200) throw new Error('write ' + path + ' ' + r.s); };
  const seedBoth = async (week, entries) => { await putDoc('logs/' + uid, { planId: K.planId, currentWeek: week, entries }); await putDoc('logs/' + uid + '/mesos/' + K.planId, { planId: K.planId, currentWeek: week, entries }); };
  const ev = (pid, load, reps, extra) => Object.assign({ carga: load, reps, unit: 'KG', done: true, rir: 2, rir_real: 2, prescriptionExerciseId: pid, ts: Date.now() }, extra || {});
  const sets = (w, d, e, pid, n, extra) => Object.fromEntries(Array.from({ length: n }, (_, s) => ['log_' + w + '_' + d + '_' + e + '_s' + s, ev(pid, String(60 + 5 * s), String(10 - s), extra)]));
  const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = await fn(); if (r) return r; await new Promise(x => setTimeout(x, 700)); } return null; };
  const browser = await L.B.launch(); const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t554s-' + n + '.png' }); };
  const open = async (opts) => { const o = await L.openReal(browser, Object.assign({ W: 390, Hh: 844, K, expressOff: true }, opts || {})); return o; };
  const toDay = async (p, d) => { await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(i => selDia(i), d); await p.waitForTimeout(800); };
  const mesoUpdate = async () => { const d = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + uid + '/mesos/' + K.planId); return d && d.updateTime; };
  const mesoEntries = async () => { const d = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + uid + '/mesos/' + K.planId); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  try {
    // ================= S1 =================
    if (want('S1')) {
      await reset();
      const E = Object.assign({}, sets(1, 0, 0, D0[0].prescriptionExerciseId, 3),                                  // ex0: standard evidence => reference + reuse
        sets(1, 0, 1, D0[1].prescriptionExerciseId, 2, { express: true }),                                        // ex1: Express-only => nothing
        sets(1, 0, 2, 'some-other-pid', 3),                                                                        // ex2 position holds evidence of ANOTHER pid => nothing for ex2 (same position, wrong PID)
        { exnotepid_1_x: { planId: K.planId, prescriptionExerciseId: D0[0].prescriptionExerciseId, week: 1, day: 0, exerciseIndex: 0, text: 'nota semana 1 NO se copia', updatedAt: 1 } });
      await seedBoth(2, E);
      const { ctx, p, errs } = await open(); await toDay(p, 0);
      const st = async (e) => p.evaluate(([ei]) => ({ block: !!document.getElementById('pw_0_' + ei), use: document.querySelectorAll('.pw-use').length, rows: document.querySelectorAll('#pw_0_' + ei + ' .pw-i').length, week: CURRENT_WEEK }), [e]);
      let r0 = await st(0); check('S1_WEEK2_SAME_PID_SHOWS_ULTIMA_SEMANA_3_STANDARD_SETS', r0.week === 2 && r0.block && r0.rows === 3, JSON.stringify(r0)); await S(p, 's1-ref');
      const key = 'log_2_0_0_s0'; await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); const u0 = await mesoUpdate();
      const pre = await p.evaluate(k => ({ c: document.getElementById('carga_' + k).value, r: document.getElementById('reps_' + k).value, rir: document.getElementById('rir_' + k).value, ics: document.getElementById('ics_' + k).value }), key);
      check('S1_INPUTS_EMPTY_BEFORE_USAR', pre.c === '' && pre.r === '' && pre.rir === '' && pre.ics === '', JSON.stringify(pre));
      await p.click('#setrow_' + key + ' .pw-use'); await p.waitForTimeout(600); await S(p, 's1-usar');
      const post = await p.evaluate(k => ({ c: document.getElementById('carga_' + k).value, r: document.getElementById('reps_' + k).value, rir: document.getElementById('rir_' + k).value, ics: document.getElementById('ics_' + k).value, pump: !!document.querySelector('#setrow_' + k + ' .pumpb.on'), done: !!(LOGS[k] && LOGS[k].done), prescRir: _EJERCICIOS_DIA[0].sets[0].rirTarget }), key);
      check('S1_USAR_FILLS_LOAD_AND_REPS_ONLY', post.c === '60' && post.r === '10' && post.rir === '' && post.ics === '' && !post.pump && !post.done, JSON.stringify(post));
      check('S1_PRESCRIBED_RIR_UNCHANGED_AND_NOT_OBSERVED', post.prescRir === D0[0].sets[0].rirTarget && post.rir === '');
      await p.waitForTimeout(3500); check('S1_NO_FIRESTORE_WRITE_BEFORE_EXPLICIT_SAVE', (await mesoUpdate()) === u0 && !(await mesoEntries())[key]);
      check('S1_NO_NOTE_COPIED_FROM_PREVIOUS_WEEK', !(await p.evaluate(() => (document.getElementById('usernote_input_0_0') || {}).value || '')).includes('NO se copia'));
      await p.evaluate(() => setEjActivo(1)); await p.waitForTimeout(500); const r1 = await st(1); check('S1_EXPRESS_ONLY_PRIOR_EVIDENCE_SHOWS_NOTHING', !r1.block && r1.use === 0, JSON.stringify(r1));
      await p.evaluate(() => setEjActivo(2)); await p.waitForTimeout(500); const r2 = await st(2); check('S1_SAME_POSITION_WRONG_PID_SHOWS_NOTHING', !r2.block && r2.use === 0, JSON.stringify(r2));
      check('S1_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
    // ================= S2 =================
    if (want('S2')) {
      await reset(); const alt = D1[0].alternatives && D1[0].alternatives[0]; check('S2_FIXTURE_EXERCISE_HAS_ALTERNATIVES', !!alt, String(alt));
      await seedBoth(2, sets(1, 1, 0, D1[0].prescriptionExerciseId, 3));
      let { ctx, p, errs } = await open(); await toDay(p, 1);
      const base = await p.evaluate(() => ({ block: !!document.getElementById('pw_1_0'), name: _EJERCICIOS_DIA[0].exerciseName })); check('S2_BEFORE_SUBSTITUTION_REFERENCE_VISIBLE', base.block, JSON.stringify(base));
      await p.evaluate(() => showExSubModal(1, 0)); await p.waitForTimeout(600); await S(p, 's2-modal');
      const btn = await p.$('button[onclick*="applyExSub(1,0,"]'); check('S2_SUBSTITUTION_MODAL_OFFERS_ALTERNATIVES', !!btn); if (btn) { await btn.click(); await p.waitForTimeout(1500); }
      const sub = await p.evaluate(() => ({ sub: LOGS['exsub_2_1_0'] || null, block: !!document.getElementById('pw_1_0'), use: document.querySelectorAll('.pw-use').length, pid: _EJERCICIOS_DIA[0].prescriptionExerciseId }));
      check('S2_SUBSTITUTED_EXPOSURE_HAS_NO_PRIOR_PERFORMANCE_BLOCK', !!sub.sub && !sub.block && sub.use === 0, JSON.stringify({ sub: sub.sub && sub.sub.nombre, block: sub.block, use: sub.use }));
      check('S2_ORIGINAL_PID_AUTHORITY_UNCHANGED', sub.pid === D1[0].prescriptionExerciseId); await S(p, 's2-after');
      const key = 'log_2_1_0_s0'; await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '45'); await p.fill('#reps_' + key, '9'); await p.click('#rir_btn_' + key + '_2'); await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 });
      await p.waitForTimeout(2500); const en = await mesoEntries(); check('S2_SUBSTITUTED_SET_NEVER_COUNTS_AS_ORIGINAL_PID_EVIDENCE_BUT_RECORDS_ITS_ORIGIN', !!en[key] && en[key].prescriptionExerciseId === undefined && !!en[key].substitutedFrom && en[key].substitutedFrom.prescriptionExerciseId === D1[0].prescriptionExerciseId && !!en.exsub_2_1_0, JSON.stringify(en[key] || null).slice(0, 700));
      await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); await clearTimer(p); await toDay(p, 1);
      const rl = await p.evaluate(() => ({ sub: !!LOGS['exsub_2_1_0'], block: !!document.getElementById('pw_1_0'), done: !!(LOGS['log_2_1_0_s0'] && LOGS['log_2_1_0_s0'].done) })); check('S2_RELOAD_KEEPS_SUBSTITUTION_AND_NO_REFERENCE', rl.sub && !rl.block && rl.done, JSON.stringify(rl));
      check('S2_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
    // ================= S3 =================
    if (want('S3')) {
      await reset(); await seedBoth(1, {}); await (async () => { await call('DELETE', FS + '/logs/' + uid + '/mesos/' + K.planId, T); await call('DELETE', FS + '/logs/' + uid, T); })();
      const { ctx, p, errs } = await open(); await toDay(p, 0); const key = 'log_1_0_0_s0';
      await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '50'); await p.fill('#reps_' + key, '8'); await p.click('#rir_btn_' + key + '_2');
      const FSRX = /firestore\.googleapis\.com/, blocker = r => r.abort(); await ctx.setOffline(true); await ctx.route(FSRX, blocker); await p.waitForTimeout(800); await S(p, 's3-offline');   // setOffline alone leaves the open WebChannel alive; the route cuts Firestore for real
      const banner = await p.evaluate(() => ({ off: !navigator.onLine, txt: document.body.innerText.slice(0, 600) })); console.log('OFFLINE_UI', JSON.stringify(banner.txt.match(/offline|sin conexi[oó]n|sin red/i)));
      await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForTimeout(6000); await S(p, 's3-offline-save');
      const off = await p.evaluate(() => ({ toast: [...document.querySelectorAll('.toast, #toast, [role=status], [role=alert]')].map(x => x.textContent.trim()).filter(Boolean).slice(0, 3), restShown: !!document.getElementById('restTimerOverlay') && getComputedStyle(document.getElementById('restTimerOverlay')).display !== 'none', body: document.body.innerText }));
      const claimedOk = /guardad[ao]|✓ Serie guardada/i.test(off.toast.join(' ')) && !/NO SE GUARD|no se guard|sin conexi|reintent/i.test(off.toast.join(' '));
      check('S3_OFFLINE_SAVE_NEVER_CLAIMS_SUCCESS', !claimedOk, JSON.stringify(off.toast));
      check('S3_OFFLINE_BANNER_VISIBLE', /SIN CONEXI/i.test(off.body)); check('S3_OFFLINE_NO_REST_TIMER_FOR_AN_UNPERSISTED_SET', !off.restShown, 'rest=' + off.restShown);
      check('S3_NOTHING_IN_FIRESTORE_WHILE_OFFLINE', !(await mesoEntries())[key]);
      await ctx.unroute(FSRX, blocker); await ctx.setOffline(false); await p.waitForTimeout(500); await clearTimer(p);
      await p.waitForTimeout(8000); const en = await mesoEntries();   // NO second tap: the queued write must sync by itself
      check('S3_BACK_ONLINE_QUEUED_SET_SYNCS_BY_ITSELF_EXACTLY_ONCE', !!en[key] && en[key].carga === '50' && Object.keys(en).filter(k => /^log_/.test(k)).length === 1, JSON.stringify(Object.keys(en)));
      check('S3_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
    // ================= S4 =================
    if (want('S4')) {
      for (const [W, H] of [[320, 700], [360, 800], [375, 812], [390, 844], [414, 896], [430, 932]]) {
        await reset(); const { ctx, p, errs } = await open({ W, Hh: H }); await toDay(p, 0); const key = 'log_1_0_0_s0';
        await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '82.5'); await p.fill('#reps_' + key, '10'); await p.click('#rir_btn_' + key + '_2'); await p.waitForTimeout(300);
        const m = await p.evaluate(k => { const b = document.querySelector('#setrow_' + k + ' .set-save-primary').getBoundingClientRect(), n = document.querySelector('.bnav').getBoundingClientRect(); const clipped = e => { for (let n = e.parentElement; n && n.id !== 'tabEntr'; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (/(auto|scroll|hidden)/.test(o)) return true; } return false; }; const ov = [...document.querySelectorAll('#tabEntr *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !clipped(e); }).length; /* intentionally scrollable strips (day / exercise tabs) are excluded */ return { overflowX: document.documentElement.scrollWidth > innerWidth + 1, offenders: ov, saveVisible: b.top >= 0 && b.bottom <= n.top + 1, saveH: Math.round(b.height) }; }, key);
        check('S4_' + W + '_NO_HORIZONTAL_OVERFLOW', !m.overflowX && m.offenders === 0, JSON.stringify(m)); check('S4_' + W + '_GUARDAR_REACHABLE_ABOVE_NAV_AFTER_FILL', m.saveVisible && m.saveH >= 44, JSON.stringify(m)); await S(p, 's4-' + W);
        await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 }); await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 6000 }).catch(() => {}); await p.waitForTimeout(400); await S(p, 's4-' + W + '-rest');
        const rs = await p.evaluate(() => { const o = document.getElementById('restTimerOverlay'); if (!o || getComputedStyle(o).display === 'none') return null; const bs = [...o.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), inside: r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 }; }); return { n: bs.length, allInside: bs.every(b => b.inside), minH: Math.min(...bs.map(b => b.h)) }; });
        check('S4_' + W + '_REST_SHEET_FITS_AND_TOUCHABLE', !!rs && rs.allInside && rs.minH >= 40, JSON.stringify(rs));
        const cont = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (cont) await cont.click(); await p.waitForTimeout(400);
        check('S4_' + W + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
      }
    }
    // ================= S5 =================
    if (want('S5')) {
      await reset(); const { ctx, p, errs } = await open(); let totE = 0, totS = 0, bad = [];
      for (let d = 0; d < plan.days.length; d++) { await toDay(p, d); const exs = plan.days[d].exercises;
        for (let e = 0; e < exs.length; e++) { await p.evaluate(i => setEjActivo(i), e); await p.waitForTimeout(250);
          const r = await p.evaluate(([d, e]) => { const ex = _EJERCICIOS_DIA[e]; const t = document.getElementById('tabEntr'); return { name: ex.exerciseName, sets: ex.sets.length, rows: document.querySelectorAll('[id^="setrow_log_"]').length, overflowX: document.documentElement.scrollWidth > innerWidth + 1, hasPresc: /PRESCRIPCI/i.test(document.body.innerText) || (ex.exerciseType && ex.exerciseType !== 'fuerza'), text: t.innerText }; }, [d, e]);
          totE++; totS += exs[e].sets.length; const tn = (exs[e].techniqueNote || '').trim().slice(0, 25), nm = exs[e].exerciseName.slice(0, 12);
          if (r.overflowX || (r.sets !== exs[e].sets.length) || (exs[e].sets.length && !r.text.includes('0/' + exs[e].sets.length)) || !r.text.includes(nm) || (tn && !r.text.includes(tn))) bad.push('d' + d + 'e' + e + ':' + exs[e].exerciseName + ' ' + JSON.stringify({ sets: r.sets, rows: r.rows, ov: r.overflowX })); } }
      check('S5_ALL_7_DAYS_32_EXERCISES_80_SETS_RENDER_NO_OVERFLOW_TECHNIQUE_VISIBLE', totE === 32 && totS === 80 && bad.length === 0, 'ex=' + totE + ' sets=' + totS + ' bad=' + bad.slice(0, 3).join(' | '));
      const iso = plan.days.flatMap((d, di) => d.exercises.map((e, ei) => ({ di, ei, e }))).filter(x => /iso/i.test((x.e.techniqueNote || '') + (x.e.technique || '') + (x.e.sets || []).map(s => s.setNote || '').join(' '))); console.log('ISO_EXERCISES', JSON.stringify(iso.map(x => [x.di, x.ei, x.e.exerciseName])));
      if (iso.length) { await toDay(p, iso[0].di); await p.evaluate(i => setEjActivo(i), iso[0].ei); await p.waitForTimeout(500); await S(p, 's5-iso'); const o = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); check('S5_ISO_HOLD_TECHNIQUE_NO_OVERFLOW', !o); }
      check('S5_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
    // ================= S6 =================
    if (want('S6')) {
      await reset(); const { ctx, p, errs } = await open(); await toDay(p, 0);
      await p.evaluate(() => { window.__iv = 0; const si = window.setInterval; window.setInterval = function () { window.__iv++; return si.apply(window, arguments); }; });
      const base = await p.evaluate(() => ({ dom: document.querySelectorAll('*').length, timers: typeof _restTimer !== 'undefined' && _restTimer ? 1 : 0 }));
      for (let i = 0; i < 30; i++) { await p.click('#nb0'); await p.click('#nb1'); await p.evaluate(([d, e]) => { selDia(d); setEjActivo(e); }, [i % 3, i % 3]); }
      await p.waitForTimeout(500); const after = await p.evaluate(() => ({ dom: document.querySelectorAll('*').length, iv: window.__iv, overlays: document.querySelectorAll('#restTimerOverlay').length, pills: document.querySelectorAll('#timerPill').length }));
      check('S6_DOM_DOES_NOT_GROW_WITH_REPEATED_NAVIGATION', after.dom < base.dom * 1.3, JSON.stringify({ base, after })); check('S6_NO_TIMER_OR_OVERLAY_LEAK', after.overlays <= 1 && after.pills <= 1 && after.iv < 40, JSON.stringify(after));
      check('S6_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
    // ================= S7 =================
    if (want('S7')) {
      await reset(); const { ctx, p, errs } = await open(); await toDay(p, 0); const key = 'log_1_0_0_s0';
      await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '70'); await p.fill('#reps_' + key, '8');
      for (const r of [0, 1, 2, 3, 4, 1, 2]) await p.click('#rir_btn_' + key + '_' + r, { delay: 5 }); const rirNow = await p.evaluate(k => ({ hidden: document.getElementById('rir_' + k).value, on: [...document.querySelectorAll('#setrow_' + k + ' .rirb.on')].length }), key);
      check('S7_RAPID_RIR_TAPS_LAST_WINS_SINGLE_SELECTION', rirNow.hidden === '2' && rirNow.on === 1, JSON.stringify(rirNow));
      await p.click('#setrow_' + key + ' .set-save-primary'); await p.click('#nb0', { force: true, timeout: 3000 }).catch(() => {}); await p.waitForTimeout(300); await p.click('#nb1', { force: true, timeout: 3000 }).catch(() => {}); await p.waitForTimeout(2500);
      const st = await p.evaluate(() => ({ n: Object.keys(LOGS).filter(k => /^log_1_0_/.test(k) && LOGS[k] && LOGS[k].done).length, ov: document.querySelectorAll('#restTimerOverlay').length, pills: document.querySelectorAll('#timerPill').length }));
      check('S7_NAVIGATE_RIGHT_AFTER_SAVE_ONE_SET_NO_DUPLICATE_TIMER', st.n === 1 && st.ov <= 1 && st.pills <= 1, JSON.stringify(st)); await clearTimer(p); await p.waitForTimeout(1500);
      const en1 = await mesoEntries(); check('S7_PERSISTED_EXACTLY_ONE_SET', Object.keys(en1).filter(k => /^log_/.test(k)).length === 1 && +en1[key].rir_real === 2 && en1[key].carga === '70', JSON.stringify(en1[key] || null).slice(0, 160));
      await toDay(p, 0); await S(p, 's7-after');
      const corr = await p.$('button:has-text("Corregir")'); check('S7_CORREGIR_AVAILABLE_ON_SAVED_SET', !!corr);
      if (corr) { await corr.click(); await p.waitForTimeout(600); await p.fill('#carga_' + key, '72.5'); await p.click('#rir_btn_' + key + '_1'); await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForTimeout(2500); await clearTimer(p); }
      const en2 = await waitFor(async () => { const e = await mesoEntries(); return e[key] && e[key].carga === '72.5' ? e : null; }); check('S7_CORRECTION_UPDATES_THE_SAME_SET_NO_DUPLICATE', !!en2 && Object.keys(en2).filter(k => /^log_/.test(k)).length === 1 && +en2[key].rir_real === 1 && en2[key].prescriptionExerciseId === D0[0].prescriptionExerciseId, en2 ? JSON.stringify(en2[key]).slice(0, 200) : 'not persisted');
      check('S7_PRESCRIPTION_STILL_INTACT', stable((await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId)).fields) === stable(planDoc.fields));
      check('S7_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
  } catch (e) { check('HARNESS', false, String(e.stack || e.message).slice(0, 700)); }
  finally { await reset().catch(() => {}); await browser.close(); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
