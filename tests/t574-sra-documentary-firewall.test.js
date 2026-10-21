'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sra = require('../assets/sra-context.js');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8'), coach = fs.readFileSync('vdsen-coach.html', 'utf8'), engine = fs.readFileSync('assets/sra-context.js', 'utf8');
function extract(src, decl) { const start = src.indexOf(decl), b = src.indexOf('{', start); let d = 0; assert.ok(start >= 0); for (let i = b; i < src.length; i++) { d += (src[i] === '{') - (src[i] === '}'); if (!d) return src.slice(start, i + 1); } throw Error(decl); }
function harness() {
  const pending = [], badge = { style: {} };
  const box = { _syncPending: 0, _WRITE_GRACE_MS: 5000, _renderSyncBadge() {}, _deferredWriteFailed() {}, localStorage: { setItem() {} }, navigator: { onLine: true }, setTimeout, clearTimeout, USER: { uid: 'c1' }, ACTIVE_PLAN_ID: 'plan1', LOGS: { log_1_0_0_s0: { done: true, prescriptionExerciseId: 'p1' } }, REAL_WEEK: 1,
    EXERCISE_UNITS: {}, EXERCISE_HISTORY: {}, _saveLogsTimer: null, _logsReqSeq: 0, _logsAckedSeq: 0, _logsWriteInFlight: 0,
    _logsAuthorityUpdatedAt: 0, _rootLogUnbound: false, _sraSaveGeneration: 0, _sraPersisted: { version: 0, entries: {} },
    console: { warn() {}, error() {} }, document: { getElementById: () => badge }, showToast() {}, _showSaveOk() {}, _maybeConsumeOverlays() {},
    FB: { db: {}, doc: (...a) => a.slice(1).join('/'), setDoc: (path, payload) => path.includes('/mesos/') ? Promise.resolve() : new Promise((resolve, reject) => pending.push({ resolve, reject, payload })) } };
  vm.createContext(box); vm.runInContext(extract(client, 'function _acceptSraPersisted(') + '\n' + extract(client, 'function _fbWriteOrQueue(') + '\n' + extract(client, 'function _writeLocalBackup(') + '\n' + extract(client, 'async function _doSaveLogs('), box);
  return { box, pending };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const checks = [
 ['D01 canonical recovery engine', () => assert.ok(extract(coach, 'function _computeRecoverySensitivity(').includes('return window.VDSEN_SRA.computeRecoverySensitivity'))],
 ['D02 existing recovery trigger authority', () => assert.ok(engine.includes('entry.deloadTriggers'))],
 ['D03 raw persisted execution authority', () => assert.ok(engine.includes('_sraPersistedSnapshots(entries, planDoc)'))],
 ['D04 PID authority excludes names and positions', () => assert.ok(engine.includes('allowed[e.prescriptionExerciseId] !== 1'))],
 ['D05 client identity required', () => assert.equal(sra.buildContext({}).dataStatus, 'INSUFFICIENT_DATA')],
 ['D06 pending save excluded', async () => { const { box: b, pending: p } = harness(); const save = b._doSaveLogs(); await tick(); assert.deepEqual(Object.keys(b._sraPersisted.entries), []); p[0].resolve(); assert.equal(await save, true); assert.equal(Object.keys(b._sraPersisted.entries).length, 1); }],
 ['D07 failed write excluded', async () => { const { box: b, pending: p } = harness(); const save = b._doSaveLogs(); await tick(); p[0].reject(Error('write failed')); assert.equal(await save, false); assert.equal(Object.keys(b._sraPersisted.entries).length, 0); }],
 ['D08 stale save acknowledgement excluded', async () => { const { box: b, pending: p } = harness(); const old = b._doSaveLogs(); await tick(); b.LOGS.log_1_0_0_s0.reps = 12; const fresh = b._doSaveLogs(); await tick(); p[1].resolve(); await fresh; p[0].resolve(); await old; assert.equal(b._sraPersisted.entries.log_1_0_0_s0.reps, 12); }],
 ['D09 rollback state detached', async () => { const { box: b, pending: p } = harness(); const save = b._doSaveLogs(); await tick(); p[0].resolve(); await save; b.LOGS = {}; assert.equal(Object.keys(b._sraPersisted.entries).length, 1); }],
 ['D10 duplicate set authority is a map', () => assert.ok(engine.includes('A map key identifies one persisted set'))],
 ['D11 DOM-only state excluded', () => assert.ok(!engine.includes('document.'))],
 ['D12 autoFilled excluded', () => assert.ok(engine.includes('e.autoFilled'))],
 ['D13 local backup not acknowledged', () => assert.ok(!extract(client, 'async function saveLogs(').includes('_acceptSraPersisted'))],
 ['D14 cached and pending server snapshots excluded', () => assert.ok(client.includes('snap.metadata.hasPendingWrites || snap.metadata.fromCache'))],
 ['D15 Client read-only render wired', () => assert.ok(client.includes("innerHTML = `${_renderClientSra()}"))],
 ['D16 Coach read-only render wired', () => assert.ok(coach.includes("window.VDSEN_SRA.renderTrace(trace, 'coach')"))],
 ['D17 trace includes complete evidence and reasons', () => { const t = sra.buildSraTrace({ clientId: 'c1', prescriptionExerciseId: 'p1' }); for (const k of ['inputEvidence', 'evidenceWindow', 'classification', 'reason', 'dataStatus', 'reviewRequired']) assert.ok(k in t); }],
 ['D18 progression signal preserved', () => assert.equal(sra.buildSraTrace({ clientId: 'c1', prescriptionExerciseId: 'p1', progressionSignal: 'increase_load' }).progressionSignal, 'increase_load')],
 ['D19 RULE preserved', () => assert.equal(sra.buildSraTrace({ ruleOrRange: 'RULE' }).ruleOrRange, 'RULE')],
 ['D20 RANGE preserved', () => assert.equal(sra.buildSraTrace({ ruleOrRange: 'RANGE' }).ruleOrRange, 'RANGE')],
 ['D21 HEURISTIC preserved', () => assert.equal(sra.buildSraTrace({ ruleOrRange: 'HEURISTIC' }).ruleOrRange, 'HEURISTIC')],
 ['D22 MONITOR and SESSION_VOLUME monitor-only', () => { const t = sra.buildSraTrace({ clientId: 'c1', prescriptionExerciseId: 'p1', sra: { classification: 'MONITOR' } }); assert.equal(t.classification, 'MONITOR'); assert.equal(t.sessionVolume, 'MONITOR_ONLY'); }],
 ['D23 numeric apply disabled', () => { assert.equal(sra.NUMERIC_APPLY_ENABLED, false); for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false); }],
 ['D24 zero prescription mutations and write paths', () => { assert.ok(!/setDoc|updateDoc|\.sets\s*=|\.reps\s*=|\.load\s*=|\.frequency\s*=/.test(engine)); assert.equal(sra.buildSraTrace({}).mutation, 'NONE'); }]
];
assert.equal(checks.length, 24);
for (const [name, run] of checks) test(name, run);
