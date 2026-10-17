// T546 B: plan.updatedAt = the LAST PRESCRIPTION REVISION TIMESTAMP. A progression safety field; never a fallback to createdAt.
// Consumers (assets/progression-auto-apply-shadow.js assess(), vdsen-coach.html staleness checks) call Date.parse(plan.updatedAt) and
// `_validTime` requires a STRING: a Firestore Timestamp object (serverTimestamp()) is rejected as PLAN_TIMESTAMP_MISSING, so the existing
// convention for every plan writer is an ISO string from `new Date().toISOString()`.
// Audit of the Coach plan writers (vdsen-coach.html):
//   create: saveImportedPlan, saveManualPlan, template x2, duplicate x2  -> createdAt + updatedAt (ISO, same event)   [already correct]
//           AI draftDoc (status draft_approved)                          -> serverTimestamp() objects               [FIXED here]
//   edit:   saveTrainingPlan, submitQuickAdd, showUpdatePlanModal, extend/shrink weeks -> updatedAt stamped; saveTrainingPlan now only
//           when the prescription actually changed
//   never:  athlete execution / client reads / logs / materializer / progression records / activation (clients.activePlanId only)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const coach = fs.readFileSync('vdsen-coach.html', 'utf8');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const SHADOW = require('../assets/progression-auto-apply-shadow.js');

