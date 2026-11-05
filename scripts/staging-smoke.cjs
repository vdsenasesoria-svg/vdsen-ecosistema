#!/usr/bin/env node
// T541: disposable STAGING-ONLY smoke harness (REST against real Firebase Auth + Firestore, so the DEPLOYED rules decide).
// Refuses to run unless config/firebase-staging.config.json targets the staging project (never production / vdsen-planes).
// Creates synthetic *.invalid accounts with random runtime passwords, runs the matrix, then cleans up. Nothing sensitive is printed or stored.
//   NODE_USE_ENV_PROXY=1 node scripts/staging-smoke.cjs [--out <file.json>]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/firebase-staging.config.json'), 'utf8'));
const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects;
const FORBIDDEN = ['vdsen-ecosistema', 'vdsen-planes'];
if (cfg.projectId !== rc.staging || FORBIDDEN.includes(cfg.projectId) || !/staging/.test(cfg.projectId)) { console.error('REFUSING: not the staging project'); process.exit(2); }
const PROJECT = cfg.projectId, KEY = cfg.apiKey;
const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const F = require(path.join(root, 'tests/helpers/lifecycle-fixture.js'));

// ---- typed value codec
const enc = v => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = v => 'nullValue' in v ? null : 'booleanValue' in v ? v.booleanValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'stringValue' in v ? v.stringValue
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : 'mapValue' in v ? Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)])) : v.timestampValue || null;
const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const unfields = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));
const maskQ = m => (m || []).map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');

async function req(method, url, token, body) {
  const r = await fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, body: j };
}
const fsGet = (t, p) => req('GET', FS + '/' + p, t);
const fsSet = (t, p, data, mask) => req('PATCH', FS + '/' + p + (mask ? '?' + maskQ(mask) : ''), t, { fields: fields(data) });   // mask => partial update; none => create / replace
const fsDel = (t, p) => req('DELETE', FS + '/' + p, t);
const fsQuery = (t, parent, sq) => req('POST', FS + (parent ? '/' + parent : '') + ':runQuery', t, { structuredQuery: sq });
const okStatus = r => r.status >= 200 && r.status < 300;
const denied = r => r.status === 403;

