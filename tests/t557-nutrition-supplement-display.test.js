'use strict';
// T557 (closure): faithful DISPLAY of Coach-authored nutrition / supplement text (no tracking, no redesign). Concrete defects fixed:
//  - a food quantity with a parenthesis / plural unit was mangled or truncated ("1 pieza (120 g)" -> "1pieza"; "3 piezas (90 g)" -> name "Tortilla 3 piezas (" + "90g")
//  - a supplement lost its authored name digits ("Vitamina D3" -> "Vitamina D"), its dose descriptor ("2 g EPA+DHA" -> "2 G"), its timing ("con el desayuno") and its notes,
//    and a timing was guessed from the NOTE ("mañana y tarde" -> "Mañana")
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const vm = require('node:vm');
const SRC = fs.readFileSync('vdsen-cliente.html', 'utf8');
function fnSrc(name) { const i = SRC.indexOf('function ' + name + '('); assert.ok(i > -1, 'missing ' + name); let d = 0, q = null, esc = false; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { const c = SRC[k]; if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; } if (c === '/' && SRC[k + 1] === '/') { k = SRC.indexOf('\n', k); continue; } if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') d++; else if (c === '}' && --d === 0) return SRC.slice(i, k + 1); } throw new Error('unbalanced'); }
const load = (...names) => { const ctx = { String, Number, Array, Object, RegExp, parseFloat, isNaN, _escHTml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }; vm.createContext(ctx); vm.runInContext(names.map(fnSrc).join('\n') + '\n' + names.map(n => 'this.' + n + '=' + n + ';').join(''), ctx); return ctx; };
const J = o => JSON.parse(JSON.stringify(o));

test('T557.1 food quantity keeps the whole authored quantity (plural units, parenthesis, trailing text)', () => {
  const f = load('_splitFoodQty')._splitFoodQty;
  assert.deepEqual(J(f('Avena en hojuelas 80 g')), { name: 'Avena en hojuelas', qty: '80g' });
  assert.deepEqual(J(f('Claras de huevo 250 ml')), { name: 'Claras de huevo', qty: '250ml' });
  assert.deepEqual(J(f('Plátano 1 pieza (120 g)')), { name: 'Plátano', qty: '1 pieza (120 g)' });
  assert.deepEqual(J(f('Tortilla de maíz 3 piezas (90 g)')), { name: 'Tortilla de maíz', qty: '3 piezas (90 g)' });
  assert.deepEqual(J(f('Arroz blanco cocido 250 g en cocido')), { name: 'Arroz blanco cocido', qty: '250g en cocido' });
  assert.deepEqual(J(f('Ensalada verde con pepino 1 plato grande')), { name: 'Ensalada verde con pepino', qty: '1 plato grande' });
  assert.deepEqual(J(f('Whey Isolate 25g')), { name: 'Whey Isolate', qty: '25g' });
  assert.equal(f('Fruta de temporada'), null, 'no quantity -> the label is shown as authored');
});
test('T557.2 a plated / portion food line is a FOOD (numbered, in order), not a loose note', () => {
  const src = fnSrc('parsearYRenderComidas'); assert.ok(/plato\|porci/.test(src.slice(src.indexOf('function esAlimento'), src.indexOf('function esAlimento') + 260)));
  assert.ok(/_splitFoodQty\(displayLabel\)/.test(src), 'the renderer uses the shared splitter');
});
test('T557.3 supplement line: authored name, full dose (incl. descriptor), authored timing and the note are all kept', () => {
  const f = load('_parseSupLine')._parseSupLine;
  assert.deepEqual(J(f('Vitamina D3 2000 UI con el desayuno')), { nombre: 'Vitamina D3', dosis: '2000 UI', timing: 'con el desayuno', nota: '' });
  assert.deepEqual(J(f('Omega-3 2 g EPA+DHA con la comida (Tomar con grasa; si hay molestias, dividir en dos tomas (mañana y tarde))')), { nombre: 'Omega-3', dosis: '2 g EPA+DHA', timing: 'con la comida', nota: 'Tomar con grasa; si hay molestias, dividir en dos tomas (mañana y tarde)' });
  assert.deepEqual(J(f('Creatina monohidrato 5 g post-entreno (Todos los días)')), { nombre: 'Creatina monohidrato', dosis: '5 g', timing: 'post-entreno', nota: 'Todos los días' });
  assert.deepEqual(J(f('Cafeína 200 mg 30 min antes de entrenar (No tomar después de las 18:00)')), { nombre: 'Cafeína', dosis: '200 mg', timing: '30 min antes de entrenar', nota: 'No tomar después de las 18:00' });
  assert.equal(f('Quemadores termogénicos (Interfieren con el sueño)'), null, 'no dose -> shown as a note line');
});
test('T557.4 formatTextoSup renders them (escaped), the timing is never guessed from the note, and the item count counts every row', () => {
  const ctx = load('_parseSupLine', 'formatTextoSup'); const html = ctx.formatTextoSup('TIER 1 — BASE\nVitamina D3 2000 UI con el desayuno\nOmega-3 2 g EPA+DHA con la comida (dividir en dos tomas, mañana y tarde)\n\nEVITAR\nQuemadores termogénicos (Interfieren con el sueño)');
  assert.ok(html.includes('Vitamina D3') && html.includes('Con el desayuno') && html.includes('2 G EPA+DHA') && html.includes('dividir en dos tomas'));
  assert.ok(!/>Mañana</.test(html), 'timing is not inferred from the note'); assert.ok(/1 items|1 item/.test(html.split('EVITAR')[1] || ''), 'EVITAR notes-only block counts its row');
  const bad = ctx.formatTextoSup('Creatina 5 g <img src=x onerror=alert(1)> (nota <b>x</b>)'); assert.ok(!/<img|<b>x/.test(bad), 'dose / timing / note are escaped');
});
