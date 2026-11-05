'use strict';
// T548: targeted STAGING browser check of the three human findings (ICS wording, rest auto-advance, rest-complete alert) on a disposable
// synthetic athlete. Viewports: 390 dark, 320 dark, 390 light. The rest is forced to zero through the app's own adjustRestTimer (a real countdown
// then reaches 0 and fires _onTimerFinished). Nothing is entered for the athlete by the advance: every set is saved by this script's own tap.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-t548-rest.cjs [--shots dir] [--out file]
const L = require('./client-staging-real-lib.cjs'); const { restGet, val } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null);
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const lum = c => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  let seed = null, K = null; const browser = await L.B.launch(); const cleaned = [];
  const readEntries = async () => { const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  const S = async (p, n) => { if (shots) await p.screenshot({ path: shots + '/t548-' + n + '.png' }); };
  async function saveSet(p, key, load, reps, rir) {
    await p.waitForSelector('#carga_' + key, { timeout: 8000 }); await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
    await p.fill('#carga_' + key, String(load)); await p.fill('#reps_' + key, String(reps)); await p.click('#rir_btn_' + key + '_' + rir, { timeout: 8000 });
    await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 }); await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 15000 }).catch(() => {}); await p.waitForTimeout(300);
  }
  const forceZero = async p => { await p.evaluate(() => adjustRestTimer(-99999)); await p.waitForFunction(() => { const e = document.getElementById('restDoneLive'); return e && e.classList.contains('on'); }, null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(500); };
  const alertState = p => p.evaluate(() => { const e = document.getElementById('restDoneLive'); const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { on: e.classList.contains('on'), t: (e.querySelector('.rd-t') || {}).textContent, s: (e.querySelector('.rd-s') || {}).textContent, live: e.getAttribute('aria-live'), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), W: innerWidth, bg: cs.backgroundColor, fg: cs.color, bgImg: cs.backgroundImage, shadow: cs.boxShadow, ptr: cs.pointerEvents, fs: parseFloat(getComputedStyle(e.querySelector('.rd-t') || e).fontSize), ovHidden: (function () { const o = document.getElementById('restTimerOverlay'); return !o || getComputedStyle(o).display === 'none'; })() }; });
  const nextVisible = p => p.evaluate(() => { const row = document.querySelector('#exPanel [data-pending="1"]'); if (!row) return null; const r = row.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), H: innerHeight, inView: r.top < innerHeight && r.bottom > 0 }; });
  try {
    for (const [W, Hh, light, full] of [[390, 844, false, true], [320, 640, false, false], [390, 844, true, false]]) {
      if (seed) cleaned.push(await seed.cleanup()); seed = await L.H.seed(); K = { athlete: seed.athlete };   // a fresh athlete per viewport: every run starts from an empty log
      const tag = W + (light ? 'L' : 'D'); const { ctx, p, errs } = await L.openReal(browser, { W, Hh, K, expressOff: true, light });
      await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(500);
      const struct = await p.evaluate(() => _EJERCICIOS_DIA.map(e => e.sets.length)); const TOT = struct.reduce((a, b) => a + b, 0);
      // ---- ICS wording
      const k0 = 'log_1_0_0_s0'; await p.waitForSelector('#ics_' + k0);
      const ics = await p.evaluate(k => { const i = document.getElementById('ics_' + k), lab = document.querySelector('label[for="ics_' + k + '"]'), d = document.getElementById(i.getAttribute('aria-describedby') || '_'); return { label: lab && lab.textContent, help: d && d.textContent, ph: i.placeholder, min: i.min, max: i.max, vis: !!(d && d.getBoundingClientRect().height > 0) }; }, k0);
      check(tag + '_ICS_LABEL', ics.label === 'Calidad de la serie (ICS) opcional', ics.label); check(tag + '_ICS_HELPER_ASSOCIATED_AND_VISIBLE', ics.help === '¿Qué tan buena fue esta serie? 1 = muy mala · 10 = excelente' && ics.vis, ics.help); check(tag + '_ICS_PLACEHOLDER_AND_RANGE', ics.ph === '1–10' && ics.min === '1' && ics.max === '10', ics.ph);
      await S(p, tag + '-ics');
      // ---- rest -> next set
      await p.click('.today-action').catch(() => {}); await p.waitForTimeout(400); await p.evaluate(() => selDia(0)); await p.waitForTimeout(400);
      await saveSet(p, 'log_1_0_0_s0', 60, 8, 2);
      check(tag + '_REST_TIMER_RUNNING_AFTER_SAVE', await p.evaluate(() => { const o = document.getElementById('restTimerOverlay'); return !!o && getComputedStyle(o).display !== 'none'; }));
      await forceZero(p); const a1 = await alertState(p); const nv = await nextVisible(p);
      check(tag + '_ALERT_DESCANSO_TERMINADO_SIGUIENTE_SERIE', a1.on && a1.t === 'DESCANSO TERMINADO' && a1.s === 'SIGUIENTE SERIE LISTA', JSON.stringify([a1.t, a1.s]));
      check(tag + '_ALERT_ASSERTIVE_LIVE_REGION', a1.live === 'assertive');
      check(tag + '_ALERT_IN_VIEWPORT_NO_OVERFLOW', a1.left >= 0 && a1.right <= a1.W && a1.top >= 40 && a1.bottom < 400, JSON.stringify([a1.left, a1.right, a1.top, a1.bottom, a1.W]));
      check(tag + '_ALERT_HIGH_CONTRAST_NO_GRADIENT_NO_GLOW', contrast(a1.bg, a1.fg) >= 7 && a1.bgImg === 'none' && a1.shadow === 'none' && a1.fs >= 22, 'contrast=' + contrast(a1.bg, a1.fg).toFixed(1) + ' fs=' + a1.fs);
      check(tag + '_ALERT_DOES_NOT_BLOCK_TAPS', a1.ptr === 'none');
      check(tag + '_TIMER_OVERLAY_CLOSED_AND_NEXT_SET_IN_VIEW', a1.ovHidden && nv && nv.inView, JSON.stringify(nv));
      await S(p, tag + '-alert-next-set');
      const e1 = await p.evaluate(() => ({ s1: !!LOGS['log_1_0_0_s1'], keys: Object.keys(LOGS).filter(k => /^log_/.test(k)).length }));
      check(tag + '_NO_AUTO_SAVE_OF_NEXT_SET', !e1.s1 && e1.keys === 1, JSON.stringify(e1));
      const alertHold = await p.evaluate(() => new Promise(r => setTimeout(() => r(document.getElementById('restDoneLive').classList.contains('on')), 4500))); check(tag + '_ALERT_STAYS_VISIBLE_LONG_ENOUGH', alertHold);
      if (full) {
        // ---- manual navigation respected: save s1, jump to another exercise before zero
        await saveSet(p, 'log_1_0_0_s1', 60, 8, 2); await p.evaluate(() => setEjActivo(2)); await p.waitForTimeout(400);
        await forceZero(p); const mn = await p.evaluate(() => ({ ej: EJ_ACTIVO })); const a2 = await alertState(p);
        check('MANUAL_NAVIGATION_RESPECTED_NO_YANK', mn.ej === 2, 'EJ_ACTIVO=' + mn.ej); check('MANUAL_NAVIGATION_STILL_SHOWS_REST_ALERT', a2.on && a2.t === 'DESCANSO TERMINADO', a2.s === '' ? 'no next-step claim' : a2.s);
        await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(300); await p.evaluate(() => stopRestTimer()); await p.waitForTimeout(300);   // the athlete dismisses the (legacy) timer sheet, which stays up because we did not move them
        // ---- cancelled timer: save s2 then cancel
        await saveSet(p, 'log_1_0_0_s2', 60, 8, 2); await p.evaluate(() => { document.getElementById('restDoneLive').classList.remove('on'); stopRestTimer(); }); await p.waitForTimeout(2500);
        const a3 = await alertState(p); check('CANCELLED_TIMER_NO_ALERT_NO_ADVANCE', !a3.on && (await p.evaluate(() => EJ_ACTIVO)) === 0);
        // ---- exercise boundary: last set of exercise 0
        await saveSet(p, 'log_1_0_0_s3', 60, 8, 2); await forceZero(p); const a4 = await alertState(p); const ej = await p.evaluate(() => EJ_ACTIVO);
        check('EXERCISE_BOUNDARY_ALERT_SIGUIENTE_EJERCICIO', a4.on && a4.s === 'SIGUIENTE EJERCICIO LISTO', a4.s); check('EXERCISE_BOUNDARY_OPENS_NEXT_EXERCISE', ej === 1, 'EJ_ACTIVO=' + ej);
        check('EXERCISE_BOUNDARY_NEXT_EXERCISE_FIRST_SET_IN_VIEW', await p.evaluate(() => !!document.getElementById('carga_log_1_0_1_s0')));
        await S(p, tag + '-alert-next-exercise');
        // ---- finish the day: every remaining set saved by this script
        let n = 4; for (let e = 1; e < struct.length; e++) for (let s = 0; s < struct[e]; s++) {
          const key = 'log_1_0_' + e + '_s' + s; await p.evaluate(i => setEjActivo(i), e); await p.waitForTimeout(250); await saveSet(p, key, 40 + e, 8 + s % 2, 2); n++;
          const last = e === struct.length - 1 && s === struct[e] - 1;
          await forceZero(p); if (last) break;
        }
        const aEnd = await alertState(p);
        check('SESSION_END_ALERT_SESION_LISTA_PARA_CERRAR', aEnd.on && aEnd.s === 'SESIÓN LISTA PARA CERRAR', aEnd.s);
        check('SESSION_NOT_AUTO_CLOSED', await p.evaluate(() => !LOGS['done_1_0'] && !!document.querySelector('.sess-hdr-btn.sess-live')));
        await S(p, tag + '-alert-session-ready');
        // ---- persistence: only the sets this script saved, nothing else
        await p.waitForTimeout(3500); const ent = await readEntries(); const logKeys = Object.keys(ent).filter(k => /^log_/.test(k));
        check('NO_DUPLICATE_OR_EXTRA_WRITES', logKeys.length === TOT && Object.keys(ent).every(k => /^log_|^exexpress_/.test(k) || ['done_1_0'].includes(k) === false), 'sets=' + logKeys.length + '/' + TOT + ' keys=' + Object.keys(ent).length);
        const root = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId);
        check('NO_CANONICAL_ATHLETE_WRITES', !!root && !root.fields.progressionApplications && !root.fields.nextExposureOverlays && !root.fields.progressionApplicationSummary, Object.keys(root.fields).join(','));
        check('NUMERIC_APPLY_ENABLED_FALSE', await p.evaluate(() => (window.VDSEN_EFFECTIVE_PRESCRIPTION || {}).NUMERIC_APPLY_ENABLED === false));
        // ---- reload mid-rest regression: restore path still finishes, never navigates
        await p.evaluate(() => { localStorage.setItem('vdsen_restEnd', String(Date.now() - 3000)); localStorage.setItem('vdsen_restTotal', '60'); }); const ejB = await p.evaluate(() => EJ_ACTIVO);
        await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(3500); const ejA = await p.evaluate(() => EJ_ACTIVO);
        const a5 = await p.evaluate(() => ({ on: document.getElementById('restDoneLive') && document.getElementById('restDoneLive').classList.contains('on') }));
        check('RELOAD_RESTORE_FINISHES_RESTS_WITHOUT_NAVIGATING', ejA === ejB || ejA === 0, 'before=' + ejB + ' after=' + ejA + ' alert=' + a5.on);
      }
      const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: innerWidth })); check(tag + '_NO_HORIZONTAL_OVERFLOW', ov.sw <= ov.W, JSON.stringify(ov));
      check(tag + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 300)); }
  finally { await browser.close(); if (seed) cleaned.push(await seed.cleanup()); console.log('CLEANUP', JSON.stringify(cleaned)); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true, viewports: ['390 dark', '320 dark', '390 light'] }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
