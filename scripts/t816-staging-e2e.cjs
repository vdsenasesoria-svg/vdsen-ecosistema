#!/usr/bin/env node
'use strict';
// T816: Real Chromium + Real Firebase Staging E2E acceptance for:
//   1. Coach A -> Client A -> Motor -> Coach A + Coach B isolation
//   2. Check-ins & Seguimiento full lifecycle under T788 staging rules
// Refuses to run against production (vdsen-ecosistema) or vdsen-planes.
// Creates disposable *.invalid synthetic accounts & docs, inventories them, and cleans up in finally.
const crypto = require('node:crypto');
const H = require('./client-staging-harness.cjs');
const B = require('./client-browser-lib.cjs');

const cfg = H.stagingConfig();
if (cfg.projectId !== 'vdsen-ecosistema-staging') {
  console.error('REFUSING: not staging project');
  process.exit(2);
}
const FS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents';
const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';

const enc = v => v === null || v === undefined ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = v => !v ? undefined
  : 'nullValue' in v ? null
  : 'booleanValue' in v ? v.booleanValue
  : 'integerValue' in v ? Number(v.integerValue)
  : 'doubleValue' in v ? v.doubleValue
  : 'stringValue' in v ? v.stringValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec)
  : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]))
  : v.timestampValue || undefined;
const unfields = d => Object.fromEntries(Object.entries((d && d.fields) || {}).map(([k, v]) => [k, dec(v)]));

async function api(method, url, token, body) {
  const r = await fetch(url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (_) {}
  return { s: r.status, b: j };
}
const ok = r => r.s >= 200 && r.s < 300;
const fsGet = (t, p) => api('GET', FS + '/' + p, t);
const fsSet = (t, p, data) => api('PATCH', FS + '/' + p, t, { fields: enc(data).mapValue.fields });
const fsDel = (t, p) => api('DELETE', FS + '/' + p, t);

async function signUp(label) {
  const email = label + '.' + crypto.randomBytes(4).toString('hex') + '@staging-t816.invalid';
  const password = crypto.randomBytes(12).toString('base64url') + 'aA1!';
  const r = await api('POST', AUTH + 'signUp?key=' + cfg.apiKey, null, { email, password, returnSecureToken: true });
  if (!ok(r)) throw new Error('signUp failed for ' + label + ': ' + r.s);
  return { label, uid: r.b.localId, email, password, token: r.b.idToken };
}
const deleteUser = u => api('POST', AUTH + 'delete?key=' + cfg.apiKey, null, { idToken: u.token });

const results = [];
function check(id, pass, note) {
  results.push({ id, pass: !!pass, note: note || '' });
  console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : ''));
  return !!pass;
}

