#!/usr/bin/env node
'use strict';
// T576: state-coverage captures of the REAL client against Firebase STAGING with synthetic accounts (deleted at the end).
//   NODE_PATH=<node_modules with playwright> VDSEN_CHROMIUM=<chrome.exe> node scripts/t576-states-capture.cjs --label before|after [--widths 320,390,430] [--root <tree>]
// Scenarios: S1 athlete WITHOUT a plan (empty states, all tabs) · S2 full dashboard · S3 training: set saved (feedback/feasible one-hand flow) · S4 offline banner
//            S5 on-screen keyboard emulation (reduced viewport height with the first input focused) · S6 long text in names/notes.
// Writes docs/t576-shots/<label>/<width>-<scenario>.png and report.json (overflow + tap-target audit per screen). Never touches production.
const fs = require('node:fs'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const label = arg('label', 'after'), widths = arg('widths', '390').split(',').map(Number), root = path.resolve(arg('root', path.join(__dirname, '..')));
const out = path.join(__dirname, '..', 'docs', 't576-shots', label);
const report = { label, at: new Date().toISOString(), screens: {} };
const audit = p => p.evaluate(() => {
  const iw = window.innerWidth, bad = [], small = [];
  const inScroller = n => { for (let x = n.parentElement; x; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  document.querySelectorAll('body *').forEach(e => {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) return; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (r.right > iw + 1 && !inScroller(e)) bad.push(e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
    if ((e.tagName === 'BUTTON' || e.tagName === 'A' || e.getAttribute('role') === 'button' || e.tagName === 'INPUT') && (r.height < 40 || r.width < 40) && r.top >= 0 && r.top < innerHeight && e.type !== 'hidden' && e.type !== 'checkbox' && e.type !== 'radio')
      small.push((e.id ? '#' + e.id : String(e.className).split(' ')[0] || e.tagName) + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
  });
  return { overflow: Array.from(new Set(bad)).slice(0, 8), smallTargets: Array.from(new Set(small)).slice(0, 12), scrollWidth: document.documentElement.scrollWidth, innerWidth: iw };
});
async function login(p, seed) {
  await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
  await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
  await p.waitForFunction(() => { const e = document.querySelector('.screen.on'); return e && e.id !== 'scrLogin' && e.id !== 'scrLoading'; }, null, { timeout: 30000 }); await p.waitForTimeout(2300);
  if (await p.$('#wnModal')) await p.click('#wnModal button'); await p.waitForTimeout(300);
  return p.evaluate(() => document.querySelector('.screen.on').id);
}
(async () => {
  const browser = await B.launch(); fs.mkdirSync(out, { recursive: true });
  const noPlan = await H.seed({ noPlan: true }), full = await H.seed();
  try {
    for (const W of widths) {
      const mk = async (seed, h) => { const ctx = await B.newCtx(browser, { width: W, height: h || 844, root, transform: x => H.buildStagingHtml(x) }); const p = await ctx.newPage(); const landing = await login(p, seed); return { ctx, p, landing }; };
      const shot = async (p, n) => { await p.screenshot({ path: path.join(out, W + '-' + n + '.png') }); report.screens[W + '-' + n] = await audit(p); };
      // S1 no plan
      { const { ctx, p, landing } = await mk(noPlan); report.noPlanLanding = landing; await shot(p, 's1-noplan-landing-' + landing); if (landing === 'scrApp') for (const [id, n] of [['nb0', 's1-noplan-home'], ['nb1', 's1-noplan-training'], ['nb2', 's1-noplan-nutrition'], ['nb3', 's1-noplan-checkin'], ['nb4', 's1-noplan-profile']]) { await p.click('#' + id); await p.waitForTimeout(700); await shot(p, n); } await ctx.close(); }
      // S2/S3/S4/S5 with a plan
      { const { ctx, p } = await mk(full);
        await p.click('#nb0'); await p.waitForTimeout(600); await shot(p, 's2-home');
        await p.click('#nb1'); await p.waitForTimeout(700);
        const first = await p.$('input[id^="carga_"]');
        if (first) {
          await p.fill('input[id^="carga_"] >> nth=0', '60'); await p.fill('input[id^="reps_"] >> nth=0', '8');
          await p.click('button:has-text("2 reps")').catch(() => {}); await shot(p, 's3-set-filled');
          await p.click('.set-save-primary >> nth=0').catch(() => {}); await p.waitForTimeout(1200); await shot(p, 's3-set-saved');
          for (let i = 0; i < 6; i++) { if (!(await p.isVisible('#restTimerOverlay'))) break; const b = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (b) await b.click().catch(() => {}); await p.waitForTimeout(500); }
        }
        await ctx.setOffline(true); await p.evaluate(() => window.dispatchEvent(new Event('offline'))); await p.waitForTimeout(500); await shot(p, 's4-offline');
        await ctx.setOffline(false); await p.evaluate(() => window.dispatchEvent(new Event('online')));
        await p.setViewportSize({ width: W, height: 420 }); await p.waitForTimeout(300);
        const inp = await p.$('input[id^="carga_"]'); if (inp) await inp.focus(); await shot(p, 's5-keyboard-height');
        await ctx.close(); }
    }
  } finally {
    await browser.close();
    for (const s of [noPlan, full]) { try { console.log('cleanup', JSON.stringify(await s.cleanup())); } catch (e) { console.log('cleanup failed', e.message); } }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    const bad = Object.entries(report.screens).filter(([k, v]) => v.overflow.length || v.scrollWidth > v.innerWidth + 1).map(([k]) => k);
    console.log(JSON.stringify({ screens: Object.keys(report.screens).length, overflowing: bad }));
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
