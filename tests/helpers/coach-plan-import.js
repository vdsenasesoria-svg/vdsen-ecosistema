'use strict';
// Test helper: run a Motor-style plan JSON through the REAL Coach import normalizer + the explicit save-time PID stamp (functions extracted from vdsen-coach.html and
// executed in a vm sandbox). The result is the plan document shape the Coach persists, so integration tests do not hand-craft plan fields the Coach never writes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const equipmentContext = require('../../assets/equipment-context.js');
const catalog = require('../../assets/exercise-visual-catalog.js');

const COACH = fs.readFileSync(path.join(__dirname, '..', '..', 'vdsen-coach.html'), 'utf8');

function fnSrc(name) {
  let i = COACH.indexOf('async function ' + name + '('); if (i < 0) i = COACH.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found in vdsen-coach.html');
  let d = 0, q = null, esc = false;
  for (let k = COACH.indexOf('{', i); k < COACH.length; k++) {
    const c = COACH[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && COACH[k + 1] === '/') { k = COACH.indexOf('\n', k); continue; }
    if (c === '/' && COACH[k + 1] === '*') { k = COACH.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return COACH.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const consts = () => (COACH.match(/const _PERF_[A-Z_]+\b[\s\S]*?;\n/g) || []).join('\n') + '\n' + (COACH.match(/const _NIVEL_MEDIO_ENUM\b[\s\S]*?;\n/g) || []).join('\n');
const HELPERS = ['_perfScalar', '_perfType', '_perfEffType', '_perfHasNoSetsOk', '_perfCarryEx', '_perfCarrySet', '_genPrescriptionId', '_stampPrescriptionIds', '_normRestSeconds',
  '_carryPrescriptionId', '_normNivelMedio', '_normVariacionVertical', '_carryClassification', '_carryExerciseIdentity'];

// idPrefix makes the minted PIDs unique per test (the sandbox uses a counter instead of crypto.randomUUID).
function coachSandbox(idPrefix, extra) {
  let n = 0;
  const ctx = Object.assign({ console, JSON, Object, Array, String, Number, Math, parseInt, parseFloat, isNaN, Date,
    window: { VDSEN_EQUIPMENT_CONTEXT: equipmentContext, VDSEN_EXERCISE_VISUAL_CATALOG: catalog },
    crypto: { randomUUID: () => (idPrefix || 'pid') + '-' + (++n) } }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(consts() + '\n' + HELPERS.map(fnSrc).join('\n') + '\n' + fnSrc('_normalizeTrainingPlan') +
    '\nthis._normalizeTrainingPlan = _normalizeTrainingPlan; this._stampPrescriptionIds = _stampPrescriptionIds;', ctx);
  return ctx;
}

// Motor-style plan (names + sets only) -> plan fields exactly as the Coach would save them (normalized + stamped).
function importLikeCoach(motorPlan, opts) {
  opts = opts || {};
  const sb = coachSandbox(opts.idPrefix, opts.extra);
  const norm = JSON.parse(JSON.stringify(sb._normalizeTrainingPlan(motorPlan)));
  norm.days = JSON.parse(JSON.stringify(sb._stampPrescriptionIds(norm.days)));
  return norm;
}

module.exports = { importLikeCoach, coachSandbox };
