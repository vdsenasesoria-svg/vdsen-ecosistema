'use strict';
// Test-only isolated module instance: production always imports the real pilot contract.
const Module = require('node:module');
const fs = require('node:fs');
const filename = require.resolve('../../api/_autonomousProgression');
function createSyntheticExecutor(syntheticWindow) {
const instance = new Module(filename, module);
instance.filename = filename;
instance.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
const originalRequire = instance.require.bind(instance);
instance.require = function(id) {
  if (id !== './_numericPilotContract.js') return originalRequire(id);
  return {
    runtimeAuthorization: () => syntheticWindow || null,
    windowValid: (w, now) => !!w && w.schema === 'vdsen-numeric-pilot-v1' && w.mode === 'NUMERIC_APPLY' &&
      Date.parse(w.startsAt) <= Date.parse(now) && Date.parse(now) < Date.parse(w.expiresAt) &&
      Date.parse(w.expiresAt) - Date.parse(w.startsAt) <= 86400000,
    scopeValid: (s, uid, pid, plan) => !!s && s.enabled === true && s.clientIds.length === 1 && s.clientIds[0] === uid &&
      s.prescriptionExerciseIds.length === 1 && s.prescriptionExerciseIds[0] === pid &&
      plan.days.some(d => d.exercises.some(e => e.prescriptionExerciseId === pid))
  };
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
module.exports = { createSyntheticExecutor, createSyntheticSweep };
