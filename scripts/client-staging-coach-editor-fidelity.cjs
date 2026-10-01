'use strict';
// T547: Coach EDITOR round trip on STAGING through the real Coach page, on a disposable SYNTHETIC clone of an Ayrton-shaped plan
// (7 days / 32 exercises / 80 sets with heterogeneous per-set RIR, notes, tempo): open the editor, save with NO intentional change,
// compare the stored prescription before / after; then make ONE real change to ONE set and verify only that set moved, updatedAt moved,
// createdAt / clientId / coachId did not. Also: OTHER Coach and the ATHLETE are denied by the (staging) rules. Never touches the human account.
// Needs the plan source file: VDSEN_AYRTON_PLAN_FILE (an exported plan JSON, outside the repo). Usage:
//   NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_AYRTON_PLAN_FILE=<file> node scripts/client-staging-coach-editor-fidelity.cjs [--out file] [--shots dir]
const fs = require('node:fs'), crypto = require('node:crypto');
const B = require('./client-browser-lib.cjs'), H = require('./client-staging-harness.cjs');
const { val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const outFile = arg('out', null), shots = arg('shots', null);
let AUTH_, cfg_, FS_, PLAN_; const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : undefined;
async function call(m, u, t, b) { const r = await fetch(u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}), body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch (e) { /* */ } return { s: r.status, b: j }; }
const ok = r => r.s >= 200 && r.s < 300;
const diffs = (a, b, p, out) => { if (a && typeof a === 'object') { if (!b || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) { out.push(p + ' type'); return; } for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (!(k in a)) out.push(p + '.' + k + ' added'); else if (!(k in b)) out.push(p + '.' + k + ' removed'); else diffs(a[k], b[k], p + '.' + k, out); } } else if (a !== b) out.push(p + ' ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b)); return out; };
(async () => {
  const cfg = H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents', AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
  const SRCF = process.env.VDSEN_AYRTON_PLAN_FILE; if (!SRCF) throw new Error('VDSEN_AYRTON_PLAN_FILE (exported plan JSON outside the repo) is required');
  const SRC = JSON.parse(fs.readFileSync(SRCF, 'utf8')).data;
  const seed = await H.seed({ noPlan: true }); let other = null; const browser = await B.launch();
  try {
    const si = await call('POST', AUTH + 'signInWithPassword?key=' + cfg.apiKey, null, { email: seed.coach.email, password: seed.coach.password, returnSecureToken: true }); const T = si.b.idToken;
    const ai = await call('POST', AUTH + 'signInWithPassword?key=' + cfg.apiKey, null, { email: seed.athlete.email, password: seed.athlete.password, returnSecureToken: true }); const TA = ai.b.idToken;
    const oe = 'coach2.' + crypto.randomBytes(3).toString('hex') + '@staging-ui.invalid', op = crypto.randomBytes(12).toString('base64url') + 'aA1!';
    const os = await call('POST', AUTH + 'signUp?key=' + cfg.apiKey, null, { email: oe, password: op, returnSecureToken: true }); other = { token: os.b.idToken };
    await call('PATCH', FS + '/coaches/' + os.b.localId, other.token, { fields: enc({ role: 'coach', displayName: 'Other coach (synthetic)', email: oe }).mapValue.fields });
    // ---- synthetic Ayrton-shaped plan (active), created by the owner coach
    const planId = 'plan-edit-' + crypto.randomBytes(3).toString('hex'); AUTH_ = AUTH; cfg_ = cfg; FS_ = FS; PLAN_ = planId; const data = JSON.parse(JSON.stringify(SRC)); data.clientId = seed.athlete.uid; data.coachId = seed.coach.uid; data.updatedAt = data.createdAt;
    const c = await call('PATCH', FS + '/plans/' + planId + '?currentDocument.exists=false', T, { fields: enc(data).mapValue.fields }); check('SYNTHETIC_AYRTON_SHAPED_PLAN_CREATED', ok(c), 'status ' + c.s);
    await call('PATCH', FS + '/clients/' + seed.athlete.uid + '?updateMask.fieldPaths=activePlanId', T, { fields: { activePlanId: { stringValue: planId } } });
    const readPlan = async () => { const r = await call('GET', FS + '/plans/' + planId, T); return r.b && r.b.fields ? dec({ mapValue: { fields: r.b.fields } }) : null; };
    const before = await readPlan(); const nEx = before.days.reduce((a, d) => a + d.exercises.length, 0), nSets = before.days.reduce((a, d) => a + d.exercises.reduce((x, e) => x + e.sets.length, 0), 0);
    check('SHAPE_7_32_80', before.days.length === 7 && nEx === 32 && nSets === 80, before.days.length + '/' + nEx + '/' + nSets);
    const hetero = before.days.flatMap(d => d.exercises).filter(e => new Set(e.sets.map(s => s.rirTarget)).size > 1).length; check('FIXTURE_HAS_HETEROGENEOUS_PER_SET_RIR', hetero >= 5, 'exercises with differing per-set RIR: ' + hetero);
    // ---- Coach page
    const ctx = await B.newCtx(browser, { width: 1280, height: 1000, transform: h => H.buildStagingHtml(h) }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B.APP + '/vdsen-coach.html'); await p.waitForSelector('#loginEmail'); await p.fill('#loginEmail', seed.coach.email); await p.fill('#loginPass', seed.coach.password); await p.click('#loginBtn');
    await p.waitForTimeout(4000); await p.reload(); await p.waitForTimeout(2500); errs.length = 0;
    await p.waitForSelector('[data-section="crearPlan"]', { state: 'visible', timeout: 30000 });
    await p.evaluate(id => showClientDetail(id, { tab: 'plan' }), seed.athlete.uid); await p.waitForTimeout(2500);
    const opened = await p.evaluate(() => { const b = document.querySelector('[onclick*="toggleTrainingEditor"]'); if (b) { b.click(); return true; } return false; }); await p.waitForTimeout(800);
    const rows = await p.evaluate(() => document.querySelectorAll('.exrow-item').length); check('EDITOR_OPENS_WITH_ALL_32_ROWS', opened && rows === 32, 'opened=' + opened + ' rows=' + rows);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await p.screenshot({ path: shots + '/coach-editor.png', fullPage: false }); }
    // ---- save with NO intentional change
    await p.evaluate(() => { window.__sv = saveTrainingPlan(); }); await p.waitForTimeout(4500);
    const after = await readPlan();
    const dd = diffs(before.days, after.days, '.days', []); check('NO_CHANGE_SAVE_0_UNEXPECTED_PRESCRIPTION_DIFFS', dd.length === 0, dd.length + ' diffs ' + dd.slice(0, 6).join(' | '));
    const pidsB = before.days.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId)), pidsA = after.days.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId));
    check('32_PIDS_UNCHANGED_SAME_ORDER', JSON.stringify(pidsB) === JSON.stringify(pidsA) && new Set(pidsA).size === 32);
    check('80_SETS_UNCHANGED', after.days.reduce((a, d) => a + d.exercises.reduce((x, e) => x + e.sets.length, 0), 0) === 80);
    check('HETEROGENEOUS_RIR_RETAINED_EXACTLY', JSON.stringify(before.days.map(d => d.exercises.map(e => e.sets.map(s => s.rirTarget)))) === JSON.stringify(after.days.map(d => d.exercises.map(e => e.sets.map(s => s.rirTarget)))));
    check('NO_CHANGE_SAVE_DOES_NOT_BUMP_UPDATEDAT_OR_CREATEDAT', after.updatedAt === before.updatedAt && after.createdAt === before.createdAt, before.updatedAt + ' -> ' + after.updatedAt);
    check('OWNERSHIP_UNCHANGED', after.clientId === seed.athlete.uid && after.coachId === seed.coach.uid && after.status === 'active');
    // ---- ONE real change to ONE set (day 0, exercise 0, set 3): RIR 2 -> 1 via the per-set editor control
    const changed = await p.evaluate(() => { const row = document.querySelector('#exrow_0_0'); const sets = row && row.querySelectorAll('.exset'); if (!sets || sets.length < 3) return { ok: false, n: sets ? sets.length : -1 }; const inp = sets[2].querySelector('[data-sf="rirTarget"]'); inp.value = '1'; inp.dispatchEvent(new Event('input', { bubbles: true })); return { ok: true, n: sets.length }; });
    check('PER_SET_EDITOR_CONTROLS_EXIST', changed.ok, JSON.stringify(changed));
    if (changed.ok) {
      await p.evaluate(() => { window.__sv2 = saveTrainingPlan(); }); await p.waitForTimeout(4500);
      const a2 = await readPlan(); const d2 = diffs(before.days, a2.days, '.days', []);
      check('ONE_SET_EDIT_CHANGES_ONLY_THAT_SET', d2.length === 1 && /\.days\.0\.exercises\.0\.sets\.2\.rirTarget 2 -> 1/.test(d2[0]), d2.slice(0, 4).join(' | '));
      check('PRESCRIPTION_EDIT_BUMPS_UPDATEDAT_ISO_AND_KEEPS_CREATEDAT', /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(a2.updatedAt) && Date.parse(a2.updatedAt) > Date.parse(before.updatedAt) && a2.createdAt === before.createdAt, before.updatedAt + ' -> ' + a2.updatedAt);
      check('OWNERSHIP_STILL_UNCHANGED_AFTER_EDIT', a2.clientId === seed.athlete.uid && a2.coachId === seed.coach.uid);
    }
    // ---- rules on staging: other coach / athlete denied
    const o1 = await call('PATCH', FS + '/plans/' + planId + '?updateMask.fieldPaths=weeks', other.token, { fields: { weeks: { integerValue: '9' } } });
    const a1 = await call('PATCH', FS + '/plans/' + planId + '?updateMask.fieldPaths=weeks', TA, { fields: { weeks: { integerValue: '9' } } });
    check('OTHER_COACH_DENIED', o1.s === 403, 'status ' + o1.s); check('ATHLETE_DENIED', a1.s === 403, 'status ' + a1.s);
    const adopt = await call('PATCH', FS + '/plans/' + planId + '?updateMask.fieldPaths=clientId', T, { fields: { clientId: { stringValue: 'someone-else-' + planId } } }); check('OWNER_CANNOT_ADOPT_INTO_UNOWNED_CLIENT', adopt.s === 403, 'status ' + adopt.s);
    const hand = await call('PATCH', FS + '/plans/' + planId + '?updateMask.fieldPaths=coachId', T, { fields: { coachId: { stringValue: 'someone-else' } } }); check('OWNER_CANNOT_CHANGE_COACHID', hand.s === 403, 'status ' + hand.s);
    check('NO_COACH_PAGE_ERRORS', errs.length === 0, errs.slice(0, 2).join(' | ')); await ctx.close();
    // cleanup the extra coach doc/user created here (the harness cleanup handles the seeded coach/athlete and every plan owned by that coach)
    await call('DELETE', FS + '/coaches/' + os.b.localId, other.token); await call('POST', AUTH + 'delete?key=' + cfg.apiKey, null, { idToken: other.token });
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 260)); }
  finally { await browser.close(); try { const tk = (await call('POST', AUTH_ + 'signInWithPassword?key=' + cfg_.apiKey, null, { email: seed.coach.email, password: seed.coach.password, returnSecureToken: true })).b.idToken; const u = FS_ + '/plans/' + PLAN_; await call('PATCH', u + '?updateMask.fieldPaths=status', tk, { fields: { status: { stringValue: 'archived' } } }); console.log('PLAN_DELETE', (await call('DELETE', u, tk)).s); } catch (e) { console.log('PLAN_DELETE_FAILED', e.message); }
    console.log('CLEANUP ' + JSON.stringify(await seed.cleanup())); const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0); }
})();
