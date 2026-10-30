'use strict';
// T593-R: concurrent / offline log writes. Two devices of the SAME athlete must never erase each other's entries (reproduced with two real sessions against the emulator: a device that
// was offline replaced the WHOLE `entries` map on reconnect and the entry another device had already saved vanished). The REAL functions of vdsen-cliente.html run in a vm against an
// in-memory Firestore with field-path merge semantics and a per-device offline queue (writes are held while offline and replayed in order on reconnect, like the SDK does).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function extract(src, decl) { const start = src.indexOf(decl), b = src.indexOf('{', start); let d = 0; assert.ok(start >= 0, decl); for (let i = b; i < src.length; i++) { d += (src[i] === '{') - (src[i] === '}'); if (!d) return src.slice(start, i + 1); } throw Error(decl); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const J = (v) => JSON.parse(JSON.stringify(v));

class FieldPath { constructor(...segments) { this.segments = segments; } }
const DELETE = { __delete: true };
// ── in-memory Firestore: documents, field-path merge writes, shared by every device ──────────────────────────────────────────────────────────────────────────
function makeServer(init) {
  const docs = J(init || {}); const log = [];
  const setAt = (obj, segs, v) => { let o = obj; for (let i = 0; i < segs.length - 1; i++) { if (typeof o[segs[i]] !== 'object' || o[segs[i]] === null) o[segs[i]] = {}; o = o[segs[i]]; } if (v === DELETE) delete o[segs[segs.length - 1]]; else o[segs[segs.length - 1]] = J(v); };
  const getAt = (obj, segs) => segs.reduce((o, s) => (o === undefined || o === null ? undefined : o[s]), obj);
  return { docs, log, apply(p, data, opts) {
    log.push({ path: p, fields: opts.mergeFields.map((f) => (f instanceof FieldPath ? f.segments.join('.') : f)) });
    const d = (docs[p] = docs[p] || {});
    opts.mergeFields.forEach((f) => { const segs = f instanceof FieldPath ? f.segments : [f]; const v = getAt(data, segs); if (v === undefined) throw new Error('mask field without data: ' + segs.join('.')); setAt(d, segs, v); });
  } };
}
function makeDevice(server, name, o) {
  o = o || {}; const calls = { toasts: [] }, stored = {}; let online = true; const queue = [];
  const box = { USER: { uid: 'ath' }, ACTIVE_PLAN_ID: 'planA', LOGS: {}, REAL_WEEK: 2, EXERCISE_UNITS: {}, EXERCISE_HISTORY: {}, _saveLogsTimer: null, _logsReqSeq: 0, _logsAckedSeq: 0, _logsWriteInFlight: 0,
    _logsAuthorityUpdatedAt: 0, _rootLogUnbound: false, _sraSaveGeneration: 0, _sraPersisted: { version: 0, entries: {} }, console: { warn() {}, error() {} }, document: { getElementById: () => ({ style: {} }) },
    showToast: (m) => calls.toasts.push(m), _showSaveOk() {}, _maybeConsumeOverlays() {}, _scheduleTrustedProgression() {}, _syncPending: 0, _WRITE_GRACE_MS: 15, _renderSyncBadge() {}, _deferredWriteFailed() {},
    localStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => (k in stored ? stored[k] : null) }, navigator: { get onLine() { return online; } }, setTimeout, clearTimeout, Date,
    FB: { db: {}, doc: (_db, ...a) => a.join('/'), FieldPath, deleteField: () => DELETE,
      setDoc: (ref, data, opts) => new Promise((resolve) => { const run = () => { server.apply(ref, data, opts); resolve(); }; if (online) run(); else queue.push(run); }) } };
  vm.createContext(box);
  const helpers = ['function _cloneJ(', 'function _deepEq(', 'function _hasKey(', 'function _logsMirrorDiverged(', 'function _noSts(', 'function _mapDiff(', 'function _setBaselines(', 'function _resetLogsConcurrencyState(', 'function _applyDiffToBaseline(', 'function _commitSentToBaseline(',
    'function _overlayDirty(', 'function _journalLogConflicts(', 'function _adoptRemoteLogs(', 'function _remoteHasNews(', 'function _buildMergeWrite(', 'function _acceptSraPersisted(', 'function _fbWriteOrQueue(', 'function _writeLocalBackup(', 'async function _doSaveLogs('];
  vm.runInContext('var _logsBaseline = null, _unitsBaseline = null, _histBaseline = null, _logsHeal = true, _remoteWeekSeen = 0;\n' + helpers.map((h) => extract(client, h)).join('\n'), box);
  return { name, box, calls, stored, server,
    set online(v) { online = v; }, get online() { return online; },
    reconnect: async () => { online = true; while (queue.length) { queue.shift()(); await tick(1); } await tick(5); },
    // what the athlete does in the UI: the entry is written into LOGS, then the app saves
    log(key, v) { box.LOGS[key] = Object.assign({ done: true, ts: Date.now() }, v); },
    remove(key) { delete box.LOGS[key]; },
    save: async () => { const r = await box._doSaveLogs(); await tick(5); return r; },
    // what the app does when this device loads the logbook from the server (loadPlan) / receives a snapshot (listener)
    load() { const d = server.docs['logs/ath/mesos/planA'] || {}; box.LOGS = J(d.entries || {}); box.EXERCISE_UNITS = J(d.exerciseUnits || {}); box.EXERCISE_HISTORY = J(d.exerciseHistory || {}); box.REAL_WEEK = d.currentWeek || 2; box.__m = server.docs['logs/ath/mesos/planA'] || null; box.__r = server.docs['logs/ath'] || null; vm.runInContext('_resetLogsConcurrencyState(); _setBaselines(LOGS, EXERCISE_UNITS, EXERCISE_HISTORY); _remoteWeekSeen = REAL_WEEK; _logsHeal = _logsMirrorDiverged(__m, __r);', box); },
    snapshot(confirmed) { const d = server.docs['logs/ath'] || {}; box.__d = d; box.__c = confirmed !== false; vm.runInContext('_adoptRemoteLogs(__d.entries || {}, __d.exerciseUnits, __d.exerciseHistory, __c)', box); },
    news() { box.__d = server.docs['logs/ath'] || {}; return vm.runInContext('_remoteHasNews(__d.entries || {})', box); },
    keys: () => Object.keys(box.LOGS).sort() };
}
const E = (carga, ts) => ({ carga: String(carga), reps: '10', unit: 'KG', ts });
const serverKeys = (s, p) => Object.keys((s.docs[p || 'logs/ath'] || {}).entries || {}).sort();
const base = () => ({ 'logs/ath': { planId: 'planA', currentWeek: 2, entries: { log_1_0_0_s0: E(100, 1) }, progressionApplications: { x: { state: 'APPLIED' } } },
  'logs/ath/mesos/planA': { planId: 'planA', currentWeek: 2, entries: { log_1_0_0_s0: E(100, 1) }, progressionApplications: { x: { state: 'APPLIED' } }, summary: { n: 1 } } });
