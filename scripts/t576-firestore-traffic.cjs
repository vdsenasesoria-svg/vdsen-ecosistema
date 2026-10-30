#!/usr/bin/env node
'use strict';
// T576: Firestore traffic of the REAL client (staging, synthetic account) during startup and tab navigation: requests per phase + listener count.
//   node scripts/t576-firestore-traffic.cjs [--root <tree>] [--label x]
const fs = require('node:fs'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('root', path.join(__dirname, '..'))), label = arg('label', 'after');
(async () => {
  const seed = await H.seed(), browser = await B.launch(), res = { label };
  try {
    const ctx = await B.newCtx(browser, { width: 390, height: 844, root, transform: x => H.buildStagingHtml(x) }); const p = await ctx.newPage();
    let bucket = 'boot'; const counts = {}; const bump = (k) => { counts[bucket] = counts[bucket] || {}; counts[bucket][k] = (counts[bucket][k] || 0) + 1; };
    p.on('request', r => { const u = r.url(); if (/firestore\.googleapis\.com/.test(u)) bump(/Listen/.test(u) ? 'listen' : /Write/.test(u) ? 'write' : /documents/.test(u) ? 'rest-doc' : 'other'); else if (/identitytoolkit|securetoken/.test(u)) bump('auth'); });
    await p.addInitScript(() => { window.__snap = 0; });
    await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail'); await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password);
    bucket = 'login'; await p.click('.login-btn'); await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(3500); if (await p.$('#wnModal')) await p.click('#wnModal button');
    for (const [id, n] of [['nb1', 'tab-training'], ['nb2', 'tab-nutrition'], ['nb3', 'tab-checkin'], ['nb4', 'tab-profile'], ['nb0', 'tab-home'], ['nb1', 'tab-training-again'], ['nb0', 'tab-home-again']]) { bucket = n; await p.click('#' + id); await p.waitForTimeout(1200); }
    res.requests = counts;
    res.totalNavRequests = Object.entries(counts).filter(([k]) => k.startsWith('tab-')).reduce((a, [, v]) => a + Object.values(v).reduce((x, y) => x + y, 0), 0);
    await ctx.close();
  } finally { await browser.close(); try { await seed.cleanup(); } catch (_) { /* ignore */ } }
  fs.mkdirSync(path.join(__dirname, '..', 'docs', 't576-perf'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '..', 'docs', 't576-perf', 'firestore-traffic-' + label + '.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res));
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
