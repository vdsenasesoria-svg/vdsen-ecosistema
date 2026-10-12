// T558: the athlete may see a PID-exact next-exposure reference, but it must
// remain read-only evidence. It is never an input default or prescription write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function source(name) {
  const start = client.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0, quote = null, escaped = false;
  for (let i = client.indexOf('{', start); i < client.length; i++) {
    const ch = client[i];
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unterminated ' + name);
}

const ctx = { CURRENT_WEEK: 3, LOGS_BY_WEEK: { progrec: {} }, LOGS: {}, isFinite, String };
vm.createContext(ctx);
vm.runInContext('var _escHTml = function(s) { return String(s); };\n' +
  source('_getPidProgRecForExercise') + '\n' + source('_buildReadOnlyNextExposureHtml') +
  '\nthis.get = _getPidProgRecForExercise; this.render = _buildReadOnlyNextExposureHtml;', ctx);

test('T558.1 client next exposure is exact-PID, latest-first and rejects ambiguity', () => {
  ctx.LOGS_BY_WEEK.progrec = { 3: ['progrec_3_0'], 2: ['progrec_2_0'] };
  ctx.LOGS = {
    progrec_3_0: { calculatedAt: '2026-10-12T12:00:00.000Z', recommendations: [
      { prescriptionExerciseId: 'pid-b', action: 'maintain', newLoad: 70, newReps: 8, rirTarget: 2, exerciseName: 'Mismo nombre' }
    ] },
    progrec_2_0: { calculatedAt: '2026-10-05T12:00:00.000Z', recommendations: [
      { prescriptionExerciseId: 'pid-a', action: 'increase_load', newLoad: 80, newReps: 8, rirTarget: 2, exerciseName: 'Mismo nombre' }
    ] }
  };
  assert.equal(ctx.get('pid-a').newLoad, 80);
  assert.equal(ctx.get('pid-b').newLoad, 70);
  assert.equal(ctx.get('missing'), null);
  assert.equal(ctx.get(null), null);

  ctx.LOGS.progrec_3_0.recommendations.push({ prescriptionExerciseId: 'pid-b', action: 'increase_load', newLoad: 72 });
  assert.equal(ctx.get('pid-b'), null, 'duplicate PID evidence is never guessed');
});

test('T558.2 rendered next exposure is read-only and insufficient evidence stays hidden', () => {
  const html = ctx.render({ action: 'increase_load', newLoad: 82.5, newReps: 10, rirTarget: 2 }, 'KG');
  assert.match(html, /PRÓXIMA EXPOSICIÓN · INFORMATIVO/);
  assert.match(html, /82.5 KG.*10 reps.*RIR 2/);
  assert.doesNotMatch(html, /onclick|<input|value=|newSets/i);
  assert.equal(ctx.render({ action: 'insufficient_data', newLoad: null }, 'KG'), '');
});

test('T558.3 the card is a read-only display path, never an operational sink', () => {
  const card = source('_buildReadOnlyNextExposureHtml');
  assert.doesNotMatch(card, /onclick|document\.|LOGS\[|\.value\s*=|newSets/);
  const clientCard = source('_buildExCard');
  assert.match(clientCard, /_getPidProgRecForExercise\(ej\.prescriptionExerciseId\)/);
  assert.doesNotMatch(clientCard, /_nextExposureHtml[^\n]*\.value|_nextExposureHtml[^\n]*LOGS/);
});
