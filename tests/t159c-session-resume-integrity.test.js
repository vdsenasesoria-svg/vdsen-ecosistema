'use strict';
/**
 * T159-C — Client session resume integrity.
 *
 * Scope: Client workout resume only. This protects the reload/reopen path
 * after logs are loaded: keep a restored day when it is still pending, but
 * do not let stale vdsen_last_dia send the client back to a completed day
 * when the real logs show another day is next.
 *
 * Run: node tests/t159c-session-resume-integrity.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  return null;
}

function resolveResumeDayIndex({ restoredDia, sessions, logs, currentWeek = 1, realWeek = 1 }) {
  if (!sessions.length) return 0;
  let idx = parseInt(restoredDia, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= sessions.length) idx = 0;
  if (currentWeek !== realWeek) return idx;

  let firstPending = -1;
  for (let d = 0; d < sessions.length; d++) {
    if (!logs[`done_${currentWeek}_${d}`]) {
      firstPending = d;
      break;
    }
  }
  if (firstPending === -1) return sessions.length - 1;
  if (logs[`done_${currentWeek}_${idx}`]) return firstPending;
  return idx;
}

function isExerciseFullyDone({ logs, week, di, ei, sets = 3, active = true, cardio = false }) {
  if (!active) return true;
  if (cardio) return !!(logs[`log_${week}_${di}_${ei}`] && logs[`log_${week}_${di}_${ei}`].done);
  for (let s = 0; s < sets; s++) {
    const entry = logs[`log_${week}_${di}_${ei}_s${s}`];
    if (!entry || !entry.done) return false;
  }
  return true;
}

function resolveActiveExercise({ exercises, logs, week = 1, di = 0 }) {
  let fallback = 0;
  for (let i = exercises.length - 1; i >= 0; i--) {
    if (exercises[i].active !== false) {
      fallback = i;
      break;
    }
  }
  for (let i = 0; i < exercises.length; i++) {
    const ej = exercises[i];
    if (ej.active === false) continue;
    if (!isExerciseFullyDone({ logs, week, di, ei: i, sets: ej.sets || 3, active: true, cardio: !!ej.cardio })) {
      return i;
    }
  }
  return fallback;
}

const resumeFn = extractFunction(CLIENT, 'function _resolveResumeDayIndex(restoredDia)');
assert.ok(resumeFn, 'T159-C: _resolveResumeDayIndex must exist for reload/reopen day reconciliation');
assert.ok(
  CLIENT.includes('CURRENT_WEEK = REAL_WEEK;\n    DIA_ACTIVO = _resolveResumeDayIndex(_rDia);\n    goTab(_rTab);'),
  'T159-C: loadPlan must reconcile restored day after resetting to REAL_WEEK and before rendering the restored tab'
);
assert.ok(
  resumeFn.includes("LOGS['done_'+CURRENT_WEEK+'_'+idx]") && resumeFn.includes('return firstPending;'),
  'T159-C: stale restored completed day must give way to the first real pending day'
);

const sessions = [{ nombre: 'Dia 1' }, { nombre: 'Dia 2' }, { nombre: 'Dia 3' }];

assert.strictEqual(
  resolveResumeDayIndex({
    restoredDia: 0,
    sessions,
    logs: { log_1_0_0_s0: { done: true } },
  }),
  0,
  'partial day stays selected so renderEntrenamiento can resume the first pending set/exercise'
);

assert.strictEqual(
  resolveResumeDayIndex({
    restoredDia: 0,
    sessions,
    logs: { done_1_0: { ts: 1 } },
  }),
  1,
  'completed restored day advances to the next pending day after refresh/reopen'
);

assert.strictEqual(
  resolveResumeDayIndex({
    restoredDia: 2,
    sessions,
    logs: { done_1_0: { ts: 1 } },
  }),
  2,
  'manual restored day remains valid when that day is still pending'
);

assert.strictEqual(
  resolveResumeDayIndex({
    restoredDia: 0,
    sessions,
    logs: { done_1_0: { ts: 1 }, done_1_1: { ts: 2 }, done_1_2: { ts: 3 } },
  }),
  2,
  'fully completed day list does not reopen a false pending set'
);

assert.strictEqual(
  resolveResumeDayIndex({
    restoredDia: 0,
    sessions,
    currentWeek: 2,
    realWeek: 2,
    logs: { done_1_0: { ts: 1 } },
  }),
  0,
  'done logs from a different week do not contaminate current-week resume'
);

assert.strictEqual(
  resolveResumeDayIndex({
    restoredDia: 0,
    sessions,
    currentWeek: 2,
    realWeek: 2,
    logs: { done_2_0: { ts: 1 } },
  }),
  1,
  'current-week done logs still drive resume to the next pending day'
);

assert.strictEqual(
  resolveActiveExercise({
    exercises: [{ sets: 3 }, { sets: 2 }],
    logs: {
      log_1_0_0_s0: { done: true },
      log_1_0_0_s1: { done: true },
    },
  }),
  0,
  'partial exercise remains active so the first pending set can be completed'
);

assert.strictEqual(
  resolveActiveExercise({
    exercises: [{ sets: 2 }, { sets: 2 }],
    logs: {
      log_1_0_0_s0: { done: true },
      log_1_0_0_s1: { done: true },
    },
  }),
  1,
  'completed exercise advances to the next pending exercise after refresh/reopen'
);

assert.strictEqual(
  resolveActiveExercise({
    exercises: [{ sets: 1 }, { sets: 1 }],
    logs: {
      log_1_0_0_s0: { done: true },
      log_1_0_1_s0: { done: true },
    },
  }),
  1,
  'completed day falls back to the last active exercise instead of inventing a pending set'
);

assert.ok(
  CLIENT.includes('function _isExerciseFullyDone(di, ei, ej)') &&
    CLIENT.includes('if (!_isExerciseFullyDone(DIA_ACTIVO, _ae, ejercicios[_ae]))') &&
    CLIENT.includes('EJ_ACTIVO = _ae; _foundActive = true; break;'),
  'T159-C: renderEntrenamiento must still derive active exercise from first incomplete exercise'
);

assert.ok(
  CLIENT.includes("FB.doc(FB.db, 'logs', user.uid, 'mesos', activePlanId)") &&
    CLIENT.includes('localPlanId   && localPlanId   !== activePlanId') &&
    CLIENT.includes('firestorePlanId && firestorePlanId !== activePlanId') &&
    CLIENT.includes('_rebuildLogsByWeek();'),
  'T159-C: plan-specific logs, active plan guard, and week index rebuild must remain in the load path'
);

console.log('T159-C — Client session resume integrity: ALL ASSERTIONS PASSED');