async function twoDevices() { const s = makeServer(base()); const a = makeDevice(s, 'A'), b = makeDevice(s, 'B'); a.load(); b.load(); return { s, a, b }; }

test('T593R-1 two devices, DIFFERENT exercises, both online: every entry survives', async () => {
  const { s, a, b } = await twoDevices();
  a.log('log_2_0_0_s0', E(101, 10)); await a.save(); b.snapshot();                 // B receives A's entry, then logs its own
  b.log('log_2_0_1_s0', E(55, 20)); await b.save(); a.snapshot();
  for (const p of ['logs/ath', 'logs/ath/mesos/planA']) assert.deepEqual(serverKeys(s, p), ['log_1_0_0_s0', 'log_2_0_0_s0', 'log_2_0_1_s0'], p);
  assert.deepEqual(a.keys(), b.keys(), 'both devices converge');
});

test('T593R-2 REPRODUCED DEFECT: a device that was OFFLINE while another saved no longer erases the other device\'s entries on reconnect', async () => {
  const { s, a, b } = await twoDevices();
  b.online = false;
  a.log('log_2_0_0_s1', E(102, 30)); await a.save();                                    // A saves while B has no connection
  b.log('log_2_0_1_s1', E(56, 40)); await b.save();                                     // B keeps training offline (held by the on-device queue)
  assert.ok(!serverKeys(s).includes('log_2_0_1_s1'), 'B is still pending');
  await b.reconnect();
  for (const p of ['logs/ath', 'logs/ath/mesos/planA']) assert.deepEqual(serverKeys(s, p), ['log_1_0_0_s0', 'log_2_0_0_s1', 'log_2_0_1_s1'], 'the entry saved by A survives B\'s reconnect (' + p + ')');
  assert.ok(s.log.every((w) => !w.fields.includes('entries')), 'no write ever replaces the whole entries map');
});