(async () => {
  const rid = crypto.randomBytes(3).toString('hex');
  const createdUsers = [];
  const docPathsToDelete = [];
  let browser = null;

  try {
    // 1. Provision Coach A, Client A, Coach B (all synthetic *.invalid)
    const coachA = await signUp('coach-a'); createdUsers.push(coachA);
    const coachB = await signUp('coach-b'); createdUsers.push(coachB);
    const clientA = await signUp('client-a'); createdUsers.push(clientA);

    await fsSet(coachA.token, 'coaches/' + coachA.uid, { role: 'coach', displayName: 'Coach A (T816)', email: coachA.email, createdAt: new Date().toISOString() });
    docPathsToDelete.push(['coachA', 'coaches/' + coachA.uid]);
    await fsSet(coachB.token, 'coaches/' + coachB.uid, { role: 'coach', displayName: 'Coach B (T816)', email: coachB.email, createdAt: new Date().toISOString() });
    docPathsToDelete.push(['coachB', 'coaches/' + coachB.uid]);

    const planId = 'plan-t816-' + rid;
    await fsSet(coachA.token, 'clients/' + clientA.uid, {
      coachId: coachA.uid,
      displayName: 'Atleta T816',
      nombre: 'Atleta T816',
      email: clientA.email,
      role: 'client',
      sexo: 'masculino',
      peso: '78',
      objetivo: 'Hipertrofia',
      profileType: 'hipertrofia',
      phone: '+525500000000',
      phoneConfirmedAt: Date.now(),
      activePlanId: planId,
      createdAt: new Date().toISOString()
    });
    docPathsToDelete.push(['coachA', 'clients/' + clientA.uid]);

    const planDoc = {
      schema: 'vdsen-plan-v2',
      coachId: coachA.uid,
      clientId: clientA.uid,
      status: 'active',
      weeks: 4,
      daysPerWeek: 2,
      generatedBy: 't816-staging-e2e',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      days: [
        {
          dayIndex: 0,
          label: 'Empuje T816',
          exercises: [
            {
              prescriptionExerciseId: 'px_press_t816',
              exerciseName: 'Press de Banca Plano',
              muscleGroup: 'Pecho',
              sets: [
                { setIndex: 0, repsTarget: 8, rirTarget: 2, restSeconds: 120, load: 80 },
                { setIndex: 1, repsTarget: 8, rirTarget: 2, restSeconds: 120, load: 80 }
              ]
            }
          ]
        },
        {
          dayIndex: 1,
          label: 'Tracción T816',
          exercises: [
            {
              prescriptionExerciseId: 'px_row_t816',
              exerciseName: 'Remo con Barra',
              muscleGroup: 'Espalda',
              sets: [
                { setIndex: 0, repsTarget: 10, rirTarget: 2, restSeconds: 90, load: 70 }
              ]
            }
          ]
        }
      ]
    };
    const pRes = await fsSet(coachA.token, 'plans/' + planId, planDoc);
    check('PLAN_CREATED_BY_COACH_A', ok(pRes), 'status=' + pRes.s);
    docPathsToDelete.push(['coachA', 'plans/' + planId]);

    // 2. Launch Chromium for Client A & Coach A
    browser = await B.launch();
    const clientCtx = await B.newCtx(browser, { width: 390, height: 844, transform: h => H.buildStagingHtml(h) });
    const cp = await clientCtx.newPage();
    const clientErrors = [];
    cp.on('pageerror', e => clientErrors.push(e.message));

    await cp.goto(B.APP + '/vdsen-cliente.html');
    await cp.waitForSelector('#liEmail');
    await cp.fill('#liEmail', clientA.email);
    await cp.fill('#liPass', clientA.password);
    await cp.click('.login-btn');
    await cp.waitForSelector('#scrApp.on', { timeout: 30000 });
    await cp.waitForTimeout(2000);
    if (await cp.$('#wnModal')) { await cp.click('#wnModal button'); await cp.waitForTimeout(300); }
    check('CLIENT_LOGIN_AND_PLAN_LOADED', await cp.evaluate(pid => typeof ACTIVE_PLAN_ID !== 'undefined' && ACTIVE_PLAN_ID === pid, planId));

    // Register real training set in Client A (Standard Mode)
    await cp.click('#nb0');
    await cp.waitForTimeout(500);
    await cp.click('.today-action');
    await cp.waitForSelector('input[id^="carga_"]', { state: 'visible', timeout: 15000 });
    await cp.fill('input[id^="carga_"] >> nth=0', '80');
    await cp.fill('input[id^="reps_"] >> nth=0', '10');
    await cp.click('button[id^="rir_btn_"][id$="_2"] >> nth=0');
    await cp.fill('input[id^="ics_"] >> nth=0', '9');
    await cp.click('.set-save-primary >> nth=0');
    await cp.waitForTimeout(2500);

    // Reload Client A & verify persistence from Firestore Staging
    await cp.reload();
    await cp.waitForSelector('#scrApp.on', { timeout: 30000 });
    await cp.waitForTimeout(2500);
    const logGet = await fsGet(clientA.token, 'logs/' + clientA.uid);
    docPathsToDelete.push(['coachA', 'logs/' + clientA.uid]);
    docPathsToDelete.push(['coachA', 'logs/' + clientA.uid + '/mesos/' + planId]);
    const logData = ok(logGet) ? unfields(logGet.b) : {};
    const hasSavedSet = !!(logData.entries && Object.keys(logData.entries).some(k => /_0_0_s0$/.test(k) || /1_0_0/.test(k)));
    check('CLIENT_EXECUTION_PERSISTED_AFTER_RELOAD', ok(logGet) && hasSavedSet, 'keys=' + Object.keys(logData.entries || {}).join(','));

    // Client A cannot overwrite Coach-owned plan
    const forgePlan = await fsSet(clientA.token, 'plans/' + planId, Object.assign({}, planDoc, { status: 'revoked' }));
    check('CLIENT_CANNOT_MODIFY_PLAN', forgePlan.s === 403, 'status=' + forgePlan.s);

    // 3. Coach A logs into vdsen-coach.html in Chromium
    const coachCtx = await B.newCtx(browser, { width: 1280, height: 900, transform: h => H.buildStagingHtml(h) });
    const kp = await coachCtx.newPage();
    const coachErrors = [];
    kp.on('pageerror', e => coachErrors.push(e.message));

    await kp.goto(B.APP + '/vdsen-coach.html');
    await kp.waitForSelector('#loginEmail');
    await kp.fill('#loginEmail', coachA.email);
    await kp.fill('#loginPass', coachA.password);
    await kp.click('#loginBtn');
    await kp.waitForSelector('[data-section="crearPlan"]', { state: 'visible', timeout: 30000 });
    await kp.waitForTimeout(2000);
    check('COACH_A_LOGIN_OK', true);

    // Coach A opens Client A detail -> seguimiento tab and requests check-in via UI
    await kp.evaluate(cid => showClientDetail(cid, { tab: 'seguimiento' }), clientA.uid);
    await kp.waitForSelector('#segReqBtn_' + clientA.uid, { state: 'visible', timeout: 15000 });
    await kp.fill('#segReqNote_' + clientA.uid, 'Por favor actualiza tu check-in semanal T816');
    await kp.click('#segReqBtn_' + clientA.uid);
    await kp.waitForTimeout(2000);
    check('COACH_A_REQUEST_SEGUIMIENTO', true);

    // Verify checkin_requests + lock created in Staging
    const reqListRes = await api('GET', FS + '/clients/' + clientA.uid + '/checkin_requests', coachA.token);
    const reqDocs = (reqListRes.b && reqListRes.b.documents) || [];
    const createdReqIds = reqDocs.map(d => d.name.split('/').pop());
    createdReqIds.forEach(id => docPathsToDelete.push(['coachA', 'clients/' + clientA.uid + '/checkin_requests/' + id]));
    docPathsToDelete.push(['coachA', 'clients/' + clientA.uid + '/checkin_request_lock/active']);
    check('T788_CHECKIN_REQUEST_CREATED_CANONICALLY', reqDocs.length === 1 && unfields(reqDocs[0]).status === 'pending', 'count=' + reqDocs.length);

    // Duplicate request from Coach A must be blocked
    await kp.evaluate(cid => requestClientSeguimiento(cid), clientA.uid);
    await kp.waitForTimeout(1500);
    const reqListAfterDup = await api('GET', FS + '/clients/' + clientA.uid + '/checkin_requests', coachA.token);
    const reqCountAfterDup = ((reqListAfterDup.b && reqListAfterDup.b.documents) || []).length;
    check('DUPLICATE_CHECKIN_REQUEST_BLOCKED', reqCountAfterDup === 1, 'count=' + reqCountAfterDup);

    // 4. Client A receives the pending request and submits check-in in Chromium
    await cp.evaluate(async () => {
      if (typeof loadClientSeguimiento === 'function') await loadClientSeguimiento();
    });
    await cp.waitForTimeout(1500);
    const clientSeesPending = await cp.evaluate(() => {
      return Array.isArray(_seguimientoRequests) && _seguimientoRequests.some(r => r && r.status === 'pending');
    });
    check('CLIENT_A_RECEIVES_PENDING_REQUEST', clientSeesPending);

    const clientSubmitRes = await cp.evaluate(async () => {
      try {
        if (typeof _initSeguimientoDraft === 'function') _initSeguimientoDraft();
        _seguimientoDraft.peso = '77.8';
        _seguimientoDraft.energia = 8;
        _seguimientoDraft.sueno = 8;
        _seguimientoDraft.estres = 3;
        _seguimientoDraft.adherenciaEntreno = '95';
        _seguimientoDraft.nutricionNoAplica = true;
        _seguimientoDraft.comentarios = 'Check-in sintetico T816 staging';
        const okSave = await saveSeguimientoClient();
        return { ok: !!okSave };
      } catch (e) {
        return { ok: false, err: e && e.message };
      }
    });
    await cp.waitForTimeout(2000);
    check('CLIENT_A_SUBMITS_CHECKIN', clientSubmitRes.ok === true, clientSubmitRes.err || '');

    // Verify canonical checkins/{checkinId} created and checkin_requests/{reqId} updated to 'sent'
    const chkListRes = await api('GET', FS + '/clients/' + clientA.uid + '/checkins', coachA.token);
    const chkDocs = (chkListRes.b && chkListRes.b.documents) || [];
    chkDocs.forEach(d => docPathsToDelete.push(['coachA', 'clients/' + clientA.uid + '/checkins/' + d.name.split('/').pop()]));
    const reqListAfterSubmit = await api('GET', FS + '/clients/' + clientA.uid + '/checkin_requests', coachA.token);
    const reqAfterSubmit = ((reqListAfterSubmit.b && reqListAfterSubmit.b.documents) || [])[0];
    check('T788_CHECKIN_PERSISTED_AND_REQUEST_FULFILLED',
      chkDocs.length === 1 && unfields(chkDocs[0]).status === 'sent' && reqAfterSubmit && unfields(reqAfterSubmit).status === 'sent',
      'checkins=' + chkDocs.length + ', reqStatus=' + (reqAfterSubmit ? unfields(reqAfterSubmit).status : 'none'));

    // Client A cannot forge checkin_reviews or write checkin_request_lock
    const clientForgeLock = await fsSet(clientA.token, 'clients/' + clientA.uid + '/checkin_request_lock/active', { clientId: clientA.uid, coachId: coachA.uid, activeRequestId: 'forged' });
    check('CLIENT_CANNOT_FORGE_REQUEST_LOCK', clientForgeLock.s === 403, 'status=' + clientForgeLock.s);
    const chkId = chkDocs[0] ? chkDocs[0].name.split('/').pop() : 'missing';
    const clientForgeReview = await fsSet(clientA.token, 'clients/' + clientA.uid + '/checkin_reviews/' + chkId, { checkinId: chkId, clientId: clientA.uid, coachId: coachA.uid, status: 'reviewed' });
    check('CLIENT_CANNOT_FORGE_CHECKIN_REVIEW', clientForgeReview.s === 403, 'status=' + clientForgeReview.s);

    // 5. Coach A reviews check-in via UI and sees history
    await kp.evaluate(cid => showClientDetail(cid, { tab: 'seguimiento' }), clientA.uid);
    await kp.waitForSelector('#btnRevSeg_' + chkId, { state: 'visible', timeout: 15000 });
    await kp.click('#btnRevSeg_' + chkId);
    await kp.waitForTimeout(2000);
    const reviewId = 'rev_' + chkId;
    const revGet = await fsGet(coachA.token, 'clients/' + clientA.uid + '/checkin_reviews/' + reviewId);
    const chkAfterRev = await fsGet(coachA.token, 'clients/' + clientA.uid + '/checkins/' + chkId);
    if (ok(revGet)) docPathsToDelete.push(['coachA', 'clients/' + clientA.uid + '/checkin_reviews/' + reviewId]);
    check('COACH_A_REVIEWS_CHECKIN_AND_HISTORY',
      ok(revGet) && unfields(revGet.b).status === 'reviewed' && ok(chkAfterRev) && unfields(chkAfterRev.b).status === 'reviewed',
      'revStatus=' + revGet.s + ', chkStatus=' + (ok(chkAfterRev) ? unfields(chkAfterRev.b).status : chkAfterRev.s));

    // 6. Coach B isolation (cannot read or write Client A profile, plan, logs, checkins, checkin_requests)
    const bReadClient = await fsGet(coachB.token, 'clients/' + clientA.uid);
    const bReadPlan = await fsGet(coachB.token, 'plans/' + planId);
    const bReadLogs = await fsGet(coachB.token, 'logs/' + clientA.uid);
    const bReadCheckins = await api('GET', FS + '/clients/' + clientA.uid + '/checkins', coachB.token);
    const bWriteReq = await fsSet(coachB.token, 'clients/' + clientA.uid + '/checkin_requests/req_b_' + rid, { id: 'req_b_' + rid, clientId: clientA.uid, coachId: coachB.uid, status: 'pending', createdAtMs: Date.now() });
    check('COACH_B_ISOLATION_ALL_DENIED',
      bReadClient.s === 403 && bReadPlan.s === 403 && bReadLogs.s === 403 && bReadCheckins.s === 403 && bWriteReq.s === 403,
      `client=${bReadClient.s},plan=${bReadPlan.s},logs=${bReadLogs.s},chk=${bReadCheckins.s},req=${bWriteReq.s}`);

    // 7. Verify zero uncaught pageerrors in both apps
    check('ZERO_UNCAUGHT_PAGEERRORS', clientErrors.length === 0 && coachErrors.length === 0,
      'client=' + clientErrors.length + ', coach=' + coachErrors.length);

  } catch (e) {
    check('UNHANDLED_E2E_ERROR', false, e && e.message ? e.message : String(e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    const tokenMap = {
      coachA: createdUsers[0] && createdUsers[0].token,
      coachB: createdUsers[1] && createdUsers[1].token,
      clientA: createdUsers[2] && createdUsers[2].token
    };
    let docsDeleted = 0;
    for (const [who, p] of docPathsToDelete.reverse()) {
      const t = tokenMap[who] || tokenMap.coachA;
      if (!t) continue;
      const r = await fsDel(t, p).catch(() => ({ s: 0 }));
      if (ok(r)) docsDeleted++;
    }
    let usersDeleted = 0;
    for (const u of createdUsers) {
      const r = await deleteUser(u).catch(() => ({ s: 0 }));
      if (ok(r)) usersDeleted++;
    }
    const failed = results.filter(r => !r.pass);
    console.log(JSON.stringify({
      project: cfg.projectId,
      checks: results.length,
      passed: results.length - failed.length,
      failed: failed.map(f => f.id + ':' + f.note),
      cleanup: { docsAttempted: docPathsToDelete.length, docsDeleted, usersCreated: createdUsers.length, usersDeleted }
    }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  }
})();
