#!/usr/bin/env node
'use strict';
// T575: acceptance matrix of the autonomous-progression endpoint against Firebase STAGING with synthetic accounts, with Firestore BEFORE/AFTER evidence.
//   node scripts/t575-hosted-matrix.cjs --phase off|on|all --base <https staging deployment host> --cookie-file <file> [--cron-secret-file f] [--preview-base url --preview-cookie-file f]
//   node scripts/t575-hosted-matrix.cjs --phase all --local-shim            (runs the SAME handler code locally behind an HTTP shim; labelled LOCAL_SHIM, never HOSTED)
//   node scripts/t575-hosted-matrix.cjs --teardown                          (removes the release allowlist doc; idempotent)
// Phases: `off` = switches OFF (current staging state): preparation + zero-write negatives. `on` = switches ON (needs the owner to set the Vercel staging variables).
// Every verdict is computed from Firestore snapshots taken with the operator IAM identity, independent of what the server answered. Nothing is PASS unless executed.
// Refuses any project other than vdsen-ecosistema-staging. Secrets/tokens are read from files and never printed.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), nodeHttp = require('node:http');
const H = require('./client-staging-harness.cjs');
const L = require('./lib/firestore-rest-db.cjs');
const cfg = H.stagingConfig();
if (cfg.projectId !== 'vdsen-ecosistema-staging' || L.P !== 'vdsen-ecosistema-staging') throw new Error('REFUSING: not staging');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = n => process.argv.includes('--' + n);
const phase = arg('phase', 'off'), shimMode = flag('local-shim'), teardownOnly = flag('teardown');
const readFile = f => (f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');
const KEY = cfg.apiKey, DOCS = L.DOCS, RELEASE = 'releaseControl/autonomousProgression';
const PID_IN = 'pid-t575-in', PID_OUT = 'pid-t575-out';
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const results = [], hosts = new Set(), created = { docs: [], users: [], coaches: [] };
const check = (id, pass, note, evidence) => { results.push({ id, pass: pass === null ? null : !!pass, note: note || null, evidence: evidence || undefined }); console.log((pass === null ? 'SKIP ' : pass ? 'PASS ' : 'FAIL ') + id + (note ? ' — ' + note : '')); return !!pass; };
const track = u => { try { const x = new URL(u); hosts.add(x.host + (x.pathname.match(/\/projects\/([^/]+)/) ? ' [project=' + x.pathname.match(/\/projects\/([^/]+)/)[1] + ']' : '')); } catch (_) { /* ignore */ } return u; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Firestore / Auth helpers (staging only)
const adm = (method, p, body, q) => L.http(method, track(DOCS + '/' + p + (q || '')), L.gToken(), body, L.adminHdr);
const fieldsOf = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, L.enc(v)]));
async function adminSet(p, data, maskFields) { const q = maskFields ? '?' + maskFields.map(f => 'updateMask.fieldPaths=' + f).join('&') : ''; const r = await adm('PATCH', p, { fields: fieldsOf(data) }, q); if (!L.ok(r)) throw new Error('adminSet ' + p.split('/')[0] + ' ' + r.s); if (!created.docs.includes(p)) created.docs.push(p); return r; }
async function adminGet(p) { const r = await adm('GET', p); return r.s === 200 ? L.decDoc(r.b) : null; }
const adminDel = p => adm('DELETE', p);
const asUser = (tok, method, p, body, q) => L.http(method, track(DOCS + '/' + p + (q || '')), tok, body);
async function signUp(label) {
  const email = label + '.' + crypto.randomBytes(3).toString('hex') + '@staging-ui.invalid', password = crypto.randomBytes(12).toString('base64url') + 'aA1!';
  const r = await L.http('POST', track('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + KEY), null, { email, password, returnSecureToken: true });
  if (!L.ok(r)) throw new Error('signUp ' + r.s);
  created.users.push(r.b.localId); return { uid: r.b.localId, token: r.b.idToken };
}
const stable = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x < y ? -1 : 1)) : v);
const h12 = x => crypto.createHash('sha256').update(stable(x)).digest('hex').slice(0, 12);

// ---------- synthetic data
const planDoc = (coachId, clientId, o) => ({ schema: 'vdsen-plan-v2', coachId, clientId, status: 'active', weeks: 4, daysPerWeek: 2, generatedBy: 't575-matrix', createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
  days: [0, 2].map(dayIndex => ({ dayIndex, label: 'Dia ' + dayIndex, exercises: [{ prescriptionExerciseId: o.pid, exerciseId: o.exerciseId || 'ex-t575', exerciseName: 'Press T575', repsRange: { min: 8, max: 12 },
    sets: [0, 1, 2].map(setIndex => ({ setIndex, repsTarget: 10, rirTarget: o.rirTarget === undefined ? 1 : o.rirTarget, restSeconds: 90, load: 0 })) }] })) });
