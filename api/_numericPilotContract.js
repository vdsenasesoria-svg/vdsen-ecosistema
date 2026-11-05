'use strict';

// Independent numeric pilot contract. This validator grants no authority by itself.
var UID = 'z82EDPvsCaabfMN3eGAP3rpxeMt1';
var PLAN = '2wywK0y0pKtXRzGS8dNx';
var PID = '831ccbbe-ab09-4669-a0ef-4c652ca84b7a';
var ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function timestamp(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return NaN;
  var n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString() === value.replace('Z', '.000Z') ? n : NaN;
}
function windowValid(w, now) {
  if (!w || w.schema !== 'vdsen-numeric-pilot-v1' || w.mode !== 'NUMERIC_APPLY' ||
      w.uid !== UID || w.planId !== PLAN || w.pid !== PID ||
      !/^[a-f0-9]{40}$/.test(w.runtimeSha || '') || !/^[A-Za-z0-9-]{8,80}$/.test(w.operationId || '')) return false;
  var start = timestamp(w.startsAt), end = timestamp(w.expiresAt), t = typeof now === 'number' ? now : Date.parse(now);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(t) && start <= t && t < end && end > start && end - start <= 24 * 3600000;
}
function scopeValid(scope, uid, pid, plan) {
  if (!scope || scope.enabled !== true || uid !== UID || pid !== PID ||
      !Array.isArray(scope.clientIds) || scope.clientIds.length !== 1 || scope.clientIds[0] !== UID ||
      !Array.isArray(scope.prescriptionExerciseIds) || scope.prescriptionExerciseIds.length !== 1 || scope.prescriptionExerciseIds[0] !== PID ||
      !plan || !Array.isArray(plan.days)) return false;
  return plan.days.some(function(day) { return day && Array.isArray(day.exercises) && day.exercises.some(function(ex) { return ex && ex.prescriptionExerciseId === PID; }); });
}
module.exports = { windowValid: windowValid, scopeValid: scopeValid, UID: UID, PLAN: PLAN, PID: PID };
