'use strict';

// Independent numeric pilot and cohort contract. This validator grants no authority by itself.
var UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
var PLAN = '2wywK0y0pKtXRzGS8dNx';
var PID = '831ccbbe-ab09-4669-a0ef-4c652ca84b7a';
var PILOT_SCHEMA = 'vdsen-numeric-pilot-v1';
var COHORT_SCHEMA = 'vdsen-numeric-cohort-v1';
var ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function timestamp(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return NaN;
  var n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === value.replace('Z', '.000Z') ? n : NaN;
}

function windowValid(w, now) {
  if (!w || (w.schema !== PILOT_SCHEMA && w.schema !== COHORT_SCHEMA) || w.mode !== 'NUMERIC_APPLY' ||
      !w.uid || !w.planId || !w.pid ||
      !/^[a-f0-9]{40}$/.test(w.runtimeSha || '') || !/^[A-Za-z0-9-]{8,80}$/.test(w.operationId || '')) return false;
  if (w.schema === PILOT_SCHEMA) {
    if (w.uid !== UID || w.planId !== PLAN || w.pid !== PID) return false;
  } else {
    if (!ID_RE.test(w.uid) || !ID_RE.test(w.planId) || !ID_RE.test(w.pid)) return false;
  }
  var start = timestamp(w.startsAt), end = timestamp(w.expiresAt), t = typeof now === 'number' ? now : Date.parse(now);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(t) && start <= t && t < end && end > start && end - start <= 24 * 3600000;
}

function scopeValid(scope, uid, pid, plan, opts) {
  if (!scope || scope.enabled !== true || !plan || !Array.isArray(plan.days)) return false;
  var isCohort = !!((opts && opts.cohort === true) || scope.cohort === true || scope.schema === 'vdsen-canary-cohort-v1');
  if (!isCohort) {
    if (uid !== UID || pid !== PID ||
        !Array.isArray(scope.clientIds) || scope.clientIds.length !== 1 || scope.clientIds[0] !== UID ||
        !Array.isArray(scope.prescriptionExerciseIds) || scope.prescriptionExerciseIds.length !== 1 || scope.prescriptionExerciseIds[0] !== PID) return false;
  } else {
    if (!Array.isArray(scope.clientIds) || scope.clientIds.length < 1 || scope.clientIds.length > 10 ||
        scope.clientIds.indexOf(uid) < 0 || new Set(scope.clientIds).size !== scope.clientIds.length ||
        !Array.isArray(scope.prescriptionExerciseIds) || scope.prescriptionExerciseIds.length < 1 ||
        scope.prescriptionExerciseIds.indexOf(pid) < 0 || new Set(scope.prescriptionExerciseIds).size !== scope.prescriptionExerciseIds.length) return false;
  }
  return plan.days.some(function(day) {
    return day && Array.isArray(day.exercises) && day.exercises.some(function(ex) { return ex && ex.prescriptionExerciseId === pid; });
  });
}

function runtimeAuthorization(env, now, clientId) {
  if (env.AUTONOMOUS_PROGRESSION_ENABLED !== 'true' || env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED !== 'true' ||
      env.VDSEN_NUMERIC_PILOT_ENABLED !== 'true' || env.CRON_SECRET) return null;
  // Plural cohort windows support
  if (env.VDSEN_NUMERIC_COHORT_WINDOWS) {
    try {
      var cohortList = JSON.parse(env.VDSEN_NUMERIC_COHORT_WINDOWS);
      var arr = Array.isArray(cohortList) ? cohortList : Object.values(cohortList);
      for (var i = 0; i < arr.length; i++) {
        var cw = arr[i];
        if (windowValid(cw, now) && (!clientId || cw.uid === clientId)) {
          if (env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA === cw.runtimeSha) return cw;
        }
      }
      return null;
    } catch (_) { return null; }
  }
  // Single or array window in VDSEN_NUMERIC_PILOT_WINDOW
  try {
    var raw = JSON.parse(env.VDSEN_NUMERIC_PILOT_WINDOW);
    if (Array.isArray(raw)) {
      for (var j = 0; j < raw.length; j++) {
        var item = raw[j];
        if (windowValid(item, now) && (!clientId || item.uid === clientId)) {
          if (env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA === item.runtimeSha) return item;
        }
      }
      return null;
    }
    var w = raw;
    if (!windowValid(w, now) || env.VDSEN_NUMERIC_PILOT_RUNTIME_SHA !== w.runtimeSha) return null;
    if (clientId && w.uid !== clientId) return null;
    return w;
  } catch (_) { return null; }
}

