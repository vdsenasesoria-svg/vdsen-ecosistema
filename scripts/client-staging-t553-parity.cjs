'use strict';
// T553 STAGING parity (synthetic coach / athlete only; the human Ayrton account is never touched): the PID-only / plan-bound previous-data contract against the
// DEPLOYED staging rules + the real client build, with an Ayrton-shaped plan (VDSEN_AYRTON_PLAN_FILE, outside the repo; used as a read-only template).
//  A  same plan + same PID + week-1 evidence            -> ÚLTIMA SEMANA + USAR CARGA/REPS (control)
//  B  plan B shares every PID with plan A (A has evidence) -> no reference, no reuse, week 1, plan A evidence untouched
//  C  LEGACY_UNBOUND root log (no planId) with week-1 evidence for the same PID, plan B active, no meso -> not attached: week 1, no reference; root doc untouched
//  D  same exercise NAME, wrong PID in the evidence       -> no reference
//  E  same POSITION, wrong PID in the evidence            -> no reference for the exercise at that position
//  F  normal execution after the unbound legacy root (C) -> a set saves to the plan-bound meso doc, survives reload, root doc NOT rewritten / stamped
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_AYRTON_PLAN_FILE=<json outside repo> node scripts/client-staging-t553-parity.cjs [--out file]
const fs = require('node:fs'), crypto = require('node:crypto');
const L = require('./client-staging-real-lib.cjs'); const { restGet, val, stable } = require('./client-staging-performance.cjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const outFile = arg('out', null); const results = []; const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || '' }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); };
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
async function call(m, u, t, b) { const r = await fetch(u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, t ? { authorization: 'Bearer ' + t } : {}), body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j = null; try { j = JSON.parse(x); } catch (e) { /* non-json */ } return { s: r.status, b: j }; }

(async () => {
  const cfg = L.H.stagingConfig(); if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
  const SRCF = process.env.VDSEN_AYRTON_PLAN_FILE; if (!SRCF) throw new Error('VDSEN_AYRTON_PLAN_FILE required'); const SRC = JSON.parse(fs.readFileSync(SRCF, 'utf8')).data;
  const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents', AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
  const seed = await L.H.seed({ noPlan: true }); const browser = await L.B.launch(); const planIds = [], docPaths = [];
  const tok = async u => (await call('POST', AUTH + 'signInWithPassword?key=' + cfg.apiKey, null, { email: u.email, password: u.password, returnSecureToken: true })).b.idToken;
  const T = await tok(seed.coach), TA = await tok(seed.athlete); const uid = seed.athlete.uid;
  const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : Object.fromEntries(Object.entries((v.mapValue || {}).fields || {}).map(([k, x]) => [k, dec(x)]));
  const readDoc = async (path, t) => { const r = await call('GET', FS + '/' + path, t || TA); return r.b && r.b.fields ? dec({ mapValue: { fields: r.b.fields } }) : null; };
  const putDoc = async (path, data) => { docPaths.push(path); const r = await call('PATCH', FS + '/' + path, TA, { fields: enc(data).mapValue.fields }); if (r.s !== 200) throw new Error('write ' + path + ' ' + r.s); };
  const pidsOf = p => p.days.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId));
  const base = JSON.parse(JSON.stringify(SRC)); delete base.status; const PIDS = pidsOf(base);
  const mkPlan = (renamePids) => { const p = JSON.parse(JSON.stringify(base)); if (renamePids) p.days.forEach((d, di) => d.exercises.forEach((e, ei) => { e.prescriptionExerciseId = 'alt-' + di + '-' + ei + '-' + crypto.randomBytes(2).toString('hex'); })); return Object.assign(p, { coachId: seed.coach.uid, clientId: uid, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); };
  const createPlan = async (tag, data) => { const id = tag + '-' + crypto.randomBytes(3).toString('hex'); planIds.push(id); const r = await call('PATCH', FS + '/plans/' + id + '?currentDocument.exists=false', T, { fields: enc(data).mapValue.fields }); if (r.s !== 200) throw new Error('plan ' + r.s); return id; };
  const setActive = id => call('PATCH', FS + '/clients/' + uid + '?updateMask.fieldPaths=activePlanId', T, { fields: { activePlanId: { stringValue: id } } });
  const ev = (pid, load, reps) => ({ carga: load, reps, unit: 'KG', done: true, rir: 2, rir_real: 2, ics: 8, pump: 1, prescriptionExerciseId: pid, ts: Date.now() });
  const sets3 = (week, d, e, pid) => Object.fromEntries([0, 1, 2].map(s => ['log_' + week + '_' + d + '_' + e + '_s' + s, ev(pid, '80', '10')]));
  const K = { athlete: seed.athlete};
  const view = async (label) => {
    const A = await L.openReal(browser, { W: 390, Hh: 844, K, expressOff: true }); const p = A.p; const info = [];
    p.on('console', m => { if (/LEGACY_LOG_UNBOUND/.test(m.text())) info.push(m.text()); });
    await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(3000); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); });
    await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(900);
    const st = await p.evaluate(() => ({ plan: ACTIVE_PLAN_ID, week: CURRENT_WEEK, pid0: _EJERCICIOS_DIA[0].prescriptionExerciseId, block: !!document.getElementById('pw_0_0'), use: !!document.querySelector('.pw-use'), rows: document.querySelectorAll('.pw-i').length, unbound: typeof _rootLogUnbound !== 'undefined' ? _rootLogUnbound : null, logs: Object.keys(LOGS).filter(k => /^log_/.test(k)).length }));
    return { A, p, st, info };
  };
  try {
    const exs = base.days.flatMap(d => d.exercises); check('FIXTURE_32_DISTINCT_PIDS', PIDS.length === 32 && new Set(PIDS).size === 32 && exs.length === 32 && exs.reduce((n, e) => n + e.sets.length, 0) === 80, 'pids=' + new Set(PIDS).size);
    const idA = await createPlan('t553-a', mkPlan(false));
    // ---- A: control ----
    await setActive(idA);
    const evA = sets3(1, 0, 0, PIDS[0]);
    await putDoc('logs/' + uid, { planId: idA, currentWeek: 2, entries: evA }); await putDoc('logs/' + uid + '/mesos/' + idA, { planId: idA, currentWeek: 2, entries: evA });
    let v = await view('A'); check('A_SAME_PLAN_SAME_PID_WEEK2_SHOWS_REFERENCE_AND_REUSE', v.st.plan === idA && v.st.week === 2 && v.st.pid0 === PIDS[0] && v.st.block && v.st.use && v.st.rows === 3, JSON.stringify(v.st)); await v.A.ctx.close();
    // ---- B: plan B shares every PID, activated at the same athlete ----
    const idB = await createPlan('t553-b', mkPlan(false)); await setActive(idB);
    v = await view('B'); check('B_PLAN_B_SAME_PIDS_NO_REFERENCE_NO_REUSE_FRESH_WEEK1', v.st.plan === idB && v.st.pid0 === PIDS[0] && v.st.week === 1 && !v.st.block && !v.st.use && v.st.rows === 0 && v.st.logs === 0, JSON.stringify(v.st)); await v.A.ctx.close();
    const mA = await readDoc('logs/' + uid + '/mesos/' + idA); check('B2_PLAN_A_EVIDENCE_UNTOUCHED', !!mA && stable(mA.entries) === stable(evA));
    // ---- C: LEGACY_UNBOUND root (no planId) + week-1 evidence of the same PID; plan C active with no meso ----
    const idC = await createPlan('t553-c', mkPlan(false)); await setActive(idC);
    const legacyEntries = Object.assign(sets3(1, 0, 0, PIDS[0]), { done_1_0: true });
    await putDoc('logs/' + uid, { currentWeek: 2, entries: legacyEntries });   // NO planId: LEGACY_UNBOUND_EVIDENCE
    const rootBefore = await readDoc('logs/' + uid);
    v = await view('C'); check('C_LEGACY_UNBOUND_NOT_ATTACHED_TO_ACTIVE_PLAN', v.st.plan === idC && v.st.week === 1 && !v.st.block && !v.st.use && v.st.rows === 0 && v.st.logs === 0, JSON.stringify(v.st));
    check('C2_LEGACY_UNBOUND_DIAGNOSTIC_PRESENT_AND_QUIET', v.st.unbound === true && v.info.length >= 1 && !/legacy|unbound|desvinculad/i.test(await v.p.evaluate(() => document.body.innerText)), 'diag=' + v.info.length);
    check('C3_ROOT_DOC_NOT_DELETED_REWRITTEN_OR_MIGRATED', stable(await readDoc('logs/' + uid)) === stable(rootBefore) && !('planId' in (await readDoc('logs/' + uid))));
    // ---- F: normal execution after the unbound legacy root ----
    const key = 'log_1_0_0_s0';
    await v.p.waitForSelector('#carga_' + key, { timeout: 8000 }); await v.p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
    await v.p.fill('#carga_' + key, '70'); await v.p.fill('#reps_' + key, '9'); await v.p.click('#rir_btn_' + key + '_2', { timeout: 8000 });
    await v.p.click('#setrow_' + key + ' .set-save-primary'); await v.p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 });
    await v.p.waitForTimeout(4000);
    const mC = await readDoc('logs/' + uid + '/mesos/' + idC);
    check('F1_EXECUTION_WRITTEN_TO_PLAN_BOUND_MESO_DOC', !!mC && mC.planId === idC && mC.entries[key] && mC.entries[key].carga === '70' && mC.entries[key].prescriptionExerciseId === PIDS[0], mC ? JSON.stringify(Object.keys(mC.entries)) : 'no meso');
    const rootAfter = await readDoc('logs/' + uid); check('F2_ROOT_STILL_UNBOUND_AND_UNCHANGED', stable(rootAfter) === stable(rootBefore) && !('planId' in rootAfter));
    await v.A.ctx.close(); v = await view('F'); check('F3_EXECUTION_SURVIVES_RELOAD', v.st.plan === idC && v.st.logs === 1 && v.st.unbound === true, JSON.stringify(v.st));
    check('F4_NO_ATHLETE_PAGE_ERRORS', v.A.errs.length === 0, v.A.errs.slice(0, 2).join(' | ')); await v.A.ctx.close();
    // ---- D: same NAME, wrong PID in the evidence (plan D has fresh PIDs; evidence written with the OLD pids for the same exercise names) ----
    const pD = mkPlan(true); const idD = await createPlan('t553-d', pD); await setActive(idD);
    const evD = sets3(1, 0, 0, PIDS[0]);   // same exercise name at the same position, but a PID that is not in plan D
    await putDoc('logs/' + uid, { planId: idD, currentWeek: 2, entries: evD }); await putDoc('logs/' + uid + '/mesos/' + idD, { planId: idD, currentWeek: 2, entries: evD });
    v = await view('D'); check('D_SAME_NAME_WRONG_PID_NO_REFERENCE', v.st.plan === idD && v.st.week === 2 && v.st.pid0 === pidsOf(pD)[0] && v.st.pid0 !== PIDS[0] && !v.st.block && !v.st.use && v.st.rows === 0, JSON.stringify(v.st)); await v.A.ctx.close();
    // ---- E: same POSITION, wrong PID (evidence belongs to another exercise of the plan) ----
    const evE = sets3(1, 0, 0, pidsOf(pD)[7]);   // position 0_0 holds the evidence of the PID of exercise #7
    await putDoc('logs/' + uid, { planId: idD, currentWeek: 2, entries: evE }); await putDoc('logs/' + uid + '/mesos/' + idD, { planId: idD, currentWeek: 2, entries: evE });
    v = await view('E'); check('E_SAME_POSITION_WRONG_PID_NO_REFERENCE_FOR_THE_EXERCISE_AT_THAT_POSITION', v.st.plan === idD && v.st.week === 2 && !v.st.block && !v.st.use && v.st.rows === 0, JSON.stringify(v.st)); await v.A.ctx.close();
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 1200)); }
  finally {
    await browser.close();
    try { for (const id of planIds) { await call('PATCH', FS + '/plans/' + id + '?updateMask.fieldPaths=status', T, { fields: { status: { stringValue: 'archived' } } }); await call('DELETE', FS + '/plans/' + id, T); } } catch (e) { /* best effort */ }
    try { for (const pth of docPaths) await call('DELETE', FS + '/' + pth, TA); } catch (e) { /* best effort */ }
    console.log('CLEANUP ' + JSON.stringify(await seed.cleanup()));
    const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0);
  }
})();
