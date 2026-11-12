'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = html.indexOf('function _scheduleTrustedProgression(');
const source = html.slice(start, html.indexOf('// T570-R: the athlete app never creates canonical records.', start));
const requestId = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function client(options = {}) {
  const calls = [], warnings = [];
  const box = { USER: { uid: 'synthetic-athlete', getIdToken: options.token || (async () => 'synthetic-credential') }, ACTIVE_PLAN_ID: 'synthetic-plan',
    FB: { db: {}, waitForPendingWrites: options.wait || (async () => {}) },
    _trustedProgressionPending: Object.create(null),
    console: { warn: (...args) => warnings.push(args) }, Date, Promise,
    fetch: async (url, init) => { calls.push({ url, init }); if (options.network) throw Error('sensitive-network-detail');
      return { status: options.status || 200, ok: (options.status || 200) < 400,
        headers: { get: () => options.requestId || requestId },
        json: options.json || (async () => ({ status: options.engineStatus || 'NO_CHANGE', created: [], applied: [], consumed: [], privateData: 'must-not-be-recorded' })) }; } };
  vm.createContext(box); vm.runInContext(source, box);
  return { box, calls, warnings, run: async () => { box._scheduleTrustedProgression('synthetic-athlete', 'synthetic-plan'); await tick(); },
    events: () => JSON.parse(JSON.stringify(box._trustedProgressionDiagnostics || [])) };
}
for (const [status, category] of [[401, 'AUTH'], [403, 'AUTH'], [500, 'SERVER'], [503, 'RUNTIME']]) {
  test('T671 Client observes HTTP ' + status + ' without leaking the response or credentials', async () => {
    const c = client({ status }); await c.run();
    const event = c.events().at(-1);
    assert.equal(event.httpStatus, status); assert.equal(event.category, category); assert.equal(event.requestId, requestId);
    assert.ok(!JSON.stringify(c.events()).includes('synthetic-credential'));
    assert.ok(!JSON.stringify(c.events()).includes('must-not-be-recorded'));
    assert.equal(c.calls.length, 1, 'no automatic retry of a rejected operation');
  });
}
test('T671 network, token and write-sync failures are distinct, redacted and recover on a later genuine notification', async () => {
  for (const [options, category, calls] of [[{ network: true }, 'NETWORK', 1], [{ token: async () => { throw Error('private-token-detail'); } }, 'TOKEN', 0],
    [{ wait: async () => { throw Error('private-write-detail'); } }, 'WRITE_SYNC', 0]]) {
    const c = client(options); await c.run(); assert.equal(c.events().at(-1).category, category); assert.equal(c.calls.length, calls);
    assert.deepEqual(Object.keys(c.box._trustedProgressionPending), []);
    assert.ok(!JSON.stringify(c.events()).includes('detail'));
    await c.run(); assert.equal(c.events().length, 2, 'a failure does not latch the notification busy');
  }
});
test('T671 successful HTTP distinguishes disarmed/closed gates from processed results', async () => {
  for (const status of ['DISARMED', 'OUT_OF_ALLOWLIST', 'OUT_OF_CANARY', 'PLAN_MISMATCH', 'SOURCE_INVALID', 'NO_CHANGE', 'MATERIALIZED']) {
    const c = client({ engineStatus: status }); await c.run();
    assert.equal(c.events().at(-1).engineStatus, status);
    assert.equal(c.events().at(-1).category, ['NO_CHANGE', 'MATERIALIZED'].includes(status) ? 'OK' : 'ENGINE_BLOCKED');
  }
});
test('T671 invalid responses and untrusted request IDs are not accepted as a healthy engine', async () => {
  const c = client({ json: async () => { throw Error('private-body'); }, requestId: 'Bearer private-header' }); await c.run();
  assert.equal(c.events().at(-1).category, 'RESPONSE_INVALID'); assert.equal(c.events().at(-1).requestId, null);
  assert.ok(!JSON.stringify(c.events()).includes('private-'));
});
test('T671 account switch while obtaining the token sends no stale request', async () => {
  let release;
  const c = client({ token: () => new Promise(resolve => { release = resolve; }) });
  c.box._scheduleTrustedProgression('synthetic-athlete', 'synthetic-plan'); await tick();
  c.box.USER = { uid: 'another-synthetic-athlete' }; release('synthetic-credential'); await tick();
  assert.equal(c.calls.length, 0);
});
test('T671 a later genuine save recovers from a failed HTTP response; diagnostic history stays bounded', async () => {
  const c = client({ status: 500 }); await c.run();
  c.box.fetch = async () => ({ ok: true, status: 200, headers: { get: () => requestId }, json: async () => ({ status: 'NO_CHANGE' }) });
  await c.run(); assert.equal(c.events().at(-1).category, 'OK');
  for (let i = 0; i < 21; i++) await c.run();
  assert.equal(c.events().length, 20);
});

test('T671 the real session save remains successful when the real notification gets HTTP rejection or a network failure', async () => {
  const { MERGE_HELPERS_SRC, withMergeSdk } = require('./helpers/client-log-merge');
  function fn(decl) {
    const i = html.indexOf(decl), b = html.indexOf('{', i); let depth = 0;
    assert.ok(i >= 0);
    for (let k = b; k < html.length; k++) { depth += (html[k] === '{') - (html[k] === '}'); if (!depth) return html.slice(i, k + 1); }
    throw Error('function not found');
  }
  for (const status of [401, 403, 500, 'network']) {
    const writes = [], entry = { done: true, prescriptionExerciseId: 'synthetic-pid', carga: '10', reps: '8' };
    const box = { USER: { uid: 'synthetic-athlete', getIdToken: async () => 'synthetic-credential' }, ACTIVE_PLAN_ID: 'synthetic-plan', LOGS: { log_1_0_0_s0: entry }, REAL_WEEK: 1,
      EXERCISE_UNITS: {}, EXERCISE_HISTORY: {}, _saveLogsTimer: null, _logsReqSeq: 0, _logsAckedSeq: 0, _logsWriteInFlight: 0, _logsAuthorityUpdatedAt: 0,
      _rootLogUnbound: false, _sraSaveGeneration: 0, _sraPersisted: { version: 0, entries: {} }, _syncPending: 0, _WRITE_GRACE_MS: 100,
      _trustedProgressionPending: Object.create(null), console: { warn() {}, error() {} }, document: { getElementById: () => ({ style: {} }) },
      localStorage: { setItem() {} }, navigator: { onLine: true }, setTimeout, clearTimeout, Date, Promise,
      showToast() {}, _showSaveOk() {}, _maybeConsumeOverlays() {}, _renderSyncBadge() {}, _deferredWriteFailed() {},
      FB: withMergeSdk({ db: {}, doc: (_db, ...parts) => parts.join('/'), waitForPendingWrites: async () => {}, setDoc: async (ref, payload) => { writes.push({ ref, payload }); } }),
      fetch: async () => { if (status === 'network') throw Error('private-detail'); return { ok: false, status, headers: { get: () => requestId } }; } };
    vm.createContext(box);
    vm.runInContext([MERGE_HELPERS_SRC, fn('function _acceptSraPersisted('), fn('function _fbWriteOrQueue('), fn('function _writeLocalBackup('), fn('async function _doSaveLogs('), source].join('\n'), box);
    assert.equal(await box._doSaveLogs(), true); await tick();
    assert.equal(writes.length, 2, 'root and mesocycle persisted');
    assert.ok(writes.every(w => w.payload.entries.log_1_0_0_s0.reps === '8'));
    assert.equal(box._trustedProgressionDiagnostics.at(-1).category, status === 'network' ? 'NETWORK' : status === 500 ? 'SERVER' : 'AUTH');
    assert.equal(entry.reps, '8');
    clearTimeout(box._trustedProgressionRetryTimer); // T676: background recovery is now bounded and covered with a deterministic clock separately.
  }
});

const trigger = require('../api/autonomous-progression-trigger');
function response() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
}
test('T671 server correlates authentication rejection and disarmed flags without reading training evidence', async () => {
  const logs = [];
  const db = { runTransaction: async () => { throw Error('must not read'); } };
  const req = { method: 'POST', headers: { authorization: 'Bearer synthetic-credential' }, body: { planId: 'synthetic-plan' } };
  for (const rejected of [true, false]) {
    const res = response();
    await trigger.makeHandler({ db, verifyIdToken: async () => { if (rejected) throw Error('private-auth-detail'); return { uid: 'synthetic-athlete' }; },
      log: line => logs.push(JSON.parse(line)) })(req, res);
    const event = logs.at(-1);
    assert.equal(res.statusCode, rejected ? 401 : 202);
    assert.equal(event.authentication, rejected ? 'REJECTED' : 'VERIFIED');
    assert.equal(event.requestId, res.headers['x-vdsen-progression-request-id']);
    assert.match(event.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(event.processingEnabled, false); assert.equal(event.numericApplyEnabled, false);
    assert.ok(!JSON.stringify(event).includes('synthetic-')); assert.ok(!JSON.stringify(event).includes('private-'));
  }
  assert.notEqual(logs[0].requestId, logs[1].requestId);
});
test('T671 processing exceptions are categorized and redacted; later authentic calls are still handled', async () => {
  for (const [code, category] of [[10, 'CONTENTION'], [14, 'UNAVAILABLE'], [4, 'DEADLINE'], [undefined, 'PROCESSING']]) {
    const logs = [], db = { runTransaction: async () => { throw Object.assign(Error('private-training-and-token-detail'), { code }); } };
    const handler = trigger.makeHandler({ db, enabled: true, numericApplyEnabled: true, verifyIdToken: async () => ({ uid: 'synthetic-athlete' }), log: line => logs.push(JSON.parse(line)) });
    for (let i = 0; i < 2; i++) {
      const res = response(); await handler({ method: 'POST', headers: { authorization: 'Bearer synthetic-credential' }, body: { planId: 'synthetic-plan' } }, res);
      assert.equal(res.statusCode, 500); assert.equal(logs.at(-1).errorCategory, category);
      assert.deepEqual(res.body, { error: 'PROGRESSION_PROCESSING_FAILED' });
      assert.equal(logs.at(-1).requestId, res.headers['x-vdsen-progression-request-id']);
      assert.ok(!JSON.stringify(logs).includes('private-')); assert.ok(!JSON.stringify(logs).includes('synthetic-'));
    }
  }
});
test('T671 diagnostic sink failure does not alter the closed gate or response', async () => {
  const res = response();
  await trigger.makeHandler({ verifyIdToken: async () => ({ uid: 'synthetic-athlete' }), log: () => { throw Error('sink failed'); } })(
    { method: 'POST', headers: { authorization: 'Bearer synthetic-credential' }, body: { planId: 'synthetic-plan' } }, res);
  assert.equal(res.statusCode, 202); assert.equal(res.body.status, 'DISARMED');
});
