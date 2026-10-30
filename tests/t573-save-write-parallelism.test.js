'use strict';
// T573 — The plan-scoped and root log writes carry the same per-entry payload (T593-R) and must not wait on one another;
// a set is still not "saved" until BOTH settle through _fbWriteOrQueue (no optimistic success).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const { MERGE_HELPERS_SRC, withMergeSdk } = require(__dirname + '/helpers/client-log-merge.js');
function extract(src, decl) { const start = src.indexOf(decl), b = src.indexOf('{', start); let d = 0; assert.ok(start >= 0, decl); for (let i = b; i < src.length; i++) { d += (src[i] === '{') - (src[i] === '}'); if (!d) return src.slice(start, i + 1); } throw Error(decl); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

function harness({ unbound = false } = {}) {
  const pending = [], refs = [], toasts = [];
  const box = { USER: { uid: 'c1' }, ACTIVE_PLAN_ID: 'plan1', LOGS: { log_1_0_0_s0: { done: true, prescriptionExerciseId: 'p1' } }, REAL_WEEK: 1, EXERCISE_UNITS: {}, EXERCISE_HISTORY: {},
    _saveLogsTimer: null, _logsReqSeq: 0, _logsAckedSeq: 0, _logsWriteInFlight: 0, _logsAuthorityUpdatedAt: 0, _rootLogUnbound: unbound, _sraSaveGeneration: 0, _sraPersisted: { version: 0, entries: {} },
    console: { warn() {}, error() {} }, document: { getElementById: () => ({ style: {} }) }, showToast: (m) => toasts.push(m), _showSaveOk() {}, _maybeConsumeOverlays() {}, _scheduleTrustedProgression() {},
    _syncPending: 0, _WRITE_GRACE_MS: 500, _renderSyncBadge() {}, _deferredWriteFailed() {}, localStorage: { setItem() {} }, navigator: { onLine: true }, setTimeout, clearTimeout,
    FB: withMergeSdk({ db: {}, doc: (...a) => a.slice(1).join('/'), setDoc: (ref) => new Promise((resolve, reject) => { refs.push(ref); pending.push({ ref, resolve, reject }); }) }) };
  vm.createContext(box);
  vm.runInContext([MERGE_HELPERS_SRC, extract(client, 'function _acceptSraPersisted('), extract(client, 'function _fbWriteOrQueue('), extract(client, 'function _writeLocalBackup('), extract(client, 'async function _doSaveLogs(')].join('\n'), box);
  return { box, pending, refs, toasts };
}

test('T573-1 both canonical writes start before either acknowledgement and the save settles only after both', async () => {
  const h = harness(); let settled = false;
  const save = h.box._doSaveLogs().then((r) => { settled = true; return r; });
  assert.equal(h.pending.length, 2, 'both writes begin synchronously from the same snapshot');
  assert.deepEqual(h.refs.slice().sort(), ['logs/c1', 'logs/c1/mesos/plan1']);
  h.pending.find((p) => p.ref === 'logs/c1').resolve(); await tick(5);
  assert.equal(settled, false, 'root ack alone cannot report saved');
  h.pending.find((p) => p.ref !== 'logs/c1').resolve();
  assert.equal(await save, true);
});

test('T573-2 a rejected root write still fails the save even when it rejects before the meso ack (no unhandled rejection, no false success)', async () => {
  const h = harness(); const save = h.box._doSaveLogs();
  h.pending.find((p) => p.ref === 'logs/c1').reject(Object.assign(new Error('denied'), { code: 'permission-denied' })); await tick(5);
  h.pending.find((p) => p.ref !== 'logs/c1').resolve();
  assert.equal(await save, false); assert.ok(h.toasts.some((m) => /Error al guardar/.test(m)));
});

test('T573-3 a rejected meso write stays non-fatal while the root write is confirmed', async () => {
  const h = harness(); const save = h.box._doSaveLogs();
  h.pending.find((p) => p.ref !== 'logs/c1').reject(Object.assign(new Error('x'), { code: 'unavailable' }));
  h.pending.find((p) => p.ref === 'logs/c1').resolve();
  assert.equal(await save, true);
});

test('T573-4 with an unbound legacy root (T553) only the meso doc is written and its failure fails the save', async () => {
  const ok = harness({ unbound: true }); const s1 = ok.box._doSaveLogs();
  assert.equal(ok.pending.length, 1); assert.equal(ok.pending[0].ref, 'logs/c1/mesos/plan1'); ok.pending[0].resolve(); assert.equal(await s1, true);
  const bad = harness({ unbound: true }); const s2 = bad.box._doSaveLogs(); bad.pending[0].reject(Object.assign(new Error('x'), { code: 'unavailable' }));
  assert.equal(await s2, false);
});
