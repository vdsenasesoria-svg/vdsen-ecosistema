'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) throw new Error('not found: ' + decl);
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + decl);
}

test('T700.1 Ejercicio con nombre largo: jerarquía visual y limitación a 2 líneas', () => {
  // Contexto y título del ejercicio en la serie activa
  assert.ok(CLIENT.includes('.active-set-context{display:flex;flex-direction:column;gap:3px'), 'active-set-context usa flex column');
  assert.ok(CLIENT.includes('-webkit-line-clamp:2'), 'active-set-ex-title limita a 2 líneas');
  assert.ok(CLIENT.includes('overflow-wrap:break-word'), 'active-set-ex-title maneja nombres largos sin desborde');
  assert.ok(CLIENT.includes('.active-set-ex-idx'), 'identificador de ejercicio presente');
  assert.ok(CLIENT.includes("EJERCICIO '+_exNumStr+' / '+_exTotalStr"), 'formato EJERCICIO XX / YY');
});

test('T700.2 Steppers de carga y repeticiones: no abren teclado virtual (sin el.focus())', () => {
  const adjRepsSrc = extractFunction(CLIENT, 'function adjReps(key, delta) {');
  const adjCargaSrc = extractFunction(CLIENT, 'function adjCarga(key, delta) {');

  // Verificar que NO llaman a el.focus()
  assert.ok(!adjRepsSrc.includes('.focus('), 'adjReps no llama a .focus(), previniendo teclado virtual en móviles');
  assert.ok(!adjCargaSrc.includes('.focus('), 'adjCarga no llama a .focus(), previniendo teclado virtual en móviles');

  // Verificar que disparan input event para persistencia de borradores
  assert.ok(adjRepsSrc.includes("dispatchEvent(new Event('input'"), 'adjReps emite input event');
  assert.ok(adjCargaSrc.includes("dispatchEvent(new Event('input'"), 'adjCarga emite input event');

  // Verificar que llaman a bcProgHint para refrescar cálculos e1RM
  assert.ok(adjRepsSrc.includes('bcProgHint(key)'), 'adjReps actualiza cálculo de progresión');
  assert.ok(adjCargaSrc.includes('bcProgHint(key)'), 'adjCarga actualiza cálculo de progresión');
});

test('T700.3 Funcionalidad de adjReps y adjCarga (incremento, decremento, clamping)', () => {
  const sandbox = {
    document: {
      getElementById: (id) => {
        if (id === 'reps_k1') return repsInput;
        if (id === 'carga_k1') return cargaInput;
        return null;
      }
    },
    window: {},
    Math,
    parseFloat,
    Event: class { constructor(type) { this.type = type; } },
    bcProgHintCalls: [],
    bcProgHint: (k) => { sandbox.bcProgHintCalls.push(k); }
  };

  const repsInput = { value: '8', dispatched: [], dispatchEvent(e) { this.dispatched.push(e.type); } };
  const cargaInput = { value: '60', dispatched: [], dispatchEvent(e) { this.dispatched.push(e.type); } };

  const src = extractFunction(CLIENT, 'function adjCarga(key, delta) {') + '\n' + extractFunction(CLIENT, 'function adjReps(key, delta) {');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // adjReps +1
  sandbox.adjReps('k1', 1);
  assert.equal(repsInput.value, 9);
  assert.ok(repsInput.dispatched.includes('input'));

  // adjReps -1
  sandbox.adjReps('k1', -1);
  assert.equal(repsInput.value, 8);

  // adjReps clamping en 0
  sandbox.adjReps('k1', -20);
  assert.equal(repsInput.value, 0);

  // adjCarga +2.5
  sandbox.adjCarga('k1', 2.5);
  assert.equal(cargaInput.value, '62.5');
  assert.ok(cargaInput.dispatched.includes('input'));

  // adjCarga -5
  sandbox.adjCarga('k1', -5);
  assert.equal(cargaInput.value, '57.5');
});

test('T700.4 Ejercicio isométrico: prescripción y etiquetas adecuadas', () => {
  // En isométricos se mide en segundos y no se debe mostrar el stepper de carga normal
  assert.ok(CLIENT.includes("var repsLabel  = isIsometric ? 'SEGUNDOS' : 'REPS';"));
  assert.ok(CLIENT.includes("var repsPh     = isIsometric ? 'seg' : 'reps';"));
  assert.ok(CLIENT.includes("(!isBodyweight && !isIsometric)"));
});

test('T700.5 Serie guardada y edición: lenguaje técnico sin emojis', () => {
  assert.ok(CLIENT.includes("saved.pump===1?'PUMP ALTO':saved.pump===2?'PUMP MEDIO':saved.pump===3?'PUMP BAJO'"), 'pump técnico sin emojis');
  assert.ok(CLIENT.includes("EDITAR</button>"), 'botón EDITAR en serie guardada');
  assert.ok(!CLIENT.includes("✏ Corregir"), 'no queda texto con emoji ✏ Corregir');
});

test('T700.6 Scroll al set activo: contrato intacto', () => {
  const revealSrc = extractFunction(CLIENT, 'function _revealActiveSet(');
  assert.ok(revealSrc.includes("block: 'start'"), 'mantiene block start');
  assert.ok(revealSrc.includes("behavior: 'auto'"), 'mantiene behavior auto');
  assert.ok(revealSrc.includes("data-pending=\"1\""), 'busca data-pending=1');
});

test('T700.7 Estados de progresión PENDING/APPLIED sin alteración semántica', () => {
  const authSrc = extractFunction(CLIENT, 'function _seriesAuthorityHtml(');
  assert.ok(authSrc.includes("APPLIED: 'AUTOAJUSTE APLICADO'"), 'etiqueta APPLIED intacta');
  assert.ok(authSrc.includes("PENDING: 'PENDIENTE · calculado, aún no aplicado'"), 'etiqueta PENDING intacta');
  assert.ok(authSrc.includes("NO_AUTHORIZED_ADJUSTMENT: 'Sin autoajuste aplicado'"), 'etiqueta sin ajuste intacta');
});

test('T700.8 Tokens de diseño y alineación escritorio/móvil', () => {
  // Brand tokens
  assert.ok(CLIENT.includes('--accent:#C6FF00;--accent-fill:#C6FF00;--accent-rgb:198,255,0;--on-accent:#0A0A0A;'), 'tokens oficiales VDSEN');
  assert.ok(CLIENT.includes('--r-1:2px;--r-2:4px;'), 'radios arquitectónicos 2px/4px');

  // Desktop centering
  assert.ok(CLIENT.includes('.hdr { max-width: 960px; margin-inline: auto; width: 100%; }') || CLIENT.includes('.hdr{max-width:960px;margin-inline:auto;width:100%}'), 'header centrado en escritorio');
  assert.ok(CLIENT.includes('.bnav { max-width: 960px; margin-inline: auto;') || CLIENT.includes('.bnav{max-width:960px;margin-inline:auto;'), 'bnav centrado en escritorio');
});