function fnSrc(src, name) {
  let i = src.indexOf('async function ' + name + '('); if (i < 0) i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

test('T546.M every Coach plan CREATION writes createdAt and updatedAt as ISO strings from one event (no Timestamp objects)', () => {
  const sites = [];
  const re = /addDoc\(collection\(db,\s*['"]plans['"]\)/g; let m;
  while ((m = re.exec(coach))) {
    const after = coach.slice(m.index, m.index + 900);
    // `addDoc(collection(db,"plans"), newPlan)`: the literal is built just before the call
    sites.push(/^addDoc\(collection\(db,\s*['"]plans['"]\),\s*[A-Za-z_]+\)/.test(after) ? coach.slice(m.index - 500, m.index + 80) : after);
  }
  assert.ok(sites.length >= 6, 'found the creation sites: ' + sites.length);
  for (const s of sites) {
    assert.match(s, /createdAt:\s*new Date\(\)\.toISOString\(\)/, 'createdAt present');
    assert.match(s, /updatedAt:\s*new Date\(\)\.toISOString\(\)/, 'updatedAt present');
    assert.ok(!/updatedAt:\s*serverTimestamp/.test(s));
  }
  const i = coach.indexOf('const draftDoc = {'); assert.ok(i > 0, 'AI draftDoc exists');
  const d = coach.slice(i, i + 1600);
  const cr = /createdAt:\s*([A-Za-z_]+)/.exec(d), up = /updatedAt:\s*([A-Za-z_]+)/.exec(d);
  assert.ok(cr && up && cr[1] === up[1] && cr[1] !== 'serverTimestamp', 'draft createdAt/updatedAt come from the same ISO value: ' + (cr && cr[1]) + '/' + (up && up[1]));
  assert.match(coach.slice(coach.lastIndexOf('\n', i - 400), i), new RegExp('const ' + cr[1] + '\\s*=\\s*new Date\\(\\)\\.toISOString\\(\\)'));
});

test('T546.N prescription edit: createdAt stable, updatedAt moves ONLY when the prescription changed', () => {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fnSrc(coach, '_planDaysSignature') + '\n' + fnSrc(coach, '_planRevisionPatch') + '\nthis.f = { _planDaysSignature, _planRevisionPatch };', ctx);
  const f = ctx.f, NOW = '2026-10-01T10:00:00.000Z';
  const days = [{ dayIndex: 0, label: 'D1', exercises: [{ exerciseName: 'Press', prescriptionExerciseId: 'p1', sets: [{ setIndex: 0, repsTarget: 8, rirTarget: 2 }] }] }];
  const cur = { createdAt: '2026-09-27T13:13:01.547Z', updatedAt: '2026-09-27T13:13:01.547Z', days, daysPerWeek: 1 };
  const same = JSON.parse(JSON.stringify(days)); same[0].exercises[0] = { sets: same[0].exercises[0].sets, prescriptionExerciseId: 'p1', exerciseName: 'Press' }; // key order differs
  const p1 = f._planRevisionPatch(cur, { days: same, daysPerWeek: 1, coachId: 'c' }, NOW);
  assert.ok(!('updatedAt' in p1), 'identical prescription (any key order) does not bump updatedAt');
  assert.ok(!('createdAt' in p1), 'createdAt is never part of an edit');
  const edited = JSON.parse(JSON.stringify(days)); edited[0].exercises[0].sets[0].rirTarget = 1;
  const p2 = f._planRevisionPatch(cur, { days: edited, daysPerWeek: 1, coachId: 'c' }, NOW);
  assert.equal(p2.updatedAt, NOW); assert.ok(ISO.test(p2.updatedAt)); assert.ok(!('createdAt' in p2));
  assert.equal(f._planRevisionPatch(cur, { days, daysPerWeek: 2 }, NOW).updatedAt, NOW, 'daysPerWeek is prescription');
  assert.equal(f._planRevisionPatch(null, { days }, NOW).updatedAt, NOW, 'unknown current doc: stamp (fail safe)');
  const renamed = JSON.parse(JSON.stringify(days)); renamed[0].exercises[0].technique = 'myoreps';
  assert.equal(f._planRevisionPatch(cur, { days: renamed, daysPerWeek: 1 }, NOW).updatedAt, NOW, 'technique is prescription');
});

test('T546.O the editor save goes through the revision patch; the other edit writers still stamp updatedAt', () => {
  const s = fnSrc(coach, 'saveTrainingPlan');
  assert.match(s, /_planRevisionPatch\(/);
  assert.ok(!/updateDoc\(doc\(db,\s*"plans",\s*_editingPlanId\),\s*\{\s*days,\s*daysPerWeek:\s*days\.length,\s*coachId:\s*currentCoach\.uid,\s*updatedAt/.test(s), 'no unconditional stamp');
  for (const n of ['submitQuickAdd']) assert.match(fnSrc(coach, n), /updatedAt:\s*new Date\(\)\.toISOString\(\)/, n);
  assert.match(fnSrc(coach, 'showUpdatePlanModal'), /updatedAt:\s*new Date\(\)\.toISOString\(\)/);
});

test('T546.P updatedAt is NEVER stamped by athlete execution, client reads, logs, the materializer, progression records or activation', () => {
  assert.ok(!/(updateDoc|setDoc)\(\s*(FB\.)?doc\((FB\.)?db,\s*['"]plans['"]/.test(client), 'the athlete app has no plan write at all');
  const mat = fnSrc(coach, '_materializeShadowRecords');
  assert.ok(!/(tx|t)\.(set|update)\(planRef/.test(mat), 'materializer writes meso/root only');
  const act = fnSrc(coach, '_vdsenActivatePlanInFirestore');
  assert.ok(!/t\.(set|update)\(planRef/.test(act), 'activation writes clients.activePlanId only (plans/{id} stays immutable)');
  for (const n of ['_reconcileShadowAuto']) assert.ok(!/(tx|t)\.(set|update)\(planRef/.test(fnSrc(coach, n)), n);
});

test('T546.Q consumer contract: a valid ISO updatedAt passes the timestamp guard; absent / Timestamp-object / never fall back to createdAt (fail closed)', () => {
  const base = { clientId: 'c', planId: 'p', activePlanId: 'p', week: 1, dayIndex: 0, calculatedAt: '2026-09-30T12:00:00.000Z',
    recommendation: { prescriptionExerciseId: 'pid', action: 'freeze_load' }, interventions: [], sourceMatches: true };
  const a = plan => SHADOW.assess(Object.assign({}, base, { plan }));
  assert.equal(a({ clientId: 'c' }).reasonCode, 'PLAN_TIMESTAMP_MISSING', 'absent updatedAt fails closed');
  assert.equal(a({ clientId: 'c', createdAt: '2026-09-27T13:13:01.547Z' }).reasonCode, 'PLAN_TIMESTAMP_MISSING', 'createdAt alone is NOT a fallback');
  assert.equal(a({ clientId: 'c', updatedAt: { seconds: 1790000000, nanoseconds: 0 } }).reasonCode, 'PLAN_TIMESTAMP_MISSING', 'a Firestore Timestamp object is not a valid plan revision time');
  assert.notEqual(a({ clientId: 'c', updatedAt: '2026-09-27T13:13:01.547Z' }).reasonCode, 'PLAN_TIMESTAMP_MISSING', 'valid updatedAt proceeds past the guard');
  const later = a({ clientId: 'c', updatedAt: '2026-10-05T00:00:00.000Z' });
  assert.equal(later.state, 'STALE', 'a revision AFTER the evidence makes the old recommendation stale (chronology semantics)');
  assert.equal(SHADOW.NUMERIC_APPLY_ENABLED, false);
});
