#!/usr/bin/env node
'use strict';
// T576: with a short viewport (on-screen keyboard open) the sticky "GUARDAR SERIE" bar must not cover the fields being typed into.
//   node scripts/t576-keyboard-overlap.cjs [--root <tree>] [--heights 420,500,560,700]
const fs = require('node:fs'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('root', path.join(__dirname, '..'))), heights = arg('heights', '420,500,560,700').split(',').map(Number);
(async () => {
  const seed = await H.seed(), browser = await B.launch(), out = {};
  try {
    for (const h of heights) {
      const ctx = await B.newCtx(browser, { width: 390, height: h, root, transform: x => H.buildStagingHtml(x) }); const p = await ctx.newPage();
      await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail'); await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
      await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2300); if (await p.$('#wnModal')) await p.click('#wnModal button');
      await p.click('#nb1'); await p.waitForTimeout(900);
      await p.focus('input[id^="carga_"] >> nth=0'); await p.waitForTimeout(400);
      out[h] = await p.evaluate(() => {
        const bar = document.querySelector('.workout-set-current .set-actions'), inputs = Array.from(document.querySelectorAll('input[id^="carga_"],input[id^="reps_"]'));
        if (!bar || !inputs.length) return { error: 'elements missing' };
        const b = bar.getBoundingClientRect(), pos = getComputedStyle(bar).position;
        const covered = inputs.map(i => { const r = i.getBoundingClientRect(); const vis = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); const ov = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)); return vis > 0 ? ov / vis : 0; });
        return { barPosition: pos, maxCoveredFraction: Math.round(Math.max.apply(null, covered) * 100) / 100 };
      });
      await ctx.close();
    }
  } finally { await browser.close(); try { await seed.cleanup(); } catch (_) { /* ignore */ } }
  console.log(JSON.stringify(out));
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
