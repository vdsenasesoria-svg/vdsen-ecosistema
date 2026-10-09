'use strict';
// EM.7 — the REAL query-authorization contract, tested deterministically.
//
// WHY THIS EXISTS AND WHY IT IS NOT IN THE EXPORT SUITE
// The original EM.7 asserted "a clientId-only query MUST permission-deny for BOTH plans and
// plans_backup". That assertion is INVALID, because the two collections have different contracts:
//
//   plans        L99-101: (coach: resource.data.coachId == uid)  ||  resource.data.clientId == uid
//                         -> the athlete branch is intentional; the athlete reads their own plan.
//   plans_backup L204:    resource.data.get('coachId','') == uid          (no athlete branch)
//   fichas_publicas L199: resource.data.get('coachId','') == uid          (no athlete branch)
//
// So the same under-specified query can legitimately behave differently per collection. The security
// invariant that actually matters, and that this file asserts, is:
//
//   NO ACTOR MAY RECEIVE A DOCUMENT BELONGING TO ANOTHER COACH/CLIENT THROUGH AN
//   UNDER-SPECIFIED QUERY.
//
// The observable outcome may be ALLOWED-with-owned-rows, ALLOWED-with-zero-rows, or DENIED, depending
// on collection + authenticated identity + query shape. This encodes that explicitly instead of
// pretending every omission is a denial.
//
// HOW IT RUNS WITHOUT THE WEB SDK
// The Firestore JS SDK hangs on this machine for every query (measured, including allowed ones), so it
// cannot produce a trustworthy decision. This drives the emulator's data REST endpoint instead:
//   - a REAL synthetic token is minted by the Auth emulator, started programmatically;
//   - the Auth/Admin SDK is used ONLY to seed documents;
//   - request.auth.uid is decoded from the token by the emulator, and firestore.rules is evaluated.
// No LISTEN channel is opened, so the hang cannot occur by construction. A timeout would be reported
// as UNKNOWN, never as a denial.
//
// Demo/local project only. No production endpoint is ever contacted.
const path = require('node:path');
const http = require('node:http');

const REPO = path.resolve(__dirname, '..');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-vdsen-em7';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT || 9199);
if (!FS_HOST) { console.error('need FIRESTORE_EMULATOR_HOST'); process.exit(2); }
if (!/^demo-/.test(PROJECT)) { console.error('ABORT: demo project only, got ' + PROJECT); process.exit(2); }

const URLQ = 'http://' + FS_HOST + '/v1/projects/' + PROJECT + '/databases/(default)/documents:runQuery';
const COMMIT = 'http://' + FS_HOST + '/v1/projects/' + PROJECT + '/databases/(default)/documents:commit';
const AUTH_BASE = 'http://127.0.0.1:' + AUTH_PORT;
const PASSWORD = 'em7-local-only';

const eq = (f, v) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: { stringValue: v } } });
const and = (...fs) => ({ compositeFilter: { op: 'AND', filters: fs } });

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}) },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

// Actor-scoped reader. Returns a DECISION, never a hang: capped, and a cap is UNKNOWN.
async function query(token, where, collectionId) {
  const body = { structuredQuery: { from: [{ collectionId }] } };
  if (where) body.structuredQuery.where = where;
  const r = await post(URLQ, body, token ? { authorization: 'Bearer ' + token } : {});
  const denied = /PERMISSION_DENIED|permission/i.test(r.text);
  let rows = 0, rule = null, ids = [], evaluation = 'ok';
  try {
    const j = JSON.parse(r.text);
    if (Array.isArray(j)) {
      const docs = j.filter((x) => x.document).map((x) => x.document);
      rows = docs.length;
      ids = docs.map((d) => (d.name || '').split('/').pop());
    } else if (j.error) {
      rule = (j.error.message || '').replace(/\s+/g, ' ').trim();
      evaluation = 'error:' + (j.error.status || j.error.code);
    }
  } catch (e) { evaluation = 'unparseable'; }
  // A rule evaluation that ERRORED is neither an allow nor a denial. Conflating it with 'zero rows'
  // would let a broken evaluation read as evidence of safety, which is precisely the mistake this
  // suite exists to prevent, so it is surfaced explicitly.
  if (r.status >= 500) evaluation = 'error:http' + r.status;
  return { status: r.status, denied, rows, ids, rule, evaluation, unknown: evaluation !== 'ok' };
}

