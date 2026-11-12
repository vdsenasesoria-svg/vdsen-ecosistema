// T499: the athlete may author EXECUTION (logs, notes, skip) but never the prescription. exmod_* (athlete-edited
// sets / reps target / RIR) no longer exists as an authoring or reading path; stored exmod_ data is left untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const lines = client.split('\n');

test('T499.1 the athlete prescription editor is gone (modal, save, clear, menu entry)', () => {
  for (const n of ['showExModModal', 'saveExMod', 'clearExMod', 'exModOverlay', 'exmod_ns', 'exmod_rr', 'exmod_rir', 'Ajustar series/reps'])
    assert.ok(!client.includes(n), n);
});

test('T499.2 no code reads or writes exmod_ keys', () => {
  const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /['"]exmod_/.test(l) && !/^\s*\/\//.test(l));
  assert.deepEqual(hits.map(([n, l]) => n + ': ' + l.trim().slice(0, 80)), []);
  assert.ok(!coach.includes('exmod_'));
});

test('T499.3 rendered / counted set totals come only from the Coach plan (plus logged execution)', () => {
  assert.ok(!/exMod\.(numSeries|repsRange|rir)/.test(client));
  assert.ok(!/_exMod\./.test(client));
});

test('T499.4 legitimate athlete channels remain: execution logs, notes, skip, unit toggle', () => {
  for (const n of ['toggleUserNote', 'skipExercise', 'toggleExUnit', 'exnote_', 'completeSet'])
    assert.ok(client.includes(n), n);
  assert.ok(client.includes('rir_real: rirReal'));
});

test('T499.5 historical exmod_ entries stored in LOGS are not deleted by the client', () => {
  assert.ok(!/delete LOGS\[[^\]]*exmod/.test(client));
  assert.ok(!/Object\.keys\(LOGS\)[^\n]*exmod/.test(client));
});
