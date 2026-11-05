#!/usr/bin/env node
'use strict';
// T576: stress scenario on the REAL client (staging, synthetic account): a day with 12 exercises, a 140-character exercise name made of long words, a long
// Coach technique/superset label and a long athlete note. Audits overflow / clipped content / tap targets at 320/390/430. Operator IAM edits ONLY the synthetic plan.
//   NODE_PATH=<node_modules with playwright> VDSEN_CHROMIUM=<chrome.exe> node scripts/t576-stress-capture.cjs --label before|after [--root <tree>]
const fs = require('node:fs'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs'), L = require('./lib/firestore-rest-db.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const label = arg('label', 'after'), root = path.resolve(arg('root', path.join(__dirname, '..'))), out = path.join(__dirname, '..', 'docs', 't576-shots', 'stress-' + label);
const LONG = 'Press inclinado unilateral con mancuernas semisupinadas agarre neutro pausa isométrica excéntrico controlado tempo 3-1-1-0 variante coach especial';
(async () => {
  const seed = await H.seed(); fs.mkdirSync(out, { recursive: true });
  const rep = { label, screens: {} }; const browser = await B.launch();
  try {
    const cur = await L.http('GET', L.DOCS + '/plans/' + seed.planId, L.gToken(), undefined, L.adminHdr); const plan = L.decDoc(cur.b);
    const day0 = plan.days[0], base = day0.exercises[0];
    day0.exercises = Array.from({ length: 12 }, (_, i) => Object.assign({}, base, { prescriptionExerciseId: 'pid-stress-' + i, exerciseName: i === 0 ? LONG : 'Ejercicio de volumen ' + (i + 1) + (i === 3 ? ' con nombre bastante largo para forzar el ajuste' : ''),
      technique: i === 1 ? 'myoreps con una descripción extensa de la técnica que el coach escribió' : base.technique, sets: base.sets.concat(i % 3 === 0 ? [Object.assign({}, base.sets[0], { setIndex: base.sets.length })] : []) }));
    const up = await L.http('PATCH', L.DOCS + '/plans/' + seed.planId + '?updateMask.fieldPaths=days', L.gToken(), { fields: { days: L.enc(plan.days) } }, L.adminHdr);
    if (!L.ok(up)) throw new Error('plan edit ' + up.s);
    for (const W of [320, 390, 430]) {
      const ctx = await B.newCtx(browser, { width: W, height: 844, root, transform: x => H.buildStagingHtml(x) }); const p = await ctx.newPage();
      await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail'); await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
      await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2300); if (await p.$('#wnModal')) await p.click('#wnModal button');
      for (const [id, n] of [['nb0', 'home'], ['nb1', 'training']]) {
        await p.click('#' + id); await p.waitForTimeout(800); await p.evaluate(() => document.querySelectorAll('*').forEach(e => { if (e.scrollTop > 0) e.scrollTop = 0; })); await p.waitForTimeout(200);
        await p.screenshot({ path: path.join(out, W + '-' + n + '.png') });
        rep.screens[W + '-' + n] = await p.evaluate(() => {
          const iw = innerWidth, bad = [], clipped = [], small = [];
          const inScroller = e => { for (let x = e.parentElement; x; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
          document.querySelectorAll('body *').forEach(e => {
            const r = e.getBoundingClientRect(); if (!r.width || !r.height) return; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return;
            if (r.right > iw + 1 && !inScroller(e)) bad.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
            if (e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis' && !inScroller(e) && (e.textContent || '').trim().length > 8) clipped.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]);
            if ((e.tagName === 'BUTTON' || e.tagName === 'A') && (r.height < 40 || r.width < 40) && r.top >= 0 && r.top < innerHeight) small.push(String(e.className).split(' ')[0] + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
          });
          return { overflow: Array.from(new Set(bad)).slice(0, 6), clippedText: Array.from(new Set(clipped)).slice(0, 6), smallTargets: Array.from(new Set(small)).slice(0, 6), sw: document.documentElement.scrollWidth, iw };
        });
      }
      await ctx.close();
    }
  } finally { await browser.close(); try { console.log('cleanup', JSON.stringify(await seed.cleanup())); } catch (e) { console.log('cleanup failed', e.message); } }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(rep, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(rep.screens).map(([k, v]) => [k, { overflow: v.overflow.length, clipped: v.clippedText.length, small: v.smallTargets.length, wide: v.sw > v.iw + 1 }]))));
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
