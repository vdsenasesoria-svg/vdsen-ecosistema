'use strict';
// T545: shared helpers for the real-plan (Ayrton staging clone) harnesses. STAGING ONLY; credentials come from a file OUTSIDE the repo.
const fs = require('node:fs'), path = require('node:path');
const B = require('./client-browser-lib.cjs'), H = require('./client-staging-harness.cjs');
function loadKeep() {
  const f = process.env.VDSEN_AYRTON_KEEP; if (!f) throw new Error('VDSEN_AYRTON_KEEP (credentials file outside the repo) is required');
  const cfg = H.stagingConfig(), K = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (K.project !== cfg.projectId || cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not the staging project');
  return { cfg, K };
}
// T556: detailed mode (Express OFF) is the app default. expressOff: true -> force detailed, false -> force Express (stored '0'), undefined -> the app default (detailed)
async function openReal(browser, { W = 390, Hh = 844, light = false, expressOff, K } = {}) {
  const ctx = await B.newCtx(browser, { width: W, height: Hh, transform: h => H.buildStagingHtml(h) });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  if (expressOff !== undefined) await ctx.addInitScript(v => { try { localStorage.setItem('vdsen_express_off', v); } catch (e) { /* storage unavailable */ } }, expressOff ? '1' : '0');
  await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
  await p.fill('#liEmail', K.athlete.email); await p.fill('#liPass', K.athlete.password); await p.click('.login-btn');
  await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(2500);
  await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); await p.waitForTimeout(400);
  if (light) await p.evaluate(() => document.documentElement.classList.add('light-mode'));
  return { ctx, p, errs };
}
module.exports = { loadKeep, openReal, B, H, fs, path };
