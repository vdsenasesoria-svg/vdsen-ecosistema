'use strict';
// T566 — Client Training: the active set's primary action must be reachable on mobile.
//
// WHY THIS TEST EXISTS (measured, not assumed)
// At 360x740 the active set's CARGA field sat at 977px and GUARDAR at 944px while the
// scroll container #tabEntr stayed at scrollTop=0, so the client had to hunt for the most
// important interaction of the workout. Two independent causes were measured:
//   1. .set-actions was sticky with bottom:-88px -> parked 88px OUTSIDE the container's
//      visible box, so it never became reachable.
//   2. Nothing scrolled the active set into view on entry. The existing
//      _scrollToNextPendingSet uses block:'nearest' over a 569px card in a 631px viewport
//      whose first edge is already inside -> the browser moves nothing (944px before and
//      after).
//
// This test proves BEHAVIOUR by executing the extracted function against a DOM double,
// and proves the CSS/contract invariants that the behaviour depends on.
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

const SRC = extract('function _revealActiveSet(');

// A DOM double that records scrollIntoView calls, so we assert behaviour, not strings.
function build(opts = {}) {
  const calls = [];
  // The real DOM nests the pending row several levels below what querySelector returns, so the
  // double deliberately does NOT hand back the row directly: _revealActiveSet must walk up.
  const container = { nodeType: 1, hasAttribute: () => false, parentElement: null,
    scrollIntoView: () => calls.push('CONTAINER-SCROLLED') };
  const wrapper = { nodeType: 1, hasAttribute: () => false, parentElement: container,
    scrollIntoView: () => calls.push('WRAPPER-SCROLLED') };
  const row = { nodeType: 1, hasAttribute: (a) => a === 'data-pending', parentElement: wrapper,
    scrollIntoView: (arg) => calls.push(arg === undefined ? 'no-args' : arg) };
  const inner = { nodeType: 1, hasAttribute: () => false, parentElement: row,
    scrollIntoView: () => calls.push('INNER-SCROLLED') };
  const doc = {
    querySelector: (sel) => (sel === '#exPanel [data-pending="1"]' ? (opts.pending ? inner : null) : null),
  };
  const sandbox = { document: doc };
  const factory = new Function('sandbox', `
    const document = sandbox.document;
    ${SRC}
    return { _revealActiveSet };
  `);
  return { api: factory(sandbox), calls };
}

test('T566-1 al entrar, el set activo se alinea al inicio del contenedor', () => {
  const { api, calls } = build({ pending: true });
  assert.equal(api._revealActiveSet(), true, 'debe reportar que si revelo');
  assert.equal(calls.length, 1, 'exactamente un scroll, sin bucles');
  assert.equal(calls[0].block, 'start', "block:'start' es lo que deja CARGA y GUARDAR a la vez");
});

test("T566-2 el scroll es instantaneo, nunca 'smooth'", () => {
  // Medido: con behavior:'smooth' el contenedor NO completa el desplazamiento (scrollTop
  // se queda en 0), y es la misma razon por la que T555 ya usa 'auto'. Un 'smooth' aqui
  // reintroduce el bug silenciosamente.
  const { api, calls } = build({ pending: true });
  api._revealActiveSet();
  assert.equal(calls[0].behavior, 'auto', "debe usar behavior:'auto'");
  assert.ok(!/behavior:\s*'smooth'/.test(SRC), 'no debe quedar ningun scroll suave');
});

test('T566-3 se desplaza la fila del set, no window', () => {
  // window.scrollY se queda en 0 porque el body tiene overflow:hidden; el unico elemento
  // desplazable es #tabEntr. Desplazar window no haria nada.
  const { api, calls } = build({ pending: true });
  api._revealActiveSet();
  assert.ok(!calls.includes('CONTAINER-SCROLLED'), 'no debe desplazar el contenedor a mano');
  assert.equal(calls.length, 1, 'solo la fila');
});

test('T566-4 busca por data-pending, no por posicion ni por texto', () => {
  assert.ok(/querySelector\('#exPanel \[data-pending="1"\]'\)/.test(SRC), 'selector por data-pending');
  assert.ok(/hasAttribute\('data-pending'\)/.test(SRC), 'sube por el arbol buscando data-pending');
});

