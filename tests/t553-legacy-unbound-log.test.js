'use strict';
// T553: a root log (`logs/{uid}`) WITHOUT a planId that holds execution evidence is LEGACY_UNBOUND_EVIDENCE. It must never become evidence for whichever plan is active
// (T552 finding: root log without planId + new active plan without a meso doc => the loader attached plan A-era entries to plan B). It is not deleted, not rewritten
// with the current planId, not migrated; new execution goes through the plan-bound meso path only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name, async) {
  const i = SRC.indexOf((async ? 'async ' : '') + 'function ' + name + '(');
  assert.ok(i > -1, 'missing function ' + name);
  let d = 0; const j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const FNS = ['_exNotePidKey', '_exNoteCtx', '_exNoteValid', '_exNoteShadowed', '_roundUnit', '_convertCarga', '_prevWeekRef', '_prevWeekRefOf', '_prevWeekHtml', '_prevWeekReuse', '_prevWeekKeyParts', '_prevWeekReuseHtml', '_getPrevWeekData', '_avgArr',
  '_selectLogAuthority', '_logsPlanChanged', '_isLegacyUnboundLog', '_logDocHasEvidence'];
const PID = 'pid-same-123';
const set = o => Object.assign({ carga: '80', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: '3', prescriptionExerciseId: PID, ts: 1 }, o);
const legacyRoot = over => Object.assign({ currentWeek: 4, updatedAt: 100, entries: { log_1_0_0_s0: set({}), log_1_0_0_s1: set({ reps: '9' }), done_1_0: true } }, over || {});
const meso = (planId, entries, over) => Object.assign({ planId, currentWeek: 2, updatedAt: 50, entries: entries || {} }, over || {});
function sandbox(active, week) {
  const ctx = { console, Number, Math, JSON, Date, Object, Array, String, parseInt, parseFloat, isNaN, RegExp, LOGS: {}, ACTIVE_PLAN_ID: active, CURRENT_WEEK: week || 2,
    _EJERCICIOS_DIA: [{ prescriptionExerciseId: PID, exerciseName: 'Press banca', sets: [{ load: 100, repsTarget: 8, rirTarget: 2 }] }], _escHTml: s => String(s), document: { getElementById: () => null } };
  ctx.window = ctx; vm.createContext(ctx); for (const f of FNS) if (SRC.includes('function ' + f + '(')) vm.runInContext(fnSrc(f), ctx); return ctx;
}
// what the loader does with the two docs (initial load): select the authority, then the plan-switch fence; unusable => empty LOGS (week 1).
function loaderLogs(w, mesoDoc, rootDoc, active, flag, localPlan) {
  const logData = w._selectLogAuthority(mesoDoc, rootDoc, active); if (!logData) return {};
  return w._logsPlanChanged(logData, active, flag, localPlan) ? {} : (logData.entries || {});
}
const J = o => JSON.parse(JSON.stringify(o));

