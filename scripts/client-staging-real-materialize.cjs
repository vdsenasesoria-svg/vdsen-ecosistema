'use strict';
// T545: progression side-effect audit after the real staging session. Drives the REAL owner-Coach page (STAGING) to the client's monitor tab,
// which runs the existing owner-Coach PENDING materializer, then reads the evidence back. NEVER creates APPLIED (NUMERIC_APPLY_ENABLED=false).
const L = require('./client-staging-real-lib.cjs'); const { restGet, val } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
(async () => {
  const { cfg, K } = L.loadKeep(); const browser = await L.B.launch();
  try {
    const mesoPath = 'logs/' + K.athlete.uid + '/mesos/' + K.planId;
    const before = await restGet(cfg, K.coach.email, K.coach.password, mesoPath);
    const pa0 = before && before.fields && before.fields.progressionApplications ? val(before.fields.progressionApplications) : {};
    check('NO_PROGRESSION_APPLICATIONS_BEFORE_COACH_VIEW', Object.keys(pa0).length === 0, 'records=' + Object.keys(pa0).length);
    const ctx = await L.B.newCtx(browser, { width: 1100, height: 900, transform: h => L.H.buildStagingHtml(h) }); const c = await ctx.newPage(); const errs = []; c.on('pageerror', e => errs.push(e.message));
    await c.goto(L.B.APP + '/vdsen-coach.html'); await c.waitForSelector('#loginEmail'); await c.fill('#loginEmail', K.coach.email); await c.fill('#loginPass', K.coach.password); await c.click('#loginBtn');
    await c.waitForTimeout(4000); await c.reload(); await c.waitForTimeout(2500); errs.length = 0;
    await c.waitForSelector('[data-section="crearPlan"]', { state: 'visible', timeout: 30000 });
    await c.evaluate(id => showClientDetail(id, { tab: 'monitor' }), K.athlete.uid); await c.waitForTimeout(6000);
    const after = await restGet(cfg, K.coach.email, K.coach.password, mesoPath);
    const pa = after && after.fields && after.fields.progressionApplications ? val(after.fields.progressionApplications) : {};
    const states = Object.values(pa).map(r => r && r.state); const count = k => states.filter(s => s === k).length;
    console.log('STATES', JSON.stringify({ total: states.length, PENDING: count('PENDING'), APPLIED: count('APPLIED'), other: states.filter(s => s !== 'PENDING' && s !== 'APPLIED').length }));
    const reasons = [...new Set(Object.values(pa).map(r => r && r.reasonCode).filter(Boolean))];
    check('OWNER_COACH_PATH_MATERIALIZED_RECORDS_WITH_EXPLICIT_STATE', states.length > 0 && states.every(s => s === 'PENDING' || s === 'REJECTED' || s === 'STALE'), 'total=' + states.length + ' PENDING=' + count('PENDING') + ' REJECTED=' + count('REJECTED') + ' reasons=' + reasons.join('|'));
    console.log('PENDING_CREATED', count('PENDING') > 0 ? 'YES' : 'NO', 'reasons=' + reasons.join('|'));
    check('NO_APPLIED_CREATED', count('APPLIED') === 0);
    const ov = Object.values(pa).filter(r => r && (r.overlay || r.appliedValue !== undefined)).length; check('NO_OVERLAY_OR_APPLIED_VALUE_ON_RECORDS', ov === 0, 'withOverlayish=' + ov);
    const root = await restGet(cfg, K.coach.email, K.coach.password, 'logs/' + K.athlete.uid); const hasOverlays = !!(root && root.fields && root.fields.nextExposureOverlays) || !!(after && after.fields && after.fields.nextExposureOverlays);
    check('NO_NEXT_EXPOSURE_OVERLAYS', !hasOverlays);
    const sample = Object.values(pa)[0] || {}; check('PENDING_SAMPLE_SHAPE', !!sample.state, Object.keys(sample).slice(0, 10).join(','));
    check('NO_COACH_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 240)); }
  finally { await browser.close(); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id) }; if (arg('out', null)) require('node:fs').writeFileSync(arg('out'), JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
