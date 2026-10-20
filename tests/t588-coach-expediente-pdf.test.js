'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pdf = require('../assets/client-export/expediente-pdf.js');

test('expediente uses only the selected client ficha and renewal; does not export credentials', () => {
  const m = pdf.buildModel({
    client: { displayName: 'Cliente Prueba', email: 'test@example.invalid', phone: '5550100', intake: { data: { objetivo: 'Hipertrofia' } } },
    onboarding: { data: { salud: { antecedentes: 'Ninguno', accessToken: 'no-export' }, prioridades: ['dorsal','deltoide'] } },
    renewal: { data: { descanso: 90, energia: 3 } },
    publicForms: [{ data: { coachId: 'coach1', clientUid: 'client1', data: { molestias: 'Sin molestias' } } }]
  });
  assert.equal(m.name, 'Cliente Prueba');
  assert.equal(m.sections.length, 3);
  const text = JSON.stringify(m);
  assert.match(text, /antecedentes/);
  assert.match(text, /Descanso/);
  assert.match(text, /Molestias/);
  assert.doesNotMatch(text, /accessToken|no-export|coach1|client1/);
});
test('expediente falls back to legacy ficha only when onboarding is missing', () => {
  const x = pdf.buildModel({ client: { name:'Prueba', intake: { data: { peso_kg: 72 } } } });
  assert.equal(x.sections.length, 1);
  assert.match(JSON.stringify(x), /72/);
});
test('values are preserved for heterogeneous arrays and nested text', () => {
  const rows = pdf.rowsOf({ carga: [40, 45, 47.5], notas: { especial: 'linea 1\nlinea 2' }, noDato: null });
  assert.equal(rows.length, 2);
  assert.match(rows[0].value, /40 · 45 · 47.5/);
  assert.match(JSON.stringify(rows), /linea 1/);
});
test('safe filename does not include paths or control characters', () => {
  assert.equal(pdf.safeName('../José/?'), 'Jose');
});
test('no ficha means no PDF can be produced', () => {
  assert.throws(() => pdf.renderPdf(pdf.buildModel({ client: { displayName:'No ficha' } }), function() {}), /NO_FICHA/);
});
test('PDF generator paginates long notes and saves a local PDF', () => {
  let saved = '', pages = 1, writes = [];
  class FakePdf {
    constructor() { this.page = 1; }
    setFillColor() {}
    rect() {}
    setTextColor() {}
    setFont() {}
    setFontSize() {}
    splitTextToSize(s) { return String(s).match(/.{1,70}/g) || ['']; }
    text(s) { writes.push(String(s)); }
    addPage() { pages++; this.page = pages; }
    getNumberOfPages() { return pages; }
    setPage(p) { this.page = p; }
    save(name) { saved = name; }
  }
  const m = pdf.buildModel({
    client: { displayName:'Cliente Ejemplo' },
    onboarding: { data: { notas: Array(300).fill('Entrenamiento controlado.').join(' ') } }
  });
  pdf.download(m, FakePdf, new Date('2026-10-20T12:00:00Z'));
  assert.ok(pages > 1);
  assert.equal(saved, 'VDSEN_Expediente_Cliente_Ejemplo_2026-10-20.pdf');
  assert.ok(writes.some(s => s.includes('EXPEDIENTE')));
  assert.ok(writes.some(s => s.includes('CONFIDENCIAL')));
});
test('Coach contains the read-only expediente button and same-client auth guards', () => {
  const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
  assert.match(coach, /modalExpedientePdfBtn/);
  assert.match(coach, /assets\/client-export\/expediente-pdf\.js/);
  assert.match(coach, /VDSEN_CE_SECURITY\.authorizeClient/);
  assert.match(coach, /_detailClientId !== clientId/);
});