test('T593R-3 the same entry edited on both devices: the NEWER ts wins, the loser is kept in the on-device conflict journal; the same write echoed back is not a conflict', async () => {
  const { s, a, b } = await twoDevices();
  a.log('log_2_0_0_s0', E(110, 100)); b.log('log_2_0_0_s0', E(105, 200));            // B edited later (ts 200) than A (ts 100)
  await a.save(); b.snapshot();                                                         // B sees A's edit while its own is pending => ts decides
  assert.equal(b.box.LOGS.log_2_0_0_s0.carga, '105', 'B keeps its newer edit');
  assert.equal(JSON.parse(b.stored.vdsen_log_conflicts)[0].key, 'log_2_0_0_s0'); assert.equal(JSON.parse(b.stored.vdsen_log_conflicts)[0].kept, 'local');
  await b.save(); assert.equal(s.docs['logs/ath'].entries.log_2_0_0_s0.carga, '105', 'converges on the newest');
  a.snapshot(); assert.equal(a.box.LOGS.log_2_0_0_s0.carga, '105');
  // the opposite order: A's pending edit is the older one => the remote (newer) one is kept and the athlete is told
  const t2 = await twoDevices(); t2.a.log('log_2_0_0_s0', E(120, 300)); t2.b.log('log_2_0_0_s0', E(90, 250));
  await t2.a.save(); t2.b.snapshot();
  assert.equal(t2.b.box.LOGS.log_2_0_0_s0.carga, '120'); assert.ok(t2.b.calls.toasts.some((m) => /más recientemente/.test(m)), 'the athlete is told');
  assert.equal(JSON.parse(t2.b.stored.vdsen_log_conflicts)[0].kept, 'remote');
  // echo of the same logical write: no conflict journal
  const t3 = await twoDevices(); t3.a.log('log_2_0_0_s0', E(130, 400)); await t3.a.save(); t3.a.snapshot(); assert.ok(!t3.a.stored.vdsen_log_conflicts, 'own write echoed back');
});

test('T593R-4 offline device with pending writes + reconnection: pending entries are sent as field-level merges, in order, and never touch other entries', async () => {
  const { s, a, b } = await twoDevices();
  b.online = false; b.log('log_2_0_1_s0', E(55, 20)); await b.save(); b.log('log_2_0_1_s1', E(56, 21)); await b.save();
  a.log('log_2_0_0_s0', E(101, 22)); await a.save();
  await b.reconnect();
  assert.deepEqual(serverKeys(s), ['log_1_0_0_s0', 'log_2_0_0_s0', 'log_2_0_1_s0', 'log_2_0_1_s1']);
  assert.equal(s.docs['logs/ath'].entries.log_2_0_0_s0.carga, '101'); assert.ok(s.docs['logs/ath'].progressionApplications.x, 'server-written progression fields are untouched');
  assert.ok(s.docs['logs/ath/mesos/planA'].summary && s.docs['logs/ath/mesos/planA'].progressionApplications.x);
});

