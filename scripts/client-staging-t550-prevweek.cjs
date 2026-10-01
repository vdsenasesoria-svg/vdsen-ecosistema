'use strict';
// T550: STAGING check of the ÚLTIMA SEMANA reference on disposable SYNTHETIC athletes. Week 1 is executed through the real UI in standard per-set mode
// (heterogeneous load / reps / RIR, one set with NO observed RIR, an athlete note); the app's currentWeek is then advanced to 2 (as the weekly roll-over does)
// and the block is compared EXACTLY with the Firestore evidence. Also: Express-only evidence => no block; inputs never prefilled. 320 dark, 390 dark, 390 light.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-t550-prevweek.cjs [--shots dir] [--out file]
const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null);
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const SETS = [['80', '10', 3], ['80', '9', 2], ['75', '8', 1], ['70', '8', null]];   // load, reps, observed RIR (null = athlete did not tap one)
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const browser = await L.B.launch(); let seed = null; const cleaned = [];
  const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:', FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents';
  const token = async u => (await (await fetch(AUTH + 'signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password, returnSecureToken: true }) })).json()).idToken;
  const entries = async () => { const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  const patch = async (fields, mask) => { const t = await token(seed.athlete); for (const path of ['logs/' + seed.athlete.uid, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId]) { const r = await fetch(FS + '/' + path + '?' + mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&'), { method: 'PATCH', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ fields }) }); if (r.status >= 300) throw new Error('patch ' + r.status); } };
  const setWeek = w => patch({ currentWeek: { integerValue: String(w) } }, ['currentWeek']);
  const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t550-' + n + '.png' }); };
  let LIGHT = false;
  const reopen = async p => { await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); if (LIGHT) await p.evaluate(() => document.documentElement.classList.add('light-mode')); await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(600); };
  async function saveSet(p, key, load, reps, rir) {
    await p.waitForSelector('#carga_' + key, { timeout: 8000 }); await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
    await p.fill('#carga_' + key, load); await p.fill('#reps_' + key, reps); if (rir !== null) await p.click('#rir_btn_' + key + '_' + rir, { timeout: 8000 });
    await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 }); await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 15000 }); await p.evaluate(() => stopRestTimer()); await p.waitForTimeout(2500);   // the rest sheet starts after the write is acknowledged; dismiss it like the athlete would, let the toast leave
  }
  const block = p => p.evaluate(() => { const b = document.getElementById('pw_0_0'); if (!b) return null; const r = b.getBoundingClientRect(); const set = document.querySelector('[id^="setrow_log_2_0_0_s0"]'); const sr = set && set.getBoundingClientRect(); return { head: b.querySelector('.pw-h').textContent, micro: b.querySelector('.pw-m').textContent, rows: [...b.querySelectorAll('.pw-i')].map(li => li.textContent), note: (b.querySelector('.pw-n') || {}).textContent || null, inputs: b.querySelectorAll('input,textarea').length, h: Math.round(r.height), right: Math.round(r.right), W: innerWidth, gapToSet: sr ? Math.round(sr.top - r.bottom) : null }; });
  try {
    for (const [W, Hh, light] of [[390, 844, false], [320, 640, false], [390, 844, true]]) {
      if (seed) cleaned.push(await seed.cleanup()); seed = await L.H.seed(); const K = { athlete: seed.athlete }; const tag = W + (light ? 'L' : 'D'); LIGHT = light;
      const { ctx, p, errs } = await L.openReal(browser, { W, Hh, K, expressOff: true, light });
      await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(600);
      const pid = await p.evaluate(() => _EJERCICIOS_DIA[0].prescriptionExerciseId);
      check(tag + '_WEEK1_NO_PREVIOUS_WEEK_CHROME', (await block(p)) === null);
      for (let s = 0; s < SETS.length; s++) await saveSet(p, 'log_1_0_0_s' + s, ...SETS[s]);
      await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500); await p.evaluate(() => toggleUserNote(0, 0)); await p.fill('#usernote_input_0_0', 'Me costó mantener técnica'); await p.evaluate(() => document.getElementById('usernote_input_0_0').blur()); await p.waitForTimeout(4000);
      const e1 = await entries();
      // ---- Week 2
      await p.waitForTimeout(1500); await setWeek(2); await reopen(p); const b = await block(p);
      const want = SETS.map((s, i) => 'S' + (i + 1) + ' · ' + s[0] + ' kg × ' + s[1] + ' · RIR ' + (s[2] === null ? '—' : s[2]));
      check(tag + '_W2_SHOWS_W1_SETS_EXACTLY', !!b && JSON.stringify(b.rows) === JSON.stringify(want), JSON.stringify(b && b.rows));
      const fs1 = SETS.every((s, i) => { const r = e1['log_1_0_0_s' + i]; return r && r.carga === s[0] && r.reps === s[1] && (s[2] === null ? (r.rir_real === '' || r.rir_real === undefined || r.rir_real === null) : String(r.rir_real) === String(s[2])) && r.prescriptionExerciseId === pid; });
      check(tag + '_RENDERED_VALUES_EQUAL_FIRESTORE_EVIDENCE', fs1);
      check(tag + '_MISSING_RIR_SHOWN_AS_DASH_NOT_PRESCRIBED', !!b && b.rows[3].endsWith('RIR —') && e1['log_1_0_0_s3'].rir !== undefined, 'prescribed rir stored=' + e1['log_1_0_0_s3'].rir + ' shown=' + (b && b.rows[3]));
      check(tag + '_HEADING_MICROCOPY_NO_NOTE_IN_BLOCK', !!b && /ÚLTIMA SEMANA/.test(b.head) && /SEM 1/.test(b.head) && b.micro === 'Referencia de tu sesión anterior' && !/Me costó/.test(b.note || ''), JSON.stringify([b && b.head, b && b.note]));   // T551: the previous note is owned by the T549 history, not by this block
      check(tag + '_DISPLAY_ONLY_NO_INPUTS', !!b && b.inputs === 0);
      const pre = await p.evaluate(() => ({ c: document.getElementById('carga_log_2_0_0_s0').value, r: document.getElementById('reps_log_2_0_0_s0').value, rir: document.getElementById('rir_log_2_0_0_s0').value }));
      check(tag + '_CURRENT_INPUTS_NOT_PREFILLED', pre.c === '' && pre.r === '' && pre.rir === '', JSON.stringify(pre));
      check(tag + '_OTHER_PID_NO_BLOCK', await p.evaluate(() => { setEjActivo(1); return !document.getElementById('pw_0_1'); })); await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(300);
      const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth })); check(tag + '_NO_HORIZONTAL_OVERFLOW', ov.sw <= ov.W && b.right <= b.W, JSON.stringify(ov));
      check(tag + '_COMPACT_NOT_PUSHING_SETS', b.h <= 190 && b.gapToSet !== null && b.gapToSet < 60, 'blockHeight=' + b.h + ' gapToSetControls=' + b.gapToSet);
      await p.evaluate(() => document.getElementById('pw_0_0').scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await S(p, tag + '-week2');
      await reopen(p); check(tag + '_RELOAD_PRESERVES_BLOCK', JSON.stringify((await block(p)).rows) === JSON.stringify(want));
      // ---- Week 3 with no Week 2 evidence: no block (never falls back to Week 1)
      await setWeek(3); await reopen(p); check(tag + '_WEEK3_WITHOUT_WEEK2_EVIDENCE_NO_BLOCK', (await block(p)) === null);
      // ---- Express-only exposure (W390 dark only): synthetic evidence written with the athlete's own token
      if (W === 390 && !light) {
        const t = (o) => ({ mapValue: { fields: o } }); const sv = s => ({ stringValue: s }), iv = n => ({ integerValue: String(n) }), bv = b => ({ booleanValue: b });
        const mk = (extra) => t(Object.assign({ carga: sv('50'), reps: sv('8'), unit: sv('KG'), done: bv(true), rir: iv(2), prescriptionExerciseId: sv(pid), ts: iv(Date.now()) }, extra));
        const ex = { log_2_0_0_s0: mk({ express: bv(true) }), log_2_0_0_s1: mk({ express: bv(true) }), log_2_0_0_s2: mk({ expressFinal: bv(true), rir_real: sv('1') }) };
        await patch({ currentWeek: iv(3), entries: t(ex) }, ['currentWeek', 'entries.log_2_0_0_s0', 'entries.log_2_0_0_s1', 'entries.log_2_0_0_s2']);
        await reopen(p); check('EXPRESS_ONLY_WEEK2_EXPOSURE_SHOWS_NO_BLOCK', (await block(p)) === null);
        const eFinal = await entries(); check('EXPRESS_FIXTURE_PRESENT_AS_EXPRESS', eFinal.log_2_0_0_s2 && eFinal.log_2_0_0_s2.expressFinal === true);
      }
      check(tag + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 1500)); }
  finally { await browser.close(); if (seed) cleaned.push(await seed.cleanup()); console.log('CLEANUP', JSON.stringify(cleaned)); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true, viewports: ['390 dark', '320 dark', '390 light'] }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
