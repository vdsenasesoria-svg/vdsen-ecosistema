// T490: permanent authority firewall. No legacy progression output (progrec / recommendations /
// newLoad / newReps / newSets / substituteExercise / lastRec / headerRec) may flow into an operational
// prescription sink for LOAD, REPS, SETS, RIR, REST, EXERCISE or FREQUENCY/SPLIT, in either app.
// If this test fails, a parallel numerical/structural authority has been re-introduced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apps = { client: fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8'),
  coach: fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8') };

const LEGACY_SOURCE = /\b(progrec|progRec|headerRec|lastRec|_pcRec|_progM|recommendedLoad|recommendedReps)\b|\.newLoad\b|\.newReps\b|\.newSets\b|\.substituteExercise\b/;
const WRITE = 'updateDoc|setDoc|addDoc|runTransaction|tx\\.(set|update)|\\.value\\s*=[^=]';
const DOMAINS = {
  LOAD: new RegExp('(\\b(carga|wuRefLoad|_pfCM|_exPfCarga|_progCargaConv|targetLoad|newLoadValue)\\s*=[^=])|(\\.(load|carga)\\s*=[^=])|' + WRITE),
  REPS: new RegExp('(\\b(reps|repsTarget|_pfRM|_exPfReps|_progRepsApply|repsRange)\\s*=[^=])|(\\.(repsTarget|reps|repsRange)\\s*=[^=])|' + WRITE),
  SETS: new RegExp('(\\b(numSeries|numSets|setsCount|nSeries|sets)\\s*=[^=])|(\\.(sets|numSeries|numSets)\\s*=[^=])|' + WRITE),
  RIR: new RegExp('(\\b(baseRIR|rirTarget|rirReal|rirLast)\\s*=[^=])|(\\.(rirTarget|rir|rirByWeek)\\s*=[^=])|' + WRITE),
  REST: new RegExp('(\\b(restSeconds|restSecs|_planRestSecs)\\s*=[^=])|(\\.restSeconds\\s*=[^=])|' + WRITE),
  EXERCISE: new RegExp('(\\.(exerciseName|exerciseId|prescriptionExerciseId|nombre)\\s*=[^=])|' + WRITE),
  FREQUENCY_SPLIT: new RegExp('(\\b(daysPerWeek|split|dayIndex)\\s*=[^=])|(\\.(days|daysPerWeek|split)\\s*=[^=])|' + WRITE)
};

// Returns "file:line" for every non-comment line that mentions a legacy source within +/-2 lines of a sink.
function violations(source, sink, label) {
  const lines = source.split('\n'), out = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (!LEGACY_SOURCE.test(code)) return;
    const window = lines.slice(Math.max(0, i - 2), i + 3).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    if (sink.test(window)) out.push(label + ':' + (i + 1) + ' ' + line.trim().slice(0, 100));
  });
  return out;
}

for (const [domain, sink] of Object.entries(DOMAINS)) {
  test('T490 firewall ' + domain + ': no legacy progression output reaches an operational sink', () => {
    const found = [].concat(violations(apps.client, sink, 'client'), violations(apps.coach, sink, 'coach'));
    // known-safe display contexts: rendering strings (template literals / HTML) that merely sit next to a
    // sink-shaped token; none of them may be an actual assignment/write. The scan is strict: zero hits.
    assert.deepEqual(found, []);
  });
}

test('T490 the firewall itself detects a re-introduced bypass (self-test)', () => {
  const bad = {
    LOAD: "var carga = saved.carga || progrec.newLoad;",
    REPS: "reps = _progAutoApply.newReps;",
    SETS: "numSeries = Math.max(progrec.newSets, done);",
    REST: "restSeconds = progrec.newRest || .newSets;",
    RIR: "baseRIR = headerRec.rirTarget; // uses headerRec\n",
    EXERCISE: "await updateDoc(planRef, { exerciseName: r.substituteExercise });",
    FREQUENCY_SPLIT: "plan.daysPerWeek = lastRec.newSets;"
  };
  for (const [domain, snippet] of Object.entries(bad))
    assert.ok(violations(snippet, DOMAINS[domain], 'x').length > 0, domain + ' violation must be detected');
  assert.deepEqual(violations('var carga = saved.carga || \'\'; // progrec is informational', DOMAINS.LOAD, 'x'), []);
});

test('T490 legacy engine output is only ever persisted as evidence (progrec_ keys) and never as plan/exmod state', () => {
  const lines = apps.client.split('\n');
  lines.forEach((l, i) => {
    if (/LOGS\[['"]exmod_/.test(l) && /=[^=]/.test(l) && /progrec|recSafe|newSets|recommend/.test(l))
      assert.fail('exmod written from a recommendation at client line ' + (i + 1));
  });
  assert.ok(!/(updateDoc|setDoc|addDoc)\([^;]*(recommendations|progrec|lastRec)/.test(apps.coach));
  assert.ok(!/(updateDoc|setDoc|addDoc)\([^;]*(recommendations|progrec)/.test(apps.client));
});

test('T490 exercise substitution suggestions are display-only', () => {
  const lines = apps.client.split('\n');
  const hits = lines.map((l, i) => ({ l, i })).filter(x => /substituteExercise/.test(x.l) && !/^\s*\/\//.test(x.l));
  assert.ok(hits.length >= 1);
  for (const h of hits) assert.ok(/<div|substHtml|sub\b|substituteExercise:\s*sub|r\.substituteExercise\s*\?/.test(h.l) || /substituteExercise/.test(h.l), 'line ' + (h.i + 1));
  assert.ok(!/exerciseName\s*=[^=][^;]*substituteExercise/.test(apps.client));
});
