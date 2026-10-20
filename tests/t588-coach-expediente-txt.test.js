'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./helpers/client-export-fixture.js');
const Collect = require('../assets/client-export/collect.js');
const TXT = require('../assets/client-export/expediente-txt.js');
const NOW = new Date('2026-10-20T12:00:00.000Z');

async function file(db, coach, client, options) {
  const raw = await Collect.collect(fx.makeIo(db, coach, options), { clientId: client, coachUid: coach });
  return TXT.build(raw, { now: NOW });
}

test('T588-1 exactly ONE UTF-8 TXT with the four requested sections; no ZIP/PDF or unrelated domains', async () => {
  const out = await file(fx.build(), fx.COACH_A, fx.A1);
  assert.match(out.filename, /^VDSEN_Expediente_.*2026-10-20\.txt$/);
  assert.equal(out.sections, 4);
  const heads = out.text.split('\n').filter(x => /^[1-4]\. /.test(x));
  assert.equal(heads.length, 4);
  assert.match(out.text, /FICHA 360/);
  assert.match(out.text, /BIOMECÁNICA/);
  assert.match(out.text, /ANTROPOMETRÍA/);
  assert.match(out.text, /RENDIMIENTO DEL MESOCICLO ACTIVO/);
  assert.doesNotMatch(out.text, /"pharmacology"|"supplements"|"nutrition"/);
  assert.doesNotMatch(out.filename, /\.pdf|\.zip/);
});
test('T588-2 includes every stored intake response and unknown future fields, renewal and own public forms', async () => {
  const out = await file(fx.build(), fx.COACH_A, fx.A1);
  assert.match(out.text, /campo_futuro/);
  assert.match(out.text, /"cintura": 70/);
  assert.match(out.text, /Tobillo limitado/);
  assert.match(out.text, /Tendinopatía rotuliana izquierda/);
  assert.match(out.text, /fotometria/);
});
test('T588-3 includes real InBody, anthropometry, and mesocycle sets with LOAD/reps/RIR/ICS', async () => {
  const out = await file(fx.build(), fx.COACH_A, fx.A1);
  assert.match(out.text, /"type": "inbody"/);
  assert.match(out.text, /"type": "anthropometry"/);
  assert.match(out.text, /"rir_observed": 0/);
  assert.match(out.text, /"ics": 8/);
  assert.match(out.text, /"load": 60/);
  assert.match(out.text, /"reps": 7/);
  assert.match(out.text, /"mesociclo"/);
});
test('T588-4 only ACTIVE mesocycle performance; does not leak a past mesocycle or another client', async () => {
  const out = await file(fx.build(), fx.COACH_A, fx.A1);
  const perf = out.text.split('4. RENDIMIENTO DEL MESOCICLO ACTIVO')[1];
  assert.match(perf, /"plan_id": "P2"/);
  assert.doesNotMatch(perf, /"plan_id": "P1"/);
  for (const foreign of ['NOTA-DE-B1-SECRETA', 'NOTA-SECRETA-A2', 'Plan de B1', 'Plan de A2'])
    assert.ok(!out.text.includes(foreign), foreign);
});
test('T588-5 no TXT on unauthorized client or denied relevant read', async () => {
  await assert.rejects(() => file(fx.build(), fx.COACH_B, fx.A1), /PERMISSION_DENIED|OWNERSHIP_DENIED/);
  await assert.rejects(() => file(fx.build(), fx.COACH_A, fx.A1, { denySection: 'fichas_onboarding' }), /PERMISSION_DENIED/);
  const raw = await Collect.collect(fx.makeIo(fx.build(), fx.COACH_A), { clientId: fx.A1, coachUid: fx.COACH_A });
  raw.sections.logs.status = 'failed';
  assert.throws(() => TXT.build(raw, { now: NOW }), /EXPORT_FAILED/);
});
test('T588-6 sanitizes secrets without stripping user notes containing ordinary word token', async () => {
  const db = fx.build();
  db.fichas_onboarding[fx.A1].data.data.accessToken = 'DO-NOT-EXPORT';
  const out = await file(db, fx.COACH_A, fx.A1);
  assert.doesNotMatch(out.text, /DO-NOT-EXPORT|accessToken/);
  assert.match(out.text, /campo_futuro/);
});
test('T588-7 single text/plain download, with one click, no network writes', () => {
  const clicks = [];
  const a = { href:'', download:'', click() { clicks.push([this.download,this.href]); } };
  const doc = { createElement: type => { assert.equal(type, 'a'); return a; }, body: { appendChild() {}, removeChild() {} } };
  const win = { Blob: class { constructor(items, options) { assert.equal(items.length, 2); assert.equal(options.type, 'text/plain;charset=utf-8'); } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, setTimeout(fn) { fn(); } };
  TXT.download(doc,win,'VDSEN_Expediente_prueba.txt','texto');
  assert.equal(clicks.length, 1);
  assert.match(clicks[0][0], /\.txt$/);
});
test('T588-8 Coach only exposes the TXT action; ZIP export remains hidden in client details', () => {
  const coach = fs.readFileSync(path.join(__dirname,'..','vdsen-coach.html'),'utf8');
  assert.match(coach, /modalExpedienteTxtBtn/);
  assert.match(coach, /assets\/client-export\/expediente-txt\.js/);
  assert.match(coach, /VDSEN_CE_COLLECT\.collect/);
  assert.match(coach, /_detailClientId !== clientId/);
  assert.match(coach, /_expBtn\.style\.display = 'none'/);
  assert.doesNotMatch(coach, /modalExpedientePdfBtn/);
});