function evidence(o) {
  const logs = {};
  [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { logs['log_' + w + '_' + d + '_0_s' + s] = { done: true, carga: '100', reps: o.restScenario && d === 2 ? '9' : '10', unit: 'KG', rir: o.rirTarget === undefined ? 1 : o.rirTarget, rir_real: o.rirReal !== undefined ? o.rirReal : (o.restScenario ? 1 : 3), prescriptionExerciseId: o.pid, ts: T0 + d * 1000 + s }; }));
  const rec = { prescriptionExerciseId: o.pid, exerciseId: o.exerciseId || 'ex-t575', exerciseName: 'Press T575', action: o.restScenario ? 'maintain' : (o.rirTarget === 2 ? 'increase_load' : 'increase_reps'), newReps: o.rirTarget === 2 ? 10 : 11 };
  if (o.rirTarget === 2) rec.newLoad = 5;
  logs.progrec_1_2 = { calculatedAt: new Date(T0 + 60000).toISOString(), recommendations: [rec] };
  if (o.pain) logs.postsession_1_2 = { articular: 'si', patron: 'press', eimd: 1, sleep: 8, rpe: 7 };
  return logs;
}
const ownedMask = '?updateMask.fieldPaths=planId&updateMask.fieldPaths=entries';
const athleteWrite = (a, entries) => Promise.all([asUser(a.token, 'PATCH', 'logs/' + a.uid + '/mesos/' + a.planId, { fields: fieldsOf({ planId: a.planId, entries }) }, ownedMask),
  asUser(a.token, 'PATCH', 'logs/' + a.uid, { fields: fieldsOf({ planId: a.planId, entries }) }, ownedMask)]).then(r => r.map(x => x.s));
async function mkCoach() { const c = await signUp('coach'); await adminSet('coaches/' + c.uid, { role: 'coach', displayName: 'Coach T575 (synthetic)', createdAt: new Date().toISOString() }); created.coaches.push(c.uid); return c; }
async function mkAthlete(coach, tag, o) {
  const a = await signUp('ath-' + tag); a.planId = 'plan-t575-' + tag + '-' + crypto.randomBytes(3).toString('hex'); a.tag = tag; a.pid = o.pid || PID_IN;
  await adminSet('clients/' + a.uid, { coachId: coach.uid, role: 'client', displayName: 'Atleta T575 ' + tag, activePlanId: a.planId, coachInterventions: [] });
  await adminSet('plans/' + a.planId, planDoc(coach.uid, a.uid, { pid: a.pid, rirTarget: o.rirTarget, exerciseId: o.exerciseId }));
  if (!o.noEvidence) { const w = await athleteWrite(a, evidence({ pid: a.pid, rirTarget: o.rirTarget, restScenario: o.restScenario, pain: o.pain, exerciseId: o.exerciseId, rirReal: o.rirReal })); if (w.some(s => s !== 200)) throw new Error('evidence write ' + w); }
  created.docs.push('logs/' + a.uid + '/mesos/' + a.planId, 'logs/' + a.uid, 'plans/' + a.planId, 'clients/' + a.uid); return a;
}
const setCanary = (coach, v) => adminSet('coaches/' + coach.uid, { autoApplyCanary: v }, ['autoApplyCanary']);
const setRelease = ids => adminSet(RELEASE, { schema: 'vdsen-autonomous-release-v1', enabled: true, expiresAt: new Date(Date.now() + 36e5).toISOString(), clientIds: ids });

