'use strict';
// T567 — Client Training: one startup notice at a time (Startup-Queue P2).
//
// WHY THIS TEST EXISTS (measured)
// The bitacora notice was scheduled with a FIXED `setTimeout(..., 500)` and did not check
// whether "Novedades" was still open, so at ~500ms both overlays were on screen at once.
// The phone prompt had already been coordinated in T565; the bitacora notice was the
// remaining uncoordinated second timing system.
//
// Behaviour is proved by EXECUTING the extracted function against a DOM double, not by
// grepping for CSS/strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CLIENT = fs.readFileSync('vdsen-cliente.html', 'utf8');

function extract(name) {
  const start = CLIENT.indexOf(name);
  assert.ok(start > -1, 'no se encontro ' + name);
  let i = CLIENT.indexOf('{', start), depth = 0;
  for (let j = i; j < CLIENT.length; j++) {
    if (CLIENT[j] === '{') depth++;
    else if (CLIENT[j] === '}') { depth--; if (depth === 0) return CLIENT.slice(start, j + 1); }
  }
  throw new Error('llaves desbalanceadas en ' + name);
}

// Strip the module-level constants so the test can drive the wait cap deterministically.
const SRC = extract('function _showBitacoraWhenClear(')
  .replace(/var _BI_MAX_WAIT_MS[\s\S]*?var _biPoll = \d+;/, '');
const CONSTS = 'var _BI_MAX_WAIT_MS = sandbox.MAX; var _biWaited = 0; var _biPoll = 400;';

// A mutable fake DOM: overlays can be opened/closed mid-test, exactly like a real client
// dismissing "Novedades". The visibility stub mirrors the production helper's semantics.
function build({ open = [], max = 300000 } = {}) {
  const shown = [];
  const timers = [];
  const overlays = {};
  for (const id of open) overlays[id] = { id, style: { display: 'flex' } };
  const sandbox = {
    MAX: max,
    document: { getElementById: (id) => overlays[id] || null },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    _startupModalOpen: (id) => !!overlays[id] && overlays[id].style.display !== 'none',
    showBitacoraInfoModal: () => shown.push('bi'),
  };
  const factory = new Function('sandbox', `
    const document = sandbox.document, setTimeout = sandbox.setTimeout;
    const _startupModalOpen = sandbox._startupModalOpen;
    const showBitacoraInfoModal = sandbox.showBitacoraInfoModal;
    ${CONSTS}
    ${SRC}
    return { _showBitacoraWhenClear };
  `);
  return {
    api: factory(sandbox),
    shown,
    timers,
    close: (id) => { if (overlays[id]) overlays[id].style.display = 'none'; },
    fire: (i = 0) => timers[i].fn(),
  };
}

test('T567-1 no se apila sobre Novedades: espera y reprograma', () => {
  const d = build({ open: ['wnModal'] });
  d.api._showBitacoraWhenClear(true);
  assert.equal(d.shown.length, 0, 'no debe abrirse con Novedades en pantalla');
  assert.equal(d.timers.length, 1, 'debe reprogramarse una sola vez');
  assert.equal(d.timers[0].ms, 400, 'espera acotada de 400ms');
});

test('T567-2 aparece en cuanto Novedades se cierra (el aviso no se pierde)', () => {
  const d = build({ open: ['wnModal'] });
  d.api._showBitacoraWhenClear(true);
  assert.equal(d.shown.length, 0);
  d.close('wnModal');       // el cliente cierra Novedades
  d.fire(0);                // se cumple el reintento
  assert.equal(d.shown.length, 1, 'debe mostrarse ahora');
  assert.equal(d.timers.length, 1, 'sin temporizadores nuevos');
});

test('T567-3 pantalla libre: se muestra de inmediato', () => {
  const d = build();
  d.api._showBitacoraWhenClear(true);
  assert.equal(d.shown.length, 1, 'con la pantalla libre debe abrirse ya');
  assert.equal(d.timers.length, 0, 'sin espera innecesaria');
});

