'use strict';
// T549: STAGING human-shaped check of athlete note continuity across weeks, on a disposable SYNTHETIC athlete (same plan / same PIDs for the 3 weeks).
// Week 1 note + Week 2 note are typed through the real UI; Week 3 is opened (the app's own currentWeek is advanced on the synthetic log doc, as the weekly
// roll-over does). Verified visually AND from Firestore. Viewports: 390 dark, 320 dark, 390 light. Never touches the human Ayrton account.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-t549-notes.cjs [--shots dir] [--out file]
const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null);
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const browser = await L.B.launch(); let seed = null; const cleaned = [];
  const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:', FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents';
  const token = async u => (await (await fetch(AUTH + 'signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password, returnSecureToken: true }) })).json()).idToken;
  const entries = async () => { const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  const setWeek = async w => { const t = await token(seed.athlete); for (const path of ['logs/' + seed.athlete.uid, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId]) { const r = await fetch(FS + '/' + path + '?updateMask.fieldPaths=currentWeek', { method: 'PATCH', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { currentWeek: { integerValue: String(w) } } }) }); if (r.status >= 300) throw new Error('setWeek ' + r.status); } };
  const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t549-' + n + '.png' }); };
  let LIGHT = false; const reopen = async p => { await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); if (LIGHT) await p.evaluate(() => document.documentElement.classList.add('light-mode')); await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(600); };
  const writeNote = async (p, text) => { await p.evaluate(() => toggleUserNote(0, 0)); await p.waitForSelector('#usernote_input_0_0', { state: 'visible' }); await p.fill('#usernote_input_0_0', text); await p.evaluate(() => document.getElementById('usernote_input_0_0').blur()); await p.waitForFunction(() => /Nota guardada/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(3500); };
  const hist = p => p.evaluate(() => { const b = document.getElementById('unhist_0_0'); if (!b) return null; const r = b.getBoundingClientRect(); return { label: b.querySelector('.un-hl').textContent, items: [...b.querySelectorAll('.un-hi')].map(li => [li.querySelector('.un-hw').textContent, li.querySelector('.un-ht').textContent]), editable: b.querySelectorAll('input,textarea,[contenteditable]').length, w: Math.round(r.width), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), W: innerWidth }; });
  const cur = p => p.evaluate(() => { const t = document.getElementById('usernote_input_0_0'); return t ? { value: t.value, ro: t.readOnly || t.disabled } : null; });
  try {
    for (const [W, Hh, light] of [[390, 844, false], [320, 640, false], [390, 844, true]]) {
      if (seed) cleaned.push(await seed.cleanup()); seed = await L.H.seed(); const K = { athlete: seed.athlete }; const tag = W + (light ? 'L' : 'D'); LIGHT = light;
      const { ctx, p, errs } = await L.openReal(browser, { W, Hh, K, expressOff: true, light });
      await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(600);
      const pid = await p.evaluate(() => _EJERCICIOS_DIA[0].prescriptionExerciseId), pid1 = await p.evaluate(() => _EJERCICIOS_DIA[1].prescriptionExerciseId);
      check(tag + '_NO_HISTORY_CHROME_WHEN_EMPTY', (await hist(p)) === null);
      // ---- Week 1
      await writeNote(p, 'Molestia leve al final del rango'); let e = await entries(); const k1 = 'exnotepid_1_' + pid;
      check(tag + '_W1_NOTE_PERSISTED_WITH_PID_WEEK_DAY', !!e[k1] && e[k1].prescriptionExerciseId === pid && e[k1].week === 1 && e[k1].day === 0 && e[k1].planId === seed.planId && e[k1].text === 'Molestia leve al final del rango' && !!e[k1].exerciseNameSnapshot && e[k1].updatedAt > 0, JSON.stringify(e[k1]));
      check(tag + '_W1_COACH_COMPATIBLE_MIRROR', e['exnote_1_0_0'] === 'Molestia leve al final del rango');
      const w1stamp = stable(e[k1]);
      await reopen(p); check(tag + '_RELOAD_KEEPS_W1_NOTE', (await cur(p)) && (await cur(p)).value === 'Molestia leve al final del rango');
      // ---- Week 2
      await setWeek(2); await reopen(p); let h = await hist(p);
      check(tag + '_W1_TO_W2_HISTORY_VISIBLE', !!h && h.items.length === 1 && h.items[0][0] === 'SEM 1 · D1' && h.items[0][1] === 'Molestia leve al final del rango', JSON.stringify(h && h.items));
      check(tag + '_W2_CURRENT_INPUT_EMPTY_AND_EDITABLE', JSON.stringify(await cur(p)) === JSON.stringify({ value: '', ro: false }));
      await writeNote(p, 'Mejor control con 80 kg'); e = await entries();
      check(tag + '_W2_NOTE_PERSISTED_AND_W1_UNCHANGED', e['exnotepid_2_' + pid] && e['exnotepid_2_' + pid].text === 'Mejor control con 80 kg' && stable(e[k1]) === w1stamp);
      await reopen(p); check(tag + '_RELOAD_KEEPS_W2_NOTE_AND_W1_HISTORY', (await cur(p)).value === 'Mejor control con 80 kg' && (await hist(p)).items.length === 1);
      // ---- Week 3
      await setWeek(3); await reopen(p); h = await hist(p); const c3 = await cur(p);
      check(tag + '_W1_W2_TO_W3_BOTH_VISIBLE_NEWEST_FIRST', !!h && h.items.length === 2 && h.items[0][0] === 'SEM 2 · D1' && h.items[0][1] === 'Mejor control con 80 kg' && h.items[1][0] === 'SEM 1 · D1', JSON.stringify(h && h.items));
      check(tag + '_HISTORY_LABELLED_ATHLETE_AUTHORED_NOT_COACH', !!h && h.label === 'NOTAS ANTERIORES DEL ALUMNO' && !(await p.evaluate(() => document.getElementById('unhist_0_0').closest('.cnote'))));
      check(tag + '_HISTORY_READ_ONLY', !!h && h.editable === 0); check(tag + '_W3_CURRENT_INPUT_EMPTY_AND_EDITABLE', JSON.stringify(c3) === JSON.stringify({ value: '', ro: false }));
      check(tag + '_PID_ISOLATION_OTHER_EXERCISE_HAS_NO_HISTORY', await p.evaluate(() => { setEjActivo(1); return !document.getElementById('unhist_0_1'); }));
      await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(400);
      e = await entries(); check(tag + '_FIRESTORE_W1_W2_NOTES_ORDER_PID_WEEK', e['exnotepid_1_' + pid].week === 1 && e['exnotepid_2_' + pid].week === 2 && e['exnotepid_1_' + pid].prescriptionExerciseId === pid && !e['exnotepid_1_' + pid1] && !e['exnotepid_3_' + pid]);
      const geo = await p.evaluate(() => { const hb = document.getElementById('unhist_0_0'); const ov = { sw: document.documentElement.scrollWidth, W: innerWidth }; const set = document.querySelector('[id^="setrow_log_3_0_0_s0"]'); const hr = hb.getBoundingClientRect(); const sr = set && set.getBoundingClientRect(); return { ov, histH: Math.round(hr.height), gap: sr ? Math.round(sr.top - hr.bottom) : null, setTop: sr ? Math.round(sr.top) : null, H: innerHeight }; });
      check(tag + '_NO_HORIZONTAL_OVERFLOW', geo.ov.sw <= geo.ov.W, JSON.stringify(geo.ov)); check(tag + '_HISTORY_COMPACT', geo.histH <= 150, 'historyHeight=' + geo.histH + ' setTop=' + geo.setTop + ' viewportH=' + geo.H);
      await p.evaluate(() => document.getElementById('unhist_0_0').scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await S(p, tag + '-week3-history');
      // ---- many notes: latest 3 + toggle (synthetic extra weeks written by the athlete's own token)
      if (W === 390 && !light) {
        const t = await token(seed.athlete); const mk = (w, txt) => ({ mapValue: { fields: { planId: { stringValue: seed.planId }, prescriptionExerciseId: { stringValue: pid }, week: { integerValue: String(w) }, day: { integerValue: '0' }, exerciseIndex: { integerValue: '0' }, exerciseNameSnapshot: { stringValue: 'x' }, text: { stringValue: txt }, updatedAt: { integerValue: String(Date.now()) } } } });
        const extra = {}; for (const w of [4, 5, 6]) extra['exnotepid_' + w + '_' + pid] = mk(w, 'Nota semana ' + w);
        for (const path of ['logs/' + seed.athlete.uid, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId]) await fetch(FS + '/' + path + '?' + ['entries.exnotepid_4_' + pid, 'entries.exnotepid_5_' + pid, 'entries.exnotepid_6_' + pid].map(f => 'updateMask.fieldPaths=' + encodeURIComponent('entries.`' + f.slice(8) + '`')).join('&') + '&updateMask.fieldPaths=currentWeek', { method: 'PATCH', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { currentWeek: { integerValue: '7' }, entries: { mapValue: { fields: extra } } } }) });
        await reopen(p); const many = await p.evaluate(() => { const b = document.getElementById('unhist_0_0'); return b && { visible: [...b.querySelectorAll('.un-hi')].filter(li => !li.hidden).length, total: b.querySelectorAll('.un-hi').length, btn: (b.querySelector('.un-hmore') || {}).textContent }; });
        check('MANY_NOTES_LATEST_3_PLUS_TOGGLE', !!many && many.visible === 3 && many.total === 5 && /Ver historial completo \(5\)/.test(many.btn), JSON.stringify(many));
        await p.click('#unhist_0_0 .un-hmore'); await p.waitForTimeout(300); check('TOGGLE_SHOWS_FULL_HISTORY', (await p.evaluate(() => [...document.querySelectorAll('#unhist_0_0 .un-hi')].filter(li => !li.hidden).length)) === 5);
        await p.evaluate(() => document.getElementById('unhist_0_0').scrollIntoView({ block: 'center' })); await S(p, tag + '-many-expanded');
      }
      check(tag + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 300)); }
  finally { await browser.close(); if (seed) cleaned.push(await seed.cleanup()); console.log('CLEANUP', JSON.stringify(cleaned)); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true, viewports: ['390 dark', '320 dark', '390 light'] }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
