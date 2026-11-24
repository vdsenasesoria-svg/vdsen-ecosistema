'use strict';

// Independent numeric pilot and multi-cohort contract. This validator grants no authority by itself.
var crypto = require('node:crypto');
var UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
var PLAN = 'yoQVsI7drVJbcHOg4sZQ';
var PID = '506fb437-f151-499a-bbdb-512cd4d0b7c6';
var PILOT_SCHEMA = 'vdsen-numeric-pilot-v1';
var COHORT_SCHEMA = 'vdsen-numeric-cohort-v1';
var COHORT_MAX_CLIENTS = 10;
var PILOT_MAX_TTL_MS = 24 * 3600000;
var COHORT_MAX_TTL_MS = 31 * 24 * 3600000;
var ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
var COHORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var SHA256_RE = /^[a-f0-9]{64}$/;
var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function timestamp(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return NaN;
  var n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === value.replace('Z', '.000Z') ? n : NaN;
}

function computePidsHash(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return null;
  var valid = pids.every(function(x) { return typeof x === 'string' && ID_RE.test(x) && x !== '*'; });
  if (!valid) return null;
  var sorted = pids.slice().sort();
  if (new Set(sorted).size !== sorted.length) return null;
  return crypto.createHash('sha256').update(sorted.join(',')).digest('hex');
}

function hasMultiPidBinding(w) {
  return !!(w && typeof w.pidsHash === 'string' && SHA256_RE.test(w.pidsHash) && Number.isInteger(w.pidCount) && w.pidCount >= 1);
}

function windowValid(w, now) {
  if (!w || (w.schema !== PILOT_SCHEMA && w.schema !== COHORT_SCHEMA) || w.mode !== 'NUMERIC_APPLY' ||
      !w.uid || !w.planId ||
      !/^[a-f0-9]{40}$/.test(w.runtimeSha || '') || !/^[A-Za-z0-9-]{8,80}$/.test(w.operationId || '')) return false;
  if (w.schema === PILOT_SCHEMA) {
    if (!w.pid || w.uid !== UID || w.planId !== PLAN || w.pid !== PID) return false;
  } else {
    if (!ID_RE.test(w.uid) || !ID_RE.test(w.planId)) return false;
    if (w.cohortId !== undefined && !COHORT_ID_RE.test(String(w.cohortId || ''))) return false;
    var singlePidOk = typeof w.pid === 'string' && ID_RE.test(w.pid) && w.pid !== '*';
    var multiPidOk = hasMultiPidBinding(w);
    if (!singlePidOk && !multiPidOk) return false;
    if (multiPidOk && w.pids !== undefined) {
      if (!Array.isArray(w.pids) || w.pids.length !== w.pidCount || computePidsHash(w.pids) !== w.pidsHash) return false;
    }
  }
  var start = timestamp(w.startsAt), end = timestamp(w.expiresAt), t = typeof now === 'number' ? now : Date.parse(now);
  var maxTtl = w.schema === COHORT_SCHEMA ? COHORT_MAX_TTL_MS : PILOT_MAX_TTL_MS;
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(t) && start <= t && t < end && end > start && end - start <= maxTtl;
}

function pidAuthorized(windowSpec, fenceForClient, pid) {
  if (!windowSpec || typeof pid !== 'string' || !ID_RE.test(pid) || pid === '*') return false;
  if (hasMultiPidBinding(windowSpec)) {
    var list = (fenceForClient && Array.isArray(fenceForClient.pids) ? fenceForClient.pids : null) ||
      (Array.isArray(windowSpec.pids) ? windowSpec.pids : null);
    if (!list || list.length !== windowSpec.pidCount) return false;
    if (computePidsHash(list) !== windowSpec.pidsHash) return false;
    return list.indexOf(pid) >= 0;
  }
  if (windowSpec.pid !== pid) return false;
  if (fenceForClient && fenceForClient.pid !== pid) return false;
  return true;
}

function scopeValid(scope, uid, pid, plan, opts) {
  if (!scope || scope.enabled !== true || !plan || !Array.isArray(plan.days)) return false;
  var isCohort = !!((opts && opts.cohort === true) || scope.cohort === true || scope.schema === 'vdsen-canary-cohort-v1');
  if (!isCohort) {
    if (uid !== UID || pid !== PID ||
        !Array.isArray(scope.clientIds) || scope.clientIds.length !== 1 || scope.clientIds[0] !== UID ||
        !Array.isArray(scope.prescriptionExerciseIds) || scope.prescriptionExerciseIds.length !== 1 || scope.prescriptionExerciseIds[0] !== PID) return false;
  } else {
    var targetScope = scope;
    if (opts && opts.cohortId && scope.cohorts && typeof scope.cohorts === 'object') {
      targetScope = scope.cohorts[opts.cohortId];
      if (!targetScope || targetScope.enabled !== true) return false;
    }
    if (!Array.isArray(targetScope.clientIds) || targetScope.clientIds.length < 1 || targetScope.clientIds.length > COHORT_MAX_CLIENTS ||
        targetScope.clientIds.indexOf(uid) < 0 || new Set(targetScope.clientIds).size !== targetScope.clientIds.length ||
        !Array.isArray(targetScope.prescriptionExerciseIds) || targetScope.prescriptionExerciseIds.length < 1 ||
        targetScope.prescriptionExerciseIds.indexOf(pid) < 0 || new Set(targetScope.prescriptionExerciseIds).size !== targetScope.prescriptionExerciseIds.length) return false;
  }
  return plan.days.some(function(day) {
    return day && Array.isArray(day.exercises) && day.exercises.some(function(ex) { return ex && ex.prescriptionExerciseId === pid; });
  });
}

