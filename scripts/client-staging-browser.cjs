#!/usr/bin/env node
'use strict';
// T542: real-browser pass of the REAL client against Firebase STAGING with synthetic accounts (cleaned up afterwards).
//   NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-browser.cjs [--shots <dir>] [--width 390] [--height 844] [--out <file.json>]
// Requires Playwright + Chromium; the app is served from a fake https origin with the STAGING firebaseConfig swapped in memory
// (buildStagingHtml). Production stays the default in vdsen-cliente.html. Never touches vdsen-ecosistema / vdsen-planes.
const fs = require('node:fs');
const path = require('node:path');
const H = require('./client-staging-harness.cjs');
const B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const W = +arg('width', 390), Hh = +arg('height', 844), shots = arg('shots', null), outFile = arg('out', null), light = process.argv.includes('--light');
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };

async function restGet(cfg, email, password, docPath) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json(); if (!j.idToken) return null;
  const d = await fetch('https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/' + docPath, { headers: { authorization: 'Bearer ' + j.idToken } });
  return d.status === 200 ? d.json() : { status: d.status };
}

(async () => {
  const cfg = H.stagingConfig();
  const seed = await H.seed();
  const browser = await B.launch();
  try {
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const ctx = await B.newCtx(browser, { width: W, height: Hh, transform: h => H.buildStagingHtml(h) });
    const p = await ctx.newPage();
    const pageErrors = []; p.on('pageerror', e => pageErrors.push(e.message));
    const S = async n => { if (shots) await p.screenshot({ path: path.join(shots, W + '-' + n + '.png') }); };
    const overflow = async id => { const o = await p.evaluate(() => { const iw = window.innerWidth; const bad = []; document.querySelectorAll('body *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width && r.right > iw + 1 && e.offsetParent !== null) { let a = e.parentElement, scroller = false; while (a && a !== document.body) { const cs = getComputedStyle(a); if (/(auto|scroll)/.test(cs.overflowX)) { scroller = true; break; } a = a.parentElement; } if (!scroller) bad.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0])); } }); return { sw: document.documentElement.scrollWidth, iw, bad: bad.slice(0, 5) }; }); check('NO_HORIZONTAL_OVERFLOW_' + id, o.sw <= o.iw + 1 && o.bad.length === 0, o.bad.join(',')); };

    await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
    if (light) await p.evaluate(() => document.documentElement.classList.add('light-mode'));
    check('LOGIN_SCREEN', await p.isVisible('#liEmail') && await p.isVisible('.login-btn')); await S('01-login'); await overflow('login');
    await p.fill('#liEmail', 'nadie@staging-ui.invalid'); await p.fill('#liPass', 'incorrecta-1'); await p.click('.login-btn');
    await p.waitForFunction(() => document.getElementById('liErr') && document.getElementById('liErr').textContent.trim().length > 0, null, { timeout: 15000 }).catch(() => {});
    const err = await p.textContent('#liErr'); check('LOGIN_BAD_CREDENTIALS_MESSAGE', err && err.trim().length > 0 && !/auth\/|Firebase/i.test(err), err.trim()); await S('02-login-error');
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2200);
    check('LOGIN_OK_APP_SHELL', await p.isVisible('.bnav') && await p.isVisible('.hdr'));
    if (await p.$('#wnModal')) { await S('03-firstrun'); await p.click('#wnModal button'); }
    await p.waitForTimeout(400);
    // ---- home / today
    await p.click('#nb0'); await p.waitForTimeout(500); await S('04-home'); await overflow('home');
    check('HOME_TODAY_SESSION', (await p.textContent('.today-session')).length > 0);
    check('HOME_PRIMARY_CTA', /EMPEZAR ENTRENAMIENTO/i.test(await p.textContent('.today-action')));
    check('HOME_PLAN_POSITION', (await p.$$('.wk')).length === 6);
    await p.click('.today-action'); await p.waitForTimeout(700);
    check('HOME_CTA_OPENS_TRAINING', await p.isVisible('#tabEntr') && await p.isVisible('#exPanel')); await S('05-training'); await overflow('training');
    // ---- prescription is Coach-owned and shown separately from execution
    check('PRESCRIPTION_LABELLED', /PRESCRIPCIÓN/.test(await p.textContent('.spec-cap')) && /COACH/.test(await p.textContent('.spec-cap')));
    check('EXECUTION_LABELLED', /REGISTRO/.test(await p.textContent('.sp-head')) && /RIR REAL/.test(await p.textContent('.sp-gl')));
    check('PRESCRIBED_RIR_SEPARATE_FROM_OBSERVED', (await p.textContent('.sp-t-r')).includes('RIR 2') && (await p.textContent('#exPanel')).includes('RIR REAL'));
    // ---- rest timer via an intermediate set
    await p.click('.setp >> nth=0'); await p.waitForTimeout(500);
    check('REST_TIMER_OPENS', await p.isVisible('#restTimerOverlay')); await S('06-rest-timer');
    check('REST_TIMER_READS', /\d+:\d\d/.test(await p.textContent('#restTimerNum')));
    await p.click('#restTimerOverlay .btn-mini'); await p.waitForTimeout(300);
    check('REST_TIMER_MINIMIZES', await p.isVisible('#timerPill') && !(await p.isVisible('#restTimerOverlay'))); await S('07-timer-pill');
    await p.click('#timerPill'); await p.waitForTimeout(200); check('REST_TIMER_RESTORES', await p.isVisible('#restTimerOverlay'));
    await p.mouse.click(10, 10); await p.waitForTimeout(300); check('REST_TIMER_CLOSES', !(await p.isVisible('#restTimerOverlay')));
    // ---- execution: load / reps / observed RIR
    await p.fill('#xcarga_0_0', '82.5'); await p.fill('#xreps_0_0', '6'); await p.click('#xrir_0_0_2'); await p.fill('#xics_0_0', '8'); await p.click('#xpump_0_0_1');
    check('OBSERVED_RIR_SELECTED', (await p.getAttribute('#xrir_0_0_2', 'aria-pressed')) === 'true' && (await p.inputValue('#xrir_val_0_0')) === '2'); await S('08-set-filled');
    await p.click('.set-save-primary'); await p.waitForTimeout(1500);
    check('EXERCISE_REGISTERED', await p.isVisible('.setdone') && /82\.5/.test(await p.textContent('.setdone'))); await S('09-registered');
    if (await p.isVisible('#restTimerOverlay')) { await S('09b-rest-after-exercise'); await p.mouse.click(10, 10); await p.waitForTimeout(300); }
    // ---- session close + post-session check-in (accessible radios, keyboard-safe)
    await p.click('.sess-hdr-btn.sess-live'); await p.waitForTimeout(600);
    if (await p.isVisible('#postSessionModal')) {
      await S('09c-postsession');
      check('POSTSESSION_MODAL_OPENS', true);
      await p.click('#eimd2'); await p.click('#artNoBtn'); await p.click('#psSuenoGrid button[data-val="8"]');
      check('POSTSESSION_CHOICES_STATE', (await p.getAttribute('#eimd2', 'aria-checked')) === 'true' && (await p.inputValue('#psSueno')) === '8' && (await p.inputValue('#psEimd')) === '2');
      await p.click('.ps-go'); await p.waitForTimeout(2500);
      check('POSTSESSION_MODAL_CLOSES', !(await p.isVisible('#postSessionModal')));
    } else check('POSTSESSION_MODAL_OPENS', false, 'modal not visible after COMPLETAR');
    if (await p.isVisible('#restTimerOverlay')) { await p.mouse.click(10, 10); await p.waitForTimeout(300); }
    // ---- persisted evidence (read back with the athlete's own token)
    let doc = null; for (let i = 0; i < 8 && !doc; i++) { await p.waitForTimeout(1000); const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId); if (d && d.fields) doc = d; }
    const ent = doc && doc.fields && doc.fields.entries && doc.fields.entries.mapValue && doc.fields.entries.mapValue.fields || {};
    const keys = Object.keys(ent);
    check('EVIDENCE_PERSISTED_IN_STAGING', !!doc && keys.some(k => /^exexpress_1_0_0$|^log_1_0_0_s\d+$/.test(k)), keys.slice(0, 4).join(','));
    check('SESSION_CLOSURE_PERSISTED', keys.some(k => /^done_1_0$/.test(k)) && keys.some(k => /^postsession_1_0$/.test(k)), keys.filter(k => /^(done|postsession|progrec)_/.test(k)).join(','));
    check('NO_CANONICAL_FIELDS_WRITTEN_BY_ATHLETE', !!doc && !doc.fields.progressionApplications && !doc.fields.nextExposureOverlays);
    // ---- tabs
    for (const [i, n] of [[2, 'nutrition'], [3, 'checkin'], [4, 'profile']]) { await p.click('#nb' + i); await p.waitForTimeout(700); await S('1' + i + '-' + n); await overflow(n); check('TAB_' + n.toUpperCase(), await p.isVisible('#nb' + i + '.on') || (await p.getAttribute('#nb' + i, 'aria-current')) === 'page'); }
    // ---- offline banner
    await ctx.setOffline(true); await p.evaluate(() => window.dispatchEvent(new Event('offline'))); await p.waitForTimeout(400);
    check('OFFLINE_BANNER_SHOWN', await p.isVisible('#offlineBanner')); await S('20-offline');
    await ctx.setOffline(false); await p.evaluate(() => window.dispatchEvent(new Event('online'))); await p.waitForTimeout(400);
    check('OFFLINE_BANNER_HIDES_ON_RECONNECT', !(await p.isVisible('#offlineBanner')));
    // ---- logout / login
    await p.click('.logout-btn'); await p.waitForTimeout(800);
    const confirmBtn = await p.$('text=/^(Sí|Si|SALIR|Cerrar sesión|CERRAR SESIÓN|Confirmar)/i'); if (confirmBtn && await p.isVisible('#scrLogin') === false) await confirmBtn.click().catch(() => {});
    await p.waitForSelector('#scrLogin.on', { timeout: 10000 }).catch(() => {});
    check('LOGOUT_RETURNS_TO_LOGIN', await p.isVisible('#liEmail')); await S('21-logout');
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(1500);
    check('RELOGIN_OK', await p.isVisible('.bnav'));
    check('NO_UNCAUGHT_PAGE_ERRORS', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } catch (e) { check('HARNESS', false, e.message.slice(0, 200)); }
  finally {
    await browser.close();
    const cleanup = await seed.cleanup();
    console.log('CLEANUP ' + JSON.stringify(cleanup));
    const summary = { project: seed.project, viewport: W + 'x' + Hh, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), cleanup };
    if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary));
    process.exit(summary.failed.length ? 1 : 0);
  }
})();
