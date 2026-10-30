'use strict';
// T545: read-only visual/metric scan of the REAL cloned Ayrton plan (all days / exercises) on STAGING. Executes nothing, writes nothing.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_AYRTON_KEEP=<file outside repo> node scripts/client-staging-real-scan.cjs [--widths 360,390,430] [--shots dir] [--light]
const fs = require('node:fs'), path = require('node:path');
const B = require('./client-browser-lib.cjs'), H = require('./client-staging-harness.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const widths = String(arg('widths', '360,390,430')).split(',').map(Number), shots = arg('shots', null), light = process.argv.includes('--light');
const KEEP = process.env.VDSEN_AYRTON_KEEP; if (!KEEP) throw new Error('VDSEN_AYRTON_KEEP (path to the staging credentials file, outside the repo) is required');
(async () => {
  const cfg = H.stagingConfig(); const K = JSON.parse(fs.readFileSync(KEEP, 'utf8'));
  if (K.project !== cfg.projectId || cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not the staging project');
  const browser = await B.launch(); const out = { project: cfg.projectId, widths: {} };
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    for (const W of widths) {
      const ctx = await B.newCtx(browser, { width: W, height: W >= 430 ? 932 : W <= 360 ? 800 : 844, transform: h => H.buildStagingHtml(h) });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
      await p.fill('#liEmail', K.athlete.email); await p.fill('#liPass', K.athlete.password); await p.click('.login-btn');
      await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500);
      await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); await p.waitForTimeout(400);
      if (light) await p.evaluate(() => document.documentElement.classList.add('light-mode'));
      const S = async n => { if (shots) await p.screenshot({ path: path.join(shots, (light ? 'L' : '') + W + '-' + n + '.png') }); };
      const metrics = () => p.evaluate(() => {
        const vw = innerWidth, over = [], small = [], clipped = [];
        const inScroller = e => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
        document.querySelectorAll('body *').forEach(e => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || inScroller(e)) return;
          if (r.right > vw + 1 && cs.position !== 'fixed') over.push((e.id || e.className || e.tagName).toString().slice(0, 40));
          if ((e.tagName === 'BUTTON' || e.tagName === 'INPUT' || e.tagName === 'A') && e.offsetParent !== null && (r.height < 40 || r.width < 40) && !e.disabled && e.type !== 'hidden') small.push((e.id || e.className || e.tagName).toString().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
          if (e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && e.children.length === 0 && e.textContent.trim().length > 3) clipped.push(e.textContent.trim().slice(0, 30)); });
        return { hScroll: document.documentElement.scrollWidth > vw + 1, over: [...new Set(over)].slice(0, 5), small: [...new Set(small)].slice(0, 6), clipped: [...new Set(clipped)].slice(0, 5) }; });
      const r = { home: null, days: [], errors: 0 };
      await p.click('#nb0'); await p.waitForTimeout(500); await S('home'); r.home = await metrics();
      const plan = await p.evaluate(() => PLAN.entrenamiento.days ? PLAN.entrenamiento.days.length : null);
      r.days_n = await p.evaluate(() => { let d = 0, e = 0, s = 0; const pids = new Set(); for (let i = 0; i < 7; i++) { selDia(i); d++; _EJERCICIOS_DIA.forEach(x => { e++; s += (x.sets || []).length; pids.add(x.prescriptionExerciseId); }); } return { d, e, s, pids: pids.size }; });
      await p.click('#nb1').catch(() => {}); await p.waitForTimeout(500);
      for (let d = 0; d < 7; d++) {
        await p.evaluate(i => selDia(i), d); await p.waitForTimeout(500); await S('d' + d);
        const n = await p.evaluate(() => _EJERCICIOS_DIA.length); const dm = await metrics(); const exs = [];
        for (let e = 0; e < n; e++) { await p.evaluate(i => setEjActivo(i), e); await p.waitForTimeout(350); if (e === 0 || e === n - 1) await S('d' + d + 'e' + e); exs.push(Object.assign({ e }, await metrics())); }
        r.days.push({ d, exercises: n, dayView: dm, bad: exs.filter(x => x.hScroll || x.over.length || x.clipped.length) });
      }
      for (const [i, n] of [[2, 'nutrition'], [3, 'checkin'], [4, 'profile']]) { await p.click('#nb' + i).catch(() => {}); await p.waitForTimeout(600); await S(n); r[n] = await metrics(); }
      r.errors = errs.length; out.widths[W] = r; await ctx.close();
    }
  } finally { await browser.close(); }
  const flat = Object.entries(out.widths).map(([w, r]) => ({ w, totals: r.days_n, home: r.home.hScroll, dayIssues: r.days.filter(d => d.dayView.hScroll || d.bad.length).map(d => ({ d: d.d, view: d.dayView.over.concat(d.dayView.clipped), bad: d.bad.slice(0, 2) })), small: [...new Set([].concat(r.home.small, ...r.days.map(d => d.dayView.small)))].slice(0, 8), errors: r.errors }));
  console.log(JSON.stringify(flat, null, 1)); if (arg('out', null)) fs.writeFileSync(arg('out'), JSON.stringify(out, null, 2));
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
