// T507: final readiness audit. One progression authority: LOGS = execution truth, PID = identity, Coach plan = base
// prescription, canonical overlay = the only FUTURE automatic prescription path, dormant while the flag is off.
// Complements t482 (plan writers), t490 (legacy-output firewall) and the per-ticket authority tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const client = read('vdsen-cliente.html'), coach = read('vdsen-coach.html');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const resolver = require(path.join(root, 'assets/progression-equipment-resolver.js'));
const count = (s, n) => s.split(n).length - 1;

test('T507.1 LOAD / REPS: athlete inputs are never prefilled from a recommendation; warm-up base is legitimate evidence only', () => {
  assert.ok(client.includes("var carga   = saved.carga   || '';") && client.includes("var reps    = saved.reps    || '';"));
  const w = client.slice(client.indexOf('function _warmupReferenceLoad('), client.indexOf('function _warmupRowsHtml('));
  assert.ok(/PREVIOUS_EXECUTION/.test(w) && /HISTORY/.test(w) && /COACH_PLAN/.test(w) && !/newLoad|progrec|recommend/i.test(w));
});

test('T507.2 SETS / EXERCISE / RIR: only the Coach plan (and logged execution) defines them in the athlete client', () => {
  const code = client.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('exmod_') && !code.includes('_maybeSuggestExtraSet') && !code.includes('addExtraSetNow'));
  assert.equal(count(client, "action === 'reduce_sets'"), 0);
  assert.ok(/function getAdjustedRIR\(baseRIR, week, exName\) \{\s*var base = parseInt\(baseRIR\);\s*return isFinite\(base\) \? base : 2;\s*\}/.test(client));
  assert.ok(!client.includes('Considera sustituir por'));
});

