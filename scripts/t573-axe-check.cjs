#!/usr/bin/env node
'use strict';
// T573: automated accessibility check (axe-core, WCAG 2 A/AA) of the REAL client on staging with synthetic accounts.
//   node scripts/t573-axe-check.cjs --root <tree> --label before|after [--light]
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('root', path.join(__dirname, '..'))), label = arg('label', 'after'), light = process.argv.includes('--light');
const KEEP = process.env.VDSEN_UI_KEEP || path.join(os.tmpdir(), 'vdsen-t573-ui-keep.json');
const axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
(async () => {
  const seed = await H.seed({ keepFile: KEEP }), browser = await B.launch();
  const out = { label: label + (light ? '-light' : ''), tabs: {} };
  try {
    const ctx = await B.newCtx(browser, { width: 390, height: 844, root, transform: h => H.buildStagingHtml(h) });
    const p = await ctx.newPage();
    await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail'); if (light) await p.evaluate(() => document.documentElement.classList.add('light-mode'));
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2500);
    if (await p.$('#wnModal')) await p.click('#wnModal button');
    for (const [id, name] of [['nb0', 'home'], ['nb1', 'training'], ['nb2', 'nutrition'], ['nb3', 'checkin'], ['nb4', 'profile']]) {
      await p.click('#' + id); await p.waitForTimeout(900);
      await p.evaluate(axeSrc);
      const r = await p.evaluate(async () => { const res = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }); return res.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, detail: v.nodes.slice(0, 6).map(n => ({ t: n.target.join(' '), s: (n.any[0] && n.any[0].data && n.any[0].data.contrastRatio) || null, fg: n.any[0] && n.any[0].data && n.any[0].data.fgColor, bg: n.any[0] && n.any[0].data.bgColor })) })); });
      out.tabs[name] = r;
    }
    const total = {}; Object.values(out.tabs).flat().forEach(v => { total[v.id + ':' + v.impact] = (total[v.id + ':' + v.impact] || 0) + v.nodes; });
    out.totals = total;
    fs.mkdirSync(path.join(__dirname, '..', 'docs', 't573-a11y'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 't573-a11y', out.label + '.json'), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(total));
  } finally { await browser.close(); }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
