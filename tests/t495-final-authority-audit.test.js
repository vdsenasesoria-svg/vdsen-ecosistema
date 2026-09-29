// T495: pins the state of the final authority audit -- what is canonical, and the residual legacy authorities that
// are KNOWN and awaiting a product decision (so they cannot change or multiply unnoticed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const client = read('vdsen-cliente.html'), coach = read('vdsen-coach.html');
const count = (src, s) => src.split(s).length - 1;

test('T495.1 the numeric-apply switch is off in every module and no APPLIED state exists', () => {
  for (const f of ['assets/progression-auto-apply-shadow.js', 'assets/progression-magnitude-policy.js', 'assets/progression-application-consumer.js'])
    assert.ok(read(f).includes('var NUMERIC_APPLY_ENABLED = false;'), f);
  assert.ok(!read('assets/progression-equipment-resolver.js').includes('NUMERIC_APPLY_ENABLED = true'));
  // T529: APPLIED exists ONLY behind the flag (lifecycleTransition refuses it while the flag is off); the policy never knows it.
  assert.ok(!/['"]APPLIED['"]/.test(read('assets/progression-magnitude-policy.js')));
  assert.ok(/to === STATES\.APPLIED && !NUMERIC_APPLY_ENABLED/.test(read('assets/progression-auto-apply-shadow.js')));
});

test('T495.2 residual legacy authorities are exactly the documented ones (change them only with a decision)', () => {
  // (1) prescribed RIR: calendar peak adjustment + reactive deload +2 + free-barbell floor
  const rir = client.slice(client.indexOf('function getAdjustedRIR('), client.indexOf('function isTechniqueActive('));
  assert.equal(count(rir, '_computeDeloadTriggers'), 0, 'T496: no reactive deload rewrite of prescribed RIR');
  assert.equal(count(rir, 'base - 1'), 0);
  assert.equal(count(rir, 'Math.max(1, adj)'), 0);
  // (2) T497: the in-session extra-set recommender no longer exists
  assert.ok(!client.includes('_maybeSuggestExtraSet(') && !client.includes('_showAddSetSuggestion'));
  // (3) history by name fallback
  assert.ok(client.includes('if (pidKey) return EXERCISE_HISTORY[pidKey] || {};'), 'T498: PID history has no name fallback');
  // (4) the legacy engine still produces progrec evidence
  assert.ok(client.includes("LOGS['progrec_'+CURRENT_WEEK+'_'+di]"));
});

test('T495.3 no other plan/exposure mutator consumes progression output (see T482 and T490 for the full scans)', () => {
  assert.ok(!/(updateDoc|setDoc|addDoc)\([^;]*(newLoad|newReps|newSets|recommendations)/.test(coach + client));
  assert.ok(!coach.includes('applyOverlayTransaction'));
  assert.ok(!client.includes('VDSEN_APPLICATION_CONSUMER') && !client.includes('VDSEN_EQUIPMENT_RESOLVER'));
});

test('T495.4 the authority state document exists and lists the open decisions', () => {
  const doc = read('docs/PROGRESSION_AUTHORITY.md');
  for (const t of ['NUMERIC_APPLY_ENABLED=false', 'Decisiones abiertas', 'getAdjustedRIR', '_maybeSuggestExtraSet', '_getExerciseHistoryEntry', 'UNRESOLVED_EQUIPMENT_INCREMENT'])
    assert.ok(doc.includes(t), t);
});
