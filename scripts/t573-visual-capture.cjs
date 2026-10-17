#!/usr/bin/env node
'use strict';
// T573: visual capture + structural checks of the REAL client against Firebase STAGING with synthetic accounts.
//   NODE_PATH=<node_modules with playwright> VDSEN_CHROMIUM=<chrome.exe> node scripts/t573-visual-capture.cjs --label before|after [--widths 320,390,430] [--light]
// Accounts live in a keep file OUTSIDE the repo (default: OS temp) so repeated runs do not hit Auth sign-up rate limits; pass --destroy to delete everything.
// Writes docs/t573-shots/<label>/<width>-<name>.png and docs/t573-shots/<label>/report.json. Never touches production.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./client-staging-harness.cjs');
const B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const label = arg('label', 'after'), widths = arg('widths', '390').split(',').map(Number), light = process.argv.includes('--light'), destroy = process.argv.includes('--destroy');
const KEEP = process.env.VDSEN_UI_KEEP || path.join(os.tmpdir(), 'vdsen-t573-ui-keep.json');
const out = path.join(__dirname, '..', 'docs', 't573-shots', label + (light ? '-light' : ''));
const report = { label, light, project: null, widths: {}, at: new Date().toISOString() };

(async () => {
  if (destroy) { console.log(JSON.stringify(await H.destroyKept(KEEP))); return; }
  const cfg = H.stagingConfig(); report.project = cfg.projectId;
  const seed = await H.seed({ keepFile: KEEP });
  const browser = await B.launch();
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const W of widths) {
      const ctx = await B.newCtx(browser, { width: W, height: 844, transform: h => H.buildStagingHtml(h) });
      const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
      const R = report.widths[W] = { overflow: {}, smallTargets: {}, errors };
      const shot = n => p.screenshot({ path: path.join(out, W + '-' + n + '.png') });
      const audit = async n => {
        const o = await p.evaluate(() => {
          const iw = window.innerWidth, bad = [], small = [];
          document.querySelectorAll('body *').forEach(e => {
            const r = e.getBoundingClientRect(); if (!r.width || !r.height) return;
            const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return;
            if (r.right > iw + 1 && !(function(n){ for (var x = n.parentElement; x; x = x.parentElement) { var o = getComputedStyle(x).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; })(e)) bad.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]));
            if ((e.tagName === 'BUTTON' || e.tagName === 'A' || e.getAttribute('role') === 'button') && (r.height < 40 || r.width < 40) && r.top >= 0 && r.top < innerHeight) small.push((e.id ? '#' + e.id : e.className ? String(e.className).split(' ')[0] : e.tagName) + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
          });
          return { bad: Array.from(new Set(bad)).slice(0, 8), small: Array.from(new Set(small)).slice(0, 12), sw: document.documentElement.scrollWidth, iw };
        });
        R.overflow[n] = o.bad.length === 0 && o.sw <= o.iw + 1; if (!R.overflow[n]) R.overflow[n + '_detail'] = o;
        R.smallTargets[n] = o.small;
      };
      await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
      if (light) await p.evaluate(() => document.documentElement.classList.add('light-mode'));
      await shot('01-login'); await audit('login');
      await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
      await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2500);
      if (await p.$('#wnModal')) { await shot('02-firstrun'); await p.click('#wnModal button'); }
      await p.waitForTimeout(400);
      const tabs = [['nb0', '10-home'], ['nb1', '20-training'], ['nb2', '30-nutrition'], ['nb3', '40-checkin'], ['nb4', '50-profile']];
      for (const [id, name] of tabs) {
        await p.click('#' + id); await p.waitForTimeout(700);
        await shot(name); await audit(name);
        const sc = await p.evaluate(() => { const els = Array.from(document.querySelectorAll('.scroll')).filter(e => e.offsetParent !== null); const e = els[0]; if (!e) return 0; e.scrollTop = Math.round(e.clientHeight * 0.9); return e.scrollTop; });
        if (sc) { await p.waitForTimeout(250); await shot(name + '-b'); }
      }
      // training: open the first exercise card if present
      await p.click('#nb1'); await p.waitForTimeout(500);
      await p.evaluate(() => { const e = Array.from(document.querySelectorAll('.scroll')).filter(x => x.offsetParent !== null)[0]; if (e) e.scrollTop = 0; });
      await ctx.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(Object.fromEntries(Object.entries(report.widths).map(([w, r]) => [w, { overflow: Object.entries(r.overflow).filter(([k, v]) => v === false).map(([k]) => k), pageErrors: r.errors.length }]))));
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
