#!/usr/bin/env node
'use strict';
// T576: real-browser regression of the unsaved-set DRAFT behaviour against Firebase STAGING (synthetic account, deleted at the end).
//   NODE_PATH=<node_modules with playwright> VDSEN_CHROMIUM=<chrome.exe> node scripts/t576-draft-e2e.cjs [--root <tree>]
// Proves: typed-but-unsaved carga/reps survive a tab switch; after SAVING they persist in Firestore exactly as typed (execution is never altered by the draft
// layer); a saved set does not get a stale draft back; a different athlete session starts with no drafts (logout clears).
const fs = require('node:fs'), path = require('node:path');
const H = require('./client-staging-harness.cjs'), B = require('./client-browser-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(arg('root', path.join(__dirname, '..')));
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || null }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' - ' + note : '')); };
async function restGet(cfg, email, password, docPath) {
  const j = await (await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json();
  const d = await fetch('https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/' + docPath, { headers: { authorization: 'Bearer ' + j.idToken } });
  return d.status === 200 ? d.json() : null;
}
(async () => {
  const cfg = H.stagingConfig(), seed = await H.seed(), browser = await B.launch();
  try {
    const ctx = await B.newCtx(browser, { width: 390, height: 844, root, transform: h => H.buildStagingHtml(h) });
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.goto(B.APP + '/'); await p.waitForSelector('#liEmail');
    await p.fill('#liEmail', seed.athlete.email); await p.fill('#liPass', seed.athlete.password); await p.click('.login-btn');
    await p.waitForSelector('#scrApp.on', { timeout: 30000 }); await p.waitForTimeout(2300);
    if (await p.$('#wnModal')) await p.click('#wnModal button');
    await p.click('#nb1'); await p.waitForTimeout(900);
    const vals = () => p.evaluate(() => ({ c: (document.querySelector('input[id^="carga_"]') || {}).value, r: (document.querySelector('input[id^="reps_"]') || {}).value }));
    await p.fill('input[id^="carga_"] >> nth=0', '72.5'); await p.fill('input[id^="reps_"] >> nth=0', '9');
    await p.click('#nb2'); await p.waitForTimeout(500); await p.click('#nb1'); await p.waitForTimeout(900);
    let v = await vals();
    check('D01 unsaved carga/reps survive a tab switch', v.c === '72.5' && v.r === '9', JSON.stringify(v));
    await p.click('#nb4'); await p.waitForTimeout(400); await p.click('#nb0'); await p.waitForTimeout(400); await p.click('#nb1'); await p.waitForTimeout(900);
    v = await vals(); check('D02 ...and several consecutive switches', v.c === '72.5' && v.r === '9', JSON.stringify(v));
    await p.click('button:has-text("2 reps")').catch(() => p.click('.rir-btn >> nth=2').catch(() => {}));
    await p.click('.set-save-primary >> nth=0'); await p.waitForTimeout(2500);
    for (let i = 0; i < 6; i++) { if (!(await p.isVisible('#restTimerOverlay'))) break; const b = await p.$('#restTimerOverlay button:has-text("CONTINUAR")'); if (b) await b.click().catch(() => {}); await p.waitForTimeout(500); }
    const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + seed.athlete.uid + '/mesos/' + seed.planId);
    const e = d && d.fields && d.fields.entries && d.fields.entries.mapValue.fields, s0 = e && e.log_1_0_0_s0 && e.log_1_0_0_s0.mapValue.fields;
    check('D03 SAVING persists exactly the typed values (draft layer never alters execution)', s0 && String(s0.carga.stringValue || s0.carga.doubleValue || s0.carga.integerValue) === '72.5' && String(s0.reps.stringValue || s0.reps.integerValue) === '9', s0 ? 'carga=' + (s0.carga.stringValue || s0.carga.doubleValue) + ' reps=' + (s0.reps.stringValue || s0.reps.integerValue) : 'no log_1_0_0_s0');
    await p.click('#nb0'); await p.waitForTimeout(400); await p.click('#nb1'); await p.waitForTimeout(900);
    v = await vals(); check('D04 a SAVED set does not get its old draft back into the next set input', v.c !== '72.5' || v.r !== '9', JSON.stringify(v));
    // logout clears drafts: type, logout, login again, drafts must be gone
    await p.fill('input[id^="carga_"] >> nth=0', '11'); await p.evaluate(() => doLogout()); await p.waitForSelector('#liEmail', { timeout: 15000 });
    const cleared = await p.evaluate(() => Object.keys(_SET_DRAFTS).length === 0); check('D05 logout drops every draft', cleared);
    check('D06 no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  } finally {
    await browser.close(); try { console.log('cleanup', JSON.stringify(await seed.cleanup())); } catch (e) { console.log('cleanup failed', e.message); }
    const out = { at: new Date().toISOString(), pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results };
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 't576-draft-e2e-results.json'), JSON.stringify(out, null, 2)); console.log('PASS ' + out.pass + ' FAIL ' + out.fail);
    process.exitCode = out.fail ? 1 : 0;
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