test('T593R-5 edit and delete: a deletion made here is propagated; a stale device never resurrects it by saving other entries; an edit after a remote delete wins', async () => {
  const { s, a, b } = await twoDevices();
  a.log('log_2_0_0_s0', E(101, 10)); await a.save(); b.snapshot();
  a.remove('log_2_0_0_s0'); await a.save();
  assert.ok(!serverKeys(s).includes('log_2_0_0_s0'), 'deleted on the server'); assert.ok(serverKeys(s).includes('log_1_0_0_s0'));
  b.log('log_2_0_1_s0', E(55, 50)); await b.save();                                    // B is stale (still holds log_2_0_0_s0) but only writes what it changed
  assert.ok(!serverKeys(s).includes('log_2_0_0_s0'), 'not resurrected'); assert.ok(serverKeys(s).includes('log_2_0_1_s0'));
  b.log('log_2_0_0_s0', E(99, 60)); await b.save(); assert.ok(serverKeys(s).includes('log_2_0_0_s0'), 'a deliberate new edit wins over the old delete');
  // deleting an entry nobody else saw
  b.remove('log_2_0_1_s0'); await b.save(); assert.ok(!serverKeys(s).includes('log_2_0_1_s0'));
});

test('T593R-6 plan switch while disconnected: the new plan starts clean and the old plan\'s entries are removed from the root log (no cross-plan evidence)', async () => {
  const s = makeServer(base()); const a = makeDevice(s, 'A'); a.load();
  a.log('log_2_0_0_s0', E(101, 10)); await a.save();
  // the coach assigned plan B: loadPlan clears LOGS (baseline = the old entries) and saves the clean week-1 state
  a.box.ACTIVE_PLAN_ID = 'planB'; a.box.LOGS = {}; a.box.REAL_WEEK = 1; await a.save();
  assert.deepEqual(serverKeys(s, 'logs/ath'), [], 'the root log holds no entry of the old plan'); assert.equal(s.docs['logs/ath'].planId, 'planB');
  assert.deepEqual(serverKeys(s, 'logs/ath/mesos/planA'), ['log_1_0_0_s0', 'log_2_0_0_s0'], 'the old mesocycle keeps its history'); assert.deepEqual(serverKeys(s, 'logs/ath/mesos/planB'), []);
});

test('T593R-7 double tap and retries: concurrent saves create no duplicates; the baseline only advances once the server confirmed; a rejected write is re-sent', async () => {
  const { s, a } = await twoDevices();
  a.log('log_2_0_0_s0', E(101, 10)); await Promise.all([a.save(), a.save()]);
  assert.deepEqual(serverKeys(s), ['log_1_0_0_s0', 'log_2_0_0_s0']);
  const n = s.log.length; a.log('log_2_0_0_s1', E(102, 11)); a.online = false; await a.save(); assert.equal(s.log.length, n, 'held offline');
  a.log('log_2_0_0_s2', E(103, 12)); await a.save();                                    // second save while the first is still held: s1 is re-sent together with s2 (idempotent)
  await a.reconnect(); assert.deepEqual(serverKeys(s), ['log_1_0_0_s0', 'log_2_0_0_s0', 'log_2_0_0_s1', 'log_2_0_0_s2']);
  const m = s.log.length; await a.save(); const last = s.log.slice(m).flatMap((w) => w.fields).filter((f) => /^entries\./.test(f)); assert.deepEqual(last, [], 'once confirmed nothing is re-sent');
});

