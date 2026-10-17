'use strict';
// T570-R.2: STAGING-ONLY end-to-end of the autonomous progression circuit (project vdsen-ecosistema-staging).
//  - Synthetic accounts (*@staging-ui.invalid) are created through the staging web API key and deleted at the end. No real account/log is touched.
//  - The athlete and the Coach act ONLY through the DEPLOYED Firestore rules (REST + their own ID tokens).
//  - The trusted executor (api/_autonomousProgression.js + trigger/sweep handlers) runs here with the operator's IAM identity (gcloud token,
//    project owner) through a REST transaction driver, because no service-account key is available locally. The Admin SDK path itself is
//    covered by tests/t570r-autonomous-emulator.cjs. The Vercel function is NOT deployed against staging (preview env points elsewhere).
//  - CRON_SECRET here is a random per-run value, never printed.
// Usage: node scripts/t570r-staging-e2e.cjs   (needs `gcloud auth login` as a staging project owner; writes docs/t570r-staging-e2e-results.json)
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execSync } = require('node:child_process');
const H = require('./client-staging-harness.cjs');
const cfg = H.stagingConfig();
if (cfg.projectId !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
const P = cfg.projectId, KEY = cfg.apiKey;
const DOCS = 'https://firestore.googleapis.com/v1/projects/' + P + '/databases/(default)/documents';
const DBPATH = 'projects/' + P + '/databases/(default)/documents';
const executor = require('../api/_autonomousProgression.js'), trigger = require('../api/autonomous-progression-trigger.js');
const effective = require('../assets/progression-effective-prescription.js');
const results = [];
const check = (id, pass, note) => { results.push({ id, pass: !!pass, note: note || null }); console.log((pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); return !!pass; };

// ---- Firestore REST codec
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null
  : 'timestampValue' in v ? v.timestampValue : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : null;
const decDoc = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));
const esc = k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '`' + k.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
function leafPaths(obj, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = (prefix ? prefix + '.' : '') + esc(k);
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out.push(...leafPaths(v, p)); else out.push(p);
  }
  return out;
}
let _tok = null, _tokAt = 0;
const gToken = () => { if (!_tok || Date.now() - _tokAt > 600000) { _tok = execSync('gcloud auth print-access-token', { encoding: 'utf8', shell: true }).trim(); _tokAt = Date.now(); } return _tok; };
async function http(method, url, token, body, extra) {
  const r = await fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
  return { s: r.status, b: j };
}
const ok = r => r.s >= 200 && r.s < 300;
const adminHdr = { 'x-goog-user-project': P };

// ---- REST db driver exposing exactly the Admin-SDK surface the executor uses (IAM identity; transactions are real Firestore transactions)
function ref(pathStr) { return { path: pathStr, collection: n => ref(pathStr + '/' + n), doc: id => ref(pathStr + '/' + id), get: async () => snap(await http('GET', DOCS + '/' + pathStr, gToken(), undefined, adminHdr)) }; }
const snap = r => ({ exists: r.s === 200, data: () => (r.s === 200 ? decDoc(r.b) : undefined) });
const restDb = {
  collection: n => Object.assign(ref(n), { where: (field, op, val) => ({ get: async () => {
    if (op !== '==') throw new Error('driver supports == only');
    const q = await http('POST', DOCS + ':runQuery', gToken(), { structuredQuery: { from: [{ collectionId: n }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: enc(val) } } } }, adminHdr);
    const docs = (Array.isArray(q.b) ? q.b : []).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), data: () => decDoc(x.document) }));
    return { docs };
  } }) }),
  runTransaction: async fn => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const begin = await http('POST', DOCS + ':beginTransaction', gToken(), { options: { readWrite: {} } }, adminHdr);
      const txId = begin.b.transaction, writes = [];
      const tx = {
        get: async r => snap(await http('GET', DOCS + '/' + r.path + '?transaction=' + encodeURIComponent(txId), gToken(), undefined, adminHdr)),
        set: (r, data, opts) => {
          const name = DBPATH + '/' + r.path;
          if (opts && opts.merge) writes.push({ update: { name, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }, updateMask: { fieldPaths: leafPaths(data) } });
          else writes.push({ update: { name, fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) } });
        }
      };
      let out;
      try { out = await fn(tx); } catch (e) { await http('POST', DOCS + ':rollback', gToken(), { transaction: txId }, adminHdr); throw e; }
      if (!writes.length) { await http('POST', DOCS + ':rollback', gToken(), { transaction: txId }, adminHdr); return out; }
      const c = await http('POST', DOCS + ':commit', gToken(), { writes, transaction: txId }, adminHdr);
      if (ok(c)) return out;
      if (c.s !== 409 && c.s !== 400) throw new Error('commit failed ' + c.s);
    }
    throw new Error('transaction retries exhausted');
  }
};

