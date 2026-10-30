'use strict';
// T552 STAGING verification (synthetic coach / athlete / second coach, Ayrton-shaped plan from VDSEN_AYRTON_PLAN_FILE; never touches the human Ayrton account):
//  A. plans CREATE ownership matrix against the DEPLOYED staging rules (REST)
//  B. rest 0: Coach import -> save -> export -> re-import -> update-plan modal keep `restSeconds: 0` (and 60 / 90 / 150)
//  C. PID export fidelity: 32 distinct PIDs (+ duplicate exercise names with different PIDs) survive export -> import -> save -> update byte for byte
//  D. T551 cross-plan isolation: plan B re-imported from plan A's export shares EVERY PID with plan A; the athlete executes Week 1 on plan A (control: Week 2 shows
//     ÚLTIMA SEMANA + USAR CARGA/REPS), then plan B becomes active at Week 2 => ÚLTIMA SEMANA / USAR CARGA/REPS are absent although the PID is identical.
// Usage: NODE_PATH=$(npm root -g) NODE_USE_ENV_PROXY=1 VDSEN_AYRTON_PLAN_FILE=<json outside repo> node scripts/client-staging-t552-closure.cjs [--out file]
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
  const seed = await L.H.seed({ noPlan: true }); const browser = await L.B.launch(); let xCoach = null; const planIds = [];
  const tok = async u => (await call('POST', AUTH + 'signInWithPassword?key=' + cfg.apiKey, null, { email: u.email, password: u.password, returnSecureToken: true })).b.idToken;
  const T = await tok(seed.coach), TA = await tok(seed.athlete);
  const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
  const readPlan = async id => { const r = await call('GET', FS + '/plans/' + id, T); return r.b && r.b.fields ? dec({ mapValue: { fields: r.b.fields } }) : null; };
  const pidsOf = p => p.days.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId)); const restsOf = p => p.days.flatMap(d => d.exercises.flatMap(e => (e.sets || []).map(s => s.restSeconds)));
  const entries = async (uid, plan) => { const d = await restGet(cfg, seed.athlete.email, seed.athlete.password, 'logs/' + uid + '/mesos/' + plan); return d && d.fields && d.fields.entries ? val(d.fields.entries) : {}; };
  try {
    // ---------------- fixture: Ayrton-shaped plan with a rest of 0, duplicate NAMES with different PIDs ----------------
    const base = JSON.parse(JSON.stringify(SRC)); delete base.status; const exs = base.days.flatMap(d => d.exercises);
    exs[1].exerciseName = exs[0].exerciseName; exs[0].sets[0].restSeconds = 0; exs[2].sets[0].restSeconds = 60; exs[3].sets[0].restSeconds = 150;
    check('FIXTURE_32_DISTINCT_PIDS_DUPLICATE_NAME_AND_REST_0', pidsOf(base).length === 32 && new Set(pidsOf(base)).size === 32 && exs[0].exerciseName === exs[1].exerciseName && exs[0].prescriptionExerciseId !== exs[1].prescriptionExerciseId && restsOf(base).filter(r => r === 0).length >= 1, 'pids=' + new Set(pidsOf(base)).size);
    // ---------------- A. plan create ownership matrix (deployed staging rules) ----------------
    const oe = 'coach2.' + crypto.randomBytes(3).toString('hex') + '@staging-ui.invalid', op = crypto.randomBytes(12).toString('base64url') + 'aA1!';
    const os = await call('POST', AUTH + 'signUp?key=' + cfg.apiKey, null, { email: oe, password: op, returnSecureToken: true }); xCoach = { token: os.b.idToken, uid: os.b.localId };
    await call('PATCH', FS + '/coaches/' + xCoach.uid, xCoach.token, { fields: enc({ role: 'coach', displayName: 'Other coach (synthetic)', email: oe }).mapValue.fields });
    const xClientId = 'cx-' + crypto.randomBytes(3).toString('hex'); const xc = await call('PATCH', FS + '/clients/' + xClientId + '?currentDocument.exists=false', xCoach.token, { fields: enc({ coachId: xCoach.uid, email: 'cx@staging-ui.invalid', role: 'client' }).mapValue.fields });
    check('FIXTURE_OTHER_COACH_CLIENT_CREATED', xc.s === 200, 'status ' + xc.s);
    const mkPlan = (coachId, clientId, extra) => Object.assign(JSON.parse(JSON.stringify(base)), { coachId, clientId, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, extra || {});
    const create = (t, id, data) => call('PATCH', FS + '/plans/' + id + '?currentDocument.exists=false', t, { fields: enc(data).mapValue.fields });
    const idA = 'plan-a-' + crypto.randomBytes(3).toString('hex'); planIds.push(idA);
    const a1 = await create(T, idA, mkPlan(seed.coach.uid, seed.athlete.uid)); check('A1_OWNER_CREATES_PLAN_FOR_OWN_CLIENT', a1.s === 200, 'status ' + a1.s);
    const probe = async (label, t, data) => { const id = 'plan-deny-' + crypto.randomBytes(3).toString('hex'); const r = await create(t, id, data); if (r.s === 200) planIds.push(id); return r.s; };
    check('A2_OWNER_CANNOT_CREATE_FOR_OTHER_COACH_CLIENT_DENIED', (await probe('a2', T, mkPlan(seed.coach.uid, xClientId))) === 403);
    check('A3_OWNER_CANNOT_CREATE_FOR_NONEXISTENT_CLIENT_DENIED', (await probe('a3', T, mkPlan(seed.coach.uid, 'does-not-exist-' + crypto.randomBytes(3).toString('hex')))) === 403);
    check('A4_OTHER_COACH_CANNOT_CREATE_FOR_OWNER_CLIENT_DENIED', (await probe('a4', xCoach.token, mkPlan(xCoach.uid, seed.athlete.uid))) === 403);
    check('A5_OTHER_COACH_FORGED_COACHID_DENIED', (await probe('a5', xCoach.token, mkPlan(seed.coach.uid, seed.athlete.uid))) === 403);
    check('A6_ATHLETE_DENIED_FORGED_COACHID', (await probe('a6', TA, mkPlan(seed.coach.uid, seed.athlete.uid))) === 403);
    check('A7_ATHLETE_DENIED_OWN_COACHID', (await probe('a7', TA, mkPlan(seed.athlete.uid, seed.athlete.uid))) === 403);
    const a8 = await probe('a8', null, mkPlan(seed.coach.uid, seed.athlete.uid)); check('A8_UNAUTHENTICATED_DENIED', a8 === 401 || a8 === 403, 'status ' + a8);
    check('A9_OTHER_COACH_CONTROL_OWN_CLIENT_ALLOWED', (await probe('a9', xCoach.token, mkPlan(xCoach.uid, xClientId))) === 200);
    await call('PATCH', FS + '/clients/' + seed.athlete.uid + '?updateMask.fieldPaths=activePlanId', T, { fields: { activePlanId: { stringValue: idA } } });
    const planA = await readPlan(idA); check('PLAN_A_STORED_PIDS_AND_RESTS_EXACT', stable(pidsOf(planA)) === stable(pidsOf(base)) && stable(restsOf(planA)) === stable(restsOf(base)));
    // ---------------- athlete executes Week 1 on plan A, control: Week 2 shows the reference ----------------
    const patchLog = async (uid, plan, week) => { for (const path of ['logs/' + uid, 'logs/' + uid + '/mesos/' + plan]) { const r = await call('PATCH', FS + '/' + path + '?updateMask.fieldPaths=currentWeek', TA, { fields: { currentWeek: { integerValue: String(week) } } }); if (r.s >= 300) throw new Error('week patch ' + r.s + ' ' + path); } };
    async function saveSet(p, key, load, reps, rir) {
      await p.waitForSelector('#carga_' + key, { timeout: 8000 }); await p.evaluate(k => document.getElementById('carga_' + k).scrollIntoView({ block: 'center' }), key);
      await p.fill('#carga_' + key, load); await p.fill('#reps_' + key, reps); await p.click('#rir_btn_' + key + '_' + rir, { timeout: 8000 });
      await p.click('#setrow_' + key + ' .set-save-primary'); await p.waitForFunction(k => LOGS[k] && LOGS[k].done, key, { timeout: 15000 });
      await p.waitForFunction(() => { const o = document.getElementById('restTimerOverlay'); return o && getComputedStyle(o).display !== 'none'; }, null, { timeout: 6000 }).catch(() => {}); /* rest 0 => no timer, by design */ await p.evaluate(() => stopRestTimer()); await p.waitForTimeout(2500);
    }
    const reopenApp = async (ctxo) => { const p = ctxo.p; await p.reload(); await p.waitForSelector('#scrApp.on', { timeout: 40000 }); await p.waitForTimeout(3000); await p.evaluate(() => { const b = document.querySelector('#wnModal button'); if (b) b.click(); }); await p.click('#nb1'); await p.waitForTimeout(500); await p.evaluate(() => selDia(0)); await p.waitForTimeout(700); };
    const K = { athlete: seed.athlete }; const A = await L.openReal(browser, { W: 390, Hh: 844, K, expressOff: true }); const pa = A.p;
    await pa.click('#nb1'); await pa.waitForTimeout(500); await pa.evaluate(() => selDia(0)); await pa.waitForTimeout(700);
    const pidEx0 = await pa.evaluate(() => _EJERCICIOS_DIA[0].prescriptionExerciseId), nSets = await pa.evaluate(() => _EJERCICIOS_DIA[0].sets.length);
    check('ATHLETE_APP_PLAN_A_ACTIVE_EX0_PID_MATCHES', pidEx0 === pidsOf(base)[0] && nSets >= 2, 'sets=' + nSets);
    const EX = [['80', '10', 3], ['80', '9', 2], ['75', '8', 1]].slice(0, nSets); for (let s = 0; s < EX.length; s++) await saveSet(pa, 'log_1_0_0_s' + s, ...EX[s]);
    await patchLog(seed.athlete.uid, idA, 2); await reopenApp(A);
    const ctl = await pa.evaluate(() => ({ block: !!document.getElementById('pw_0_0'), rows: [...document.querySelectorAll('#pw_0_0 .pw-i')].map(l => l.textContent), use: !!document.querySelector('#setrow_log_2_0_0_s0 .pw-use'), plan: ACTIVE_PLAN_ID }));
    check('D0_CONTROL_SAME_PLAN_SAME_PID_WEEK2_SHOWS_REFERENCE_AND_REUSE', ctl.block && ctl.use && ctl.rows.length === EX.length && ctl.plan === idA && /S1 · 80 kg × 10 · RIR 3/.test(ctl.rows[0]), JSON.stringify(ctl.rows));
    await A.ctx.close();
    // ---------------- Coach UI: export plan A, import it as plan B (same PIDs), update-in-place ----------------
    const cctx = await L.B.newCtx(browser, { width: 1100, height: 900, transform: h => L.H.buildStagingHtml(h) }); const c = await cctx.newPage(); const cerrs = []; c.on('pageerror', e => cerrs.push(e.message));
    await c.goto(L.B.APP + '/vdsen-coach.html'); await c.waitForSelector('#loginEmail'); await c.fill('#loginEmail', seed.coach.email); await c.fill('#loginPass', seed.coach.password); await c.click('#loginBtn');
    await c.waitForTimeout(4000); await c.reload(); await c.waitForTimeout(2500); cerrs.length = 0; await c.waitForSelector('[data-section="crearPlan"]', { state: 'visible', timeout: 30000 });
    await c.evaluate(() => { window.__exp = null; navigator.clipboard.writeText = async t => { window.__exp = t; }; });
    await c.evaluate(([cid, pid]) => exportActivePlanJSON(cid, pid), [seed.athlete.uid, idA]); await c.waitForFunction(() => window.__exp, null, { timeout: 15000 });
    const expText = await c.evaluate(() => window.__exp); const exp = JSON.parse(expText);
    check('C1_EXPORT_CONTAINS_ALL_32_PIDS_BYTE_FOR_BYTE_IN_ORDER', stable(pidsOf(exp)) === stable(pidsOf(base)) && new Set(pidsOf(exp)).size === 32, 'pids=' + pidsOf(exp).filter(Boolean).length);
    check('B1_EXPORT_KEEPS_REST_0_AND_60_90_150', stable(restsOf(exp)) === stable(restsOf(base)) && restsOf(exp)[0] === 0 && restsOf(exp).includes(60) && restsOf(exp).includes(150), JSON.stringify(restsOf(exp).slice(0, 8)));
    check('C2_EXPORT_DUPLICATE_NAMES_KEEP_DISTINCT_PIDS', exp.days.flatMap(d => d.exercises)[0].exerciseName === exp.days.flatMap(d => d.exercises)[1].exerciseName && exp.days[0].exercises[0].prescriptionExerciseId !== exp.days[0].exercises[1].prescriptionExerciseId);
    await c.click('[data-section="crearPlan"]'); await c.waitForTimeout(800);
    await c.waitForFunction(id => { const s = document.getElementById('planClientSelect'); return s && Array.from(s.options).some(o => o.value === id); }, seed.athlete.uid, { timeout: 20000 }); await c.selectOption('#planClientSelect', seed.athlete.uid);
    await c.evaluate(() => document.getElementById('jsonModeBtn').click()); await c.waitForSelector('#planJsonInput'); await c.fill('#planJsonInput', expText);
    await c.evaluate(() => parsePlanFromJSON()); await c.waitForSelector('#saveImportedPlanBtn', { timeout: 10000 });
    const prev = await c.evaluate(() => ({ pids: window._importedPlan.days.flatMap(d => d.exercises.map(e => e.prescriptionExerciseId)), rests: window._importedPlan.days.flatMap(d => d.exercises.flatMap(e => e.sets.map(s => s.restSeconds))) }));
    check('B2_IMPORT_PREVIEW_KEEPS_REST_0_AND_PIDS', stable(prev.rests) === stable(restsOf(base)) && stable(prev.pids) === stable(pidsOf(base)));
    await c.click('#saveImportedPlanBtn'); await c.waitForSelector('#_ack_ok', { timeout: 15000 }); await c.click('#_ack_ok');
    let idB = null; for (let i = 0; i < 25 && !idB; i++) { await c.waitForTimeout(1000); const cd = await call('GET', FS + '/clients/' + seed.athlete.uid, T); const ap = cd.b && cd.b.fields && cd.b.fields.activePlanId && cd.b.fields.activePlanId.stringValue; if (ap && ap !== idA) idB = ap; }
    check('D1_COACH_IMPORTED_AND_ACTIVATED_PLAN_B_FOR_THE_SAME_ATHLETE', !!idB, idB); if (idB) planIds.push(idB);
    const planB = idB ? await readPlan(idB) : null;
    check('C3_SAVED_PLAN_B_PRESERVES_EVERY_PID_BYTE_FOR_BYTE', !!planB && stable(pidsOf(planB)) === stable(pidsOf(planA)) && new Set(pidsOf(planB)).size === 32);
    check('B3_SAVED_PLAN_B_PRESERVES_REST_0_60_90_150', !!planB && stable(restsOf(planB)) === stable(restsOf(planA)) && restsOf(planB)[0] === 0);
    // update-plan modal (the third normalizer): same JSON re-applied in place
    await c.waitForTimeout(5000); await c.waitForFunction(() => typeof showUpdatePlanModal === 'function'); await c.evaluate(([cid, pid]) => { showUpdatePlanModal(cid, pid); }, [seed.athlete.uid, idB]); await c.waitForSelector('#upd-plan-json', { timeout: 10000 }); await c.fill('#upd-plan-json', expText); await c.click('#upd-plan-apply'); await c.waitForTimeout(5000);
    const planB2 = await readPlan(idB); check('C4_UPDATE_PLAN_MODAL_KEEPS_PIDS_AND_REST_0', !!planB2 && stable(pidsOf(planB2)) === stable(pidsOf(planA)) && stable(restsOf(planB2)) === stable(restsOf(planA)));
    check('NO_COACH_PAGE_ERRORS', cerrs.length === 0, cerrs.slice(0, 2).join(' | ')); await cctx.close();
    // ---------------- D. athlete opens plan B (Week 2): same PIDs, different plan => no reference, no reuse ----------------
    const B = await L.openReal(browser, { W: 390, Hh: 844, K, expressOff: true }); const pb = B.p;
    const st1 = await pb.evaluate(() => ({ plan: ACTIVE_PLAN_ID, week: CURRENT_WEEK, logs: Object.keys(LOGS).filter(k => /^log_/.test(k)).length })); check('D2_ATHLETE_APP_LOADED_PLAN_B_FRESH_WEEK_1_NO_PLAN_A_EVIDENCE', st1.plan === idB && st1.week === 1 && st1.logs === 0, JSON.stringify(st1));
    await pb.waitForTimeout(3500); await patchLog(seed.athlete.uid, idB, 2); await reopenApp(B);
    const st2 = await pb.evaluate(() => ({ plan: ACTIVE_PLAN_ID, week: CURRENT_WEEK, pid: _EJERCICIOS_DIA[0].prescriptionExerciseId, block: !!document.getElementById('pw_0_0'), use: !!document.querySelector('.pw-use'), plainRows: document.querySelectorAll('.pw-i').length, logs: Object.keys(LOGS).filter(k => /^log_/.test(k)).length }));
    check('D3_SAME_PID_DIFFERENT_PLAN_WEEK2_NO_ULTIMA_SEMANA_NO_USAR', st2.plan === idB && st2.week === 2 && st2.pid === pidsOf(base)[0] && !st2.block && !st2.use && st2.plainRows === 0 && st2.logs === 0, JSON.stringify(st2));
    const eA = await entries(seed.athlete.uid, idA); check('D4_PLAN_A_EVIDENCE_UNTOUCHED', EX.every((x, i) => eA['log_1_0_0_s' + i] && eA['log_1_0_0_s' + i].carga === x[0] && eA['log_1_0_0_s' + i].reps === x[1]), Object.keys(eA).filter(k => /^log_/.test(k)).length + ' sets');
    const eB = await entries(seed.athlete.uid, idB); check('D5_NO_EXECUTION_WRITTEN_FOR_PLAN_B', Object.keys(eB).filter(k => /^log_/.test(k)).length === 0);
    check('NO_ATHLETE_PAGE_ERRORS', A.errs.length === 0 && B.errs.length === 0, [...A.errs, ...B.errs].slice(0, 2).join(' | ')); await B.ctx.close();
  } catch (e) { check('HARNESS', false, String(e.message).slice(0, 1200)); }
  finally {
    await browser.close();
    // cleanup: archive then delete every synthetic plan (the rules forbid deleting an ACTIVE plan), extra coach / client, then the harness accounts
    try { for (const id of planIds) { await call('PATCH', FS + '/plans/' + id + '?updateMask.fieldPaths=status', T, { fields: { status: { stringValue: 'archived' } } }); await call('DELETE', FS + '/plans/' + id, T); } } catch (e) { /* best effort */ }
    if (xCoach) { try { const xt = xCoach.token; await call('DELETE', FS + '/plans', xt); for (const id of planIds) await call('DELETE', FS + '/plans/' + id, xt); await call('DELETE', FS + '/coaches/' + xCoach.uid, xt); await call('POST', AUTH + 'delete?key=' + cfg.apiKey, null, { idToken: xt }); } catch (e) { /* best effort */ } }
    console.log('CLEANUP ' + JSON.stringify(await seed.cleanup()));
    const summary = { project: cfg.projectId, checks: results.length, failed: results.filter(r => !r.pass).map(r => r.id), synthetic: true }; if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2)); console.log(JSON.stringify(summary)); process.exit(summary.failed.length ? 1 : 0);
  }
})();