test('T593R-8 reload with a pending save (fresh page, unknown baseline): everything local is written as merges, nothing is deleted, nobody else\'s entries are touched', async () => {
  const { s, a, b } = await twoDevices();
  a.log('log_2_0_0_s0', E(101, 10)); await a.save();
  // B reloads from its on-device backup (an interrupted session): it holds entries the server never received and lacks A's
  const fresh = makeDevice(s, 'B2'); fresh.box.LOGS = { log_2_0_1_s0: E(55, 20), log_1_0_0_s0: E(100, 1) };
  await fresh.save();
  assert.deepEqual(serverKeys(s), ['log_1_0_0_s0', 'log_2_0_0_s0', 'log_2_0_1_s0']); assert.ok(s.log.at(-1).fields.every((f) => !/^entries$/.test(f)));
  // the first save of a session also heals a plan-bound mirror that missed earlier writes
  delete s.docs['logs/ath/mesos/planA'].entries.log_1_0_0_s0; const h2 = makeDevice(s, 'B3'); h2.load(); h2.box.LOGS = J(s.docs['logs/ath'].entries); await h2.save();
  assert.ok(serverKeys(s, 'logs/ath/mesos/planA').includes('log_1_0_0_s0'), 'the mirror is healed');
});

test('T593R-9 local state vs Firestore: the remote copy is merged UNDER the pending local changes (never replaced wholesale); the week never moves backwards from a stale device', async () => {
  const { s, a, b } = await twoDevices();
  a.log('log_2_0_0_s0', E(101, 10)); await a.save();
  b.log('log_2_0_1_s0', E(55, 20));                                                    // B has an unsaved/unconfirmed entry
  assert.equal(b.news(), true, 'B detects an entry it never saw'); b.snapshot();
  assert.deepEqual(b.keys(), ['log_1_0_0_s0', 'log_2_0_0_s0', 'log_2_0_1_s0'], 'remote + local pending');
  await b.save(); assert.deepEqual(serverKeys(s), ['log_1_0_0_s0', 'log_2_0_0_s0', 'log_2_0_1_s0']); assert.equal(b.news(), false, 'nothing left to adopt once in sync');
  // week monotonicity: another device advanced to week 3
  s.docs['logs/ath'].currentWeek = 3; s.docs['logs/ath/mesos/planA'].currentWeek = 3; b.box._remoteWeekSeen = 3; b.box.REAL_WEEK = 2; b.log('log_2_0_1_s1', E(56, 30)); await b.save();
  assert.equal(s.docs['logs/ath'].currentWeek, 3, 'a stale device does not move the week back');
});

test('T593R-10 exerciseUnits / exerciseHistory are merged per key too, and an interrupted session recovers on the next save', async () => {
  const { s, a, b } = await twoDevices();
  a.box.EXERCISE_UNITS = { '0_0': 'LB' }; a.box.EXERCISE_HISTORY = { Press: { carga: 100 } }; await a.save();
  b.box.EXERCISE_UNITS = { '0_1': 'KG' }; b.box.EXERCISE_HISTORY = { Remo: { carga: 60 } }; await b.save();
  assert.deepEqual(Object.keys(s.docs['logs/ath'].exerciseUnits).sort(), ['0_0', '0_1']); assert.deepEqual(Object.keys(s.docs['logs/ath'].exerciseHistory).sort(), ['Press', 'Remo']);
  // an incomplete session: entries without done_ keys survive a crash + reload from the server
  a.log('log_2_0_0_s0', E(101, 10)); await a.save(); const r = makeDevice(s, 'R'); r.load(); assert.deepEqual(r.keys(), ['log_1_0_0_s0', 'log_2_0_0_s0']);
});

test('T593R-11 the save never writes the shadow / canonical fields and the source keeps no whole-map write', () => {
  const save = extract(client, 'async function _doSaveLogs(');
  assert.ok(!/mergeFields: \['entries'/.test(save) && /_buildMergeWrite\(/.test(save) && /_mapDiff\(/.test(save));
  assert.ok(!/progressionApplications|nextExposureOverlays|consumptionReceipts/.test(extract(client, 'function _buildMergeWrite(')));
  assert.ok(/deleteField, FieldPath/.test(client), 'the SDK symbols are imported and exposed on FB');
});
