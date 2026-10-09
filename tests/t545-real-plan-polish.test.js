// T545: defects exposed by executing Ayrton's REAL 7-day / 32-exercise plan through the Client UI on staging.
//  - Coach-authored per-set `setNote` text without a dedicated badge was dropped (cardio "1 bloque continuo de 20-25 min · Zone 2 · RPE 3-4",
//    iso-hold "Hold 15-30 s" never reached the athlete).
//  - Session tabs read "#1 — P…": long Coach labels made every day indistinguishable.
//  - The week strip hard-coded 'DELOAD' for the final week (T162 says week N is not an automatic deload).
//  - Express RIR preselects the prescribed RIR: it must not look like the athlete's own observation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');

function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let d = 0, q = null, esc = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const c = src[k];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
function load() {
  const ctx = {};
  vm.createContext(ctx);
  const labels = client.match(/var SET_NOTE_LABELS = \{[\s\S]*?\n\};/)[0];
  const fns = ['_plainSetNote', '_setNoteBlockHtml', '_exSetNotesHtml', '_stripDayNo', '_dayShortLabel'].map(n => fnSrc(client, n)).join('\n');
  // the brace scanner cannot cross the /"/g regex literal inside _escHTml, so the (unchanged) helper is pinned textually and inlined
  const esc = "function _escHTml(s) {\n  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');\n}";
  assert.ok(client.includes(esc), '_escHTml is the expected 4-replace escaper');
  vm.runInContext(labels + '\n' + esc + '\n' + fns + '\nthis.f = { _plainSetNote, _exSetNotesHtml, _stripDayNo, _dayShortLabel };', ctx);
  return ctx.f;
}

test('T545.1 real-plan cardio / iso-hold setNote text reaches the athlete (escaped, deduped, straight/iso-hold only)', () => {
  const f = load();
  const cardio = { technique: 'straight', sets: [{ setNote: '1 bloque continuo de 20–25 min · Zone 2 · RPE 3–4' }] };
  const html = f._exSetNotesHtml(cardio);
  assert.match(html, /NOTA COACH/);
  assert.match(html, /1 bloque continuo de 20–25 min · Zone 2 · RPE 3–4/);
  const vacuum = { technique: 'iso-hold', sets: [0, 1, 2, 3, 4].map(() => ({ setNote: 'Hold 15–30 s' })) };
  assert.equal((f._exSetNotesHtml(vacuum).match(/class="sp-n-t"/g) || []).length, 1, 'five identical notes render once');
  assert.match(f._exSetNotesHtml({ technique: 'straight', sets: [{ setNote: '<img src=x onerror=alert(1)>' }] }), /&lt;img/);
  assert.doesNotMatch(f._exSetNotesHtml({ technique: 'straight', sets: [{ setNote: '<b>x</b>' }] }), /<b>/);
});

test('T545.2 notes that already have a badge, or belong to techniques with their own renderer, are not duplicated', () => {
  const f = load();
  assert.equal(f._plainSetNote({ technique: 'straight' }, 'Serie principal'), '', 'known label keeps its badge');
  assert.equal(f._plainSetNote({ technique: 'y3t' }, 'S1 · lo que sea'), '');
  assert.equal(f._plainSetNote({ technique: 'myoreps' }, 'texto'), '');
  assert.equal(f._plainSetNote({ technique: 'straight' }, '   '), '');
  assert.equal(f._plainSetNote({}, ' texto '), 'texto', 'no technique = straight');
  assert.equal(f._exSetNotesHtml({ technique: 'straight', sets: [{}, { setNote: '' }] }), '');
});

test('T545.3 display-only day labels: numbering stripped, short identity for the tabs, stored label untouched', () => {
  const f = load();
  const real = ['#1 — Pecho superior + dorsal + lateral', '#2 — Lower A · Isquios + cuádriceps + gemelo', '#3 — Deltoide + brazos · baja fatiga',
    '#4 — Espalda + pecho + gemelo', '#5 — Lower B · Isquios + quad/glúteo', '#6 — Classic Specialization', '#7 — Cardio Zone 2 + core / recovery'];
  assert.deepEqual(real.map(f._dayShortLabel), ['Pecho superior', 'Lower A', 'Deltoide', 'Espalda', 'Lower B', 'Classic Specialization', 'Cardio Zone 2']);
  assert.equal(f._stripDayNo('#1 — Pecho superior + dorsal + lateral'), 'Pecho superior + dorsal + lateral');
  assert.equal(f._stripDayNo('Push A'), 'Push A');
  assert.equal(f._stripDayNo(null), '');
  assert.ok(f._dayShortLabel('Un nombre de sesión extraordinariamente largo sin separadores').length <= 22);
  assert.equal(f._dayShortLabel(''), '');
});

test('T545.4 the week strip only says DELOAD when the reactive trigger check says so (T162), otherwise FINAL', () => {
  assert.ok(client.includes("const _wIsDeload = w===_totalWeeksGrid && _computeDeloadTriggers(w).isDeload === true;"));
  assert.ok(client.includes("lbl = w===_totalWeeksGrid?(_wIsDeload?'DELOAD':'FINAL')"));
  assert.ok(!client.includes("lbl = w===_totalWeeksGrid?'DELOAD'"), 'the unconditional label is gone');
});

test('T545.5 express RIR: the preselected objective is visually a suggestion until the athlete taps; stored values are unchanged', () => {
  assert.ok(client.includes("class=\"rirb'+(sel2?' on pre':'')+'\""));
  assert.ok(client.includes('id="xrirpre_'));
  const fn = fnSrc(client, 'expressSetRIR');
  assert.match(fn, /classList\.remove\('pre'\)/);
  assert.match(fn, /xrirpre_/);
  assert.match(fn, /h\.value = val/, 'the hidden observed-RIR value is still written only from the tapped value');
  assert.ok(client.includes('.rirb.on.pre{border-style:dashed'));
});

test('T545.6 layout: week summary sits below the active exercise; session title drops the redundant numbering', () => {
  const nav = client.indexOf('<div id="exNav" class="xnav"'), panel = client.indexOf('<div id="exPanel" class="xpanel">'), sum = client.indexOf('_buildWeekPerfSummary()+');
  assert.ok(nav > 0 && panel > nav && sum > panel, 'summary comes after exNav and exPanel in the training tab markup');
  assert.ok(client.includes("'<h2 class=\"tr-title\">'+_escHTml(_stripDayNo("));
  assert.ok(client.includes('<span class="dt-n">D\'+(i+1)+\'</span>'));
});

test('T545.7 canonical fields and data contracts are untouched by the presentation changes', () => {
  // T546 supersedes the T545 pin: the record keeps its shape, but observed values are explicit-only (see t546-express-evidence-integrity)
  assert.ok(client.includes("return { carga: carga, reps: String(reps), sets: sets, rir_last: obs.rir, ics: obs.ics, pump: obs.pump, unit: unit, done: true, ts: ts };"), 'express record keeps its shape');
  assert.ok(client.includes('prescriptionExerciseId'), 'PID contract present');
});