test('T566-5 falla en silencio si no hay set pendiente (sesion completa)', () => {
  const { api, calls } = build({ pending: false });
  assert.equal(api._revealActiveSet(), false, 'sin set pendiente devuelve false');
  assert.equal(calls.length, 0, 'no debe intentar desplazar nada');
});

test('T566-6 no hay bucle de scroll: una llamada, un desplazamiento', () => {
  const { api, calls } = build({ pending: true });
  api._revealActiveSet(); api._revealActiveSet(); api._revealActiveSet();
  assert.equal(calls.length, 3, 'una llamada -> un scroll; ninguna reprogramacion interna');
  assert.ok(!/requestAnimationFrame|setInterval/.test(SRC), 'sin temporizadores dentro del revelado');
});

test('T566-7 el helper queda expuesto como window._revealActiveSet', () => {
  assert.ok(/window\._revealActiveSet = _revealActiveSet;/.test(CLIENT), 'expuesto para el harness');
});

test('T566-8 el sticky esta DENTRO del area visible del contenedor', () => {
  // bottom:-88px lo aparcaba fuera del area visible: era el defecto original.
  const rule = CLIENT.match(/\.workout-set-current \.set-actions\{([^}]*)\}/);
  assert.ok(rule, 'debe existir la regla sticky del set activo');
  const css = rule[1];
  assert.ok(/position:sticky/.test(css), 'el set activo conserva su sticky');
  assert.ok(!/bottom:-88px/.test(css), 'no debe volver a aparcarse 88px fuera');
  assert.ok(/bottom:calc\(env\(safe-area-inset-bottom/.test(css), 'bottom debe respetar el safe-area del iPhone');
});

test('T566-9 el boton primario cumple el minimo tactil de 40px', () => {
  const base = CLIENT.match(/\.set-save-primary\{([^}]*)\}/);
  assert.ok(base, 'debe existir .set-save-primary');
  const m = base[1].match(/min-height:(\d+)px/);
  assert.ok(m, 'debe declarar min-height');
  assert.ok(Number(m[1]) >= 40, 'min-height ' + m[1] + 'px debe ser >= 40px, medido real: 54px');
});

test('T566-10 el revelado se consume una sola vez por entrada', () => {
  // No un temporizador: un marcador que goTab activa y el render consume, para que un
  // snapshot o el fin del descanso no muevan la pantalla bajo los dedos del cliente.
  assert.ok(/if \(_pendingSetReveal\) \{\s*\n\s*_pendingSetReveal = false;/.test(CLIENT), 'debe consumirse al usarse');
  assert.ok(/_pendingSetReveal = true; renderEntrenamiento\(\);/.test(CLIENT), 'goTab lo activa al entrar al tab');
  const decls = CLIENT.match(/var _pendingSetReveal = false;/g) || [];
  assert.equal(decls.length, 1, 'una sola declaracion');
});

test('T566-11 el revelado no corre en el render de otras pestanas', () => {
  // goTab renderiza Nutricion/Checkin/Perfil/Resumen; el marcador solo se activa en i===1.
  const goTab = CLIENT.slice(CLIENT.indexOf('function goTab(i)'), CLIENT.indexOf('function renderAll('));
  const flags = goTab.match(/_pendingSetReveal = true/g) || [];
  assert.equal(flags.length, 1, 'solo una activacion en goTab');
  assert.ok(/if \(i === 1\) \{[^}]*_pendingSetReveal = true;/.test(goTab), 'y es en la rama del tab de entrenamiento');
});

test('T566-12 no se regresa el mecanismo post-descanso existente', () => {
  // _scrollToNextPendingSet sigue siendo block:'nearest': es correcto al TERMINAR una serie
  // (la fila ya esta en pantalla) y se deja intacto a proposito.
  const fn = extract('function _scrollToNextPendingSet(');
  assert.ok(/block: 'nearest'/.test(fn), 'conserva nearest');
  assert.ok(/behavior: 'auto'/.test(fn), 'conserva auto (T555)');
});

test('T566-13 el cambio no toca el contrato de datos', () => {
  // Solo scroll + CSS: ninguna clave de log, ningun campo, ningun escritura nueva.
  assert.ok(!/log_\$\{|entries\[/.test(SRC), 'el revelado no escribe datos');
  assert.ok(!/setDoc|updateDoc|addDoc/.test(SRC), 'el revelado no escribe en Firestore');
});

test('T566-14 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