// ---------- Firestore evidence (operator identity, independent of the server's answers)
async function snap(a) {
  const [meso, root, client, plan] = await Promise.all([adminGet('logs/' + a.uid + '/mesos/' + a.planId), adminGet('logs/' + a.uid), adminGet('clients/' + a.uid), adminGet('plans/' + a.planId)]);
  const recs = Object.values((meso && meso.progressionApplications) || {}), ovs = Object.values((meso && meso.nextExposureOverlays) || {});
  return { digest: h12({ meso, root, client, plan }), entriesDigest: h12((meso && meso.entries) || {}), planDigest: h12(plan), clientDigest: h12(client),
    records: recs.map(r => ({ state: r.state, events: (r.events || []).map(e => e.state), sra: r.sraTrace && r.sraTrace.mutation, reasons: r.magnitude && r.magnitude.reasonCodes })),
    overlays: ovs.map(o => ({ dim: o.dimension, status: o.status, applied: o.appliedValue, prev: o.previousValue, rec: o.sourceRecordKey, key: o.key })), receipts: Object.keys((meso && meso.consumptionReceipts) || {}).length, meso, plan };
}
const brief = s => ({ digest: s.digest, records: s.records, overlays: s.overlays.map(o => ({ dim: o.dim, status: o.status })), receipts: s.receipts });
const same = (b, a) => b.digest === a.digest;

