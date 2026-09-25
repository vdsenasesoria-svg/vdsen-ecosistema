const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('var _historyStore = typeof EXERCISE_HISTORY');
const end = client.indexOf('\n    return false;\n  }\n\n  // The write belongs', start);
assert.ok(start >= 0 && end > start);
const source = client.slice(start, end);

test('T437: failed set write rollback uses the PID history key', () => {
  assert.match(source, /var _historyKey = _historyPidKey\(_ejMeta\.prescriptionExerciseId/);
  assert.match(source, /_historyStore\[_historyKey\] = _previousExerciseHistory/);
  assert.match(source, /delete _historyStore\[_historyKey\]/);
});