function _matchCohortList(rawJson, env, now, clientId) {
  if (!rawJson) return null;
  try {
    var cohortList = JSON.parse(rawJson);
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

function runtimeAuthorization(env, now, clientId) {
  if (env.AUTONOMOUS_PROGRESSION_ENABLED !== 'true' || env.AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED !== 'true' ||
      env.VDSEN_NUMERIC_PILOT_ENABLED !== 'true' || env.CRON_SECRET) return null;
  // Sharded per-cohort env vars (VDSEN_NUMERIC_COHORT_1 .. VDSEN_NUMERIC_COHORT_20), each <= 10 clients
  for (var s = 1; s <= 20; s++) {
    var shardKey = 'VDSEN_NUMERIC_COHORT_' + s;
    if (env[shardKey]) {
      var hit = _matchCohortList(env[shardKey], env, now, clientId);
      if (hit) return hit;
    }
  }
  // Plural cohort windows support
  if (env.VDSEN_NUMERIC_COHORT_WINDOWS) {
    return _matchCohortList(env.VDSEN_NUMERIC_COHORT_WINDOWS, env, now, clientId);
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

function windowFieldsMatch(a, b) {
  if (!a || !b) return false;
  var baseKeys = ['schema', 'mode', 'uid', 'planId', 'runtimeSha', 'operationId', 'startsAt', 'expiresAt'];
  if (baseKeys.some(function(k) { return a[k] !== b[k]; })) return false;
  if (a.cohortId !== b.cohortId) return false;
  if (hasMultiPidBinding(a) || hasMultiPidBinding(b)) {
    return a.pidsHash === b.pidsHash && a.pidCount === b.pidCount;
  }
  return a.pid === b.pid;
}

function ledgerValid(ledgerDoc, current, recordKey, targetPid) {
  if (!ledgerDoc || typeof ledgerDoc !== 'object') return false;
  if (ledgerDoc.schema !== 'vdsen-numeric-operations-ledger-v1' || ledgerDoc.status !== 'RESERVED') return false;
  if (ledgerDoc.operationId !== current.operationId || ledgerDoc.runtimeSha !== current.runtimeSha) return false;
  if (current.schema === PILOT_SCHEMA) {
    if (ledgerDoc.uid !== current.uid || ledgerDoc.planId !== current.planId || ledgerDoc.pid !== current.pid) return false;
    if (!windowFieldsMatch(ledgerDoc.window, current)) return false;
    if (!ledgerDoc.scope || ledgerDoc.scope.enabled !== true ||
        !Array.isArray(ledgerDoc.scope.clientIds) || ledgerDoc.scope.clientIds.length !== 1 || ledgerDoc.scope.clientIds[0] !== current.uid ||
        !Array.isArray(ledgerDoc.scope.prescriptionExerciseIds) || ledgerDoc.scope.prescriptionExerciseIds.length !== 1 || ledgerDoc.scope.prescriptionExerciseIds[0] !== current.pid) return false;
  } else {
    var ledgerWindow = (ledgerDoc.windows && ledgerDoc.windows[current.uid]) || ledgerDoc.window;
    if (!windowFieldsMatch(ledgerWindow, current)) return false;
    var checkPid = targetPid || current.pid;
    if (!ledgerDoc.scope || ledgerDoc.scope.enabled !== true ||
        !Array.isArray(ledgerDoc.scope.clientIds) || ledgerDoc.scope.clientIds.length < 1 || ledgerDoc.scope.clientIds.length > COHORT_MAX_CLIENTS ||
        ledgerDoc.scope.clientIds.indexOf(current.uid) < 0 ||
        !Array.isArray(ledgerDoc.scope.prescriptionExerciseIds) ||
        (checkPid && ledgerDoc.scope.prescriptionExerciseIds.indexOf(checkPid) < 0)) return false;
  }
  if (recordKey && Array.isArray(ledgerDoc.appliedRecordKeys) && ledgerDoc.appliedRecordKeys.indexOf(recordKey) >= 0) return false;
  return true;
}

function transactionAllowed(original, current, fence, release, scope, uid, record, plan, ledgerDoc, recordKey) {
  if (!current || typeof current !== 'object') return false;
  var isCohort = current.schema === COHORT_SCHEMA;
  var releaseOk = release && Array.isArray(release.clientIds) &&
    (isCohort
      ? (release.clientIds.length >= 1 && release.clientIds.length <= COHORT_MAX_CLIENTS && release.clientIds.indexOf(current.uid) >= 0)
      : (release.clientIds.length === 1 && release.clientIds[0] === current.uid));
  var recPid = record && record.prescriptionExerciseId;
  var base = !!(JSON.stringify(current) === JSON.stringify(original) && fence && fence.enabled === true &&
    releaseOk && release.expiresAt === current.expiresAt &&
    windowFieldsMatch(fence, current) &&
    record && record.state === 'PENDING' && pidAuthorized(current, fence, recPid) &&
    scopeValid(scope, uid, recPid, plan, { cohort: isCohort, cohortId: current.cohortId }));
  if (!base) return false;
  if (ledgerDoc !== undefined) {
    return ledgerValid(ledgerDoc, current, recordKey, recPid);
  }
  return true;
}

module.exports = {
  windowValid: windowValid,
  scopeValid: scopeValid,
  runtimeAuthorization: runtimeAuthorization,
  transactionAllowed: transactionAllowed,
  ledgerValid: ledgerValid,
  computePidsHash: computePidsHash,
  pidAuthorized: pidAuthorized,
  windowFieldsMatch: windowFieldsMatch,
  UID: UID,
  PLAN: PLAN,
  PID: PID,
  PILOT_SCHEMA: PILOT_SCHEMA,
  COHORT_SCHEMA: COHORT_SCHEMA,
  COHORT_MAX_CLIENTS: COHORT_MAX_CLIENTS
};
