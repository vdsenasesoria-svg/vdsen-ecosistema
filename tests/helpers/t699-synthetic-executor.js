'use strict';
// Test-only isolated module instance: production always imports the real pilot contract.
const Module = require('node:module');
const fs = require('node:fs');
const filename = require.resolve('../../api/_autonomousProgression');
function createSyntheticExecutor(syntheticWindow, options = {}) {
const instance = new Module(filename, module);
instance.filename = filename;
instance.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
const originalRequire = instance.require.bind(instance);
instance.require = function(id) {
  if (id !== './_numericPilotContract.js') return originalRequire(id);
  const synthetic = {
    runtimeAuthorization: (_env, now) => {
      if (!syntheticWindow) return null;
      if (options.validateTime === true && !(Date.parse(syntheticWindow.startsAt) <= now && now < Date.parse(syntheticWindow.expiresAt) &&
          Date.parse(syntheticWindow.expiresAt) - Date.parse(syntheticWindow.startsAt) <= 86400000)) return null;
      return syntheticWindow;
    },
    windowValid: (w, now) => !!w && w.schema === 'vdsen-numeric-pilot-v1' && w.mode === 'NUMERIC_APPLY' &&
      Date.parse(w.startsAt) <= Date.parse(now) && Date.parse(now) < Date.parse(w.expiresAt) &&
      Date.parse(w.expiresAt) - Date.parse(w.startsAt) <= 86400000,
    scopeValid: (s, uid, pid, plan) => !!s && s.enabled === true && s.clientIds.length === 1 && s.clientIds[0] === uid &&
      s.prescriptionExerciseIds.length === 1 && s.prescriptionExerciseIds[0] === pid &&
      plan.days.some(d => d.exercises.some(e => e.prescriptionExerciseId === pid)),
    ledgerValid: (doc, current, key) => {
      if (options.historicalScope === true) return true;
      const realC = require('../../api/_numericPilotContract');
      return realC.ledgerValid(doc, current, key);
    }
  };
  synthetic.transactionAllowed = (original, current, fence, release, scope, uid, record, plan) => !!(
    original && current && JSON.stringify(original) === JSON.stringify(current) && fence && fence.enabled === true &&
    release && Array.isArray(release.clientIds) && (options.historicalScope === true
      ? release.clientIds.includes(current.uid) : release.clientIds.length === 1 && release.clientIds[0] === current.uid) &&
    (options.historicalScope === true || release.expiresAt === current.expiresAt) &&
    ['schema', 'mode', 'uid', 'planId', 'pid', 'runtimeSha', 'operationId', 'startsAt', 'expiresAt'].every(k => fence[k] === current[k]) &&
    record && record.state === 'PENDING' && (options.historicalPids || [current.pid]).includes(record.prescriptionExerciseId) &&
    (options.historicalPids ? scope && scope.enabled === true && Array.isArray(scope.clientIds) && scope.clientIds.includes(uid) &&
      Array.isArray(scope.prescriptionExerciseIds) && scope.prescriptionExerciseIds.includes(record.prescriptionExerciseId) && plan && Array.isArray(plan.days) &&
      plan.days.some(d => Array.isArray(d.exercises) && d.exercises.some(e => e.prescriptionExerciseId === record.prescriptionExerciseId))
      : synthetic.scopeValid(scope, uid, record.prescriptionExerciseId, plan)));
  return synthetic;
};
instance._compile(fs.readFileSync(filename, 'utf8'), filename);
return instance.exports;
}
function createSyntheticSweep(executor) {
  const file = require.resolve('../../api/_autonomousProgressionSweep');
  const instance = new Module(file, module);
  instance.filename = file;
  instance.paths = Module._nodeModulePaths(require('node:path').dirname(file));
  const originalRequire = instance.require.bind(instance);
  instance.require = id => id === './_autonomousProgression' ? executor : originalRequire(id);
  instance._compile(fs.readFileSync(file, 'utf8'), file);
  return instance.exports;
}
function createSyntheticLedgerDoc(window, pids) {
  const effectivePids = Array.isArray(pids) ? pids : (window && window.pid ? [window.pid] : []);
  return {
    schema: 'vdsen-numeric-operations-ledger-v1',
    operationId: window.operationId,
    status: 'RESERVED',
    reservedAt: new Date().toISOString(),
    completedAt: null,
    stoppedAt: null,
    uid: window.uid,
    planId: window.planId,
    pid: window.pid,
    runtimeSha: window.runtimeSha,
    deploymentId: 'dpl_synthetic_test',
    runId: 'run-' + (window.operationId || 'synthetic'),
    window: structuredClone(window),
    scope: { enabled: true, clientIds: [window.uid], prescriptionExerciseIds: effectivePids },
    appliedRecordKeys: [],
    history: []
  };
}
// Emulator-only authority for a named synthetic fixture. The real release and
// Coach documents are still read transactionally; only the extra pilot fence is
// isolated per fixture so historical multi-client tests cannot race on it.
async function createHistoricalFixture(db, uid, planId, pid) {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '') || !/^demo-/.test(process.env.GCLOUD_PROJECT || '')) throw new Error('DEMO_EMULATOR_REQUIRED');
  const pids = Array.isArray(pid) ? pid.slice() : [pid];
  if (!pids.length || new Set(pids).size !== pids.length || ![uid, planId, ...pids].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x) && x !== '*')) throw new Error('SYNTHETIC_IDENTITY_INVALID');
  const start = Math.floor(Date.now() / 1000) * 1000, iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
  const window = { schema: 'vdsen-numeric-pilot-v1', mode: 'NUMERIC_APPLY', uid, planId, pid: pids[0],
    runtimeSha: 'a'.repeat(40), operationId: 'synthetic-test-window', startsAt: iso(start - 1000), expiresAt: iso(start + 3600000) };
  const fenceId = 't699-synthetic-' + uid;
  await db.doc('releaseControl/' + fenceId).set({ ...window, enabled: true });
  const opDoc = createSyntheticLedgerDoc(window, pids);
  await db.doc('releaseControl/' + fenceId + '/operations/' + window.operationId).set(opDoc);
  await db.doc('releaseControl/numericPilot/operations/' + window.operationId).set(opDoc);
  const scopedDb = Object.create(db);
  scopedDb.collection = name => name === 'releaseControl' ? { doc: id => db.collection(name).doc(id === 'numericPilot' ? fenceId : id) } : db.collection(name);
  scopedDb.runTransaction = fn => db.runTransaction(fn);
  return { db: scopedDb, executor: createSyntheticExecutor(window, { validateTime: true, historicalScope: true, historicalPids: pids }) };
}
// Compose the unchanged request handler with an explicitly supplied test-only executor.
// Authentication still goes through the handler's verifyIdToken dependency.
function createSyntheticTrigger(executor, sweep) {
  const file = require.resolve('../../api/autonomous-progression-trigger');
  const instance = new Module(file, module);
  instance.filename = file;
  instance.paths = Module._nodeModulePaths(require('node:path').dirname(file));
  const originalRequire = instance.require.bind(instance);
  instance.require = id => id === './_autonomousProgression' ? executor :
    id === './_autonomousProgressionSweep' ? sweep : originalRequire(id);
  instance._compile(fs.readFileSync(file, 'utf8'), file);
  return instance.exports;
}
module.exports = { createSyntheticExecutor, createSyntheticSweep, createSyntheticTrigger, createHistoricalFixture, createSyntheticLedgerDoc };
