'use strict';
// T551: STAGING end-to-end of the unified previous-week model on a disposable SYNTHETIC athlete: Week 1 executed through the real UI (standard per-set);
// controls written with the athlete's own token (same-name different-PID, ambiguous PID, Express-only, Express+different plan PID). Week 2 opened:
// ÚLTIMA SEMANA rows must equal Firestore; USAR CARGA/REPS fills load + reps only (RIR stays empty), nothing is written until the athlete saves; the save
// writes only the normal current-week set; reload persists it. Mobile pass at 320 / 360 / 390 / 430 dark + 390 light. Never touches the human Ayrton account.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-t551-reuse.cjs [--shots dir] [--out file]
const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null);
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const SETS = [['80', '10', 3], ['80', '9', 2], ['75', '8', 1]];   // Week-1 executed on exercise 0 (S4 never executed)
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const browser = await L.B.launch(); let seed = null; const cleaned = [];
  const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:', FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents';
  const token = async u => (await (await fetch(AUTH + 'signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password, returnSecureToken: true }) })).json()).idToken;
  const entries = async () => { const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  const patch = async (fields, mask) => { const t = await token(seed.athlete); for (const path of ['logs/' + seed.athlete.uid, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId]) { const r = await fetch(FS + '/' + path + '?' + mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&'), { method: 'PATCH', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ fields }) }); if (r.status >= 300) throw new Error('patch ' + r.status); } };
  const T = o => ({ mapValue: { fields: o } }), sv = s => ({ stringValue: s }), iv = n => ({ integerValue: String(n) }), bv = b => ({ booleanValue: b });
  const mk = (pid, over) => T(Object.assign({ carga: sv('50'), reps: sv('8'), unit: sv('KG'), done: bv(true), rir: iv(2), rir_real: sv('3'), prescriptionExerciseId: sv(pid), ts: iv(Date.now()) }, over || {}));
  const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t551-' + n + '.png' }); };
  let LIGHT = false;
  const reopen = async p => { await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); if (LIGHT) await p.evaluate(() => document.documentElement.classList.add('light-mode')); await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(600); };
  async function saveSet(p, key, load, reps, rir) {
    await p.waitForSelector('#carga_' + key, { timeout: 8000 }); await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
    if (load !== null) await p.fill('#carga_' + key, load); if (reps !== null) await p.fill('#reps_' + key, reps); if (rir !== null) await p.click('#rir_btn_' + key + '_' + rir, { timeout: 8000 });
    await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 });
    await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 15000 }); await p.evaluate(() => stopRestTimer()); await p.waitForTimeout(2500);
  }
  const block = (p, ei) => p.evaluate(e => { const b = document.getElementById('pw_0_' + e); if (!b) return null; const r = b.getBoundingClientRect(); return { head: b.querySelector('.pw-h').textContent, rows: [...b.querySelectorAll('.pw-i')].map(li => li.textContent), hasNote: !!b.querySelector('.pw-n') || /NOTA/.test(b.textContent), h: Math.round(r.height), right: Math.round(r.right), W: innerWidth }; }, ei);
  const useBtn = (p, key) => p.evaluate(k => { const b = document.querySelector('#setrow_' + k + ' .pw-use'); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent, h: Math.round(r.height), right: Math.round(r.right), W: innerWidth, bg: getComputedStyle(b).backgroundColor, bd: getComputedStyle(b).borderColor }; }, key);
  const inputs = (p, key) => p.evaluate(k => ({ c: document.getElementById('carga_' + k).value, r: document.getElementById('reps_' + k).value, rir: document.getElementById('rir_' + k).value, rirOn: document.querySelectorAll('#setrow_' + k + ' .rirb.on').length, ics: (document.getElementById('ics_' + k) || {}).value }), key);
  try {
    for (const [W, Hh, light, full] of [[390, 844, false, true], [320, 640, false, false], [360, 740, false, false], [430, 900, false, false], [390, 844, true, false]]) {
      if (seed) cleaned.push(await seed.cleanup()); seed = await L.H.seed(); const K = { athlete: seed.athlete }; const tag = W + (light ? 'L' : 'D'); LIGHT = light;
      const { ctx, p, errs } = await L.openReal(browser, { W, Hh, K, expressOff: true, light });
      await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(600);
      const P = await p.evaluate(() => _EJERCICIOS_DIA.map(e => e.prescriptionExerciseId)), names = await p.evaluate(() => _EJERCICIOS_DIA.map(e => e.exerciseName));
      // ---- Week 1: real UI execution of exercise 0 (3 sets), then controls via the athlete's own token
      for (let s = 0; s < SETS.length; s++) await saveSet(p, 'log_1_0_0_s' + s, ...SETS[s]);
      await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(400); await p.evaluate(() => toggleUserNote(0, 0)); await p.fill('#usernote_input_0_0', 'Me costó mantener técnica'); await p.evaluate(() => document.getElementById('usernote_input_0_0').blur()); await p.waitForTimeout(4000);
      const ctl = {
        log_1_0_1_s0: mk('pid-NOT-' + P[1], { exerciseNameSnapshot: sv(names[1]) }),                       // same NAME + same POSITION as exercise 1, other PID
        log_1_0_2_s0: mk(P[2]), log_1_2_1_s0: mk(P[2]),                                                    // ambiguous: exercise 2's PID at two positions
        log_1_0_3_s0: mk(P[3], { express: bv(true) }), log_1_0_3_s1: mk(P[3], { expressFinal: bv(true) }),  // Express-only
      };
      await patch({ entries: T(ctl) }, Object.keys(ctl).map(k => 'entries.' + k));
      const e1 = await entries();
      await patch({ currentWeek: iv(2) }, ['currentWeek']); await reopen(p);
      // ---- Week 2: display
      const b0 = await block(p, 0); const want = SETS.map((s, i) => 'S' + (i + 1) + ' · ' + s[0] + ' kg × ' + s[1] + ' · RIR ' + s[2]);
      check(tag + '_ULTIMA_SEMANA_ROWS_EQUAL_FIREBASE_EVIDENCE', !!b0 && JSON.stringify(b0.rows) === JSON.stringify(want) && SETS.every((s, i) => e1['log_1_0_0_s' + i].carga === s[0] && String(e1['log_1_0_0_s' + i].rir_real) === String(s[2])), JSON.stringify(b0 && b0.rows));
      check(tag + '_NO_NOTE_INSIDE_PERFORMANCE_BLOCK', !!b0 && !b0.hasNote);
      check(tag + '_T549_NOTE_HISTORY_OWNS_PREVIOUS_NOTE', await p.evaluate(() => { const h = document.getElementById('unhist_0_0'); return !!h && /Me costó mantener técnica/.test(h.textContent); }));
      check(tag + '_ONE_LAST_WEEK_PANEL_NO_OLD_CHIP', await p.evaluate(() => document.querySelectorAll('#exPanel .pw').length === 1 && !/↩ SEM|📋 HISTORIAL|↺ USAR/.test(document.getElementById('exPanel').innerText)));
      const btn0 = await useBtn(p, 'log_2_0_0_s0');
      check(tag + '_USE_BUTTON_PER_SET_SECONDARY_NO_LIME', !!btn0 && /USAR CARGA\/REPS/.test(btn0.text) && /S1 · 80 kg × 10/.test(btn0.text) && btn0.h >= 44 && btn0.right <= btn0.W && !/198, ?255|c6ff00/i.test(btn0.bg), JSON.stringify(btn0));
      check(tag + '_TU_EJECUCION_LABEL_PRESENT', await p.evaluate(() => /TU EJECUCIÓN/.test(document.querySelector('#exPanel [data-pending="1"]').innerText) && /PRESCRIPCIÓN/.test(document.getElementById('exPanel').innerText)));
      const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth })); check(tag + '_NO_HORIZONTAL_OVERFLOW', ov.sw <= ov.W && b0.right <= b0.W, JSON.stringify(ov));
      check(tag + '_COMPACT', b0.h <= 190, 'blockHeight=' + b0.h);
      await p.evaluate(() => document.getElementById('pw_0_0').scrollIntoView({ block: 'start' })); await p.waitForTimeout(300); await S(p, tag + '-week2');
      if (full) {
        check('CONTROL_SAME_NAME_DIFFERENT_PID_NO_BLOCK_NO_BUTTON', await p.evaluate(() => { setEjActivo(1); return !document.getElementById('pw_0_1') && !document.querySelector('.pw-use'); }));
        check('CONTROL_AMBIGUOUS_PID_NO_BLOCK_NO_BUTTON', await p.evaluate(() => { setEjActivo(2); return !document.getElementById('pw_0_2') && !document.querySelector('.pw-use'); }));
        check('CONTROL_EXPRESS_ONLY_NO_BLOCK_NO_BUTTON', await p.evaluate(() => { setEjActivo(3); return !document.getElementById('pw_0_3') && !document.querySelector('.pw-use'); }));
        await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500);
        // ---- reuse: draft only
        const before = await entries(); const reqs = []; p.on('request', r => { if (r.method() === 'POST' && /Write\/channel|:commit/.test(r.url())) reqs.push(r.url().slice(-30)); });
        await p.evaluate(() => document.querySelector('#setrow_log_2_0_0_s0 .pw-use').click()); await p.waitForTimeout(600);
        const d1 = await inputs(p, 'log_2_0_0_s0');
        check('USE_FILLS_LOAD_AND_REPS_ONLY', d1.c === '80' && d1.r === '10', JSON.stringify(d1)); check('USE_NEVER_COPIES_RIR_OR_ICS', d1.rir === '' && d1.rirOn === 0 && (d1.ics === '' || d1.ics === undefined), JSON.stringify(d1));
        await p.waitForTimeout(5000); const after = await entries();
        check('NO_FIRESTORE_WRITE_BEFORE_EXPLICIT_SAVE', stable(before) === stable(after) && Object.keys(after).every(k => !/^log_2_/.test(k)) && (await p.evaluate(() => !Object.keys(LOGS).some(k => /^log_2_/.test(k)))), 'week2 keys=' + Object.keys(after).filter(k => /^log_2_/.test(k)).length + ' postWriteRequests=' + reqs.length);
        const ed = await p.evaluate(() => { const c = document.getElementById('carga_log_2_0_0_s0'); c.value = ''; return !c.readOnly && !c.disabled; }); check('COPIED_DRAFT_STAYS_EDITABLE', ed);
        await p.evaluate(() => document.querySelector('#setrow_log_2_0_0_s0 .pw-use').click()); await p.waitForTimeout(300);
        // ---- explicit save: athlete confirms with his own RIR
        await saveSet(p, 'log_2_0_0_s0', null, null, 2); const e2 = await entries();
        const newKeys = Object.keys(e2).filter(k => !(k in before));
        check('EXPLICIT_SAVE_WRITES_ONLY_THE_NORMAL_CURRENT_WEEK_SET', newKeys.every(k => /^log_2_0_0_s0$/.test(k) || /^exnote|^progrec_2/.test(k) === false) && !!e2.log_2_0_0_s0 && e2.log_2_0_0_s0.carga === '80' && e2.log_2_0_0_s0.reps === '10' && String(e2.log_2_0_0_s0.rir_real) === '2' && !e2.log_2_0_0_s0.ics && !e2.log_2_0_0_s0.express, JSON.stringify(newKeys));
        check('PRIOR_WEEK_EVIDENCE_UNCHANGED_BY_REUSE_AND_SAVE', SETS.every((s, i) => stable(e2['log_1_0_0_s' + i]) === stable(before['log_1_0_0_s' + i])));
        // per-set mapping on the next sets
        const u2 = await p.evaluate(() => { const b = document.querySelector('#setrow_log_2_0_0_s1 .pw-use'); return b && b.textContent; }); check('PER_SET_MAPPING_S2_USES_PRIOR_S2', !!u2 && /S2 · 80 kg × 9/.test(u2), u2);
        await p.evaluate(() => document.querySelector('#setrow_log_2_0_0_s1 .pw-use').click()); const d2 = await inputs(p, 'log_2_0_0_s1'); check('S2_DRAFT_80_X_9_RIR_EMPTY', d2.c === '80' && d2.r === '9' && d2.rir === '', JSON.stringify(d2));
        await saveSet(p, 'log_2_0_0_s1', null, null, 1); await p.evaluate(() => document.querySelector('#setrow_log_2_0_0_s2 .pw-use').click()); const d3 = await inputs(p, 'log_2_0_0_s2'); check('S3_DRAFT_75_X_8', d3.c === '75' && d3.r === '8' && d3.rir === '', JSON.stringify(d3));
        await saveSet(p, 'log_2_0_0_s2', null, null, 1);
        check('NO_PRIOR_S4_NO_BUTTON_EMPTY_DRAFT', await p.evaluate(() => { const row = document.getElementById('setrow_log_2_0_0_s3'); return !!row && !row.querySelector('.pw-use') && document.getElementById('carga_log_2_0_0_s3').value === '' && document.getElementById('reps_log_2_0_0_s3').value === ''; }));
        await p.evaluate(() => document.getElementById('setrow_log_2_0_0_s3').scrollIntoView({ block: 'center' })); await S(p, tag + '-s4-no-button');
        // ---- hard reload persistence
        await reopen(p); const pers = await p.evaluate(() => ({ a: LOGS['log_2_0_0_s0'], b: LOGS['log_2_0_0_s1'] })); check('HARD_RELOAD_PERSISTS_SAVED_CURRENT_EXECUTION', !!pers.a && pers.a.done && pers.a.carga === '80' && pers.a.reps === '10' && !!pers.b && pers.b.reps === '9');
        check('RELOAD_STILL_SHOWS_SINGLE_PREVIOUS_WEEK_BLOCK', (await block(p, 0)).rows.length === 3);
        check('NUMERIC_APPLY_ENABLED_FALSE', await p.evaluate(() => (window.VDSEN_EFFECTIVE_PRESCRIPTION || {}).NUMERIC_APPLY_ENABLED === false));
      } else {
        // long unit / many sets safety on the mobile pass: 8 prior sets with LB + long values
        const many = {}; for (let i = 0; i < 8; i++) many['log_1_0_0_s' + (i + 3)] = mk(P[0], { carga: sv('1234.5'), unit: sv('LB'), reps: sv('100'), rir_real: sv('0') });
        await patch({ entries: T(many) }, Object.keys(many).map(k => 'entries.' + k)); await reopen(p);
        const m = await block(p, 0); check(tag + '_MANY_SETS_COLLAPSE_AND_NO_OVERFLOW', !!m && m.rows.length === 11 && m.right <= m.W, 'rows=' + m.rows.length);
        const vis = await p.evaluate(() => [...document.querySelectorAll('#pw_0_0 .pw-i')].filter(li => !li.hidden).length); check(tag + '_COLLAPSE_SHOWS_6', vis === 6, 'visible=' + vis);
        await p.click('#pw_0_0 .pw-more'); await p.waitForTimeout(200); check(tag + '_EXPAND_SHOWS_ALL', (await p.evaluate(() => [...document.querySelectorAll('#pw_0_0 .pw-i')].filter(li => !li.hidden).length)) === 11);
        const ov2 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth })); check(tag + '_LONG_VALUES_NO_OVERFLOW', ov2.sw <= ov2.W, JSON.stringify(ov2)); await p.evaluate(() => document.getElementById('pw_0_0').scrollIntoView({ block: 'start' })); await S(p, tag + '-many');
      }
      check(tag + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 1200)); }
  finally { await browser.close(); if (seed) cleaned.push(await seed.cleanup()); console.log('CLEANUP', JSON.stringify(cleaned)); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true, viewports: ['390 dark', '320 dark', '360 dark', '430 dark', '390 light'] }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
