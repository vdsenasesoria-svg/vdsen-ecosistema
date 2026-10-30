'use strict';
// T596: a write made without connection is held by Firestore's on-device queue; the app must not wait for the server to confirm it (it blocked the whole session offline).
// Helpers are extracted from the real HTML and run in a vm with controllable promises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const { MERGE_HELPERS_SRC, withMergeSdk } = require(__dirname + '/helpers/client-log-merge.js');   // T593-R
function extract(src, decl) { const start = src.indexOf(decl), b = src.indexOf('{', start); let d = 0; assert.ok(start >= 0, decl); for (let i = b; i < src.length; i++) { d += (src[i] === '{') - (src[i] === '}'); if (!d) return src.slice(start, i + 1); } throw Error(decl); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

function harness({ online = true, grace = 30 } = {}) {
  const pending = [], stored = {}, calls = { badge: 0, deferredErrors: [], toasts: [] };
  const box = { USER: { uid: 'c1' }, ACTIVE_PLAN_ID: 'plan1', LOGS: { log_1_0_0_s0: { done: true, prescriptionExerciseId: 'p1' } }, REAL_WEEK: 1, EXERCISE_UNITS: {}, EXERCISE_HISTORY: {},
    _saveLogsTimer: null, _logsReqSeq: 0, _logsAckedSeq: 0, _logsWriteInFlight: 0, _logsAuthorityUpdatedAt: 0, _rootLogUnbound: false, _sraSaveGeneration: 0, _sraPersisted: { version: 0, entries: {} },
    console: { warn() {}, error() {} }, document: { getElementById: () => ({ style: {} }) }, showToast: (m) => calls.toasts.push(m), _showSaveOk() { calls.saveOk = (calls.saveOk || 0) + 1; }, _maybeConsumeOverlays() { calls.consume = (calls.consume || 0) + 1; }, _scheduleTrustedProgression() { calls.trusted = (calls.trusted || 0) + 1; },
    _syncPending: 0, _WRITE_GRACE_MS: grace, _renderSyncBadge() { calls.badge++; }, localStorage: { setItem: (k, v) => { stored[k] = v; } }, navigator: { onLine: online }, setTimeout, clearTimeout,
    FB: withMergeSdk({ db: {}, doc: (...a) => a.slice(1).join('/'), setDoc: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }) };
  box._deferredWriteFailed = (e) => calls.deferredErrors.push(e && e.code);
  vm.createContext(box);
  vm.runInContext([MERGE_HELPERS_SRC, extract(client, 'function _acceptSraPersisted('), extract(client, 'function _fbWriteOrQueue('), extract(client, 'function _writeLocalBackup('), extract(client, 'async function _doSaveLogs(')].join('\n'), box);
  return { box, pending, stored, calls };
}

test('T596-1 a write confirmed within the grace window is "acked" (normal online behaviour unchanged)', async () => {
  const h = harness(); const p = h.box._fbWriteOrQueue(Promise.resolve('ok')); const r = await p;
  assert.equal(r.state, 'acked'); assert.equal(h.box._syncPending, 0);
});

test('T596-2 a write that is not confirmed is QUEUED (immediately when the device reports no connection) and the real outcome is still handled', async () => {
  const off = harness({ online: false }); let resolveLate; const never = new Promise((res) => { resolveLate = res; });
  const t0 = Date.now(); const r = await off.box._fbWriteOrQueue(never);
  assert.equal(r.state, 'queued'); assert.ok(Date.now() - t0 < 25, 'no waiting when offline'); assert.equal(off.box._syncPending, 1); assert.ok(off.calls.badge >= 1, 'the sticky badge is shown');
  resolveLate(); await r.done; assert.equal(off.box._syncPending, 0, 'the badge is cleared once the server confirms');
  const slow = harness({ online: true, grace: 20 }); const r2 = await slow.box._fbWriteOrQueue(new Promise(() => {}));
  assert.equal(r2.state, 'queued', 'online but slower than the grace window: also held, never blocking');
  const rej = harness({ online: false }); let rejectLate; const bad = new Promise((_, rj) => { rejectLate = rj; });
  const r3 = await rej.box._fbWriteOrQueue(bad); rejectLate(Object.assign(new Error('denied'), { code: 'permission-denied' })); await r3.done.catch(() => {});
  assert.deepEqual(rej.calls.deferredErrors, ['permission-denied'], 'a deferred rejection is reported, not swallowed'); assert.equal(rej.box._syncPending, 0);
});

test('T596-3 an immediate rejection (a real error before any grace) still fails the save, as before', async () => {
  const h = harness({ online: true, grace: 500 });
  const p = h.box._doSaveLogs(); await tick(5); h.pending[0].reject(Object.assign(new Error('x'), { code: 'unavailable' })); // meso write: error is non-fatal by design
  await tick(5); h.pending[1].reject(Object.assign(new Error('write failed'), { code: 'permission-denied' }));
  assert.equal(await p, false); assert.ok(h.calls.toasts.some((m) => /Error al guardar/.test(m)));
});

test('T596-4 saving a set OFFLINE no longer blocks: _doSaveLogs returns true, leaves the on-device backup, shows the pending badge and does not claim a confirmed save', async () => {
  const h = harness({ online: false });
  const r = await Promise.race([h.box._doSaveLogs(), tick(300).then(() => 'BLOCKED')]);
  assert.equal(r, true, 'the athlete can continue'); assert.ok(h.stored.vdsen_logs_backup && JSON.parse(h.stored.vdsen_logs_backup).entries.log_1_0_0_s0, 'local backup written by the direct save path too');
  assert.equal(h.calls.saveOk || 0, 0, 'no "✓ GUARDADO" while it is only held on the device'); assert.ok(h.box._syncPending >= 1); assert.equal(h.calls.trusted || 0, 0, 'server follow-ups wait for the confirmation');
  h.pending.forEach((p) => p.resolve()); await tick(10);
  assert.equal(h.box._syncPending, 0, 'after reconnection the queue drains'); assert.equal(h.calls.trusted, 1, 'the trusted executor is notified only after the real confirmation');
});

test('T596-5 wiring: every write of the log documents goes through the queue-aware helper; the sticky badge and the deferred error path exist', () => {
  const save = extract(client, 'async function _doSaveLogs(');
  assert.equal((save.match(/_fbWriteOrQueue\(FB\.setDoc\(/g) || []).length, 2, 'meso and root writes');
  assert.ok(!/await FB\.setDoc\(/.test(save), 'no direct await of setDoc left in the log save');
  assert.match(client, /id = 'syncPendingBadge'/); assert.match(client, /function _deferredWriteFailed\(err\)/);
  assert.match(extract(client, 'function saveLogs(') || '', /_writeLocalBackup\(\)/);
});
