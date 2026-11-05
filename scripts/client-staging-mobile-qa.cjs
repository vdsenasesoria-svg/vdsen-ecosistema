'use strict';
// T547: mobile QA of the Client on STAGING (synthetic seed) at 320 / 360 / 375 / 390 / 414 / 430 px: no horizontal page overflow, no element
// painted beyond the right edge (outside intentional scroll containers), set-row controls >= 44px, on every tab + the open set row.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 node scripts/client-staging-mobile-qa.cjs [--shots dir] [--out file]
const L = require('./client-staging-real-lib.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const shots = arg('shots', null), outFile = arg('out', null), WIDTHS = [320, 360, 375, 390, 414, 430];
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const probe = () => {
  const W = window.innerWidth, over = [];
  const scrollers = el => { for (let n = el; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if ((o === 'auto' || o === 'scroll') && n !== document.documentElement) return true; } return false; };
  document.querySelectorAll('body *').forEach(el => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' && el.offsetParent === null && false) return; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return; if (r.right > W + 1 && !scrollers(el)) over.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 24)) + ' r=' + Math.round(r.right)); });
  return { W, sw: document.documentElement.scrollWidth, bodySw: document.body.scrollWidth, over: over.slice(0, 5), nOver: over.length };
};
(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const seed = await L.H.seed(); const K = { athlete: seed.athlete }; const browser = await L.B.launch();
  try {
    for (const W of WIDTHS) {
      const { ctx, p, errs } = await L.openReal(browser, { W, Hh: 800, K, expressOff: true });
      const tabs = [['home', '#nb0'], ['training', '#nb1'], ['nutrition', '#nb2'], ['checkin', '#nb3'], ['profile', '#nb4']];
      for (const [name, sel] of tabs) {
        await p.click(sel); await p.waitForTimeout(600); const m = await p.evaluate(probe);
        check('W' + W + '_' + name + '_NO_HORIZONTAL_OVERFLOW', m.sw <= m.W && m.bodySw <= m.W && m.nOver === 0, JSON.stringify(m));
        if (shots) await p.screenshot({ path: shots + '/m' + W + '-' + name + '.png' });
      }
      await p.click('#nb1'); await p.waitForTimeout(500);
      const setOk = await p.evaluate(() => { const i = document.querySelector('[id^="carga_log_"]'); if (!i) return null; i.scrollIntoView({ block: 'center' }); const row = i.closest('[id^="setrow_"]') || document.body; const small = [...row.querySelectorAll('button, input:not([type=hidden])')].map(b => { const r = b.getBoundingClientRect(); return [(b.id || b.textContent || '').trim().slice(0, 14), Math.round(r.width), Math.round(r.height)]; }).filter(x => x[1] && x[2] && (x[2] < 44 || x[1] < 44)); return small; });
      check('W' + W + '_SET_ROW_TOUCH_TARGETS_44', Array.isArray(setOk) && setOk.length === 0, JSON.stringify(setOk));
      const m2 = await p.evaluate(probe); check('W' + W + '_SET_ROW_NO_HORIZONTAL_OVERFLOW', m2.sw <= m2.W && m2.nOver === 0, JSON.stringify(m2));
      if (shots) await p.screenshot({ path: shots + '/m' + W + '-setrow.png' });
      check('W' + W + '_NO_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    }
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 240)); }
  finally { await browser.close(); console.log('CLEANUP', JSON.stringify(await seed.cleanup())); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true, widths: WIDTHS }; if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
