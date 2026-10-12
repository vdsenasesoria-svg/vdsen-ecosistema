import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../peds/index.html', import.meta.url), 'utf8');

// This is an audit detector, not a release-approval test.  A passing result
// means the candidate's unsafe behaviour was located reproducibly.
test('T574: candidate emits application-level dose and administration instructions', () => {
  assert.match(source, /dosisBaseKg\s*=\s*mgKgInicio/);
  assert.match(source, /dosisC1mg\s*=\s*totalMg\s*\*\s*fracC1/);
  assert.match(source, /mg\/inj/);
  assert.match(source, /Insulina Lispro \/ Aspart/);
  assert.match(source, /Calculadora de Reconstitución/);
});

test('T574: phase, compound, and split inputs have no fail-closed validation', () => {
  assert.match(source, /const techoFase = TECHO_FASE\[fase\];/);
  assert.doesNotMatch(source, /if\s*\(\s*!TECHO_FASE\.hasOwnProperty\(fase\)\s*\)/);
  assert.doesNotMatch(source, /Number\.isFinite\(split2\)/);
  assert.doesNotMatch(source, /!COMPUESTOS\[c1Id\]/);
  assert.doesNotMatch(source, /!COMPUESTOS\[c2Id\]/);
});

test('T574: missing clinical inputs can take permissive paths instead of an explicit insufficient-data state', () => {
  assert.match(source, /if \(val !== null && !isNaN\(val\)\)/);
  assert.match(source, /const insulHoma = labs\.homa \? labs\.homa <= 3\.0 : true/);
  assert.doesNotMatch(source, /INSUFFICIENT_DATA/);
});

test('T574: eGFR and hematocrit logic contains the audited inconsistencies', () => {
  assert.match(source, /\{v:Infinity,n:'OK',min:90\}/);
  assert.match(source, /if \(valor < 80\) return 'ALERTA';\s*return 'OK';/);
  assert.match(source, /\{v:\(sexo==='M'\?54:48\),n:'STOP'\},\{v:50,n:'ALERTA'\}/);
});

test('T574: declared renal interaction is not a hard block and trace is presentation-only', () => {
  assert.match(source, /if \(ctx\.toma_aines\)\s*\{\s*informativos\.push/s);
  assert.match(source, /window\._saveRun\(html, ctx\)/);
  assert.doesNotMatch(source, /inputFact/i);
  assert.doesNotMatch(source, /reviewState/i);
});
