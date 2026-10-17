'use strict';
// T552: T551 closed the different-plan case only through PID mismatch. This is the EXPLICIT test with the SAME PID in two plans (a re-imported / duplicated plan
// keeps its PIDs, T150-H): previous-week display + reuse are SAME-PLAN ONLY. The fence is the log source selection: LOGS must never be plan A's evidence while
// plan B is active. Control: same plan + same PID + exactly week-1 => reference and reuse available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) {
  const i = SRC.indexOf('function ' + name + '(');
  assert.ok(i > -1, 'missing function ' + name);
  let d = 0; const j = SRC.indexOf('{', i);
  for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}' && --d === 0) return SRC.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
const FNS = ['_exNotePidKey', '_exNoteCtx', '_exNoteValid', '_exNoteShadowed', '_roundUnit', '_convertCarga', '_prevWeekRef', '_prevWeekHtml', '_prevWeekReuse', '_prevWeekKeyParts', '_prevWeekReuseHtml', '_logDocHasEvidence', '_isLegacyUnboundLog', '_selectLogAuthority', '_logsPlanChanged'];
const SAME = 'pid-same-123';
const pres = [{ prescriptionExerciseId: SAME, exerciseName: 'Press banca', sets: [{ rirTarget: 2, load: 100, repsTarget: 8 }] }];
const set = o => Object.assign({ carga: '80', reps: '10', unit: 'KG', done: true, rir: 2, rir_real: '3', prescriptionExerciseId: SAME, ts: 1 }, o);
const docA = () => ({ planId: 'planA', currentWeek: 1, updatedAt: 100, entries: { log_1_0_0_s0: set({}), log_1_0_0_s1: set({ reps: '9' }) } });   // PLAN A, Week 1, PID = pid-same-123, 80 kg x 10
function world(activePlanId, logsOf, week) {
  const ctx = { console, Number, Math, JSON, Date, Object, Array, String, parseInt, parseFloat, isNaN, RegExp, LOGS: logsOf, ACTIVE_PLAN_ID: activePlanId, CURRENT_WEEK: week, _EJERCICIOS_DIA: pres,
    _escHTml: s => String(s), document: { getElementById: () => null } };
  ctx.window = ctx; vm.createContext(ctx); for (const f of FNS) vm.runInContext(fnSrc(f), ctx); return ctx;
}
const btn = (w) => w._prevWeekReuseHtml('log_' + w.CURRENT_WEEK + '_0_0_s0', 'KG');
// What the loader does: pick the log doc for the ACTIVE plan; if the doc belongs to another plan, `_logsPlanChanged` => LOGS = {} (week 1, no evidence).
function loaderLogs(w, meso, root, activePlanId, flag, localPlan) {
  const logData = w._selectLogAuthority(meso, root, activePlanId);
  if (!logData) return {};
  return w._logsPlanChanged(logData, activePlanId, flag, localPlan) ? {} : (logData.entries || {});
}

test('T552.X1 CONTROL: same plan + same PID + exactly week-1 => ÚLTIMA SEMANA and USAR CARGA/REPS are available', () => {
  const w0 = world('planA', {}, 2); const logs = loaderLogs(w0, null, docA(), 'planA', false, 'planA'); assert.equal(Object.keys(logs).length, 2);
  const w = world('planA', logs, 2); assert.ok(w._prevWeekHtml(0, 0).includes('S1 · 80 kg × 10 · RIR 3'));
  const b = btn(w); assert.ok(b.includes('USAR CARGA/REPS') && b.includes('S1 · 80 kg × 10'));
});
test('T552.X2 SAME PID in ANOTHER plan: plan B (current, Week 2) never shows plan A\'s Week-1 execution — no meso doc for B yet, root doc still plan A', () => {
  const w0 = world('planB', {}, 2); const logs = loaderLogs(w0, null, docA(), 'planB', false, null);   // fresh device: no localStorage plan id; Firestore root doc is plan A's
  assert.deepEqual(Object.keys(logs), [], 'plan A\'s entries are not loaded for plan B');
  const w = world('planB', logs, 2); assert.equal(w._prevWeekHtml(0, 0), '', 'ÚLTIMA SEMANA absent'); assert.equal(btn(w), '', 'USAR CARGA/REPS absent');
});
test('T552.X3 SAME PID in ANOTHER plan: meso doc of plan B exists (Week 2, empty) next to the stale plan-A root doc => plan B\'s own log wins; still nothing to reuse', () => {
  const mesoB = { planId: 'planB', currentWeek: 2, updatedAt: 50, entries: {} };
  const w0 = world('planB', {}, 2); const logs = loaderLogs(w0, mesoB, docA(), 'planB', false, 'planB'); assert.deepEqual(Object.keys(logs), []);
  const w = world('planB', logs, 2); assert.equal(w._prevWeekHtml(0, 0), ''); assert.equal(btn(w), '');
});
test('T552.X4 plan switch signals are independent: Firestore planId mismatch, local plan id mismatch and the session flag each reset the log source', () => {
  const w = world('planB', {}, 1);
  assert.equal(w._logsPlanChanged({ planId: 'planA', entries: { x: 1 } }, 'planB', false, 'planB'), true, 'firestore planId differs');
  assert.equal(w._logsPlanChanged({ planId: 'planB', entries: {} }, 'planB', false, 'planA'), true, 'local plan id differs');
  assert.equal(w._logsPlanChanged({ planId: 'planB', entries: {} }, 'planB', true, 'planB'), true, 'session flag');
  assert.equal(w._logsPlanChanged({ planId: 'planB', entries: {} }, 'planB', false, 'planB'), false, 'same plan: the saved week / entries are used');
  assert.equal(w._logsPlanChanged(null, 'planB', false, 'planB'), false);
});
test('T552.X5 the loader uses the tested decision (no second inline copy) and the plan-switch branch still wipes LOGS', () => {
  assert.ok(SRC.includes('var planChanged = _logsPlanChanged(logData, activePlanId, flagSession, localPlanId);'));
  const i = SRC.indexOf('if (planChanged) {'); const branch = SRC.slice(i, i + 1400); assert.ok(/LOGS\s*=\s*\{\};/.test(branch) && /CURRENT_WEEK\s*=\s*1;/.test(branch) && /REAL_WEEK\s*=\s*1;/.test(branch));
  assert.ok(/data\.planId && ACTIVE_PLAN_ID && data\.planId !== ACTIVE_PLAN_ID/.test(SRC), 'the T124-C refresh guard against stale cross-plan entries is intact');
});
test('T552.X6 the USAR CARGA/REPS contract is unchanged (explicit, load + reps only, draft, no RIR / ICS / Pump, no save)', () => {
  const use = fnSrc('_prevWeekUse'); assert.ok(use.includes("'carga_' + key") && use.includes("'reps_' + key"));
  for (const bad of ['setRirReal', 'rir_real', 'ics', 'pump', 'saveLogs', '_doSaveLogs', 'completeSet', 'LOGS[']) assert.ok(!use.includes(bad), bad);
});