test('T567-4 si el aviso no aplica, no hace nada', () => {
  const d = build({ open: ['wnModal'] });
  d.api._showBitacoraWhenClear(false);
  assert.equal(d.shown.length, 0, 'no debe abrirse');
  assert.equal(d.timers.length, 0, 'ni reprogramarse: no hay nada que esperar');
});

test('T567-5 nunca se duplica', () => {
  const d = build({ open: ['biModal'] });
  d.api._showBitacoraWhenClear(true);
  assert.equal(d.shown.length, 0, 'si ya esta visible no se abre otra vez');
  assert.equal(d.timers.length, 0, 'ni se reprograma');
});

test('T567-6 respeta el prompt de celular como bloqueante', () => {
  const d = build({ open: ['phoneConfirmOverlay'] });
  d.api._showBitacoraWhenClear(true);
  assert.equal(d.shown.length, 0, 'no debe abrirse encima del prompt de celular');
  assert.equal(d.timers.length, 1, 'debe esperar');
});

test('T567-7 el tope corta la espera: el aviso NUNCA se pierde', () => {
  // Tope diminuto: en cuanto se consume, debe mostrarse aunque la pantalla siga ocupada.
  const d = build({ open: ['wnModal'], max: 400 });
  d.api._showBitacoraWhenClear(true);   // waited 0 -> reprograma (waited = 400)
  d.fire(0);                            // waited 400 >= 400 -> muestra
  assert.equal(d.shown.length, 1, 'tras alcanzar el tope debe mostrarse igualmente');
});

test('T567-8 la espera es acotada, sin bucle infinito', () => {
  assert.ok(/_BI_MAX_WAIT_MS/.test(SRC), 'debe existir un tope explicito');
  assert.ok(/if \(_biWaited >= _BI_MAX_WAIT_MS\)/.test(SRC), 'el tope debe cortar la espera');
  assert.ok(!/setInterval/.test(SRC), 'sin setInterval');
  assert.ok(!/requestAnimationFrame/.test(SRC), 'sin rAF');
});

test('T567-9 loadPlan ya no usa el temporizador fijo de 500ms', () => {
  // El defecto original era un SEGUNDO sistema de temporizacion independiente.
  assert.ok(!/setTimeout\(function\(\)\{ showBitacoraInfoModal\(\); \}, 500\);/.test(CLIENT),
    'el setTimeout fijo de 500ms debe estar eliminado');
  assert.ok(/_showBitacoraWhenClear\(_showBitacoraInfo\)/.test(CLIENT),
    'loadPlan debe usar el camino coordinado');
});

test('T567-10 el estado del aviso viaja como parametro, no por variable global', () => {
  // _showBitacoraInfo es local a loadPlan: leerlo dentro del helper lanzaba
  // "ReferenceError: _showBitacoraInfo is not defined" (observado en el navegador real).
  assert.ok(/function _showBitacoraWhenClear\(aplica\)/.test(SRC), 'debe recibir `aplica`');
  assert.ok(!/_showBitacoraInfo/.test(SRC), 'no debe referenciar la variable local de loadPlan');
});

test('T567-11 un unico criterio de visibilidad para todos los overlays', () => {
  assert.ok(/_startupModalOpen\('wnModal'\)/.test(SRC), 'consulta Novedades');
  assert.ok(/_startupModalOpen\('phoneConfirmOverlay'\)/.test(SRC), 'consulta el prompt de celular');
  const defs = CLIENT.match(/function _startupModalOpen\(/g) || [];
  assert.equal(defs.length, 1, 'un solo helper de visibilidad, no uno por overlay');
});

test('T567-12 no se crea un tercer sistema de temporizacion', () => {
  // T565 y T567 comparten el MISMO helper de visibilidad y el mismo patron acotado.
  const t565 = CLIENT.match(/function _showPhoneConfirmWhenClear\(/g) || [];
  assert.equal(t565.length, 1, 'un solo coordinador de prompt de celular');
  const phone = extract('function _showPhoneConfirmWhenClear(');
  assert.ok(/waited >= maxWait/.test(phone), 'T565 conserva su tope');
  assert.ok(/_startupModalOpen/.test(phone), 'T565 usa el mismo criterio de visibilidad');
});

test('T567-13 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