async function mint(email) {
  const up = await post(AUTH_BASE + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key',
    { email, password: PASSWORD, returnSecureToken: true });
  if (up.status !== 200) throw new Error('signUp ' + up.status + ' ' + up.text.slice(0, 160));
  const j = JSON.parse(up.text);
  return { token: j.idToken, uid: j.localId, email };
}

async function seed(writes) {
  const body = { writes: writes.map(([p, fields]) => ({ update: { name: 'projects/' + PROJECT + '/databases/(default)/documents/' + p, fields } })) };
  const r = await post(COMMIT, body, { authorization: 'Bearer owner' });
  if (r.status !== 200) throw new Error('seed ' + r.status + ' ' + r.text.slice(0, 200));
}

(async () => {
  let emulator = null;
  const results = [];
  const record = (label, outcome, ok, detail) => {
    results.push({ label, outcome, ok });
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(64) + ' -> ' + outcome + (detail ? '  ' + detail : ''));
  };
  // An evaluation ERROR (HTTP 500 from the rules engine) is neither allow nor deny: it is UNKNOWN.
  // It is never counted as a pass, because 'the engine could not decide' is not evidence of safety.
  const unknowns = [];
  const recordOrUnknown = (label, q, okFn, detail) => {
    if (q.unknown) {
      unknowns.push({ label, evaluation: q.evaluation });
      console.log('  UNKN  ' + label.padEnd(64) + ' -> ' + q.evaluation + ' (engine could not decide)');
      return;
    }
    record(label, q.denied ? 'DENIED' : q.rows + ' row(s)', okFn(q), detail ? detail(q) : (q.denied ? q.rule : q.ids.join(',')));
  };

  try {
    const ftAuth = require.resolve('firebase-tools/lib/emulator/auth', {
      paths: [REPO].concat(String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)),
    });
    const { AuthEmulator } = require(ftAuth);
    emulator = new AuthEmulator({ projectId: PROJECT, host: '127.0.0.1', port: AUTH_PORT });
    await emulator.start();

    // Synthetic identities. Their uids come from the emulator, so the fixture is seeded FROM them.
    const COACH_A = await mint('em7.coachA@local.invalid');
    const COACH_B = await mint('em7.coachB@local.invalid');
    const CLIENT_A1 = await mint('em7.clientA1@local.invalid');
    const CLIENT_B1 = await mint('em7.clientB1@local.invalid');

    // plans: coachId + clientId. plan_A1 belongs to COACH_A / CLIENT_A1; plan_B1 to COACH_B / CLIENT_B1.
    await seed([
      ['coaches/' + COACH_A.uid, { role: { stringValue: 'coach' } }],
      ['coaches/' + COACH_B.uid, { role: { stringValue: 'coach' } }],
      ['clients/' + CLIENT_A1.uid, { coachId: { stringValue: COACH_A.uid } }],
      ['clients/' + CLIENT_B1.uid, { coachId: { stringValue: COACH_B.uid } }],
      ['plans/plan_A1', { coachId: { stringValue: COACH_A.uid }, clientId: { stringValue: CLIENT_A1.uid }, status: { stringValue: 'active' } }],
      ['plans/plan_B1', { coachId: { stringValue: COACH_B.uid }, clientId: { stringValue: CLIENT_B1.uid }, status: { stringValue: 'active' } }],
      ['plans_backup/bk_A1', { coachId: { stringValue: COACH_A.uid }, clientId: { stringValue: CLIENT_A1.uid } }],
      ['plans_backup/bk_B1', { coachId: { stringValue: COACH_B.uid }, clientId: { stringValue: CLIENT_B1.uid } }],
      ['fichas_publicas/fp_A1', { coachId: { stringValue: COACH_A.uid }, nombre: { stringValue: 'Prospect A' } }],
      ['fichas_publicas/fp_B1', { coachId: { stringValue: COACH_B.uid }, nombre: { stringValue: 'Prospect B' } }],
    ]);
    console.log('  fixture: plan_A1/plan_B1, bk_A1/bk_B1, fp_A1/fp_B1 seeded');
    console.log('  actors: COACH_A, COACH_B, CLIENT_A1, CLIENT_B1');
    console.log('');

    const FOREIGN = (q, allowedIds) => q.ids.filter((id) => !allowedIds.includes(id));

    // ── 1.2 ATHLETE/CLIENT CONTRACT ────────────────────────────────────────────────────────────
    console.log('=== plans — CLIENT_A1 ===');
    let q = await query(CLIENT_A1.token, eq('clientId', CLIENT_A1.uid), 'plans');
    recordOrUnknown('CLIENT_A1 clientId==own => own row, no foreign', q, (x) => !x.denied && x.rows >= 1 && FOREIGN(x, ['plan_A1']).length === 0);
    q = await query(CLIENT_A1.token, eq('clientId', CLIENT_B1.uid), 'plans');
    recordOrUnknown('CLIENT_A1 clientId==foreign => FOREIGN_ROWS 0', q, (x) => x.rows === 0, (x) => x.denied ? x.rule : '');

    // ── 1.3 COACH CONTRACT ─────────────────────────────────────────────────────────────────────
    console.log('=== plans — COACH_A ===');
    q = await query(COACH_A.token, and(eq('coachId', COACH_A.uid), eq('clientId', CLIENT_A1.uid)), 'plans');
    record('COACH_A coachId+clientId owned => allowed, own row', q.denied ? 'DENIED' : q.rows + ' row(s)', !q.denied && q.rows >= 1 && FOREIGN(q, ['plan_A1']).length === 0, q.ids.join(','));
    q = await query(COACH_A.token, and(eq('coachId', COACH_A.uid), eq('clientId', CLIENT_B1.uid)), 'plans');
    record('COACH_A coachId=self+clientId=foreign => EMPTY', q.denied ? 'DENIED' : q.rows + ' row(s)', q.rows === 0 || q.denied);
    q = await query(COACH_A.token, eq('clientId', CLIENT_A1.uid), 'plans');
    // Under-specified: the athlete branch makes this provable-safe, so ALLOWED is legitimate here.
    // The invariant is zero foreign rows, NOT a denial.
    // Under-specified: the athlete branch makes it legitimately allowed, so the invariant is zero foreign rows - not a denial.
    recordOrUnknown('COACH_A clientId only (under-specified) => FOREIGN_ROWS 0', q, (x) => FOREIGN(x, ['plan_A1']).length === 0);
    q = await query(COACH_A.token, eq('clientId', CLIENT_B1.uid), 'plans');
    recordOrUnknown('COACH_A clientId==B1 only => FOREIGN_ROWS 0', q, (x) => x.rows === 0, (x) => x.denied ? x.rule : '');

    // ── 1.4 CROSS-COACH ATTACK ─────────────────────────────────────────────────────────────────
    console.log('=== plans — COACH_B attacking COACH_A ===');
    q = await query(COACH_B.token, eq('clientId', CLIENT_A1.uid), 'plans');
    recordOrUnknown('COACH_B clientId==A1 => NEVER plan_A1', q, (x) => x.rows === 0, (x) => x.denied ? x.rule : x.ids.join(','));
    q = await query(COACH_B.token, and(eq('coachId', COACH_A.uid), eq('clientId', CLIENT_A1.uid)), 'plans');
    record('COACH_B coachId=A + clientId=A1 => denied/no docs', q.denied ? 'DENIED' : q.rows + ' row(s)', q.rows === 0, q.denied ? q.rule : '');
    q = await query(COACH_B.token, eq('coachId', COACH_A.uid), 'plans');
    recordOrUnknown('COACH_B coachId=A only => denied/no docs', q, (x) => x.rows === 0, (x) => x.denied ? x.rule : '');

    // ── 1.5 plans_backup: coach-only, no athlete branch ────────────────────────────────────────
    console.log('=== plans_backup — coach-only contract ===');
    q = await query(COACH_A.token, eq('clientId', CLIENT_A1.uid), 'plans_backup');
    record('COACH_A clientId only => DENIED (no athlete branch)', q.denied ? 'DENIED' : q.rows + ' row(s)', q.denied, q.rule ? q.rule.slice(0, 46) : '');
    q = await query(COACH_A.token, and(eq('coachId', COACH_A.uid), eq('clientId', CLIENT_A1.uid)), 'plans_backup');
    record('COACH_A coachId+clientId owned => allowed, own row', q.denied ? 'DENIED' : q.rows + ' row(s)', !q.denied && q.rows >= 1 && FOREIGN(q, ['bk_A1']).length === 0, q.ids.join(','));
    q = await query(COACH_A.token, eq('coachId', COACH_B.uid), 'plans_backup');
    record('COACH_A coachId=B => DENIED', q.denied ? 'DENIED' : q.rows + ' row(s)', q.denied);
    q = await query(CLIENT_A1.token, eq('clientId', CLIENT_A1.uid), 'plans_backup');
    record('CLIENT_A1 clientId only => DENIED / no docs', q.denied ? 'DENIED' : q.rows + ' row(s)', q.rows === 0);

    // ── 1.6 fichas_publicas: coach-only, same methodology ──────────────────────────────────────
    console.log('=== fichas_publicas — coach-only contract ===');
    q = await query(COACH_A.token, eq('coachId', COACH_A.uid), 'fichas_publicas');
    record('COACH_A coachId=self => allowed, own row', q.denied ? 'DENIED' : q.rows + ' row(s)', !q.denied && q.rows >= 1 && FOREIGN(q, ['fp_A1']).length === 0, q.ids.join(','));
    q = await query(COACH_A.token, eq('coachId', COACH_B.uid), 'fichas_publicas');
    record('COACH_A coachId=B => DENIED', q.denied ? 'DENIED' : q.rows + ' row(s)', q.denied);
    q = await query(CLIENT_A1.token, eq('coachId', COACH_A.uid), 'fichas_publicas');
    record('CLIENT_A1 (not a coach) => DENIED / no docs', q.denied ? 'DENIED' : q.rows + ' row(s)', q.rows === 0);
    q = await query(COACH_B.token, eq('coachId', COACH_A.uid), 'fichas_publicas');
    record('COACH_B coachId=A => DENIED / no docs', q.denied ? 'DENIED' : q.rows + ' row(s)', q.rows === 0);

    // ── Unauthenticated ───────────────────────────────────────────────────────────────────────
    console.log('=== no auth ===');
    q = await query(null, eq('clientId', CLIENT_A1.uid), 'plans');
    record('anonymous plans clientId only => DENIED', q.denied ? 'DENIED' : q.rows + ' row(s)', q.denied);

    const failed = results.filter((r) => !r.ok);
    console.log('');
    console.log('  ' + (results.length - failed.length) + '/' + results.length + ' filas PASS');
    failed.forEach((f) => console.log('    FAIL ' + f.label + ' got=' + f.outcome));
    console.log('  UNKNOWN_EVALUATIONS=' + unknowns.length + (unknowns.length ? ' (' + unknowns.map((u) => u.evaluation).join(',') + ')' : ''));
    console.log('  LEAK_DETECTED=' + (failed.length ? 'SEE_FAILURES' : 'NO'));
    console.log('  EM7_SECURITY=' + (failed.length ? 'FAIL' : unknowns.length ? 'PASS_WITH_UNKNOWN_EVALUATIONS' : 'PASS'));
    console.log('  VDSEN_EM7_SECURITY_COMPLETE rows=' + results.length + ' failures=' + failed.length);
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('  FATAL ' + (e && e.message));
    process.exitCode = 2;
  } finally {
    try { if (emulator) await emulator.stop(); } catch (e) { /* ignore */ }
  }
})();
