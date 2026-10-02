'use strict';
// T555 (athlete findings after the T554 preview): rest sheet shows what comes next; alarm channels (background audio keep-alive + alarm tone + service-worker notification);
// finishing the rest takes ONE tap; a plain "Cardio ..." plan row is a cardio card. AUTOMATION staging athlete only (never the human account).
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_TRAIN_KEEP=<creds json outside repo> node scripts/client-staging-t555.cjs [--shots dir] [--out file]
const fs = require('node:fs'); const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null); const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const K = JSON.parse(fs.readFileSync(process.env.VDSEN_TRAIN_KEEP, 'utf8')); if (K.project !== cfg.projectId || K.kind !== 'automation') throw new Error('REFUSING: not the automation account');
  const reset = async () => { const si = await (await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: K.coach.email, password: K.coach.password, returnSecureToken: true }) })).json(); const B = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/logs/' + K.athlete.uid; for (const u of [B + '/mesos/' + K.planId, B]) await fetch(u, { method: 'DELETE', headers: { authorization: 'Bearer ' + si.idToken } }); };
  const mesoEntries = async () => { const d = await restGet(cfg, K.athlete.email, K.athlete.password, 'logs/' + K.athlete.uid + '/mesos/' + K.planId); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  const planDoc = await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId); const plan = val({ mapValue: { fields: planDoc.fields } });
  const browser = await L.B.launch(); const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t555-' + n + '.png' }); };
  const open = async (W, Hh) => { const o = await L.openReal(browser, { W, Hh, K, expressOff: true }); await o.ctx.grantPermissions(['notifications']).catch(() => {}); return o; };
  const initSw = `window.__sw = []; try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: { postMessage: m => window.__sw.push(m) }, getRegistration: () => Promise.resolve(null), register: () => Promise.resolve({}) } }); } catch (e) {}`;
  const toDay = async (p, d) => { await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(i => selDia(i), d); await p.waitForTimeout(800); };
  const restVisible = p => p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 15000 });
  try {
    await reset();
    // ============ R1 / R2 / R3: rest sheet next-up, alarm channels, one-tap finish ============
    for (const [W, Hh] of [[390, 844], [320, 640]]) {
      await reset(); const { ctx, p, errs } = await open(W, Hh); await ctx.addInitScript(initSw); await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); });
      await toDay(p, 0); const key = 'log_1_0_0_s0';
      await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '40'); await p.fill('#reps_' + key, '8'); await p.click('#rir_btn_' + key + '_3'); await p.click('#setrow_' + key + ' .set-save-primary'); await restVisible(p); await p.waitForTimeout(500); await S(p, 'rest-' + W);
      const r = await p.evaluate(() => { const sh = document.querySelector('#restTimerOverlay .rt-sheet').getBoundingClientRect(), nx = document.getElementById('nextActionHint'), nr = nx.getBoundingClientRect(); return { sheetH: Math.round(sh.height), vh: innerHeight, nextVisible: getComputedStyle(nx).display !== 'none' && nr.height > 20 && nr.top >= sh.top && nr.bottom <= sh.bottom + 1, txt: nx.innerText.replace(/\n/g, ' | '), tnum: document.getElementById('restTimerNum').getBoundingClientRect().width > 0 }; });
      check('R1_' + W + '_REST_SHEET_SHOWS_WHAT_COMES_NEXT', r.nextVisible && /SIGUIENTE · SERIE 2 DE 3/.test(r.txt) && /Press Convergente Inclinado/.test(r.txt) && /8 reps · RIR \d/.test(r.txt), JSON.stringify(r));
      check('R1_' + W + '_REST_SHEET_IS_COMPACT', r.sheetH <= r.vh * (W < 360 ? 0.7 : 0.55), r.sheetH + 'px of ' + r.vh);
      const bg = await p.evaluate(() => ({ has: !!_bgAudio, paused: _bgAudio ? _bgAudio.paused : null, loop: _bgAudio ? _bgAudio.loop : null, blob: _bgAudio ? /^blob:/.test(_bgAudio.src) : null, sw: window.__sw.slice() }));
      check('R2_' + W + '_KEEPALIVE_AUDIO_PLAYING_DURING_REST', bg.has && bg.paused === false && bg.loop === true && bg.blob === true, JSON.stringify({ paused: bg.paused, loop: bg.loop }));
      const sch = bg.sw.filter(m => m.type === 'VDSEN_REST_SCHEDULE'); check('R2_' + W + '_SERVICE_WORKER_NOTIFICATION_SCHEDULED_FOR_THE_REST_END', sch.length >= 1 && sch[sch.length - 1].endMs > Date.now() && /Siguiente: Press Convergente Inclinado · serie 2\/3/.test(sch[sch.length - 1].body), JSON.stringify(sch[sch.length - 1] || null).slice(0, 220));
      await p.click('#restTimerOverlay .rt-adj button:nth-child(2)'); await p.waitForTimeout(200); const sw2 = await p.evaluate(() => window.__sw.filter(m => m.type === 'VDSEN_REST_SCHEDULE').length); check('R2_' + W + '_ADJUSTING_THE_REST_RESCHEDULES', sw2 >= 2, 'schedules=' + sw2);
      // zero: the athlete is typing (auto-advance is blocked on purpose) so the sheet stays and CONTINUAR must work on the FIRST tap
      await p.evaluate(() => { const i = document.getElementById('carga_log_1_0_0_s1'); if (i) { i.value = '41'; i.focus(); } _restEndMs = Date.now() + 1500; }); await p.waitForFunction(() => _restSeconds <= 0, null, { timeout: 15000 }); await p.waitForTimeout(400);
      const z = await p.evaluate(() => ({ ring: _bgRinging, playing: !!_bgAudio && !_bgAudio.paused, isAlarm: !!_bgAudio && _bgUrls && _bgAudio.src === _bgUrls.alarm, overlay: getComputedStyle(document.getElementById('restTimerOverlay')).display !== 'none', banner: !!document.querySelector('#restDoneLive.on') }));
      check('R2_' + W + '_ALARM_TONE_RINGS_AT_ZERO_VIA_THE_AUDIO_ELEMENT', z.ring && z.playing && z.isAlarm, JSON.stringify(z)); check('R3_' + W + '_ANNOUNCEMENT_IS_IMMEDIATE_AT_ZERO', z.banner && z.overlay, JSON.stringify(z)); await S(p, 'zero-' + W);
      const cancels0 = await p.evaluate(() => window.__sw.filter(m => m.type === 'VDSEN_REST_CANCEL').length); check('R2_' + W + '_PAGE_RINGS_ITSELF_SO_THE_PENDING_NOTIFICATION_IS_CANCELLED', cancels0 >= 1);
      const bb = await (await p.$('#restTimerOverlay .rt-go')).boundingBox(); const t0 = Date.now(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await p.waitForFunction(() => getComputedStyle(document.getElementById('restTimerOverlay')).display === 'none', null, { timeout: 3000 }); const dt = Date.now() - t0;
      const after = await p.evaluate(() => ({ ring: _bgRinging, paused: _bgAudio ? _bgAudio.paused : true, guard: !!document.getElementById('tapGuard') }));
      check('R3_' + W + '_ONE_TAP_ON_CONTINUAR_CLOSES_THE_SHEET_AND_SILENCES_THE_ALARM', dt < 1200 && !after.ring && after.paused, dt + 'ms ' + JSON.stringify(after)); await p.waitForTimeout(500);
      check('R3_' + W + '_TAP_GUARD_IS_TEMPORARY', !(await p.evaluate(() => !!document.getElementById('tapGuard'))));
      check('R_' + W + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
    // ============ R4: alarm stops on a tap anywhere ============
    { await reset(); const { ctx, p } = await open(390, 844); await toDay(p, 0); const key = 'log_1_0_0_s0'; await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '40'); await p.fill('#reps_' + key, '8'); await p.click('#rir_btn_' + key + '_3'); await p.click('#setrow_' + key + ' .set-save-primary'); await restVisible(p);
      await p.evaluate(() => { _restEndMs = Date.now() + 800; }); await p.waitForFunction(() => _bgRinging, null, { timeout: 15000 }).catch(() => {}); const ring = await p.evaluate(() => _bgRinging); await p.mouse.click(200, 80); await p.waitForTimeout(300);
      check('R4_ALARM_RINGS_THEN_A_TAP_ANYWHERE_SILENCES_IT', ring === true && (await p.evaluate(() => !_bgRinging && _bgAudio.paused))); await ctx.close(); }
    // ============ R5: opt-out ============
    { await reset(); const { ctx, p } = await open(390, 844); await p.evaluate(() => setBgAlarm(false)); await toDay(p, 0); const key = 'log_1_0_0_s0'; await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key); await p.fill('#carga_' + key, '40'); await p.fill('#reps_' + key, '8'); await p.click('#rir_btn_' + key + '_3'); await p.click('#setrow_' + key + ' .set-save-primary'); await restVisible(p);
      check('R5_OPT_OUT_NO_BACKGROUND_AUDIO', await p.evaluate(() => !_bgAudio || _bgAudio.paused)); await ctx.close(); }
    // ============ C: cardio ============
    { await reset(); const { ctx, p, errs } = await open(390, 844); const D5 = plan.days[5].exercises, ci = D5.length - 1; await toDay(p, 5);
      const rt = await p.evaluate(() => _EJERCICIOS_DIA.map(e => [e.exerciseName, e.exerciseType || null, e.sets.length])); const cardio = rt[ci];
      check('C1_PLAIN_CARDIO_ROW_IS_A_CARDIO_EXERCISE_AT_RUNTIME', cardio[1] === 'cardio' && cardio[2] === 0 && rt.slice(0, ci).every(x => !x[1] && x[2] > 0), JSON.stringify(rt));
      check('C2_THE_PRESCRIPTION_IN_FIRESTORE_IS_UNCHANGED', stable((await restGet(cfg, K.athlete.email, K.athlete.password, 'plans/' + K.planId)).fields) === stable(planDoc.fields) && D5[ci].sets.length === 1 && D5[ci].exerciseType === undefined);
      await p.evaluate(i => setEjActivo(i), ci); await p.waitForTimeout(600); await S(p, 'cardio');
      const card = await p.evaluate(() => ({ cardioCard: !!document.querySelector('[data-extype="cardio"]'), chip: /CARDIO/.test(document.body.innerText), dur: !!document.querySelector('[id^=card_dur_]'), strengthSet: !!document.querySelector('[id^=setrow_log_]'), rirButtons: document.querySelectorAll('.rirb').length, ov: document.documentElement.scrollWidth > innerWidth + 1 }));
      check('C3_CARDIO_CARD_NOT_A_STRENGTH_SET', card.cardioCard && card.dur && !card.strengthSet && card.rirButtons === 0 && !card.ov, JSON.stringify(card));
      const id = await p.evaluate(() => document.querySelector('[id^=card_dur_]').id.replace('card_dur_', '')); await p.fill('#card_dur_' + id, '30'); await p.fill('#card_rpe_' + id, '6'); await p.click('[data-extype="cardio"] .set-save-primary, [data-extype="cardio"] .pf-cta'); await p.waitForTimeout(2500);
      const en = await (async () => { const t0 = Date.now(); let e; while (Date.now() - t0 < 12000) { e = await mesoEntries(); if (e[id]) return e; await new Promise(r => setTimeout(r, 700)); } return e; })();
      check('C4_CARDIO_LOG_PERSISTED_AS_CARDIO_NOT_AS_A_STRENGTH_SET', !!en[id] && en[id].exType === 'cardio' && +en[id].duracionMin === 30 && en[id].done === true && !Object.keys(en).some(k => /_s0$/.test(k)), JSON.stringify(en[id] || null).slice(0, 200));
      const tot = await p.evaluate(() => (document.body.innerText.match(/\n(\d+)\/(\d+)\nSERIES/) || []).slice(1).join('/')); check('C7_DAY_SERIES_TOTAL_COUNTS_THE_CARDIO_AS_ONE_SERIES', /^1\/17$/.test(tot), tot);
      const nav = await p.evaluate(() => ({ done: _isExerciseFullyDone(5, _EJERCICIOS_DIA.length - 1, _EJERCICIOS_DIA[_EJERCICIOS_DIA.length - 1]) })); check('C5_COMPLETION_COUNTS_THE_CARDIO_EXERCISE', nav.done);
      // next action: after the last strength set of exercise ci-1 the next exercise is the cardio one
      const act = await p.evaluate(ci => { const lg = {}; _EJERCICIOS_DIA.forEach((e, ei) => { if (ei < ci) e.sets.forEach((s, si) => { lg['log_1_5_' + ei + '_s' + si] = { done: true }; }); }); return _resolveNextWorkoutAction(5, _EJERCICIOS_DIA, ci - 1, _EJERCICIOS_DIA[ci - 1].sets.length - 1, lg, 1, 6); }, ci);
      check('C6_REST_AFTER_THE_LAST_STRENGTH_SET_POINTS_AT_THE_CARDIO_EXERCISE', act.type === 'NEXT_EXERCISE' && /cardio/i.test(act.title) && act.kind === 'cardio', JSON.stringify(act));
      check('C_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close(); }
  } catch (e) { check('HARNESS', false, String(e.stack || e.message).slice(0, 700)); }
  finally { await reset().catch(() => {}); await browser.close(); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
