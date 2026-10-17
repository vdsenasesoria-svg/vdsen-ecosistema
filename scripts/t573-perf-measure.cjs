#!/usr/bin/env node
'use strict';
// T573: tab-switch / render timing + DOM size of the REAL client (staging, synthetic accounts) for a given source tree.
//   node scripts/t573-perf-measure.cjs --root <dir with vdsen-cliente.html> --label before|after [--runs 7]
// Median of N runs per tab (click -> two animation frames). Lab numbers on one machine: compare only within the same session.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('root', path.join(__dirname, '..'))), label = arg('label', 'after'), runs = +arg('runs', 7);
const KEEP = process.env.VDSEN_UI_KEEP || path.join(os.tmpdir(), 'vdsen-t573-ui-keep.json');
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
(async () => {
  const seed = await H.seed({ keepFile: KEEP }), browser = await B.launch();
  try {
    const ctx = await B.newCtx(browser, { width: 390, height: 844, root, transform: h => H.buildStagingHtml(h) });
    const p = await ctx.newPage();
    const t0 = Date.now(); await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }); const loginMs = Date.now() - t0; await p.waitForTimeout(2500);
    if (await p.$('#wnModal')) await p.click('#wnModal button');
    const out = { label, loginToShellMs: loginMs, tabs: {} };
    for (const [id, name] of [['nb0', 'home'], ['nb1', 'training'], ['nb2', 'nutrition'], ['nb3', 'checkin'], ['nb4', 'profile']]) {
      const times = [];
      for (let i = 0; i < runs; i++) {
        await p.click('#' + (id === 'nb0' ? 'nb4' : 'nb0')); await p.waitForTimeout(150);
        const t = await p.evaluate(id => new Promise(res => { const s = performance.now(); document.getElementById(id).click(); requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - s))); }), id);
        times.push(t);
      }
      const nodes = await p.evaluate(() => document.querySelectorAll('*').length);
      out.tabs[name] = { medianMs: Math.round(med(times) * 10) / 10, domNodes: nodes };
    }
    out.heapMB = await p.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null);
    fs.mkdirSync(path.join(__dirname, '..', 'docs', 't573-perf'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 't573-perf', label + '.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
  } finally { await browser.close(); }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