// ---------- endpoint client
let BASE = null, COOKIE = '';
async function call(method, p, headers, body) {
  const url = track(BASE + p);
  const r = await fetch(url, { method, headers: Object.assign({ cookie: COOKIE, 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  return { s: r.status, j };
}
const EP = '/api/autonomous-progression-trigger';
const post = (a, planId) => call('POST', EP, { authorization: 'Bearer ' + a.token }, { planId: planId || a.planId });

// ---------- local shim: the production handler + executor, behind HTTP, backed by the staging REST driver (labelled LOCAL_SHIM)
function startShim(opts) {
  const trigger = require('../api/autonomous-progression-trigger.js');
  const verifyIdToken = async t => { const r = await L.http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + KEY, null, { idToken: t }); if (!L.ok(r) || !r.b.users) throw new Error('bad'); return { uid: r.b.users[0].localId }; };
  const handler = trigger.makeHandler({ db: L.restDb, enabled: opts.enabled, numericApplyEnabled: opts.numeric, cronSecret: opts.cronSecret, verifyIdToken, allowProbe: false });
  return new Promise(resolve => {
    const srv = nodeHttp.createServer((req, res) => {
      let b = ''; req.on('data', c => { b += c; });
      req.on('end', async () => {
        const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams.entries());
        let body; try { body = b ? JSON.parse(b) : undefined; } catch (_) { body = undefined; }
        const rs = { code: 200, status(n) { this.code = n; return this; }, json(v) { res.writeHead(this.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); return this; } };
        try { await handler({ method: req.method, headers: req.headers, body, query: q }, rs); } catch (e) { rs.status(500).json({ error: 'SHIM_ERROR' }); }
      });
    }).listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

// ---------- cleanup + verification
async function cleanup() {
  const out = { docsDeleted: 0, docsRemaining: [], usersDeleted: 0, usersRemaining: [] };
  const docs = Array.from(new Set(created.docs)).concat([RELEASE]);
  for (const p of docs) { const r = await adminDel(p); if (L.ok(r) || r.s === 404) out.docsDeleted++; }
  for (const c of created.coaches) await adminDel('coaches/' + c);
  for (const p of docs.concat(created.coaches.map(c => 'coaches/' + c))) { const g = await adm('GET', p); if (g.s !== 404) out.docsRemaining.push(p.split('/')[0]); }
  for (const uid of created.users) { const d = await L.http('POST', track('https://identitytoolkit.googleapis.com/v1/projects/' + L.P + '/accounts:delete'), L.gToken(), { localId: uid }, L.adminHdr); if (L.ok(d)) out.usersDeleted++; }
  if (created.users.length) { const lk = await L.http('POST', track('https://identitytoolkit.googleapis.com/v1/projects/' + L.P + '/accounts:lookup'), L.gToken(), { localId: created.users }, L.adminHdr); out.usersRemaining = (lk.b && lk.b.users || []).map(() => 'user'); }
  return out;
}

// ---------- phases
async function phaseOff(ctx) {
  const coach = await mkCoach(), aOK = await mkAthlete(coach, 'ok', {}), aOut = await mkAthlete(coach, 'out', {});
  await setRelease([aOK.uid]); await setCanary(coach, { enabled: true, clientIds: [aOK.uid], prescriptionExerciseIds: [PID_IN] });
  const rel = await adminGet(RELEASE), co = await adminGet('coaches/' + coach.uid);
  const synthetic = new Set(created.users);
  check('P01 allowlist holds ONLY synthetic uids created by this run (no real client)', rel.clientIds.length >= 1 && rel.clientIds.every(u => synthetic.has(u)), rel.clientIds.length + ' id(s)');
  check('P02 canary lists only synthetic clients and EXPLICIT PIDs', co.autoApplyCanary.clientIds.every(u => synthetic.has(u)) && co.autoApplyCanary.prescriptionExerciseIds.length > 0 && co.autoApplyCanary.prescriptionExerciseIds.every(x => x.startsWith('pid-t575-')), 'pids=' + co.autoApplyCanary.prescriptionExerciseIds.join(','));
  const before = await snap(aOK), beforeOut = await snap(aOut);
  check('P03 evidence is persisted and no canonical state exists yet', before.records.length === 0 && before.overlays.length === 0 && Object.keys((before.meso || {}).entries || {}).length === 7, 'records=' + before.records.length);
  const r1 = await post(aOK); const after = await snap(aOK);
  check('N01 engine switches OFF => 202 DISARMED and ZERO Firestore writes (digest unchanged)', r1.s === 202 && r1.j && r1.j.status === 'DISARMED' && same(before, after), r1.s + ' ' + (r1.j && r1.j.status), { before: brief(before), after: brief(after) });
  const r2 = await post(aOut); const afterOut = await snap(aOut);
  check('N02 athlete outside the allowlist, switches OFF => DISARMED, zero writes', r2.s === 202 && same(beforeOut, afterOut), String(r2.s), { before: brief(beforeOut), after: brief(afterOut) });
  const g1 = await call('GET', EP), g2 = await call('GET', EP, { authorization: 'Bearer wrong-secret' });
  check('N03 cron without / with a wrong secret => 401 and zero writes', g1.s === 401 && g2.s === 401 && same(after, await snap(aOK)), g1.s + '/' + g2.s);
  if (ctx.previewBase) {
    const saved = [BASE, COOKIE]; BASE = ctx.previewBase; COOKIE = readFile(ctx.previewCookieFile);
    const pr = await call('POST', EP + '?check=firestore', { authorization: 'Bearer ' + aOK.token }); [BASE, COOKIE] = saved;
    const walled = pr.s === 401 || pr.s === 302 || pr.s === 403;   // Vercel Authentication answered, the function never ran: not evidence either way
    check('N04 Preview deployment (OIDC environment:preview) cannot reach Firestore', walled ? null : pr.s === 502 && pr.j && pr.j.firestore === 'READ_FAILED', walled ? 'NOT_TESTED: blocked by the Vercel Authentication wall (no valid access cookie for the preview host)' : pr.s + ' ' + JSON.stringify(pr.j));
  } else check('N04 Preview rejection', null, 'NOT_TESTED (no --preview-base)');
  // deactivation procedure: remove allowlist + canary and prove it
  await adminDel(RELEASE); await adminSet('coaches/' + coach.uid, { autoApplyCanary: { enabled: false, clientIds: [], prescriptionExerciseIds: [] } }, ['autoApplyCanary']);
  const r3 = await post(aOK);
  check('N05 deactivation procedure: allowlist removed + canary emptied => still zero writes', same(before, await snap(aOK)), String(r3.s));
  const probe = await call('GET', EP, { authorization: 'Bearer wrong' }); check('N06 runtime still answers after teardown (recovery)', probe.s === 401, String(probe.s));
}

async function phaseOn(ctx) {
  const coach = await mkCoach(), mk = (t, o) => mkAthlete(coach, t, o || {});
  const aOK = await mk('ok'), aOut = await mk('out'), aPid = await mk('pid', { pid: PID_OUT }), aPain = await mk('pain', { pain: true }), aLoad = await mk('load', { rirTarget: 2 });
  const aRest = await mk('rest', { restScenario: true }), aCron = await mk('cron'), aE06 = await mk('e06', { noEvidence: true }), aTog = await mk('tog');
  // T578: verified-equipment LOAD. Equipment IDENTITY = public catalog entry; the INCREMENT is a SYNTHETIC Coach-configured fixture (no real gym data).
  const LV_EX = 'sf-sd-converging-lat-pulldown-plate-loaded', coach2 = await mkCoach();
  await adminSet('coaches/' + coach.uid, { equipmentIncrements: { shared: { [LV_EX]: { kind: 'STEP', step: 5, min: 0, unit: 'KG', source: 'COACH_CONFIGURED', scope: 'SHARED_EQUIPMENT', configuredAt: '2026-09-26T00:00:00.000Z', configuredBy: 'synthetic-t578', revision: 1 } }, gyms: {} } }, ['equipmentIncrements']);
  const aLV = await mk('lv', { rirTarget: 2, rirReal: 4, exerciseId: LV_EX }), aLVT = await mkAthlete(coach2, 'lvtwin', { rirTarget: 2, rirReal: 4, exerciseId: LV_EX });
  const inScope = [aOK, aPid, aPain, aLoad, aRest, aCron, aE06, aTog, aLV, aLVT];
  const arm = async () => { await setRelease(inScope.map(a => a.uid)); await setCanary(coach, { enabled: true, clientIds: inScope.concat([aOut]).map(a => a.uid), prescriptionExerciseIds: [PID_IN] }); await setCanary(coach2, { enabled: true, clientIds: [aLVT.uid], prescriptionExerciseIds: [PID_IN] }); };
  await arm();
  // H12 client outside the allowlist
  let b = await snap(aOut), r = await post(aOut), a = await snap(aOut);
  check('H12 client outside the allowlist => OUT_OF_ALLOWLIST, zero writes', r.j && r.j.status === 'OUT_OF_ALLOWLIST' && same(b, a), r.s + ' ' + (r.j && r.j.status), { before: brief(b), after: brief(a) });
  // H10 allowlist absent
  b = await snap(aTog); await adminDel(RELEASE); r = await post(aTog); a = await snap(aTog);
  check('H10 allowlist ABSENT => OUT_OF_ALLOWLIST, zero writes', r.j && r.j.status === 'OUT_OF_ALLOWLIST' && same(b, a), r.s + ' ' + (r.j && r.j.status), { before: brief(b), after: brief(a) });
  await arm();
  // H11/H25 canary disabled / revoked
  await setCanary(coach, { enabled: false, clientIds: [aTog.uid], prescriptionExerciseIds: [PID_IN] }); b = await snap(aTog); r = await post(aTog); a = await snap(aTog);
  check('H11/H25 canary disabled (revoked) => OUT_OF_CANARY, zero writes', r.j && r.j.status === 'OUT_OF_CANARY' && same(b, a), r.s + ' ' + (r.j && r.j.status), { before: brief(b), after: brief(a) });
  await arm();
  // H13 PID outside the canary
  b = await snap(aPid); r = await post(aPid); a = await snap(aPid);
  check('H13 PID outside the canary => no record, no application, zero writes', a.records.length === 0 && a.overlays.length === 0 && same(b, a), r.s + ' ' + (r.j && r.j.status), { before: brief(b), after: brief(a) });
  // H14-H16, H23 authorised flow
  b = await snap(aOK); check('H14 persisted evidence present, no canonical state before', b.records.length === 0 && Object.keys(b.meso.entries).length === 7);
  r = await post(aOK); a = await snap(aOK);
  check('H15 PENDING materialized (record history starts with PENDING)', a.records.length === 1 && a.records[0].events[0] === 'PENDING' && a.records[0].sra === 'NONE', JSON.stringify(a.records[0]), { before: brief(b), after: brief(a) });
  check('H16/H23 APPLIED REPS overlay; execution evidence, plan and client untouched', a.records[0].state === 'APPLIED' && a.overlays.length === 1 && a.overlays[0].dim === 'REPS' && a.overlays[0].status === 'APPLIED' && a.entriesDigest === b.entriesDigest && a.planDigest === b.planDigest && a.clientDigest === b.clientDigest, JSON.stringify(a.overlays));
  // H17 client reads the effective prescription from SERVER-confirmed data under its own rules
  const effective = require('../assets/progression-effective-prescription.js');
  const mr = await asUser(aOK.token, 'GET', 'logs/' + aOK.uid + '/mesos/' + aOK.planId), pr = await asUser(aOK.token, 'GET', 'plans/' + aOK.planId);
  const m = L.decDoc(mr.b), plan = L.decDoc(pr.b), ov = Object.values(m.nextExposureOverlays)[0];
  const eff = effective.resolveEffective({ clientId: aOK.uid, planId: aOK.planId, activePlanId: aOK.planId, pid: PID_IN, week: ov.target.week, dayIndex: ov.target.dayIndex, records: m.progressionApplications, overlays: m.nextExposureOverlays, interventions: [], plan, entries: m.entries, baseSets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, rirTarget: 1, restSeconds: 90, load: 0 })), canonicalOverlayRead: true });
  check('H17 athlete (own token, deployed rules) resolves the effective prescription', mr.s === 200 && eff.provenance === 'CANONICAL_OVERLAY' && eff.sets[0].effective.repsTarget === ov.appliedValue, eff.provenance + ' ' + JSON.stringify(eff.presentation));
  // H18 CONSUMED
  const t = ov.target, first = {}; first['log_' + t.week + '_' + t.dayIndex + '_0_s0'] = { done: true, carga: '100', reps: String(ov.appliedValue), unit: 'KG', rir: 1, rir_real: 2, prescriptionExerciseId: PID_IN, ts: T0 + 9e6 };
  const rec = Object.values(m.progressionApplications)[0];
  await athleteWrite(aOK, Object.assign({}, m.entries, first));
  const rr = await asUser(aOK.token, 'PATCH', 'logs/' + aOK.uid + '/mesos/' + aOK.planId, { fields: fieldsOf({ consumptionReceipts: { [rec.key]: { recordKey: rec.key, overlayKey: ov.key, dimension: ov.dimension, appliedValue: ov.appliedValue, provenance: 'CANONICAL_OVERLAY', ackAt: new Date().toISOString() } } }) }, '?updateMask.fieldPaths=consumptionReceipts.' + rec.key);
  b = await snap(aOK); r = await post(aOK); a = await snap(aOK);
  check('H18 CONSUMED: server validates receipt + persisted first set; prescription unchanged', rr.s === 200 && a.records[0].state === 'CONSUMED' && a.overlays[0].status === 'CONSUMED' && a.overlays[0].applied === b.overlays[0].applied && a.records[0].events.filter(e => e === 'CONSUMED').length === 1, JSON.stringify(a.records[0].events), { before: brief(b), after: brief(a) });
  // H19 + H26 idempotency and cron/client concurrency (fresh athlete aTog, evidence untouched)
  await arm(); b = await snap(aTog);
  const secret = ctx.cronSecret;
  const burst = await Promise.all([post(aTog), post(aTog), post(aTog), secret ? call('GET', EP, { authorization: 'Bearer ' + secret }) : Promise.resolve(null)]);
  a = await snap(aTog);
  check('H19/H26 3 concurrent POSTs + a cron sweep => exactly ONE record, ONE APPLIED event, ONE overlay', a.records.length === 1 && a.records[0].events.filter(e => e === 'APPLIED').length === 1 && a.overlays.length === 1, JSON.stringify(a.records.map(x => x.events)) + (secret ? '' : ' (cron leg skipped: no secret)'), { before: brief(b), after: brief(a) });
  // H20 E06
  const foreign = await signUp('foreign'); b = await snap(aE06);
  const den = await asUser(foreign.token, 'PATCH', 'logs/' + aE06.uid + '/mesos/' + aE06.planId, { fields: fieldsOf({ planId: aE06.planId, entries: evidence({ pid: PID_IN }) }) }, ownedMask);
  r = await post(aE06); a = await snap(aE06);
  const noRec = a.records.length === 0 && a.overlays.length === 0;
  const w1 = await athleteWrite(aE06, evidence({ pid: PID_IN })), w2 = await athleteWrite(aE06, evidence({ pid: PID_IN }));
  await post(aE06); await post(aE06); const a2 = await snap(aE06);
  check('H20 E06: denied write persists nothing and creates no progression; legitimate retry (x2) => ONE record/overlay', den.s === 403 && noRec && w1.every(x => x === 200) && w2.every(x => x === 200) && a2.records.length === 1 && a2.overlays.length === 1 && Object.keys(a2.meso.entries).length === 7, 'denied=' + den.s, { before: brief(b), after: brief(a2) });
  // H21 E08
  b = await snap(aPain); r = await post(aPain); a = await snap(aPain);
  check('H21 E08 SAFETY_CONFLICT: increase blocked, no overlay, SRA mutation NONE', a.overlays.length === 0 && r.j && r.j.applied && r.j.applied.every(x => x.written === false && /SAFETY_CONFLICT/.test(x.reason || '')) && a.entriesDigest === b.entriesDigest, JSON.stringify(r.j && r.j.applied), { before: brief(b), after: brief(a) });
  // H22 LOAD
  b = await snap(aLoad); r = await post(aLoad); a = await snap(aLoad);
  check('H22 LOAD without verified increments => BLOCKED_EQUIPMENT_DATA, no overlay', a.overlays.length === 0 && r.j && r.j.applied && r.j.applied.length === 1 && r.j.applied[0].blocked === 'BLOCKED_EQUIPMENT_DATA', JSON.stringify(r.j && r.j.applied), { before: brief(b), after: brief(a) });
  // H29 (T578) LOAD with VERIFIED equipment: applied, base plan/evidence untouched, then consumed; H30 twin WITHOUT increments stays blocked; repeats idempotent
  b = await snap(aLV); r = await post(aLV); a = await snap(aLV);
  const lvOv = a.overlays[0];
  check('H29 LOAD verified increment: APPLIED 100 -> 105 KG, evidence/plan/client untouched', a.records.length === 1 && a.records[0].state === 'APPLIED' && a.overlays.length === 1 && lvOv.dim === 'LOAD' && lvOv.status === 'APPLIED' && lvOv.prev === 100 && lvOv.applied === 105 && a.entriesDigest === b.entriesDigest && a.planDigest === b.planDigest && a.clientDigest === b.clientDigest, JSON.stringify(a.overlays) + ' ' + JSON.stringify(r.j && r.j.applied), { before: brief(b), after: brief(a) });
  const lvFull = Object.values(a.meso.nextExposureOverlays)[0], lvRec = Object.values(a.meso.progressionApplications)[0];
  check('H29b overlay carries unit, equipment identity and increment snapshot', lvFull.unit === 'KG' && lvFull.equipmentId === LV_EX && lvFull.equipmentSnapshot && lvFull.equipmentSnapshot.kind === 'STEP' && lvFull.equipmentSnapshot.source === 'COACH_CONFIGURED' && lvFull.prescriptionExerciseId === PID_IN, JSON.stringify({ unit: lvFull.unit, eq: lvFull.equipmentId, snap: lvFull.equipmentSnapshot }));
  b = await snap(aLVT); r = await post(aLVT); a = await snap(aLVT);
  check('H30 LOAD, known equipment WITHOUT increments => BLOCKED_EQUIPMENT_DATA, record PENDING, no overlay', a.overlays.length === 0 && a.records.length === 1 && a.records[0].state === 'PENDING' && r.j && r.j.applied && r.j.applied.length === 1 && r.j.applied[0].blocked === 'BLOCKED_EQUIPMENT_DATA' && a.entriesDigest === b.entriesDigest, JSON.stringify(r.j && r.j.applied), { before: brief(b), after: brief(a) });
  const lvT = lvFull.target, lvFirst = {}; lvFirst['log_' + lvT.week + '_' + lvT.dayIndex + '_0_s0'] = { done: true, carga: '105', reps: '10', unit: 'KG', rir: 2, rir_real: 2, prescriptionExerciseId: PID_IN, ts: T0 + 9e6 };
  await athleteWrite(aLV, Object.assign({}, a.meso && (await adminGet('logs/' + aLV.uid + '/mesos/' + aLV.planId)).entries, lvFirst));
  const lvRr = await asUser(aLV.token, 'PATCH', 'logs/' + aLV.uid + '/mesos/' + aLV.planId, { fields: fieldsOf({ consumptionReceipts: { [lvRec.key]: { recordKey: lvRec.key, overlayKey: lvFull.key, dimension: 'LOAD', appliedValue: 105, provenance: 'CANONICAL_OVERLAY', ackAt: new Date().toISOString() } } }) }, '?updateMask.fieldPaths=consumptionReceipts.' + lvRec.key);
  await Promise.all([post(aLV), post(aLV), post(aLV)]); a = await snap(aLV);
  check('H31 LOAD CONSUMED once (receipt + persisted first set); 3 concurrent repeats => ONE record, ONE overlay, applied value unchanged', lvRr.s === 200 && a.records.length === 1 && a.records[0].state === 'CONSUMED' && a.overlays.length === 1 && a.overlays[0].status === 'CONSUMED' && a.overlays[0].applied === 105 && a.records[0].events.filter(e => e === 'CONSUMED').length === 1 && a.records[0].events.filter(e => e === 'APPLIED').length === 1, JSON.stringify(a.records[0].events));
  // H24 REST
  b = await snap(aRest); r = await post(aRest); a = await snap(aRest);
  check('H24 REST (rule C) applied automatically', a.overlays.length === 1 && a.overlays[0].dim === 'REST' && a.overlays[0].status === 'APPLIED', JSON.stringify(a.overlays), { before: brief(b), after: brief(a) });
  // H08/H09 cron
  if (secret) {
    b = await snap(aCron); const bad = await call('GET', EP, { authorization: 'Bearer wrong' }); const mid = await snap(aCron);
    const ok = await call('GET', EP, { authorization: 'Bearer ' + secret }); a = await snap(aCron);
    check('H08 cron with a wrong secret => 401, zero writes', bad.s === 401 && same(b, mid));
    check('H09 cron with the valid secret recovers evidence nobody notified about (no browser/POST)', ok.s === 200 && a.overlays.length === 1 && a.overlays[0].status === 'APPLIED', ok.s + ' ' + JSON.stringify(ok.j), { before: brief(mid), after: brief(a) });
    const outAfter = await snap(aOut); check('H09b cron leaves the out-of-allowlist athlete untouched', outAfter.records.length === 0 && outAfter.overlays.length === 0);
  } else { check('H08 cron wrong secret', null, 'NOT_TESTED (no cron secret available)'); check('H09 cron valid secret', null, 'NOT_TESTED (no cron secret available)'); }
  // H27 preview
  if (ctx.previewBase) { const saved = [BASE, COOKIE]; BASE = ctx.previewBase; COOKIE = readFile(ctx.previewCookieFile); const pr2 = await call('POST', EP + '?check=firestore', { authorization: 'Bearer ' + aOK.token }); [BASE, COOKIE] = saved; check('H27 Preview rejected by OIDC', [401, 302, 403].includes(pr2.s) ? null : pr2.s === 502, [401, 302, 403].includes(pr2.s) ? 'NOT_TESTED: Vercel Authentication wall' : String(pr2.s)); } else check('H27 Preview rejected', null, 'NOT_TESTED (no --preview-base)');
  // H28 integrity across every athlete
  let integ = true; const notes = [];
  for (const x of inScope.concat([aOut])) { const s = await snap(x); const m2 = s.meso || {}; const recs = Object.values(m2.progressionApplications || {}), ovs = Object.values(m2.nextExposureOverlays || {});
    const consistent = ovs.every(o => recs.some(rc => rc.key === o.sourceRecordKey && rc.state === o.status && o.key === 'ovl_' + rc.key));
    const planOk = s.plan && s.plan.updatedAt === '2026-09-26T00:00:00.000Z'; if (!consistent || !planOk) { integ = false; notes.push(x.tag); } }
  check('H28 data integrity: every overlay mirrors its record; base plans immutable', integ, notes.join(',') || 'all athletes');
}

(async () => {
  const out = { project: L.P, at: new Date().toISOString(), phase, mode: shimMode ? 'LOCAL_SHIM (same handler code, staging data, NOT the hosted function)' : 'HOSTED' };
  if (teardownOnly) { await adminDel(RELEASE); console.log('release allowlist removed:', (await adm('GET', RELEASE)).s === 404); return; }
  let shim = null, cronSecret = readFile(arg('cron-secret-file', null));
  if (shimMode) {
    cronSecret = crypto.randomBytes(16).toString('hex');
    shim = await startShim({ enabled: phase !== 'off', numeric: phase !== 'off', cronSecret }); BASE = shim.base; COOKIE = '';
  } else { BASE = arg('base'); COOKIE = readFile(arg('cookie-file', null)); if (!/^https:\/\/vdsen-ecosistema-staging-t573[a-z0-9-]*\.vercel\.app$/.test(BASE || '')) throw new Error('REFUSING: base must be a vdsen-ecosistema-staging-t573 deployment host'); }
  const ctx = { cronSecret, previewBase: arg('preview-base', null), previewCookieFile: arg('preview-cookie-file', null) };
  let fatal = null;
  try { if (phase === 'off' || phase === 'all') await phaseOff(ctx); if (phase === 'on' || phase === 'all') await phaseOn(ctx); }
  catch (e) { fatal = String(e && e.message).slice(0, 200); check('MATRIX_ERROR', false, fatal); }
  finally {
    const c = await cleanup().catch(e => ({ error: String(e.message) }));
    check('CLEANUP all synthetic docs and users removed and verified absent', !c.error && c.docsRemaining.length === 0 && c.usersRemaining.length === 0, JSON.stringify(c));
    const prodTouched = Array.from(hosts).some(h => /\[project=vdsen-ecosistema\]/.test(h) || /vdsen-planes/.test(h));
    check('ZERO production access: every Firestore/Auth call targeted vdsen-ecosistema-staging', !prodTouched, Array.from(hosts).join(' | '));
    if (shim) shim.srv.close();
  }
  out.results = results; out.pass = results.filter(x => x.pass === true).length; out.fail = results.filter(x => x.pass === false).length; out.skipped = results.filter(x => x.pass === null).length;
  const file = path.join(__dirname, '..', 'docs', 't575-matrix-' + (shimMode ? 'local-shim' : 'hosted') + '-' + phase + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('PASS ' + out.pass + ' FAIL ' + out.fail + ' SKIP ' + out.skipped + ' -> ' + path.basename(file));
  process.exit(out.fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
