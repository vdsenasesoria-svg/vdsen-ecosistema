// T515: runtime display defaults (RIR 2 / rest 90 when the Coach omitted them; rest-timer fatigueCost fallback) are UI
// fallbacks ONLY. They never overwrite a Coach-authored value (incl. 0), are never persisted as prescription, and never
// become canonical evidence (log.rir prescribed / history observed RIR).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const between = (a, b) => { const i = client.indexOf(a); assert.ok(i >= 0, a); const j = client.indexOf(b, i); assert.ok(j > i, b); return client.slice(i, j); };

// --- the plan converter (real source) ---
const rirLine = between("var rirTarget  = (e.sets && e.sets[0]", "\n");
const setsMap = between("sets: (e.sets || []).map(function(s, si){", "          coachNote: e.coachNote");
function convert(e) {
  const ctx = { e, out: null };
  vm.createContext(ctx);
  vm.runInContext(`var repsTarget = 8; ${rirLine}\nvar firstAuthored = !!(e.sets && e.sets[0] && e.sets[0].rirTarget !== undefined && e.sets[0].rirTarget !== null);\nvar o = { ${setsMap.replace(/\),\s*$/, ')')} };\nthis.out = o.sets; this.rirTarget = rirTarget;`, ctx);
  return ctx;
}

test('T515.1 a Coach-authored rest of 0 (superset A1) and RIR 0 are preserved by the converter', () => {
  const r = convert({ sets: [{ setIndex: 0, repsTarget: 10, rirTarget: 0, restSeconds: 0 }, { setIndex: 1, repsTarget: 10, rirTarget: 0, restSeconds: 90 }] });
  assert.deepEqual([r.out[0].restSeconds, r.out[0].rirTarget, r.out[1].restSeconds], [0, 0, 90]);
  assert.ok(!r.out[0].restDefaulted && !r.out[0].rirDefaulted);
});

test('T515.2 omitted values are defaulted for DISPLAY and are explicitly marked as defaults', () => {
  const r = convert({ sets: [{ setIndex: 0, repsTarget: 10 }] });
  assert.deepEqual([r.out[0].restSeconds, r.out[0].rirTarget, r.out[0].restDefaulted, r.out[0].rirDefaulted], [90, 2, true, true]);
});

test('T515.3 the exercise-level RIR is marked defaulted only when the Coach authored none', () => {
  assert.ok(/rirDefaulted: !\(e\.sets && e\.sets\[0\] && e\.sets\[0\]\.rirTarget !== undefined && e\.sets\[0\]\.rirTarget !== null\)/.test(client));
});

// --- completeSet: prescribed RIR on the log is Coach-authored or absent ---
const start = client.indexOf('async function completeSet(key, di, ei, si, unit) {');
let depth = 0, end = client.indexOf('{', start);
for (; end < client.length; end++) { if (client[end] === '{') depth++; if (client[end] === '}' && --depth === 0) break; }
const completeSetSource = client.slice(start, end + 1);
function runtime(ej) {
  return new Function('EJ', `
    var CURRENT_WEEK = 1, REAL_WEEK = 1, DIA_ACTIVO = 0, EJ_ACTIVO = 0;
    var LOGS = {}, EXERCISE_HISTORY = {}, LOGS_BY_WEEK = { log: { 1: [] } }, _saveLogsTimer = null, recorded = [];
    var _EJERCICIOS_DIA = [EJ]; var window = {}, navigator = {};
    var elements = { carga_log_1_0_0_s0: { value: '80' }, reps_log_1_0_0_s0: { value: '8' }, rir_log_1_0_0_s0: { value: '' }, ics_log_1_0_0_s0: { value: '8' },
      setrow_log_1_0_0_s0: { dataset: { exname: 'press' }, style: {}, offsetHeight: 0 } };
    var document = { getElementById: function(id) { return elements[id] || null; } };
    function getExUnit() { return 'KG'; }
    function getAdjustedRIR(b) { var v = parseInt(b); return isFinite(v) ? v : 2; }
    function _coachRIR(e) { var v = parseInt(e && e.rir); return isFinite(v) ? v : 2; }
    function _historyPidKey(pid) { return pid ? '__pid__' + String(pid) : ''; }
    function _lbwTrack() {} function _recordExerciseHistoryAndPR() { recorded.push([].slice.call(arguments)); return false; }
    function _rebuildExerciseHistoryFromLogs() {} function saveLogs() {} async function _doSaveLogs() { return true; }
    function _isExerciseFullyDone() { return false; } function isTechniqueActive() { return true; } function _refreshExPanelOnly() {}
    function _resolveNextWorkoutAction() { return { type: 'NONE' }; } function _renderNextWorkoutAction() {} function isY3TExercise() { return false; }
    function getEffectiveSets(e) { return e.sets; } function getTotalWeeks() { return 6; } function showToast() {} function startRestTimer() {}
    function setTimeout(fn) { fn(); }
    ${completeSetSource}
    return { save: completeSet, log: function() { return LOGS.log_1_0_0_s0; }, recorded: function() { return recorded; } };
  `)(ej);
}
const ejBase = { exerciseName: 'Press', prescriptionExerciseId: 'pid-press', sets: [{ restSeconds: 0 }] };