// ---- actors via deployed rules
const asUser = (tok, method, p, body, q) => http(method, DOCS + '/' + p + (q || ''), tok, body);
const fieldsOf = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const T0 = Date.parse('2026-09-27T12:00:00.000Z'), PID = 'pid-t570r-1';
function evidence(week, days, reps, rirReal, withRec) {
  const logs = {};
  days.forEach(d => [0, 1, 2].forEach(s => { logs['log_' + week + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: String(reps), unit: 'KG', rir: 1, rir_real: rirReal, prescriptionExerciseId: PID, ts: T0 + (week - 1) * 6e5 + d * 1000 + s }; }));
  if (withRec) logs['progrec_' + week + '_' + days[days.length - 1]] = { calculatedAt: new Date(T0 + 60000).toISOString(), recommendations: [{ prescriptionExerciseId: PID, exerciseId: 'ex-t570r', exerciseName: 'Press T570R', action: 'increase_reps', newReps: 11 }] };
  return logs;
}
const planDoc = (coachId, clientId) => ({ schema: 'vdsen-plan-v2', coachId, clientId, status: 'active', weeks: 4, daysPerWeek: 2, generatedBy: 't570r-staging', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  days: [0, 2].map(dayIndex => ({ dayIndex, label: 'Dia ' + dayIndex, exercises: [{ prescriptionExerciseId: PID, exerciseId: 'ex-t570r', exerciseName: 'Press T570R', repsRange: { min: 8, max: 12 }, sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: 1, restSeconds: 90, load: 0 })) }] })) });

async function provision(label) {
  const h = await H.seed({ noPlan: true });                                   // synthetic coach + athlete + client doc through the DEPLOYED rules
  const coachTok = (await http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + KEY, null, { email: h.coach.email, password: h.coach.password, returnSecureToken: true })).b.idToken;
  const athTok = (await http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + KEY, null, { email: h.athlete.email, password: h.athlete.password, returnSecureToken: true })).b.idToken;
  const planId = 'plan-t570r-' + label + '-' + crypto.randomBytes(3).toString('hex');
  const a = await asUser(coachTok, 'PATCH', 'plans/' + planId, { fields: fieldsOf(planDoc(h.coach.uid, h.athlete.uid)) }, '?currentDocument.exists=false');
  const b = await asUser(coachTok, 'PATCH', 'clients/' + h.athlete.uid, { fields: fieldsOf({ activePlanId: planId }) }, '?updateMask.fieldPaths=activePlanId');
  if (!ok(a) || !ok(b)) throw new Error('plan provisioning failed ' + a.s + '/' + b.s);
  return Object.assign(h, { coachTok, athTok, planId, label });
}
const setCanary = (x, canary) => http('PATCH', DOCS + '/coaches/' + x.coach.uid + '?updateMask.fieldPaths=autoApplyCanary', gToken(), { fields: { autoApplyCanary: enc(canary) } }, adminHdr);
async function athleteWrite(x, entries) {                                    // what the client does on save: root + meso docs, under the athlete's own token
  const body = { fields: fieldsOf({ planId: x.planId, entries }) }, mask = '?updateMask.fieldPaths=planId&updateMask.fieldPaths=entries';   // like the client's mergeFields: only owned fields
  const r1 = await asUser(x.athTok, 'PATCH', 'logs/' + x.athlete.uid + '/mesos/' + x.planId, body, mask), r2 = await asUser(x.athTok, 'PATCH', 'logs/' + x.athlete.uid, body, mask);
  return [r1.s, r2.s];
}
async function readMeso(x) { const r = await asUser(x.athTok, 'GET', 'logs/' + x.athlete.uid + '/mesos/' + x.planId); return r.s === 200 ? decDoc(r.b) : { _status: r.s }; }
const verifyIdToken = async t => { const r = await http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + KEY, null, { idToken: t }); if (!ok(r) || !r.b.users) throw new Error('bad token'); return { uid: r.b.users[0].localId }; };
const stable = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x < y ? -1 : 1)) : v);
const mkRes = () => ({ statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });

(async () => {
  const CRON = crypto.randomBytes(16).toString('hex');
  const handler = trigger.makeHandler({ db: restDb, enabled: true, numericApplyEnabled: true, cronSecret: CRON, verifyIdToken });
  const A = await provision('reactive'), B = await provision('cron');
  const created = [A, B];
  try {
    const relDoc = { schema: 'vdsen-autonomous-release-v1', enabled: true, clientIds: [A.athlete.uid, B.athlete.uid] };
    const relBody = { fields: Object.fromEntries(Object.entries(relDoc).map(([k, v]) => [k, enc(v)])) };
    const forgedRel = await asUser(A.athTok, 'PATCH', 'releaseControl/autonomousProgression', relBody);
    const forgedRelCoach = await asUser(A.coachTok, 'PATCH', 'releaseControl/autonomousProgression', relBody);
    check('STG00 release allowlist cannot be written by an athlete or a Coach (deployed rules)', forgedRel.s === 403 && forgedRelCoach.s === 403, forgedRel.s + '/' + forgedRelCoach.s);
    const noList = mkRes(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + A.athTok }, body: { planId: A.planId } }, noList);
    check('STG00b without the release allowlist the endpoint performs no canonical write', noList.body && noList.body.status === 'OUT_OF_ALLOWLIST', noList.body && noList.body.status);
    await http('PATCH', DOCS + '/releaseControl/autonomousProgression', gToken(), relBody, adminHdr);      // the release system lists the two synthetic athletes
    await setCanary(A, { enabled: true, clientIds: [A.athlete.uid], prescriptionExerciseIds: [] });
    await setCanary(B, { enabled: true, clientIds: [B.athlete.uid], prescriptionExerciseIds: [] });

    // 1. two comparable exposures persisted by the athlete under the DEPLOYED rules
    const w = await athleteWrite(A, evidence(1, [0, 2], 10, 3, true));
    check('STG01 athlete persists two comparable exposures through deployed rules', w.every(s => s === 200), JSON.stringify(w));

    // 2. authenticated endpoint (reactive path)
    let res = mkRes(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + A.athTok }, body: { planId: A.planId } }, res);
    check('STG02 authenticated endpoint materializes and applies (no Coach session)', res.statusCode === 200 && res.body.status === 'MATERIALIZED' && res.body.applied.length === 1 && res.body.applied[0].written === true, JSON.stringify(res.body));
    res = mkRes(); await handler({ method: 'POST', headers: {}, body: { planId: A.planId } }, res);
    check('STG03 endpoint without a token is rejected', res.statusCode === 401);
    res = mkRes(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + B.athTok }, body: { planId: A.planId } }, res);
    check('STG04 another athlete cannot trigger processing of a foreign plan', res.body && res.body.status === 'PLAN_MISMATCH', JSON.stringify(res.body));

    // 3. client sees the effective prescription from SERVER-confirmed data written by the trusted executor
    const m = await readMeso(A), plan = (await asUser(A.athTok, 'GET', 'plans/' + A.planId)); const planData = decDoc(plan.b);
    const rec = Object.values(m.progressionApplications || {})[0], ov = Object.values(m.nextExposureOverlays || {})[0];
    check('STG05 record APPLIED + overlay APPLIED exist, written by the trusted executor', rec && ov && rec.state === 'APPLIED' && ov.status === 'APPLIED' && ov.dimension === 'REPS' && JSON.stringify(rec.events).includes('trusted-progressor'), rec && JSON.stringify({ state: rec.state, dim: ov && ov.dimension, prev: ov && ov.previousValue, applied: ov && ov.appliedValue }));
    const baseSets = [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 1, restSeconds: 90, load: 0 }));
    const effIn = x => Object.assign({ clientId: A.athlete.uid, planId: A.planId, activePlanId: A.planId, pid: PID, week: ov.target.week, dayIndex: ov.target.dayIndex, records: m.progressionApplications, overlays: m.nextExposureOverlays, interventions: [], plan: planData, entries: m.entries, baseSets, canonicalOverlayRead: true }, x || {});
    const eff = effective.resolveEffective(effIn());
    check('STG06 client resolves the effective prescription for the next exposure', eff.provenance === 'CANONICAL_OVERLAY' && eff.sets.every(s => s.effective.repsTarget === ov.appliedValue && s.base.repsTarget === 10), JSON.stringify({ prov: eff.provenance, shown: eff.presentation }));
    check('STG07 base plan untouched (immutable)', (decDoc((await asUser(A.athTok, 'GET', 'plans/' + A.planId)).b)).updatedAt === '2026-09-26T00:00:00.000Z');

    // 4. forgery attempts by the athlete are denied by the deployed rules
    const f1 = await asUser(A.athTok, 'PATCH', 'logs/' + A.athlete.uid + '/mesos/' + A.planId, { fields: fieldsOf({ nextExposureOverlays: { forged: { status: 'APPLIED' } } }) }, '?updateMask.fieldPaths=nextExposureOverlays.forged');
    const f2 = await asUser(A.athTok, 'PATCH', 'logs/' + A.athlete.uid + '/mesos/' + A.planId, { fields: fieldsOf({ progressionApplications: { x: { state: 'APPLIED' } } }) }, '?updateMask.fieldPaths=progressionApplications.x');
    check('STG08 athlete cannot forge overlays or APPLIED records', f1.s === 403 && f2.s === 403, f1.s + '/' + f2.s);

    // 5. next session executed with DIFFERENT values: execution stays separate from prescription; overlay keeps being shown (started exposure)
    const next = Object.assign({}, m.entries, evidence(2, [0], 11, 2, false));
    const w2 = await athleteWrite(A, next);
    const m2 = await readMeso(A);
    const eff2 = effective.resolveEffective(effIn({ entries: m2.entries, records: m2.progressionApplications, overlays: m2.nextExposureOverlays }));
    const executed = Object.keys(m2.entries).filter(k => k.startsWith('log_2_0_0_')).map(k => m2.entries[k].reps);
    check('STG09 next exposure: executed reps recorded independently; overlay not rewritten; still shown for the started exposure', w2.every(s => s === 200) && executed.join() === '11,11,11' && eff2.provenance === 'CANONICAL_OVERLAY' && Object.values(m2.nextExposureOverlays)[0].appliedValue === ov.appliedValue, executed.join());
    // CONSUMED: the athlete appends a receipt (deployed rules), the SERVER validates it against the persisted first set and transitions
    const rcpt = { recordKey: rec.key, overlayKey: ov.key, dimension: ov.dimension, appliedValue: ov.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: new Date().toISOString() };
    const rr = await asUser(A.athTok, 'PATCH', 'logs/' + A.athlete.uid + '/mesos/' + A.planId, { fields: fieldsOf({ consumptionReceipts: { [rec.key]: rcpt } }) }, '?updateMask.fieldPaths=consumptionReceipts.' + rec.key);
    check('STG09b athlete appends the consumption receipt through deployed rules', rr.s === 200, String(rr.s));
    res = mkRes(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + A.athTok }, body: { planId: A.planId } }, res);
    const afterC = await readMeso(A), recC = Object.values(afterC.progressionApplications)[0], ovC = Object.values(afterC.nextExposureOverlays)[0];
    check('STG09c server performs APPLIED -> CONSUMED (no Monitor); prescription unchanged; one CONSUMED event', res.body.consumed && res.body.consumed[0] && res.body.consumed[0].written === true && recC.state === 'CONSUMED' && ovC.status === 'CONSUMED' && ovC.appliedValue === ov.appliedValue && recC.events.filter(e => e.state === 'CONSUMED').length === 1, JSON.stringify({ consumed: res.body.consumed, state: recC.state, ov: ovC.status, events: recC.events.map(e => e.state) }));
    res = mkRes(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + A.athTok }, body: { planId: A.planId } }, res);
    const after = await readMeso(A);
    check('STG10 reprocessing is idempotent: still one record, one overlay, one APPLIED event', Object.keys(after.progressionApplications).length >= 1 && Object.keys(after.nextExposureOverlays).length === 1 && Object.values(after.progressionApplications).filter(r => r.state === 'APPLIED').every(r => r.events.filter(e => e.state === 'APPLIED').length === 1), JSON.stringify({ recs: Object.keys(after.progressionApplications).length, ovs: Object.keys(after.nextExposureOverlays).length }));

    // 6. cron recovery: athlete B persists evidence and NEVER notifies the server
    const wb = await athleteWrite(B, evidence(1, [0, 2], 10, 3, true));
    check('STG11 athlete B persists evidence without any notification', wb.every(s => s === 200));
    const before = await readMeso(B);
    check('STG12 nothing processed before the sweep', !before.nextExposureOverlays);
    res = mkRes(); await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res); const badStatus = res.statusCode;
    res = mkRes(); await handler({ method: 'GET', headers: { authorization: 'Bearer ' + CRON } }, res);
    const mb = await readMeso(B);
    check('STG13 cron sweep (GET + secret) recovers B without the browser; wrong secret rejected', badStatus === 401 && res.statusCode === 200 && mb.nextExposureOverlays && Object.keys(mb.nextExposureOverlays).length === 1, 'sweep status ' + res.statusCode);

    // 7. canary disabled => no new application, zero writes
    await setCanary(A, { enabled: false, clientIds: [A.athlete.uid] });
    const snapBefore = stable(await readMeso(A));
    res = mkRes(); await handler({ method: 'POST', headers: { authorization: 'Bearer ' + A.athTok }, body: { planId: A.planId } }, res);
    check('STG14 canary disabled: OUT_OF_CANARY and zero writes', res.body.status === 'OUT_OF_CANARY' && stable(await readMeso(A)) === snapBefore, res.body.status);
  } catch (e) {
    check('STG_ERROR', false, String(e && e.message).slice(0, 300));
  } finally {
    await http('DELETE', DOCS + '/releaseControl/autonomousProgression', gToken(), undefined, adminHdr);
    for (const x of created) {
      try { const c = await x.cleanup(); console.log('cleanup', x.label, JSON.stringify(c)); } catch (e) { console.log('cleanup failed', x.label, e.message); }
      // belt and braces: the operator identity removes the two synthetic Auth users (only the UIDs created by this run)
      for (const uid of [x.coach.uid, x.athlete.uid]) { const d = await http('POST', 'https://identitytoolkit.googleapis.com/v1/projects/' + P + '/accounts:delete', gToken(), { localId: uid }, adminHdr); console.log('auth user removed:', d.s === 200); }
    }
  }
  const out = { project: P, at: new Date().toISOString(), driver: 'REST transactions with operator IAM identity (executor code under test is the production module)', pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results };
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 't570r-staging-e2e-results.json'), JSON.stringify(out, null, 2));
  console.log('PASS ' + out.pass + ' FAIL ' + out.fail);
  process.exit(out.fail ? 1 : 0);
})();
