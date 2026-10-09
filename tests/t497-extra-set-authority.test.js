// T497: no fixed ICS/pump/RIR/MRV threshold creates an athlete-facing operational extra set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

test('T497.1 the extra-set recommender and its UI/writer are gone', () => {
  for (const n of ['_maybeSuggestExtraSet', '_showAddSetSuggestion', '_dismissAddSetSuggestion', 'addExtraSetNow', 'addSetSuggestion', 'autoregOffered_'])
    assert.ok(!client.includes(n), n);
});

test('T497.2 completing a set never consults MRV/ICS/pump to change the set count', () => {
  const i = client.indexOf('async function completeSet(');
  const body = client.slice(i, client.indexOf('\nfunction ', i + 10));
  assert.ok(!/MEV_MRV_BY_MUSCLE|_getWeeklyVolumeByMuscle|numSeries\s*=|numSeries\+\+|exmod_/.test(body));
});

test('T497.3 evidence is still logged: ics, pump and observed rir_real stay on the set log', () => {
  assert.ok(/LOGS\[key\] = \{ carga, reps, unit, done, rir: _ejMeta\.rirDefaulted === true \? undefined : getAdjustedRIR/.test(client));
  const i = client.indexOf('LOGS[key] = { carga, reps, unit, done, rir:');
  const rec = client.slice(i, i + 420);
  assert.ok(rec.includes('rir_real: rirReal') && rec.includes('ics, pump'));
});

test('T497.4 nothing writes exmod numSeries from a metric threshold', () => {
  const writers = client.split('\n').filter(l => /LOGS\[[^\]]*exmod_[^\]]*\]\s*=/.test(l) || /LOGS\[key\]\s*=\s*Object\.assign\(\{\}, exMod/.test(l));
  for (const l of writers) assert.ok(!/ics|pump|mrv/i.test(l), l.trim());
});
