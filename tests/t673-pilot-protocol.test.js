'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const P = require('../scripts/pilot/window-protocol.cjs'), C = require('../scripts/pilot/ayrton-canary.cjs');
const R = require('../scripts/pilot/ayrton-runtime.cjs'), G = require('../scripts/release/numeric-guard.cjs');
const makeHandler = require('../api/autonomous-progression-trigger.js').makeHandler;
// Identity only; every document, deployment and adapter below is isolated in memory. No network or credentials.
const UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
const w = () => ({ schema: 'vdsen-ayrton-window-v1', uid: UID, coachId: 'test-coach', planId: 'test-plan',
  runtimeSha: 'a'.repeat(40), deployment: 'dpl_pilot', operationId: 'isolated-window-01', expiresAt: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z') });
const snapshot = () => ({ uid: UID, coachId: 'test-coach', client: { coachId: 'test-coach', activePlanId: 'test-plan' }, release: { enabled: false, clientIds: [UID] }, coach: { autoApplyCanary: { enabled: false, clientIds: [UID] } } });
const base = { deployment: 'dpl_off', runtimeSha: R.T671 };
function harness(overrides = {}) {
  let current = base.deployment; const calls = [], reports = [];
  const io = {
    validateSource: async () => {}, validateBaseline: async () => {}, snapshot: async () => snapshot(),
    current: async () => current, offProof: async () => G.evaluateProductionEnv([]), assertNoPriorOperation: async () => {},
    save: async r => reports.push(JSON.parse(JSON.stringify(r))),
    stage: async () => { calls.push('stage'); return { id: 'dpl_pilot', url: 'isolated.vercel.app', projectId: P.PROJECT, teamId: P.TEAM, sha: 'a'.repeat(40), state: 'READY', target: 'production', envNames: G.KNOWN_FLAGS }; },
    promote: async id => { calls.push('promote'); current = id; },
    rollback: async id => { calls.push('rollback'); current = id; }, verifyBytes: async () => calls.push('bytes'), ...overrides,
  }; return { io, calls, reports };
}
test('T673 OFF transition never reads old sensitive values, keeps nonproduction scope and rejects ambiguity/shared links', () => {
  const sensitive = { id: 'env1', key: G.FLAG_GLOBAL, type: 'sensitive', target: ['production'], updatedAt: 123 };
  Object.defineProperty(sensitive, 'value', { get() { throw Error('SECRET_WAS_READ'); } });
  const p = P.offTransition([sensitive]); assert.equal(p.actions[0].newValue, 'false'); assert.equal(p.retrieveOldValues, false);
  assert.equal(p.redeploy, false); assert.equal(p.restoreUnknownValues, false);
  assert.equal(P.offTransition([]).status, 'DISARMED');
  for (const entries of [[sensitive, sensitive], [{ ...sensitive, target: ['production', 'preview'] }], [{ ...sensitive, type: 'shared' }], [{ ...sensitive, gitBranch: 'other' }]]) assert.throws(() => P.offTransition(entries));
  assert.equal(P.offTransition([{ ...sensitive, target: ['preview'] }]).actions.length, 0);
  assert.throws(() => G.evaluateProductionEnv([sensitive]), e => e.code === 'VALUE_NOT_READABLE');
  assert.throws(() => G.evaluateProductionEnv([{ key: G.FLAG_GLOBAL, target: ['production'], type: 'plain', value: 'false', visibility: 'secret' }]), e => e.code === 'VALUE_NOT_READABLE');
});
test('T673 windows accept only Ayrton with a fixed unexpired bounded TTL and no active renewal, plan change or foreign fence', () => {
  P.windowSpec(w());
  for (const patch of [{ uid: 'Q'.repeat(28) }, { expiresAt: '2020-01-01T00:00:00Z' }, { expiresAt: new Date(Date.now() + 169 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z') }, { expiresAt: 'invalid' }]) assert.throws(() => P.windowSpec({ ...w(), ...patch }));
  const st = snapshot(); st.client.activePlanId = 'different'; assert.throws(() => P.stateGate(w(), st, 'enable'), /PLAN_CHANGED/);
  assert.equal(P.stateGate(w(), st, 'stop'), true, 'a changed plan must not prevent safe revocation');
  st.release.clientIds.push('other'); assert.throws(() => P.stateGate(w(), st, 'stop'), /FOREIGN/);
  const active = snapshot(); active.release = { enabled: true, clientIds: [UID], expiresAt: new Date(Date.now() + 2 * 3600e3).toISOString() };
  assert.throws(() => P.stateGate(w(), active, 'enable'), /NO_RENEWAL/);
});
test('T673 effective flags require the exact deployment/project/team/SHA, READY production and no CRON', () => {
  const d = { id: 'dpl_pilot', projectId: P.PROJECT, teamId: P.TEAM, sha: 'a'.repeat(40), state: 'READY', target: 'production' };
  const ww = w(), p = { schema: 'vdsen-progression-runtime-v1', processingEnabled: true, numericApplyEnabled: true, cronConfigured: false,
    pilotWindow: { uidHash: require('node:crypto').createHash('sha256').update(UID).digest('hex'), planHash: require('node:crypto').createHash('sha256').update(ww.planId).digest('hex'), expiresAt: ww.expiresAt, operationId: ww.operationId } };
  P.effectiveGate(ww, d, p);
  for (const patch of [{ processingEnabled: false }, { numericApplyEnabled: false }, { cronConfigured: true }, { pilotWindow: null }]) assert.throws(() => P.effectiveGate(ww, d, { ...p, ...patch }));
  for (const patch of [{ sha: 'b'.repeat(40) }, { id: 'dpl_other' }, { teamId: 'other' }, { state: 'BUILDING' }]) assert.throws(() => P.effectiveGate(ww, { ...d, ...patch }, p));
});
test('T673 authenticated GET runtime probe has no Firestore, executor, sweep or training side effects', async () => {
  for (const [authorization, expected] of [[undefined, 401], ['Bearer rejected', 401], ['Bearer accepted', 200]]) {
    const headers = {}; let body, code;
    const h = makeHandler({ enabled: true, numericApplyEnabled: true, db: new Proxy({}, { get() { throw Error('DATABASE_TOUCHED'); } }),
      verifyIdToken: async token => { if (token !== 'accepted') throw Error('private'); return { uid: 'synthetic-user' }; } });
    await h({ method: 'GET', query: { check: 'runtime' }, headers: { authorization } }, { setHeader: (k, v) => { headers[k] = v; }, status: n => { code = n; return { json: b => { body = b; } }; } });
    assert.equal(code, expected); assert.equal(headers['Cache-Control'], 'no-store');
    if (code === 200) assert.deepEqual(body, { schema: 'vdsen-progression-runtime-v1', processingEnabled: true, numericApplyEnabled: true, cronConfigured: false, pilotWindow: null });
    assert.ok(!JSON.stringify(body).includes('private'));
  }
});
test('T673 immutable runtime window blocks other users, expired/malformed windows and CRON before touching Firestore', async () => {
  const ww = w(), bound = JSON.stringify({ uidHash: require('node:crypto').createHash('sha256').update(UID).digest('hex'), planHash: require('node:crypto').createHash('sha256').update(ww.planId).digest('hex'), expiresAt: ww.expiresAt, operationId: ww.operationId });
  const inspect = require('../api/autonomous-progression-trigger').inspectPilotWindow;
  assert.equal(inspect(bound, UID, undefined, ww.planId).allowed, true); assert.equal(inspect(bound, 'other', undefined, ww.planId).allowed, false);
  assert.equal(inspect(bound, UID, undefined, 'different-plan').allowed, false);
  assert.equal(inspect(bound, UID, Date.parse(ww.expiresAt), ww.planId).allowed, false);
  for (const [method, raw, uid, expected] of [['GET', bound, UID, 403], ['POST', bound, 'other', 202], ['POST', '{}', UID, 202],
    ['POST', bound.replace(ww.expiresAt, '2020-01-01T00:00:00Z'), UID, 202]]) {
    let status;
    await makeHandler({ pilotWindow: raw, enabled: true, numericApplyEnabled: true, cronSecret: 'must-not-enable', verifyIdToken: async () => ({ uid }),
      db: new Proxy({}, { get() { throw Error('OTHER_CLIENT_OR_EXPIRED_WINDOW_READ_DATABASE'); } }) })({ method, query: {}, headers: { authorization: 'Bearer test' }, body: { planId: 'isolated-plan' } },
      { setHeader() {}, status: n => { status = n; return { json() {} }; } });
    assert.equal(status, expected);
  }
});
test('T673 pilot runtime stages once, promotes that same ID, and leaves both fences CLOSED', async () => {
  const h = harness(), r = await R.arm(w(), base, h.io);
  assert.equal(r.status, 'RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED'); assert.deepEqual(h.calls, ['stage', 'promote', 'bytes']);
  assert.equal(r.window.deployment, 'dpl_pilot'); assert.equal(r.productionMutations, 2);
  assert.ok(h.reports.some(x => x.status === 'DEPLOY_INTENT_NO_RETRY'));
});
test('T673 armed/unknown OFF proof, prior operation and non-disabled fences fail before any deploy', async () => {
  for (const overrides of [{ offProof: async () => { throw Error('VALUE_NOT_READABLE'); } }, { assertNoPriorOperation: async () => { throw Error('OPERATION_EXISTS'); } },
    { snapshot: async () => { const s = snapshot(); s.coach.autoApplyCanary.enabled = true; return s; } }]) {
    const h = harness(overrides); await assert.rejects(() => R.arm(w(), base, h.io)); assert.deepEqual(h.calls, []);
  }
});
test('T673 changed gates during stage block promotion; an uncertain deploy is never retried', async () => {
  let n = 0; const h = harness({ snapshot: async () => { const s = snapshot(); if (++n > 1) s.release.clientIds.push('other'); return s; } });
  await assert.rejects(() => R.arm(w(), base, h.io)); assert.deepEqual(h.calls, ['stage']);
  let attempts = 0; const u = harness({ stage: async () => { attempts++; throw Error('timeout after possible deployment'); } });
  await assert.rejects(() => R.arm(w(), base, u.io)); assert.equal(attempts, 1); assert.equal(u.reports.at(-1).status, 'FAILED_BASELINE_UNCHANGED_NO_RETRY');
});
test('T673 a post-promotion byte failure restores captured OFF baseline with readback; restore is idempotent and rejects foreign traffic', async () => {
  let bytes = 0; const h = harness({ verifyBytes: async () => { if (++bytes === 1) throw Error('mismatch'); } });
  await assert.rejects(() => R.arm(w(), base, h.io), /ROLLED_BACK_VERIFIED/);
  assert.deepEqual(h.calls, ['stage', 'promote', 'rollback']);
  const report = h.reports.at(-1); assert.equal((await R.restore(report, h.io)).wrote, 0);
  await assert.rejects(() => R.restore(report, { ...h.io, current: async () => 'dpl_foreign' }), /FOREIGN_ALIAS/);
});
test('T673 absolute expiry gives idempotent fence enable/stop without renewing or touching other data', () => {
  const ww = w(), st = snapshot();
  const p = C.planWrites('enable', UID, st, { expiresAt: ww.expiresAt }); assert.equal(p.writes.length, 2);
  st.release = p.writes[0].fields; st.coach = p.writes[1].fields;
  assert.equal(C.planWrites('enable', UID, st, { expiresAt: ww.expiresAt }).unchanged, true);
  st.release.enabled = false; st.coach.autoApplyCanary.enabled = false;
  assert.equal(C.planWrites('stop', UID, st).unchanged, true);
  assert.throws(() => C.planWrites('enable', UID, st, { expiresAt: '2020-01-01T00:00:00Z' }), /no se renueva/);
});
test('T673 pilot mutations are unavailable locally; both production workflows share a non-cancelling lock', () => {
  assert.throws(() => R.invocation({ GITHUB_ACTIONS: 'false' }));
  const pilot = fs.readFileSync('.github/workflows/vdsen-ayrton-runtime.yml', 'utf8');
  for (const f of ['vdsen-app-release-prod.yml', 'vdsen-ayrton-runtime.yml']) {
    const text = fs.readFileSync('.github/workflows/' + f, 'utf8'); assert.match(text, /group: vdsen-production-app/); assert.match(text, /cancel-in-progress: false/);
  }
  assert.match(pilot, /environment: Production/); assert.match(pilot, /AYRTON_RUNTIME_RELEASE_ENABLED/);
  assert.ok(!/pull_request_target|secrets\.(?!VERCEL_TOKEN)/.test(pilot));
});
test('T673 strict wrapper brackets one atomic commit, verifies readback, repeats without renewal and revokes without runtime credentials', async () => {
  const W = require('../scripts/pilot/ayrton-window.cjs');
  const file = require('node:path').join(require('node:os').tmpdir(), 't673-window-' + require('node:crypto').randomUUID() + '.json');
  const ww = w(); fs.writeFileSync(file, JSON.stringify(ww));
  const documents = { ['clients/' + UID]: { coachId: ww.coachId, activePlanId: ww.planId }, ['plans/' + ww.planId]: {},
    ['coaches/' + ww.coachId]: { unrelated: 'preserved' } }; let commits = 0, probes = 0;
  const enc = x => typeof x === 'string' ? { stringValue: x } : typeof x === 'boolean' ? { booleanValue: x } : Array.isArray(x) ? { arrayValue: { values: x.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k,v]) => [k, enc(v)])) } };
  const http = async (method, p, token, body) => {
    if (method === 'GET') return documents[p] ? { status: 200, body: { updateTime: 'v' + commits, fields: Object.fromEntries(Object.entries(documents[p]).map(([k,v]) => [k, enc(v)])) } } : { status: 404 };
    assert.equal(method, 'COMMIT'); commits++;
    for (const write of body.writes) { const p = write.update.name.split('/documents/')[1]; documents[p] = { ...documents[p], ...C.decDoc(write.update) }; }
    return { status: 200 };
  };
  const deps = { http, token: () => 'isolated-token', runtimeEvidence: async () => { probes++; return {}; }, log() {} };
  try {
    const args = ['--window', file, '--mode', 'enable'];
    await W.main(args, deps); assert.equal(commits, 0, 'default is read-only simulation');
    const r = await W.main([...args, '--confirm'], deps); assert.equal(commits, 1); assert.ok(r.verifiedBefore && r.verifiedAfter);
    assert.equal(r.readback.releaseEnabled, true); assert.equal(r.readback.coachEnabled, true); assert.equal(probes, 4);
    const again = await W.main([...args, '--confirm'], deps); assert.equal(again.unchanged, true); assert.equal(commits, 1);
    assert.equal(documents[C.RELEASE_PATH].expiresAt, ww.expiresAt);
    delete documents['clients/' + UID].activePlanId;
    await W.main(['--window', file, '--mode', 'stop', '--confirm'], { ...deps, runtimeEvidence: async () => { throw Error('must not require runtime for revocation'); } });
    assert.equal(commits, 2); assert.equal(documents[C.RELEASE_PATH].enabled, false);
    assert.equal(documents['coaches/' + ww.coachId].autoApplyCanary.enabled, false); assert.equal(documents['coaches/' + ww.coachId].unrelated, 'preserved');
    documents['clients/' + UID].activePlanId = ww.planId;
    await assert.rejects(() => W.main([...args, '--confirm'], { ...deps, http: async (...call) => {
      const response = await http(...call); return call[0] === 'COMMIT' ? { status: 503 } : response;
    } }), /REVIEW_EVIDENCE_NO_RETRY/);
    assert.equal(commits, 3, 'an ambiguous acknowledgement never repeats the commit');
    const evidence = JSON.parse(fs.readFileSync(file + '.evidence.json', 'utf8'));
    assert.ok(evidence.steps.some(x => x.step === 'FENCES_AFTER' && x.releaseEnabled === true && x.coachEnabled === true));
    assert.equal(evidence.steps.at(-1).step, 'STOPPED_VERIFY_OR_COMMIT_UNCERTAIN');
    assert.ok(!JSON.stringify(evidence).includes('isolated-token'));
  } finally { fs.unlinkSync(file); if (fs.existsSync(file + '.evidence.json')) fs.unlinkSync(file + '.evidence.json'); }
});
test('T673 runtime evidence uses the authenticated exact deployment URL, requires alias readback and never follows redirects', async () => {
  const W = require('../scripts/pilot/ayrton-window.cjs'), ww = w(); let gets = 0;
  const d = { id: ww.deployment, url: 'isolated.vercel.app', projectId: P.PROJECT, teamId: P.TEAM, meta: { githubCommitSha: ww.runtimeSha }, readyState: 'READY', target: 'production' };
  const deps = { idToken: 'isolated-token', assertLegacyRetired: async () => true, deployment: async () => d, currentApp: async () => ww.deployment,
    fetch: async (url, init) => { gets++; assert.equal(new URL(url).hostname, d.url); assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer isolated-token');
      return { status: 200, json: async () => ({ schema: 'vdsen-progression-runtime-v1', processingEnabled: true, numericApplyEnabled: true, cronConfigured: false,
        pilotWindow: { uidHash: require('node:crypto').createHash('sha256').update(UID).digest('hex'), planHash: require('node:crypto').createHash('sha256').update(ww.planId).digest('hex'), expiresAt: ww.expiresAt, operationId: ww.operationId } }) }; } };
  await W.runtimeEvidence(ww, deps); assert.equal(gets, 1);
  await assert.rejects(() => W.runtimeEvidence(ww, { ...deps, currentApp: async () => 'dpl_changed' }), /ALIAS_CHANGED/);
  const previous = gets;
  await assert.rejects(() => W.runtimeEvidence(ww, { ...deps, deployment: async () => ({ ...d, projectId: 'foreign' }) })); assert.equal(gets, previous);
});
test('T673 a legacy armed runtime must be retired; permissions and transport errors never count as retirement', async () => {
  const check = require('../scripts/pilot/ayrton-window.cjs').assertLegacyRetired;
  assert.equal(await check({}, async () => { throw Error('API GET deployment failed: HTTP 404'); }), true);
  await assert.rejects(() => check({}, async () => ({ id: P.LEGACY_ARMED_DEPLOYMENT })), /STILL_EXISTS/);
  for (const message of ['HTTP 403', 'HTTP 500', 'timeout']) await assert.rejects(() => check({}, async () => { throw Error(message); }), /UNVERIFIED/);
});
