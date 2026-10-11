'use strict';

// T255 — P0: actual execution is the authority. A missing or partial client
// execution must surface as evidence insufficiency, never as completed work or
// an automatic numeric adjustment. This exercises the real client helper and
// asserts the Coach consumes its explicit state as an exception.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, declaration + ' must exist');
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + declaration);
}

const helperSource = extractFunction(client, 'function _insufficientProgressionRec(ej, opts)');
const makeRec = new Function('_avgArr', helperSource + '; return _insufficientProgressionRec;')(
  values => values.reduce((sum, value) => sum + value, 0) / values.length
);

const prescribed = {
  exerciseName: 'Press Banca',
  exerciseId: 'catalog-bench',
  prescriptionExerciseId: 'pid-client-a-bench',
  sets: [{}, {}, {}]
};

const missing = makeRec(prescribed, { plannedSetCount: 3, prescribedRIR: 2 });
assert.deepStrictEqual(
  {
    action: missing.action,
    executionState: missing.executionState,
    pid: missing.prescriptionExerciseId,
    exerciseId: missing.exerciseId,
    numeric: [missing.newLoad, missing.newSets, missing.newReps, missing.rirTarget],
    completion: missing.setMetrics.setCompletionRate
  },
  {
    action: 'insufficient_data',
    executionState: 'NO_EXECUTED_SETS',
    pid: 'pid-client-a-bench',
    exerciseId: 'catalog-bench',
    numeric: [null, null, null, null],
    completion: 0
  },
  'no performed sets retains exact prescribed identity and proposes no numeric mutation'
);

const partial = makeRec(prescribed, {
  plannedSetCount: 3,
  prescribedRIR: 2,
  sets: [{ done: true, rir_real: '1', ics: '8' }]
});
assert.strictEqual(partial.action, 'insufficient_data');
assert.strictEqual(partial.executionState, 'PARTIAL_EXECUTION');
assert.strictEqual(partial.setMetrics.setCompletionRate, 1 / 3);
assert.strictEqual(partial.observedRIR, 1);
assert.strictEqual(partial.observedICS, 8);
assert.strictEqual(partial.newLoad, null);

assert.ok(
  client.includes("if (sets.length < planSets) return _insufficientProgressionRec(ej, {"),
  'partial execution is gated before normal progression math'
);
assert.ok(
  client.includes('var setCompletionRate = planSets > 0 ? Math.min(1, sets.length / planSets) : null;'),
  'completion rate uses prescribed, not executed, set count'
);
assert.ok(
  coach.includes("if (r.action === 'insufficient_data') return 'INSUFFICIENT_DATA';"),
  'Coach exposes explicit insufficient execution as its own state'
);
assert.ok(
  coach.includes("insufficient_data:{label:'DATOS INSUFICIENTES',color:'#888'}"),
  'Coach renders the state without inventing a progression action'
);
assert.ok(
  coach.includes("const _rPid   = r.prescriptionExerciseId || '';") &&
  !coach.includes("const _rPid   = (_monEx && _monEx.prescriptionExerciseId) || '';") ,
  'Coach deep links use the persisted prescriptionExerciseId, never a display-name lookup'
);
assert.ok(!client.includes('NUMERIC_APPLY_ENABLED = true'), 'numeric application remains disabled');

console.log('T255 — progression execution boundary: PASSED');