test('T553.U1 REPRODUCTION: root log without planId + active plan without a meso doc is no longer loaded as the active plan\'s evidence', () => {
  const w = sandbox('planB'); assert.equal(w._selectLogAuthority(null, legacyRoot(), 'planB'), null, 'the authority selector refuses the unbound root');
  assert.deepEqual(Object.keys(loaderLogs(w, null, legacyRoot(), 'planB', false, null)), [], 'fresh device (no local plan id)');
  assert.deepEqual(Object.keys(loaderLogs(w, null, legacyRoot(), 'planB', false, 'planB')), [], 'same device that already ran plan B');
});
test('T553.U2 contract A: the plan-specific meso doc of the ACTIVE plan always wins over an unbound root', () => {
  const w = sandbox('planB'); const m = meso('planB', { log_2_0_0_s0: set({ carga: '99' }) }); const sel = w._selectLogAuthority(m, legacyRoot(), 'planB'); assert.equal(sel, m);
  const noId = meso(undefined, { log_2_0_0_s0: set({}) }); delete noId.planId; assert.equal(w._selectLogAuthority(noId, legacyRoot(), 'planB'), noId, 'a meso doc is bound by its PATH, not by a planId field');
});
test('T553.U3 contract B: a root log with an explicit planId == active plan stays eligible (existing compatibility contract)', () => {
  const w = sandbox('planB'); const root = legacyRoot({ planId: 'planB' }); assert.equal(w._selectLogAuthority(null, root, 'planB'), root); assert.equal(Object.keys(loaderLogs(w, null, root, 'planB', false, 'planB')).length, 3);
});
test('T553.U4 contract C: a root log with an explicit DIFFERENT planId is never active-plan evidence', () => {
  const w = sandbox('planB'); const root = legacyRoot({ planId: 'planA' }); assert.deepEqual(Object.keys(loaderLogs(w, null, root, 'planB', false, null)), []);
  assert.equal(w._selectLogAuthority(meso('planB', {}), root, 'planB').planId, 'planB', 'with a meso doc the other plan\'s root is ignored');
});
test('T553.U5 contract D: missing / empty / null / non-string planId + execution evidence = LEGACY_UNBOUND (never bound by shape, name or position)', () => {
  const w = sandbox('planB'); for (const pid of [undefined, null, '', 0, false, {}, []]) {
    const root = legacyRoot(); if (pid !== undefined) root.planId = pid; assert.equal(w._isLegacyUnboundLog(root), true, JSON.stringify(pid)); assert.equal(w._selectLogAuthority(null, root, 'planB'), null, JSON.stringify(pid));
  }
  assert.equal(w._isLegacyUnboundLog(legacyRoot({ planId: 'planA' })), false); assert.equal(w._isLegacyUnboundLog(null), false);
});
test('T553.U6 an unbound root WITHOUT execution evidence (e.g. only exerciseUnits / week) is not "historical evidence" and is not treated as unbound', () => {
  const w = sandbox('planB'); const empty = { currentWeek: 1, entries: { ci_sem_1: { peso: 80 } }, exerciseUnits: { '0_0': 'LB' } }; assert.equal(w._isLegacyUnboundLog(empty), false); assert.equal(w._isLegacyUnboundLog({ currentWeek: 1 }), false);
});
test('T553.U7 NO LEAK into any prior-exposure helper: ÚLTIMA SEMANA, USAR CARGA/REPS, previous-week data, warm-up base all stay empty on plan B Week 2', () => {
  const w = sandbox('planB', 2); w.LOGS = loaderLogs(w, null, legacyRoot(), 'planB', false, null);
  assert.equal(w._prevWeekHtml(0, 0), ''); assert.equal(w._prevWeekReuseHtml('log_2_0_0_s0', 'KG'), ''); assert.equal(w._getPrevWeekData(2, 0, 0, 8, PID), null);
  const lg = sandbox('planB', 2); lg.LOGS = legacyRoot().entries; assert.notEqual(lg._getPrevWeekData(2, 0, 0, 8, PID), null, 'CONTROL: if the legacy entries WERE attached, they would leak (this is what the fence prevents)');
});
test('T553.U8 plan A (same device) and the legacy root are not rewritten: classification is pure (no write, no mutation of the document)', () => {
  const w = sandbox('planB'); const root = legacyRoot(); const before = JSON.stringify(root); w._selectLogAuthority(null, root, 'planB'); w._isLegacyUnboundLog(root); w._logsPlanChanged(root, 'planB', false, null); assert.equal(JSON.stringify(root), before);
});
test('T553.U9 EVERY loader path uses the fence: initial load (selector), live listener, refresh, local backup', () => {
  assert.ok(/function _selectLogAuthority\(mesoData, rootData, planId\) \{\s*if \(_isLegacyUnboundLog\(rootData\)\) rootData = null;/.test(SRC), 'selector drops an unbound root first (initial load + listener + refresh all call it)');
  const listener = SRC.slice(SRC.indexOf("_liveUnsubLogs = FB.onSnapshot(FB.doc(FB.db, 'logs', user.uid)"), SRC.indexOf("} catch(snapErr)")); assert.ok(listener.includes('_isLegacyUnboundLog(d)'), 'live listener ignores an unbound root');
  const refresh = SRC.slice(SRC.indexOf("const ref = FB.doc(FB.db, 'logs', USER.uid);"), SRC.indexOf("const ref = FB.doc(FB.db, 'logs', USER.uid);") + 1500); assert.ok(refresh.includes('_isLegacyUnboundLog(data)'), 'refresh ignores an unbound root');
  const bk = fnSrc('loadBackupLogs'); assert.ok(bk.includes('_isLegacyUnboundLog(data)'), 'a local backup without planId is not loaded either');
});
test('T553.U10 NEW EXECUTION after LEGACY_UNBOUND: saved through the plan-bound meso path ONLY; the root document is neither rewritten nor stamped with the planId', async () => {
  const src = fnSrc('_doSaveLogs', true);
  async function run(unbound) {
    const calls = [];
    const rt = new Function(`
      var USER = { uid: 'U' }, ACTIVE_PLAN_ID = 'planB', REAL_WEEK = 1, LOGS = { log_1_0_0_s0: { done: true, prescriptionExerciseId: 'p' } }, EXERCISE_UNITS = {}, EXERCISE_HISTORY = {};
      var _saveLogsTimer = null, _logsWriteInFlight = 0, _logsReqSeq = 0, _logsAckedSeq = 0, _logsAuthorityUpdatedAt = 0, _rootLogUnbound = ${unbound}, calls = arguments[0];
      var document = { getElementById: function(){ return null; }, createElement: function(){ return { style:{}, addEventListener:function(){} }; }, body:{ appendChild:function(){} } };
      var navigator = { onLine: true }; function showToast() {} function _showSaveOk() {} function _maybeConsumeOverlays() {}
      var FB = { doc: function(){ return Array.prototype.join.call(arguments, '/'); }, setDoc: async function(path, payload) { calls.push({ path: path, payload: payload }); } };
      ${src}
      return { save: _doSaveLogs };`)(calls);
    const ok = await rt.save(); return { ok, calls };
  }
  const u = await run(true); assert.equal(u.ok, true); assert.deepEqual(u.calls.map(c => c.path), ['/logs/U/mesos/planB'], 'meso only');
  assert.equal(u.calls[0].payload.planId, 'planB'); assert.deepEqual(Object.keys(u.calls[0].payload.entries), ['log_1_0_0_s0'], 'only the current plan\'s own entries');
  const b = await run(false); assert.deepEqual(b.calls.map(c => c.path), ['/logs/U/mesos/planB', '/logs/U'], 'a bound / absent root keeps the existing dual write (Coach compatibility)');
});
test('T553.U11 the athlete can still train: the loader leaves a usable empty week-1 state and the unbound flag is set only from the document classification (quiet, no UI)', () => {
  assert.ok(/_rootLogUnbound = _isLegacyUnboundLog\(/.test(SRC), 'flag derived from the classification');
  assert.ok(SRC.includes("console.info('LEGACY_LOG_UNBOUND'"), 'diagnostic reason is internal');
  const unbound = SRC.slice(SRC.indexOf('function _isLegacyUnboundLog('), SRC.indexOf('function _isLegacyUnboundLog(') + 900); assert.ok(!/showToast|alert\(|innerHTML/.test(unbound), 'no user-facing corruption message');
});
test('T553.U12 no new collection, no migration: the client has no write to a legacy-unbound collection / no setDoc stamping planId onto the root', () => {
  assert.ok(!/legacy_unbound|unbound_logs|logs_legacy/.test(SRC.replace(/LEGACY_UNBOUND|LEGACY_LOG_UNBOUND|_isLegacyUnboundLog|_rootLogUnbound/g, '')));
});