test('T515.4 a defaulted prescribed RIR is NOT written to the log (no invented canonical evidence)', async () => {
  const app = runtime(Object.assign({ rir: '2', rirDefaulted: true }, ejBase));
  await app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  assert.equal(app.log().rir, undefined); assert.equal(app.log().carga, '80');
});

test('T515.5 a Coach-authored prescribed RIR (including 0) is logged; observed RIR stays separate', async () => {
  for (const rir of ['3', '0']) {
    const app = runtime(Object.assign({ rir, rirDefaulted: false }, ejBase));
    await app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
    assert.equal(app.log().rir, Number(rir)); assert.equal(app.log().rir_real, '');
  }
});

test('T515.6 history never stores the PRESCRIBED RIR as the observed one when the athlete logged none', async () => {
  const app = runtime(Object.assign({ rir: '2', rirDefaulted: false }, ejBase));
  await app.save('log_1_0_0_s0', 0, 0, 0, 'KG');
  assert.equal(app.recorded()[0][4], '', 'observed RIR argument is empty, not the prescribed value');
});

// --- the canonical policy never reads a defaulted value ---
test('T515.7 with no Coach RIR anywhere the canonical policy produces no candidate (RIR_EVIDENCE_MISSING)', () => {
  const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
  const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
  const PID = 'pid-x', T0 = Date.parse('2026-09-27T12:00:00.000Z');
  const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [0, 2].map(d => ({ dayIndex: d, exercises: [
    { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'X', sets: [0, 1, 2].map(i => ({ setIndex: i, repsTarget: 10, restSeconds: 90 })) }] })) };
  const entries = {}; [[1, 0], [1, 2]].forEach(([w, d]) => [0, 1, 2].forEach(s => { entries['log_' + w + '_' + d + '_0_s' + s] = { carga: '100', reps: '10', unit: 'KG', done: true, rir_real: 3, prescriptionExerciseId: PID, ts: T0 + d * 1000 + s }; }));
  const rec = shadow.buildRecord({ clientId: 'c', planId: 'p', activePlanId: 'p', plan, entries, week: 1, dayIndex: 2, calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: PID, exerciseId: 'e', exerciseName: 'X', action: 'increase_load', newLoad: 5, newReps: 10 } }, '2026-09-27T13:00:00.000Z');
  assert.equal(rec.magnitude.eligible, false); assert.ok(rec.magnitude.reasonCodes.includes('RIR_EVIDENCE_MISSING'));
  assert.equal(rec.magnitude.candidates.length, 0); void policy;
});

// --- nothing persists the fallbacks ---
test('T515.8 defaults are never persisted: the athlete client writes no prescription, and log/plan writes carry no rest default', () => {
  assert.ok(!/(updateDoc|setDoc|addDoc)\([^;]*plans/.test(client));
  const logWrite = between("LOGS[key] = { carga, reps, unit, done, rir:", "_lbwTrack(key);");
  assert.ok(!/restSeconds|restDefaulted|fatigueCost/.test(logWrite));
  const timers = [client.indexOf('function markExpressSerie('), client.indexOf('function markExpressSsRonda(')].map(i => client.slice(i, client.indexOf('\n}\n', i)));
  for (const body of timers) assert.ok(!/LOGS\[[^\]]*\]\s*=[^=][^;]*restTime/.test(body), 'the rest fallback never lands in LOGS');
});