function ledgerValid(ledgerDoc, current, recordKey) {
  if (!ledgerDoc || typeof ledgerDoc !== 'object') return false;
  if (ledgerDoc.schema !== 'vdsen-numeric-operations-ledger-v1' || ledgerDoc.status !== 'RESERVED') return false;
  if (ledgerDoc.operationId !== current.operationId || ledgerDoc.uid !== current.uid ||
      ledgerDoc.planId !== current.planId || ledgerDoc.pid !== current.pid ||
      ledgerDoc.runtimeSha !== current.runtimeSha) return false;
  if (!ledgerDoc.window || ['schema', 'mode', 'uid', 'planId', 'pid', 'runtimeSha', 'operationId', 'startsAt', 'expiresAt'].some(function(k) { return ledgerDoc.window[k] !== current[k]; })) return false;
  if (!ledgerDoc.scope || ledgerDoc.scope.enabled !== true ||
      !Array.isArray(ledgerDoc.scope.clientIds) || ledgerDoc.scope.clientIds.indexOf(current.uid) < 0 ||
      !Array.isArray(ledgerDoc.scope.prescriptionExerciseIds) || ledgerDoc.scope.prescriptionExerciseIds.indexOf(current.pid) < 0) return false;
  if (current.schema === PILOT_SCHEMA) {
    if (ledgerDoc.scope.clientIds.length !== 1 || ledgerDoc.scope.clientIds[0] !== current.uid ||
        ledgerDoc.scope.prescriptionExerciseIds.length !== 1 || ledgerDoc.scope.prescriptionExerciseIds[0] !== current.pid) return false;
  }
  if (recordKey && Array.isArray(ledgerDoc.appliedRecordKeys) && ledgerDoc.appliedRecordKeys.indexOf(recordKey) >= 0) return false;
  return true;
}

function transactionAllowed(original, current, fence, release, scope, uid, record, plan, ledgerDoc, recordKey) {
  if (!current || typeof current !== 'object') return false;
  var isCohort = current.schema === COHORT_SCHEMA;
  var releaseOk = release && Array.isArray(release.clientIds) &&
    (isCohort
      ? (release.clientIds.length >= 1 && release.clientIds.length <= 10 && release.clientIds.indexOf(current.uid) >= 0)
      : (release.clientIds.length === 1 && release.clientIds[0] === current.uid));
  var base = !!(JSON.stringify(current) === JSON.stringify(original) && fence && fence.enabled === true &&
    releaseOk && release.expiresAt === current.expiresAt &&
    ['schema', 'mode', 'uid', 'planId', 'pid', 'runtimeSha', 'operationId', 'startsAt', 'expiresAt'].every(function(k) { return fence[k] === current[k]; }) &&
    record && record.state === 'PENDING' && record.prescriptionExerciseId === current.pid &&
    scopeValid(scope, uid, record.prescriptionExerciseId, plan, { cohort: isCohort }));
  if (!base) return false;
  if (ledgerDoc !== undefined) {
    return ledgerValid(ledgerDoc, current, recordKey);
  }
  return true;
}

module.exports = {
  windowValid: windowValid,
  scopeValid: scopeValid,
  runtimeAuthorization: runtimeAuthorization,
  transactionAllowed: transactionAllowed,
  ledgerValid: ledgerValid,
  UID: UID,
  PLAN: PLAN,
  PID: PID,
  PILOT_SCHEMA: PILOT_SCHEMA,
  COHORT_SCHEMA: COHORT_SCHEMA
};