async function signUp(label) {
  const email = label + '.' + crypto.randomBytes(4).toString('hex') + '@staging-smoke.invalid', password = crypto.randomBytes(12).toString('base64url') + 'aA1!';
  const r = await req('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + KEY, null, { email, password, returnSecureToken: true });
  if (!okStatus(r)) throw new Error('signUp failed ' + r.status + ' ' + JSON.stringify(r.body && r.body.error && r.body.error.message));
  return { label, uid: r.body.localId, token: r.body.idToken };
}
const deleteUser = u => req('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:delete?key=' + KEY, null, { idToken: u.token });

const results = [];
function check(id, invariant, expected, r, extra) {
  const actual = okStatus(r) ? 'ALLOW' : denied(r) ? 'DENY' : 'ERROR ' + r.status + (r.body && r.body.error ? ' ' + r.body.error.status : '');
  results.push({ id, invariant, expected, actual, pass: actual === expected, emulator: extra || null });
  return r;
}
const blocked = (id, invariant, why) => results.push({ id, invariant, expected: 'n/a', actual: 'BLOCKED_BY_STAGING_ADMIN_CREDENTIALS', pass: null, note: why });

(async () => {
  const created = { docs: [], users: [] }, log = () => {};
  const O = await signUp('owner-coach'), X = await signUp('other-coach'), S = await signUp('self-promoted'), A = await signUp('athlete'), A2 = await signUp('athlete2'), P0 = await signUp('probe');
  created.users.push(O, X, S, A, A2, P0);
  const rid = crypto.randomBytes(3).toString('hex'), PLAN = 'plan-smoke-' + rid, PLAN2 = 'plan2-smoke-' + rid;

  // ---- coach accounts (open registration path) and protected field
  const coachData = (n) => ({ role: 'coach', displayName: n, email: 'coach@staging-smoke.invalid', createdAt: new Date().toISOString() });
  check('COACH_CREATE_OWNER', 'open registration creates a normal coach doc', 'ALLOW', await fsSet(O.token, 'coaches/' + O.uid, coachData('Owner (synthetic)')), 'A01');
  check('COACH_CREATE_OTHER', 'open registration creates a normal coach doc', 'ALLOW', await fsSet(X.token, 'coaches/' + X.uid, coachData('Other (synthetic)')), 'A01');
  check('COACH_CREATE_SELF', 'open registration (self-promoted path)', 'ALLOW', await fsSet(S.token, 'coaches/' + S.uid, coachData('Self (synthetic)')), 'A01');
  check('COACH_CREATE_WITH_ENTITLEMENT', 'create coach doc with apiAccessEnabled=true', 'DENY', await fsSet(P0.token, 'coaches/' + P0.uid, Object.assign(coachData('probe'), { apiAccessEnabled: true })), 'A01');
  check('COACH_CREATE_WITH_ENTITLEMENT_FALSE', 'create coach doc with apiAccessEnabled=false', 'DENY', await fsSet(P0.token, 'coaches/' + P0.uid, Object.assign(coachData('probe'), { apiAccessEnabled: false })), 'A01');
  const own = await fsGet(O.token, 'coaches/' + O.uid); results.push({ id: 'ENTITLEMENT_DEFAULT', invariant: 'new coach docs carry no entitlement', expected: 'absent', actual: unfields(own.body).apiAccessEnabled === undefined ? 'absent' : 'present', pass: unfields(own.body).apiAccessEnabled === undefined, emulator: 'A01' });
  check('COACH_ADD_ENTITLEMENT_LATER', 'add apiAccessEnabled to an existing coach doc', 'DENY', await fsSet(O.token, 'coaches/' + O.uid, { apiAccessEnabled: true }, ['apiAccessEnabled']), 'A02');
  check('COACH_ENTITLEMENT_FALSE_LATER', 'add apiAccessEnabled=false later', 'DENY', await fsSet(O.token, 'coaches/' + O.uid, { apiAccessEnabled: false }, ['apiAccessEnabled']), 'A02');
  check('COACH_DELETE_RECREATE', 'delete + recreate with the entitlement', 'ALLOW', await fsDel(S.token, 'coaches/' + S.uid), 'A02 (delete of a doc WITHOUT the field is allowed)');
  check('COACH_RECREATE_WITH_ENTITLEMENT', 'recreate after delete with apiAccessEnabled=true', 'DENY', await fsSet(S.token, 'coaches/' + S.uid, Object.assign(coachData('Self (synthetic)'), { apiAccessEnabled: true })), 'A02');
  check('COACH_RECREATE_NORMAL', 'recreate normally', 'ALLOW', await fsSet(S.token, 'coaches/' + S.uid, coachData('Self (synthetic)')), 'A01');
  blocked('ENTITLEMENT_TRUE_FALSE_FLIP', 'flip / drop / delete an entitlement-bearing doc (needs an existing TRUE entitlement, provisioned only by the Admin SDK)', 'covered by emulator A02/A03');
  check('COACH_PROFILE_UPDATE', 'normal profile update', 'ALLOW', await fsSet(O.token, 'coaches/' + O.uid, { displayName: 'Owner (synthetic) v2', phone: '+000 synthetic' }, ['displayName', 'phone']), 'A02');
  check('ATHLETE_SELF_PROMOTE_PRE', 'athlete uid (no client doc yet) can register: reported product behavior', 'ALLOW', await fsSet(P0.token, 'coaches/' + P0.uid, coachData('probe plain')), 'T07');

  // ---- client ownership
  const cli = (coachId, name) => ({ coachId, email: name + '@staging-smoke.invalid', displayName: name, role: 'client', activePlanId: null, nutritionPlan: {}, supplementPlan: {}, coachInterventions: [] });
  check('CLIENT_CREATE_OWNER', 'owner creates its client (legit onboarding)', 'ALLOW', await fsSet(O.token, 'clients/' + A.uid, cli(O.uid, 'athlete-synth')), 'O02');
  check('CLIENT_CREATE_OTHER', 'other coach creates its own client', 'ALLOW', await fsSet(X.token, 'clients/' + A2.uid, cli(X.uid, 'athlete2-synth')), 'O02');
  check('CLIENT_CREATE_UNDER_OTHER', 'create a client under another coach id', 'DENY', await fsSet(S.token, 'clients/spoof-' + rid, cli(X.uid, 'spoof')), 'O02');
  check('CLIENT_ADOPT_OWNED', 'overwrite / adopt an existing owned client', 'DENY', await fsSet(S.token, 'clients/' + A.uid, cli(S.uid, 'evil')), 'O02');
  check('CLIENT_STEAL_UPDATE', 'other coach reassigns an owned client', 'DENY', await fsSet(X.token, 'clients/' + A.uid, { coachId: X.uid }, ['coachId']), 'O01');
  check('CLIENT_OWNER_REASSIGN', 'owner reassigns (immutable)', 'DENY', await fsSet(O.token, 'clients/' + A.uid, { coachId: X.uid }, ['coachId']), 'O01');
  check('CLIENT_ATHLETE_ASSIGN', 'athlete alters coachId', 'DENY', await fsSet(A.token, 'clients/' + A.uid, { coachId: S.uid }, ['coachId']), 'O01');
  check('CLIENT_READ_ATHLETE', 'athlete reads own client', 'ALLOW', await fsGet(A.token, 'clients/' + A.uid), 'T08');
  check('CLIENT_READ_OWNER', 'owner reads its client', 'ALLOW', await fsGet(O.token, 'clients/' + A.uid), 'T01');
  check('CLIENT_READ_OTHER', 'other coach reads owner client', 'DENY', await fsGet(X.token, 'clients/' + A.uid), 'T01');
  check('CLIENT_READ_SELF', 'self-promoted coach reads owner client', 'DENY', await fsGet(S.token, 'clients/' + A.uid), 'T01');
  check('CLIENT_READ_UNAUTH', 'unauthenticated reads a client', 'DENY', await fsGet(null, 'clients/' + A.uid), 'M01');
  check('CLIENT_READ_ATHLETE_OTHER', 'athlete reads another athlete client', 'DENY', await fsGet(A.token, 'clients/' + A2.uid), 'T08');
  check('CLIENT_WRITE_OTHER', 'other coach updates owner client', 'DENY', await fsSet(X.token, 'clients/' + A.uid, { displayName: 'x' }, ['displayName']), 'T05');
  check('CLIENT_WRITE_SELF', 'self-promoted coach updates owner client', 'DENY', await fsSet(S.token, 'clients/' + A.uid, { displayName: 'x' }, ['displayName']), 'T05');
  check('CLIENT_INTERVENTIONS_ATHLETE', 'athlete forges coachInterventions', 'DENY', await fsSet(A.token, 'clients/' + A.uid, { coachInterventions: [{ id: 'forged' }] }, ['coachInterventions']), 'R15');
  check('CLIENT_OWNER_UPDATE', 'owner updates permitted own-client fields', 'ALLOW', await fsSet(O.token, 'clients/' + A.uid, { displayName: 'athlete-synth v2' }, ['displayName']), 'O02');
  check('CLIENT_LIST_OTHER_OF_OWNER', 'other coach lists the owner clients', 'DENY', await fsQuery(X.token, '', { from: [{ collectionId: 'clients' }], where: { fieldFilter: { field: { fieldPath: 'coachId' }, op: 'EQUAL', value: enc(O.uid) } } }), 'T01');
  check('CLIENT_LIST_OWNER', 'owner lists its clients', 'ALLOW', await fsQuery(O.token, '', { from: [{ collectionId: 'clients' }], where: { fieldFilter: { field: { fieldPath: 'coachId' }, op: 'EQUAL', value: enc(O.uid) } } }), 'T01');
  check('CLIENT_ORPHAN_ENUM', 'enumerate unowned clients', 'DENY', await fsQuery(S.token, '', { from: [{ collectionId: 'clients' }], where: { fieldFilter: { field: { fieldPath: 'coachId' }, op: 'EQUAL', value: enc('') } } }), 'T10');
  blocked('ORPHAN_CLAIM_EXISTING_UNOWNED', 'claim a pre-existing UNOWNED legacy client (creating an orphan needs the Admin SDK: no legitimate client-side path makes one)', 'covered by emulator O01');

  // ---- plan + execution evidence
  const sc = F.scenario({ clientId: A.uid, planId: PLAN });
  check('PLAN_CREATE_OWNER', 'owner creates the client plan', 'ALLOW', await fsSet(O.token, 'plans/' + PLAN, Object.assign({}, sc.plan, { coachId: O.uid, clientId: A.uid, status: 'draft' })), 'tenant');
  check('CLIENT_ACTIVATE_PLAN', 'owner points the client at the plan', 'ALLOW', await fsSet(O.token, 'clients/' + A.uid, { activePlanId: PLAN }, ['activePlanId']), 'O02');
  check('PLAN_READ_ATHLETE', 'athlete reads its plan', 'ALLOW', await fsGet(A.token, 'plans/' + PLAN), 'tenant');
  check('PLAN_READ_OTHER', 'other coach reads the plan', 'DENY', await fsGet(X.token, 'plans/' + PLAN), 'tenant');
  const entries = Object.assign({ progrec_1_2: { calculatedAt: '2026-09-27T12:00:00.000Z', recommendations: [{ prescriptionExerciseId: 'pid-1', exerciseId: sc.exerciseId, exerciseName: 'X', action: 'increase_load', newLoad: 5, newReps: 10 }] } }, sc.entries);
  const payload = { entries, currentWeek: 1, planId: PLAN, exerciseUnits: { '0_0': 'KG' }, exerciseHistory: { x: { load: '100' } }, updatedAt: 1000 }, keys = Object.keys(payload);
  check('EVIDENCE_ATHLETE_SAVE_MESO', 'athlete saves execution (meso, mergeFields-style)', 'ALLOW', await fsSet(A.token, 'logs/' + A.uid + '/mesos/' + PLAN, payload, keys), 'L01');
  check('EVIDENCE_ATHLETE_SAVE_ROOT', 'athlete saves execution (root log)', 'ALLOW', await fsSet(A.token, 'logs/' + A.uid, payload, keys), 'L01');
  check('EVIDENCE_ATHLETE_SET', 'athlete logs load / reps / observed RIR', 'ALLOW', await fsSet(A.token, 'logs/' + A.uid + '/mesos/' + PLAN, { entries: Object.assign({}, entries, { log_1_0_0_s3: { carga: '102.5', reps: '10', unit: 'KG', done: true, rir_real: 2, prescriptionExerciseId: 'pid-1', ts: 5 } }) }, ['entries']), 'L03');
  const canon = { progressionApplications: { v1_aaaaaaaaaaaaaaaa: { state: 'APPLIED' } }, nextExposureOverlays: { ovl_x: { status: 'APPLIED', appliedValue: 999 } }, progressionApplicationSummary: { counts: {} } };
  for (const k of Object.keys(canon)) {
    check('CANON_ATHLETE_' + k, 'athlete writes ' + k, 'DENY', await fsSet(A.token, 'logs/' + A.uid + '/mesos/' + PLAN, { [k]: canon[k] }, [k]), 'R01-R15');
    check('CANON_OTHER_' + k, 'other coach writes ' + k, 'DENY', await fsSet(X.token, 'logs/' + A.uid + '/mesos/' + PLAN, { [k]: canon[k] }, [k]), 'T05');
    check('CANON_SELF_' + k, 'self-promoted coach writes ' + k, 'DENY', await fsSet(S.token, 'logs/' + A.uid + '/mesos/' + PLAN, { [k]: canon[k] }, [k]), 'T05');
  }
  check('CANON_ATHLETE_FAKE_ROOT_SUMMARY', 'athlete alters the root summary', 'DENY', await fsSet(A.token, 'logs/' + A.uid, { progressionApplicationSummary: { counts: {} } }, ['progressionApplicationSummary']), 'R15');
  check('EVIDENCE_OWNER_READ', 'owner reads execution evidence', 'ALLOW', await fsGet(O.token, 'logs/' + A.uid + '/mesos/' + PLAN), 'T02');
  for (const [who, U] of [['OTHER', X], ['SELF', S]]) {
    check('EVIDENCE_' + who + '_READ_META', who + ' coach reads logs (meso)', 'DENY', await fsGet(U.token, 'logs/' + A.uid + '/mesos/' + PLAN), 'T02');
    check('EVIDENCE_' + who + '_READ_ROOT', who + ' coach reads logs (root)', 'DENY', await fsGet(U.token, 'logs/' + A.uid), 'T02');
    check('EVIDENCE_' + who + '_ENTRIES', who + ' poisons entries', 'DENY', await fsSet(U.token, 'logs/' + A.uid + '/mesos/' + PLAN, { entries: { log_9_0_0_s0: { carga: '999', done: true } } }, ['entries']), 'T04');
    check('EVIDENCE_' + who + '_WEEK', who + ' changes currentWeek', 'DENY', await fsSet(U.token, 'logs/' + A.uid, { currentWeek: 9 }, ['currentWeek']), 'T04');
    check('EVIDENCE_' + who + '_HISTORY', who + ' poisons exerciseHistory', 'DENY', await fsSet(U.token, 'logs/' + A.uid, { exerciseHistory: { x: { load: '1' } } }, ['exerciseHistory']), 'T04');
    check('EVIDENCE_' + who + '_PROGREC', who + ' forges progrec evidence', 'DENY', await fsSet(U.token, 'logs/' + A.uid + '/mesos/' + PLAN, { entries: { progrec_1_2: { calculatedAt: 'x', recommendations: [] } } }, ['entries']), 'T04');
    check('EVIDENCE_' + who + '_DELETE', who + ' deletes logs', 'DENY', await fsDel(U.token, 'logs/' + A.uid + '/mesos/' + PLAN), 'T04');
  }
  check('EVIDENCE_ATHLETE_OTHER_ATHLETE', 'athlete writes another athlete logs', 'DENY', await fsSet(A2.token, 'logs/' + A.uid, { currentWeek: 5 }, ['currentWeek']), 'T08');
  check('EVIDENCE_UNAUTH', 'unauthenticated reads logs', 'DENY', await fsGet(null, 'logs/' + A.uid), 'M01');

  // ---- canonical materialization (owner Coach authority), real evidence read back from staging
  const rd = async (t, p) => unfields((await fsGet(t, p)).body);
  const clientData = await rd(O.token, 'clients/' + A.uid), planData = await rd(O.token, 'plans/' + PLAN), mesoData = await rd(O.token, 'logs/' + A.uid + '/mesos/' + PLAN), rootData = await rd(O.token, 'logs/' + A.uid);
  const auth = shadow.selectLogAuthority(mesoData, rootData, PLAN);
  const out = shadow.materializeRecords({ clientId: A.uid, planId: PLAN, activePlanId: clientData.activePlanId, plan: planData, interventions: clientData.coachInterventions, entries: auth.entries, records: {}, at: new Date().toISOString(), isStarted: consumer.targetStarted });
  results.push({ id: 'MATERIALIZER_ELIGIBLE', invariant: 'athlete evidence in staging -> owner materializer produces a PENDING candidate (flag off)', expected: '1 PENDING', actual: out.created.length + ' ' + (out.created[0] ? out.records[out.created[0]].state : 'none'), pass: out.created.length === 1 && out.records[out.created[0]].state === 'PENDING', emulator: 'T476 #2-4' });
  const summary = shadow.summarize(out.records, PLAN);
  check('CANON_OTHER_PENDING', 'other coach writes the PENDING record', 'DENY', await fsSet(X.token, 'logs/' + A.uid + '/mesos/' + PLAN, { progressionApplications: out.records }, ['progressionApplications']), 'T05');
  check('CANON_SELF_PENDING', 'self-promoted coach writes the PENDING record', 'DENY', await fsSet(S.token, 'logs/' + A.uid + '/mesos/' + PLAN, { progressionApplications: out.records }, ['progressionApplications']), 'T05');
  check('CANON_ATHLETE_PENDING', 'athlete writes the PENDING record', 'DENY', await fsSet(A.token, 'logs/' + A.uid + '/mesos/' + PLAN, { progressionApplications: out.records }, ['progressionApplications']), 'R01');
  check('CANON_OWNER_PENDING', 'OWNER coach materializes PENDING (meso)', 'ALLOW', await fsSet(O.token, 'logs/' + A.uid + '/mesos/' + PLAN, { progressionApplications: out.records, progressionApplicationSummary: summary }, ['progressionApplications', 'progressionApplicationSummary']), 'T476 #2');
  check('CANON_OWNER_SUMMARY_ROOT', 'owner mirrors the root summary', 'ALLOW', await fsSet(O.token, 'logs/' + A.uid, { progressionApplicationSummary: summary }, ['progressionApplicationSummary']), 'T476 #2');
  const back = await rd(O.token, 'logs/' + A.uid + '/mesos/' + PLAN);
  results.push({ id: 'NO_APPLIED_STATE', invariant: 'no APPLIED record / overlay exists (flag off)', expected: 'none', actual: (Object.values(back.progressionApplications || {}).some(r => r.state === 'APPLIED') || back.nextExposureOverlays) ? 'PRESENT' : 'none', pass: !Object.values(back.progressionApplications || {}).some(r => r.state === 'APPLIED') && !back.nextExposureOverlays, emulator: 'T529/T535' });
  check('CANON_ATHLETE_RECEIPT', 'athlete appends a consumption receipt (append-only)', 'ALLOW', await fsSet(A.token, 'logs/' + A.uid + '/mesos/' + PLAN, { consumptionReceipts: { v1_aaaaaaaaaaaaaaaa: { ackAt: 'x' } } }, ['consumptionReceipts.v1_aaaaaaaaaaaaaaaa']), 'L04');
  check('CANON_ATHLETE_RECEIPT_EDIT', 'athlete edits an existing receipt', 'DENY', await fsSet(A.token, 'logs/' + A.uid + '/mesos/' + PLAN, { consumptionReceipts: { v1_aaaaaaaaaaaaaaaa: { ackAt: 'y' } } }, ['consumptionReceipts.v1_aaaaaaaaaaaaaaaa']), 'L04');

  // ---- phone index
  const digits = '9990' + crypto.randomInt(1e6, 9e6);
  check('PHONE_OWNER_CREATE', 'owner creates an index entry for its client', 'ALLOW', await fsSet(O.token, 'phone_index/' + digits, { email: 'athlete-synth@staging-smoke.invalid', uid: A.uid }), 'T06');
  check('PHONE_PUBLIC_READ', 'public lookup (pre-login) works unauthenticated', 'ALLOW', await fsGet(null, 'phone_index/' + digits), 'T06');
  check('PHONE_OTHER_REDIRECT', 'other coach redirects the entry to its own client', 'DENY', await fsSet(X.token, 'phone_index/' + digits, { email: 'evil@staging-smoke.invalid', uid: A2.uid }), 'T06');
  check('PHONE_OTHER_REPOINT_TO_VICTIM', 'other coach points an entry at the victim client', 'DENY', await fsSet(X.token, 'phone_index/9990' + crypto.randomInt(1e6, 9e6), { email: 'x@staging-smoke.invalid', uid: A.uid }), 'T06');
  check('PHONE_OTHER_DELETE', 'other coach deletes the entry', 'DENY', await fsDel(X.token, 'phone_index/' + digits), 'T06');
  check('PHONE_OWNER_UPDATE', 'owner repairs its entry', 'ALLOW', await fsSet(O.token, 'phone_index/' + digits, { updatedAt: 'now' }, ['updatedAt']), 'T06');

  // ---- private coach collections
  const tpl = 'tpl-' + rid, bk = 'bk-' + rid, fp = 'fp-' + rid;
  check('TPL_OWNER_CREATE', 'owner creates a template', 'ALLOW', await fsSet(O.token, 'templates/' + tpl, { name: 'T', coachId: O.uid, days: [] }), 'T09');
  check('TPL_OWNER_READ', 'owner reads its template', 'ALLOW', await fsGet(O.token, 'templates/' + tpl), 'T03');
  check('TPL_OTHER_READ', 'other coach reads it', 'DENY', await fsGet(X.token, 'templates/' + tpl), 'T03');
  check('TPL_SELF_READ', 'self-promoted coach reads it', 'DENY', await fsGet(S.token, 'templates/' + tpl), 'T03');
  check('TPL_OTHER_WRITE', 'other coach edits it', 'DENY', await fsSet(X.token, 'templates/' + tpl, { name: 'evil' }, ['name']), 'T03');
  check('COMPENDIO_OWNER', 'owner writes / reads its compendium', 'ALLOW', await fsSet(O.token, 'compendio/' + O.uid, { content: 'synthetic' }), 'T09');
  check('COMPENDIO_OTHER_READ', 'other coach reads the owner compendium', 'DENY', await fsGet(X.token, 'compendio/' + O.uid), 'T03');
  check('COMPENDIO_ATHLETE_READ', 'athlete reads the owner compendium', 'DENY', await fsGet(A.token, 'compendio/' + O.uid), 'T03');
  check('BACKUP_OWNER_CREATE', 'owner creates a plan backup', 'ALLOW', await fsSet(O.token, 'plans_backup/' + bk, { coachId: O.uid, clientId: A.uid, originalPlanId: PLAN, backedUpAt: '2026-09-30T00:00:00.000Z' }), 'T09');
  check('BACKUP_OTHER_READ', 'other coach reads it', 'DENY', await fsGet(X.token, 'plans_backup/' + bk), 'T03');
  check('BACKUP_OTHER_CREATE_FOR_OWNER', 'other coach creates a backup naming the owner', 'DENY', await fsSet(X.token, 'plans_backup/spoof-' + rid, { coachId: O.uid, clientId: A.uid }), 'T03');
  check('FICHA_ATHLETE_WRITE', 'athlete writes its onboarding form', 'ALLOW', await fsSet(A.token, 'fichas_onboarding/' + A.uid, { data: { peso: 80 } }), 'T08');
  check('FICHA_OWNER_READ', 'owner reads the form', 'ALLOW', await fsGet(O.token, 'fichas_onboarding/' + A.uid), 'T02');
  check('FICHA_OTHER_READ', 'other coach reads the form', 'DENY', await fsGet(X.token, 'fichas_onboarding/' + A.uid), 'T02');
  check('FICHA_SELF_READ', 'self-promoted coach reads the form', 'DENY', await fsGet(S.token, 'fichas_onboarding/' + A.uid), 'T02');
  check('FICHA_ATHLETE2_READ', 'another athlete reads the form', 'DENY', await fsGet(A2.token, 'fichas_onboarding/' + A.uid), 'T08');
  check('PROSPECT_PUBLIC_CREATE', 'public prospect form creation (unauthenticated)', 'ALLOW', await fsSet(null, 'fichas_publicas/' + fp, { coachId: O.uid, nombre: 'Prospect (synthetic)' }), 'public');
  check('PROSPECT_OWNER_READ', 'owner reads its prospect', 'ALLOW', await fsGet(O.token, 'fichas_publicas/' + fp), 'T03');
  check('PROSPECT_OTHER_READ', 'other coach reads it', 'DENY', await fsGet(X.token, 'fichas_publicas/' + fp), 'T03');
  check('PROSPECT_UNAUTH_READ', 'unauthenticated reads it', 'DENY', await fsGet(null, 'fichas_publicas/' + fp), 'T03');
  check('SESSIONS_CLOSED', 'legacy sessions collection is closed', 'DENY', await fsSet(O.token, 'sessions/s-' + rid, { x: 1 }), 'T11');

  // ---- equipment metadata
  const inc = { shared: { 'functional-dumbbells': { kind: 'STEP', step: 2.5, unit: 'KG', source: 'COACH_CONFIGURED' } }, gyms: {} };
  check('EQUIP_OWNER', 'owner writes its equipmentIncrements', 'ALLOW', await fsSet(O.token, 'coaches/' + O.uid, { equipmentIncrements: inc }, ['equipmentIncrements']), 'E01');
  check('EQUIP_OTHER', 'other coach writes the owner equipmentIncrements', 'DENY', await fsSet(X.token, 'coaches/' + O.uid, { equipmentIncrements: inc }, ['equipmentIncrements']), 'E01');
  check('EQUIP_ATHLETE', 'athlete writes the owner equipmentIncrements', 'DENY', await fsSet(A.token, 'coaches/' + O.uid, { equipmentIncrements: inc }, ['equipmentIncrements']), 'E01');
  const ex = 'ex-' + rid;
  check('EXERCISE_OWNER_CREATE', 'owner creates an exercise in its namespace', 'ALLOW', await fsSet(O.token, 'exercises/' + ex, { name: 'X', coachId: O.uid }), 'E02');
  check('EXERCISE_OTHER_INCREMENT', 'other coach edits loadIncrement of the owner exercise', 'DENY', await fsSet(X.token, 'exercises/' + ex, { loadIncrement: { kind: 'STEP', step: 1 } }, ['loadIncrement']), 'E02');
  check('EXERCISE_OWNER_INCREMENT', 'owner edits loadIncrement', 'ALLOW', await fsSet(O.token, 'exercises/' + ex, { loadIncrement: { kind: 'STEP', step: 2.5, unit: 'KG', source: 'EXERCISE_METADATA' } }, ['loadIncrement']), 'E02');
  check('EXERCISE_ATHLETE_CREATE', 'athlete creates an exercise', 'DENY', await fsSet(A.token, 'exercises/spoof-' + rid, { name: 'spoof', coachId: A.uid }), 'E02');

  // ---- athlete self-promotion (athlete with a client doc)
  check('ATHLETE_SELF_PROMOTE', 'athlete WITH a client doc creates a coach doc', 'DENY', await fsSet(A.token, 'coaches/' + A.uid, coachData('athlete')), 'T07');
  check('COACH_DOC_READ_OTHER', 'other coach reads the owner coach doc', 'DENY', await fsGet(X.token, 'coaches/' + O.uid), 'M01');

  // ---- plans_backup runtime query (needs the composite index)
  const q = { from: [{ collectionId: 'plans_backup' }], where: { compositeFilter: { op: 'AND', filters: [{ fieldFilter: { field: { fieldPath: 'coachId' }, op: 'EQUAL', value: enc(O.uid) } }, { fieldFilter: { field: { fieldPath: 'clientId' }, op: 'EQUAL', value: enc(A.uid) } }] } }, orderBy: [{ field: { fieldPath: 'backedUpAt' }, direction: 'DESCENDING' }], limit: 1 };
  let qr = await fsQuery(O.token, '', q), tries = 0;
  while (!okStatus(qr) && qr.body && JSON.stringify(qr.body).includes('index') && tries++ < 20) { await new Promise(r => setTimeout(r, 15000)); qr = await fsQuery(O.token, '', q); }
  const rows = okStatus(qr) ? (qr.body || []).filter(x => x.document) : [];
  results.push({ id: 'PLANS_BACKUP_QUERY', invariant: 'runtime backup query (coachId == uid, clientId == c, order backedUpAt desc, limit 1) runs without a missing-index error', expected: 'ALLOW + 1 row', actual: okStatus(qr) ? 'ALLOW ' + rows.length + ' row(s)' : 'WAITING_FOR_INDEX (' + qr.status + ')', pass: okStatus(qr) && rows.length === 1 ? true : (okStatus(qr) ? false : null), emulator: 'T03' });
  check('PLANS_BACKUP_QUERY_OTHER', 'other coach runs the same query for the owner coach id', 'DENY', await fsQuery(X.token, '', q), 'T03');

  // ---- cleanup (reverse dependency order; each actor deletes what it owns)
  const del = async (t, p) => { const r = await fsDel(t, p); created.docs.push({ p: p.split('/')[0], ok: okStatus(r) || r.status === 404 }); };
  await del(O.token, 'logs/' + A.uid + '/mesos/' + PLAN); await del(O.token, 'logs/' + A.uid); await del(O.token, 'plans_backup/' + bk); await del(O.token, 'templates/' + tpl); await del(O.token, 'compendio/' + O.uid);
  await del(O.token, 'fichas_onboarding/' + A.uid); await del(O.token, 'fichas_publicas/' + fp); await del(O.token, 'phone_index/' + digits); await del(O.token, 'exercises/' + ex); await del(O.token, 'plans/' + PLAN);
  await del(O.token, 'clients/' + A.uid); await del(X.token, 'clients/' + A2.uid);
  for (const [t, u] of [[O.token, O.uid], [X.token, X.uid], [S.token, S.uid], [P0.token, P0.uid]]) await del(t, 'coaches/' + u);
  const userCleanup = []; for (const u of created.users) userCleanup.push((await deleteUser(u)).status);
  const residues = created.docs.filter(d => !d.ok).map(d => d.p);
  const summary2 = { project: PROJECT, checks: results.length, passed: results.filter(r => r.pass === true).length, failed: results.filter(r => r.pass === false).map(r => r.id), pending: results.filter(r => r.pass === null).map(r => r.id + ':' + r.actual),
    cleanup: { docsDeleted: created.docs.filter(d => d.ok).length, docResidueCollections: residues, usersCreated: created.users.length, usersDeleted: userCleanup.filter(s => s === 200).length } };
  const outFile = process.argv.indexOf('--out') > 0 ? process.argv[process.argv.indexOf('--out') + 1] : null;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary: summary2, results }, null, 2));
  console.log(JSON.stringify(summary2, null, 2));
  process.exit(summary2.failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR: ' + e.message); process.exit(3); });