test('T507.3 REST: prescribed rest is the plan value; fallbacks are timer-only aids that never write plan or logs', () => {
  for (const fnName of ['function markExpressSerie(', 'function markExpressSsRonda(']) {
    const i = client.indexOf(fnName);
    assert.ok(i >= 0, fnName);
    const body = client.slice(i, client.indexOf('\n}\n', i));
    assert.ok(/_planRest > 0/.test(body), fnName + ' prefers the plan rest');
    const uses = body.split('\n').filter(l => /\brestTime\b/.test(l));
    assert.ok(uses.length >= 3);
    for (const l of uses) assert.ok(/restTime\s*=|Math\.max\(restTime|startRestTimer\(restTime\)|var restTime;/.test(l), 'restTime only feeds the timer: ' + l.trim());
  }
});

test('T507.4 FREQUENCY / SPLIT: neither app derives them from progression; only explicit Coach plan edits write plans', () => {
  assert.ok(!/(updateDoc|setDoc)\(doc\(db,\s*'plans'[^;]*(newLoad|newReps|newSets|progrec|recommend)/.test(coach));
  assert.ok(!/(updateDoc|setDoc)\([^;]*plans[^;]*\)/.test(client), 'the athlete client never writes plans');
  assert.ok(fs.existsSync(path.join(root, 'tests/t482-numeric-plan-writer-authority.test.js')));
  assert.ok(fs.existsSync(path.join(root, 'tests/t490-authority-firewall.test.js')));
});

test('T507.5 execution truth: LOGS keep executed values; substituted sets never carry the plan PID', () => {
  assert.ok(client.includes('rir_real: rirReal') && client.includes('substitutedFrom'));
  assert.ok(client.includes('exerciseNameSnapshot: (_subName || _ejMetaName) || undefined'));
});

test('T507.6 exact PID identity is mandatory; names are labels only', () => {
  const src = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/exerciseName\b[^;\n]*(===|==|indexOf|includes)/.test(src('assets/progression-magnitude-policy.js')), 'policy never matches by name');
  assert.ok(!/toLowerCase|_normName/.test(src('assets/progression-application-consumer.js')), 'consumer never matches by name');
  assert.ok(client.includes('if (pidKey) return EXERCISE_HISTORY[pidKey] || {};'));
  assert.ok(coach.includes('return pidCount === 1 ? foundByPid : null;'));
  const c = consumer.planApplication({ record: { key: 'k', magnitude: { mode: 'SHADOW', schema: 'vdsen-magnitude-shadow-v1', numericApplyAllowed: false } }, context: {} });
  assert.ok(c.blockers.includes('NOT_CANONICAL_RECORD'), 'a record without PID is not canonical');
});

test('T507.7 equipment rounding is sourced, never guessed', () => {
  assert.deepEqual(Object.keys(resolver.INCREMENT_METADATA), []);
  const code = read('assets/progression-equipment-resolver.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\b(machine|barbell|dumbbell|free_weight|cable|trap_bar)\b/.test(code.replace(/equipmentType/g, '')), 'no per-type increments');
  for (const type of ['machine', 'barbell', 'free_weight', 'cable', 'trap_bar', 'bench']) {
    const r = resolver.resolveLoad({ currentLoad: 100, desiredLoad: 102.5, direction: 'UP', unit: 'KG', equipment: { equipmentId: 'x', equipmentType: type } });
    assert.equal(r.resolutionState, 'UNRESOLVED_EQUIPMENT_INCREMENT', type);
  }
});

test('T507.8 the canonical overlay is the ONLY writer of nextExposureOverlays, and it is dormant while the flag is off', async () => {
  const writers = [['vdsen-cliente.html', client], ['vdsen-coach.html', coach], ['assets/progression-auto-apply-shadow.js', read('assets/progression-auto-apply-shadow.js')],
    ['assets/progression-magnitude-policy.js', read('assets/progression-magnitude-policy.js')]]
    .filter(([, s]) => /nextExposureOverlays\s*:/.test(s)).map(([f]) => f);
  assert.deepEqual(writers, [], 'no other file writes overlays');
  assert.ok(/nextExposureOverlays:/.test(read('assets/progression-application-consumer.js')));
  const calls = [];
  const tx = { get: async () => { calls.push('get'); throw new Error('must not read'); }, set: () => calls.push('set') };
  const res = await consumer.applyOverlayTransaction(tx, {}, { recordKey: 'k' });
  assert.equal(res.written, false); assert.equal(res.reason, 'NUMERIC_APPLY_DISABLED'); assert.deepEqual(calls, []);
});

test('T507.9 flags off everywhere; no APPLIED state; legacy progrec cannot mutate targets', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false); assert.equal(consumer.NUMERIC_APPLY_ENABLED, false);
  assert.ok(!('APPLIED' in shadow.STATES));
  assert.equal(count(client, '_getProgRecForExercise('), 1, 'compat adapter only, no consumer');
  assert.ok(!client.includes('_buildNextExposureHtml') && !client.includes('headerRecHtml'));
  assert.ok(/<details[^>]*id="_legacyProgEvidence"/.test(coach), 'Coach sees legacy output only as collapsed evidence');
});

test('T507.10 competitive / enhanced / PED labels are never read by the canonical modules', () => {
  for (const f of ['assets/progression-magnitude-policy.js', 'assets/progression-auto-apply-shadow.js', 'assets/progression-application-consumer.js'])
    assert.ok(!/\b(PED|enhanced|competitive|natural|perfil)\b/i.test(read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), f);
});

test('T507.11 vdsen-plan-v2 stays pure: overlays are additive records, never plan fields', () => {
  const o = consumer.SCHEMA;
  assert.equal(o, 'vdsen-next-exposure-overlay-v1');
  assert.ok(!/plans[^;\n]*nextExposureOverlays|nextExposureOverlays[^;\n]*plans/.test(read('assets/progression-application-consumer.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/refs\.plan/g, '')));
});

test('T507.12 the authority document lists every residual and open item', () => {
  const doc = read('docs/PROGRESSION_AUTHORITY.md');
  for (const t of ['Matriz de autoridad final', 'RULE_D_E_ALTERNATIVE_NOT_DEFINED', 'RULE_C_E_PRECEDENCE_NOT_DEFINED', 'REPRESENTATIVE_SET_NOT_DEFINED',
    'Temporizador de descanso', 'NUMERIC_APPLY_ENABLED=false'])
    assert.ok(doc.includes(t), t);
});
