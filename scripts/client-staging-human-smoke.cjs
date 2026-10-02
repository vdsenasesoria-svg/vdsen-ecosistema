'use strict';
// T554: READ-ONLY smoke of the DEPLOYED staging preview with the human-training account: login -> Home -> Entreno -> tomorrow's day -> expand an exercise -> tabs -> logout.
// It NEVER saves a set / note / session. It verifies: plan identity, 5 exercises / 12 sets for Day 1, no page errors, no production Firebase contact, and that the account's
// Firestore documents are unchanged (REST updateTime before / after).
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-human-smoke.cjs <share url> <creds json outside repo> [--shots dir] [--logout]
const fs = require('node:fs'); const L = require('./client-staging-real-lib.cjs'); const { restGet } = require('./client-staging-performance.cjs');
const url = process.argv[2], keepFile = process.argv[3]; if (!url || !keepFile) throw new Error('usage: <share url> <creds json>');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), doLogout = process.argv.includes('--logout');
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
(async () => {
  const cfg = L.H.stagingConfig(), K = JSON.parse(fs.readFileSync(keepFile, 'utf8')); if (K.project !== cfg.projectId || K.kind !== 'human') throw new Error('REFUSING: not the staging human account');
  const paths = ['clients/' + K.athlete.uid, 'logs/' + K.athlete.uid, 'logs/' + K.athlete.uid + '/mesos/' + K.planId, 'plans/' + K.planId];
  const stamp = async () => { const o = {}; for (const p of paths) { const d = await restGet(cfg, K.athlete.email, K.athlete.password, p); o[p] = d && d.updateTime ? d.updateTime : (d && d.fields ? 'exists' : null); } return o; };
  const before = await stamp(); const browser = await L.B.launch(); const HOST = new URL(url).host;
  // the share link sets the Vercel bypass cookie; every browser request goes through Node fetch (works behind the sandbox proxy) and the cookie is attached to the preview host only
  const r0 = await fetch(url, { redirect: 'manual' }); const ck = r0.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await ctx.route('**/*', async route => { const rq = route.request(), u = new URL(rq.url());
    try { const h = Object.assign({}, rq.headers()); delete h['content-length']; delete h.host; if (u.host === HOST) h.cookie = ck; const res = await fetch(rq.url(), { method: rq.method(), headers: h, body: rq.postDataBuffer() || undefined, redirect: 'manual' }); const buf = Buffer.from(await res.arrayBuffer()), hd = {}; res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) hd[k] = v; }); hd['access-control-allow-origin'] = rq.headers().origin || '*'; hd['access-control-allow-headers'] = '*'; hd['access-control-allow-methods'] = '*'; return route.fulfill({ status: res.status, headers: hd, body: buf }); } catch (e) { return route.abort(); } });
  const p = await ctx.newPage();
  const errs = [], hosts = new Set(), bad = []; p.on('pageerror', e => errs.push(e.message)); p.on('request', r => { const u = r.url(); try { hosts.add(new URL(u).hostname); } catch (e) { /* ignore */ } if (/projects\/vdsen-ecosistema\/|vdsen-planes|vdsen-ecosistema\.firebaseapp|vdsen-ecosistema\.appspot/.test(u)) bad.push(u.slice(0, 120)); });
  try {
    await p.goto('https://' + HOST + '/cliente', { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#liEmail', { timeout: 40000 });
    const html = await p.content(); check('SERVED_BUILD_HAS_T554_MARKERS', /class="sp-opt"|sp-opt/.test(html) && /set-actions/.test(html) && /vdsen-ecosistema-staging/.test(html));
    await p.fill('#liEmail', K.athlete.email); await p.fill('#liPass', K.athlete.password); await p.click('.login-btn'); await p.waitForSelector('#scrApp.on', { timeout: 45000 }); await p.waitForTimeout(3000);
    await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); await p.waitForTimeout(500); if (shots) await p.screenshot({ path: shots + '/human-01-home.png' });
    const st = await p.evaluate(() => ({ name: (document.body.innerText.match(/AYRTON VD/i) || [''])[0], week: CURRENT_WEEK, plan: ACTIVE_PLAN_ID, logs: Object.keys(LOGS).filter(k => /^(log|done)_/.test(k)).length, cta: (document.body.innerText.match(/EMPEZAR ENTRENAMIENTO|CONTINUAR[^\n]*/) || [''])[0], today: (document.body.innerText.match(/HOY — SEM \d+\s*\n[^\n]+/) || [''])[0].replace(/\n/g, ' · ') }));
    check('LOGIN_OK_ATHLETE_PLAN_WEEK1_NO_EXECUTION', /AYRTON/i.test(st.name) && st.plan === K.planId && st.week === 1 && st.logs === 0, JSON.stringify(st));
    await p.click('#nb1'); await p.waitForTimeout(800); await p.evaluate(() => selDia(0)); await p.waitForTimeout(900); if (shots) await p.screenshot({ path: shots + '/human-02-day1.png' });
    const day = await p.evaluate(() => ({ label: (document.body.innerText.match(/SEM 1 · [^\n]+\n[^\n]+/) || [''])[0].replace(/\n/g, ' | '), ex: _EJERCICIOS_DIA.length, sets: _EJERCICIOS_DIA.reduce((n, e) => n + e.sets.length, 0), names: _EJERCICIOS_DIA.map(e => e.exerciseName), timer: !!document.getElementById('restTimerOverlay') && getComputedStyle(document.getElementById('restTimerOverlay')).display !== 'none', ls: localStorage.getItem('vdsen_restEnd') }));
    check('TOMORROW_DAY_1_5_EXERCISES_12_SETS', day.ex === 5 && day.sets === 12, JSON.stringify(day)); check('NO_STALE_TIMER', !day.timer && !day.ls);
    for (let e = 0; e < day.ex; e++) { await p.evaluate(i => setEjActivo(i), e); await p.waitForTimeout(350); }
    await p.evaluate(() => setEjActivo(0)); await p.waitForTimeout(500); const view = await p.evaluate(() => ({ presc: /PRESCRIPCI/i.test(document.body.innerText), inputsEmpty: [...document.querySelectorAll('[id^=xcarga_],[id^=carga_log_]')].every(i => i.value === ''), ov: document.documentElement.scrollWidth > innerWidth + 1 }));
    check('FIRST_EXERCISE_SHOWS_PRESCRIPTION_EMPTY_EXECUTION_NO_OVERFLOW', view.presc && view.inputsEmpty && !view.ov, JSON.stringify(view));
    for (const i of [2, 3, 4, 0]) { await p.click('#nb' + i); await p.waitForTimeout(700); } const body = await p.evaluate(() => document.body.innerText); check('NO_NAN_UNDEFINED_TEXT', !/\bNaN\b|\bundefined\b|\[object/.test(body));
    if (doLogout) { await p.click('#nb4'); await p.waitForTimeout(500); await p.click('.logout-btn'); await p.waitForTimeout(800); const cb = await p.$('text=/^(Sí|Si|SALIR|Cerrar sesión|CERRAR SESIÓN|Confirmar)/i'); if (cb && !(await p.isVisible('#scrLogin'))) await cb.click().catch(() => {}); await p.waitForSelector('#scrLogin.on', { timeout: 10000 }).catch(() => {}); check('LOGOUT_CLEAN', await p.isVisible('#liEmail')); }
    check('NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); check('NO_PRODUCTION_FIREBASE_CONTACT', bad.length === 0, bad.slice(0, 2).join(' | ') + ' hosts=' + [...hosts].filter(h => /google|firebase|vercel/.test(h)).join(','));
  } catch (e) { check('HARNESS', false, String(e.stack || e.message).slice(0, 600)); }
  finally { await browser.close(); const after = await stamp(); check('HUMAN_ACCOUNT_DOCUMENTS_UNCHANGED_BY_THE_SMOKE', paths.every(x => before[x] === after[x]), paths.map(x => before[x] === after[x] ? 'same' : before[x] + '->' + after[x]).join(',')); const summary = { checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id) }; console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
