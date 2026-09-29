// T482: no recommendation-derived numeric writer may mutate plans/ outside the (future) canonical
// magnitude application layer. Explicit Coach authoring and plan activation stay untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'vdsen-cliente.html'), 'utf8');
const shadowSource = fs.readFileSync(path.join(root, 'assets/progression-auto-apply-shadow.js'), 'utf8');
const policySource = fs.readFileSync(path.join(root, 'assets/progression-magnitude-policy.js'), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));

function functionSource(source, name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, quote = null, escaped = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Cannot extract ' + name);
}

// Every runtime call that writes to a plans/ document, with its enclosing function.
function planWriters(source) {
  const lines = source.split('\n'), out = [];
  lines.forEach((line, i) => {
    if (!/(updateDoc|setDoc|addDoc|\btx\.(set|update)|\bt\.(set|update)|batch\.(set|update))\s*\(/.test(line)) return;
    if (!/['"]plans['"]|\bplanRef\b/.test(line) || /plans_backup/.test(line)) return;
    if (/\b(tx|t)\.(set|update)\(\s*(clientRef|mesoRef|rootRef)/.test(line)) return;
    let fn = '(top-level)';
    // Inline Monitor handlers (plan duration +/- week buttons) sit inside a nested render closure.
    if (/planWeek(Add|Remove|Sub|Del)|weekApply/.test(lines.slice(Math.max(0, i - 16), i + 1).join('\n'))) {
      out.push({ line: i + 1, fn: 'planWeekHandlers', window: lines.slice(Math.max(0, i - 14), i + 3).join('\n') });
      return;
    }
    for (let j = i; j >= 0 && j > i - 600; j--) {
      const m = /^\s*(?:async )?function\s+([A-Za-z_0-9$]+)\s*\(/.exec(lines[j]);
      if (m) { fn = m[1]; break; }
    }
    out.push({ line: i + 1, fn });
  });
  return out;
}
// Writers to plans/ that are authored by the Coach (or copy Coach-authored plans). None consumes
// a recommendation, progrec record or magnitude.
const LEGIT = ['saveImportedPlan', 'saveManualPlan', '_applyTemplateToClient', 'applyTemplate', 'duplicatePlan',
  'duplicatePlanToClient', '_vdsenSaveDraftToFirestore', 'saveTrainingPlan', 'submitQuickAdd', 'showUpdatePlanModal',
  'extendPlanWeeks', 'planWeekHandlers'];

test('T482.1/2 the recommendation-to-plan writers no longer exist (removed in T487)', () => {
  for (const gone of ['_applyRecLoadsToMonitor', '_applyAllModuloD', '_buildRecApplyPreview', '_confirmApplyRecModal',
    '_resolveExerciseInFreshPlan', '_buildPlanChangeSummary', '_moduloDPending'])
    assert.ok(!coach.includes(gone), gone + ' must not exist');
  assert.ok(!client.includes('_buildSessionTargetBanner'));
});

test('T482 legacy apply UI is gone: no bulk or single apply-load button, no wiring', () => {
  for (const gone of ['applyRecLoadsBtn', '_mon-apply-single', 'Aplicar cargas al plan', 'Aplicar esta carga al plan', 'data-recidx'])
    assert.ok(!coach.includes(gone), gone);
  assert.ok(coach.includes('Recomendaciones del motor: informativas · Shadow / no aplicado'));
  assert.ok(coach.includes('_deepLinkToExercise(this.dataset.exname,this.dataset.expid)'), 'recommendations are still displayed with their deep link');
});

test('T482.3 Modulo D remains read-only', () => {
  assert.ok(!coach.includes('_applyAllModuloD'));
  const block = coach.slice(coach.indexOf('// ── Módulo D — vista de decisiones shadow canónicas (T481).'), coach.indexOf('// ── Tendencias de carga por ejercicio'));
  assert.ok(!/updateDoc|setDoc|addDoc|runTransaction|'plans'/.test(block));
});

test('T482.4/5 numeric apply disabled; the unresolved-policy guard is intact', () => {
  assert.equal(shadow.NUMERIC_APPLY_ENABLED, false); assert.equal(policy.NUMERIC_APPLY_ENABLED, false);
  assert.deepEqual(shadow.attemptNumericApply(), { ok: false, reasonCode: 'MAGNITUDE_POLICY_MISSING', applied: false });
  assert.ok(!('APPLIED' in shadow.STATES) && !('APPLIED' in policy.REASONS));
  const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [
    { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'p', sets: [{ repsTarget: 10 }] }] },
    { dayIndex: 2, exercises: [{ prescriptionExerciseId: 'p', sets: [{ repsTarget: 10 }] }] }] };
  const a = shadow.assess({ clientId: 'c', planId: 'x', activePlanId: 'x', plan, week: 1, dayIndex: 0, calculatedAt: '2026-09-27T12:00:00.000Z',
    sourceMatches: true, sourcePidCount: 1, recommendation: { prescriptionExerciseId: 'p', action: 'increase_load', newLoad: 5 } });
  assert.equal(a.state, 'PENDING'); assert.equal(a.reasonCode, 'MAGNITUDE_POLICY_MISSING');
});

test('T482.6 record.magnitude remains the displayed canonical candidate', () => {
  const block = coach.slice(coach.indexOf('// ── Módulo D — vista de decisiones shadow canónicas (T481).'), coach.indexOf('// ── Tendencias de carga por ejercicio'));
  assert.ok(block.includes('_moduloDCanonicalView(') && block.includes('_renderModuloDShadow('));
  assert.ok(functionSource(coach, '_renderModuloDShadow').includes('CANDIDATO SHADOW · NO APLICADO'));
  assert.ok(coach.includes('record.magnitude') || functionSource(coach, '_renderModuloDShadow').includes('.magnitude'));
  assert.ok(!/\b(r|rec)\.(newLoad|newReps|recommendedLoad)\b/.test(functionSource(coach, '_renderModuloDShadow')));
});

test('T482.7 explicit Coach manual plan editing remains functional', () => {
  for (const fn of ['saveTrainingPlan', 'submitQuickAdd', 'extendPlanWeeks', 'showUpdatePlanModal']) {
    const body = functionSource(coach, fn);
    assert.ok(/updateDoc\(doc\(db, ?['"]plans['"]/.test(body), fn + ' still updates plans');
    assert.ok(/updatedAt/.test(body), fn + ' keeps updatedAt');
  }
  assert.ok(/coachId: currentCoach\.uid/.test(functionSource(coach, 'saveTrainingPlan')));
});

test('T482.8 plan authoring, activation and persistence remain functional', () => {
  for (const fn of ['saveImportedPlan', 'saveManualPlan', '_applyTemplateToClient', 'applyTemplate', 'duplicatePlan', 'duplicatePlanToClient'])
    assert.ok(/addDoc\(collection\(db, ?['"]plans['"]\)/.test(functionSource(coach, fn)), fn);
  assert.ok(/setDoc\(planRef, draftDoc\)/.test(functionSource(coach, '_vdsenSaveDraftToFirestore')));
  const activate = functionSource(coach, '_vdsenActivatePlanInFirestore');
  assert.ok(activate.includes('runTransaction') && /t\.update\(clientRef/.test(activate));
  assert.ok(!/t\.(set|update)\(planRef/.test(activate), 'activation never mutates plans/');
});

test('T482.9/10 same-name/different-PID gains no authority; PID-first mapping remains', () => {
  const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [
    { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'pid-A', exerciseName: 'Remo', sets: [{ repsTarget: 10 }] }] }] };
  const rec = { prescriptionExerciseId: 'pid-B', exerciseName: 'Remo', action: 'increase_load', newLoad: 5 };
  const a = shadow.assess({ clientId: 'c', planId: 'x', activePlanId: 'x', plan, week: 1, dayIndex: 0,
    calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1, recommendation: rec });
  assert.equal(a.reasonCode, 'IDENTITY_CONFLICT');
  assert.ok(coach.includes('return pidCount === 1 ? foundByPid : null;'));
  assert.ok(!coach.includes('_resolveExerciseInFreshPlan'), 'the legacy name-matching resolver was removed (T487)');
});

test('T482.11 Coach KEEP > AUTO remains', () => {
  const plan = { clientId: 'c', weeks: 4, updatedAt: '2026-09-26T00:00:00.000Z', days: [
    { dayIndex: 0, exercises: [{ prescriptionExerciseId: 'p', sets: [{ repsTarget: 10 }] }] },
    { dayIndex: 2, exercises: [{ prescriptionExerciseId: 'p', sets: [{ repsTarget: 10 }] }] }] };
  const a = shadow.assess({ clientId: 'c', planId: 'x', activePlanId: 'x', plan, week: 1, dayIndex: 0,
    calculatedAt: '2026-09-27T12:00:00.000Z', sourceMatches: true, sourcePidCount: 1,
    recommendation: { prescriptionExerciseId: 'p', action: 'increase_load', newLoad: 5 },
    interventions: [{ targetType: 'EXERCISE', targetId: 'p', planId: 'x', action: 'KEEP', decidedAt: '2026-09-27T12:01:00.000Z' }] });
  assert.equal(a.state, 'STALE'); assert.equal(a.reasonCode, 'COACH_OVERRIDE');
  assert.ok(functionSource(coach, '_onShadowAutoAction').includes("action === 'KEEP_ORIGINAL' ? 'KEEP' : 'NO_CHANGE'"));
});

test('T482.12 no new numerical writer: every plans/ writer is a Coach-authored one; none consumes recommendations', () => {
  const found = planWriters(coach);
  assert.ok(found.length >= LEGIT.length - 1, 'scan sees the writers: ' + JSON.stringify(found));
  const unknown = found.filter(w => !LEGIT.includes(w.fn));
  assert.deepEqual(unknown, [], 'unexpected plans/ writer(s): ' + JSON.stringify(unknown));
  assert.deepEqual(planWriters(client), [], 'the client app never writes plans/');
  for (const w of found) {
    const name = w.fn, body = w.window || functionSource(coach, name);
    assert.ok(!/lastRec|progrec|recommendedLoad|\.recommendations|record\.magnitude|progressionApplications|magnitude/.test(body),
      name + ' must not consume recommendations or magnitude');
  }
});

test('T482.13 the shadow module and its transactions never write plans/', () => {
  assert.ok(!/updateDoc|setDoc|addDoc|firestore|fetch\(|'plans'/i.test(shadowSource.replace(/\/\*[\s\S]*?\*\//, '')));
  for (const [source, fn] of [[client, '_recordShadowProgression'], [coach, '_reconcileShadowAuto'], [coach, '_onShadowAutoAction']]) {
    const body = functionSource(source, fn);
    assert.ok(!/\b(tx|t)\.(set|update)\(\s*planRef/.test(body), fn);
    assert.ok(/tx\.get\(planRef\)/.test(body), fn + ' only reads the plan');
    assert.ok(!/updateDoc\(\s*(doc\([^)]*plans|planRef)|setDoc\(\s*(doc\([^)]*plans|planRef)/.test(body), fn);
  }
});

test('T482.14 the magnitude policy never writes plans/', () => {
  const code = policySource.replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/updateDoc|setDoc|addDoc|firestore|firebase|fetch\(|localStorage|'plans'|\bdb\b/i.test(code));
});

test('T482.15 competitive/enhanced/PED context creates no writer and no magnitude difference', () => {
  const inert = shadowSource + policySource;
  assert.ok(!/ctx\.(competitive|enhanced|ped)|context\.(competitive|enhanced|ped)|\bcompetitive\b\s*[?&|]/i.test(inert));
  const exposures = [1, 2].map(week => ({ prescriptionExerciseId: 'p', planId: 'x', clientId: 'c', week, dayIndex: 0,
    sets: [0, 1, 2].map(i => ({ setIndex: i, load: 100, reps: 10, unit: 'KG', done: true, rirPrescribed: 2, rirReal: 3, ts: Date.parse('2026-09-27T12:00:00.000Z') + week * 1000 + i })) }));
  const base = { clientId: 'c', planId: 'x', prescriptionExerciseId: 'p', plan: { updatedAt: '2026-09-26T00:00:00.000Z' },
    prescription: { prescriptionExerciseId: 'p', repsRange: { min: 8, max: 12 }, sets: [{ repsTarget: 10, rirTarget: 2 }] }, exposures };
  const plain = policy.evaluate(Object.assign({ context: {} }, base));
  for (const context of [{ competitive: true }, { enhanced: true }, { ped: true }])
    assert.deepEqual(policy.evaluate(Object.assign({ context }, base)), plain);
  assert.equal(plain.candidates[0].rawCandidate, 102.5);
  assert.equal(planWriters(coach).filter(w => !LEGIT.includes(w.fn)).length, 0);
});
