'use strict';
// T570 — A tap may receive immediate local acknowledgement, but it must never
// look durably complete or expose the next authoritative set write before ack.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');

function extract(name) {
  const start = client.indexOf(name);
  assert.ok(start >= 0, 'missing ' + name);
  const open = client.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}

const complete = extract('async function completeSet(');

test('T570-1 pending state is UI-only and is cleared on either result', () => {
  assert.match(client, /var _setSavePending = Object\.create\(null\)/, 'mapa transitorio');
  assert.match(complete, /_setSavePending\[key\] = true/, 'marca pendiente antes de escribir');
  assert.equal((complete.match(/delete _setSavePending\[key\]/g) || []).length, 2,
    'se limpia tanto tras fallo como tras ack');
  const doSave = extract('async function _doSaveLogs(');
  assert.doesNotMatch(doSave, /_setSavePending/, 'nunca se serializa al payload');
});

test('T570-2 local pending feedback is painted before the Firestore request', () => {
  const pendingComment = complete.indexOf('// Paint a pending acknowledgement');
  const paint = complete.indexOf('_refreshExPanelOnly()', pendingComment);
  const write = complete.indexOf('await _doSaveLogs(_saveMetrics)');
  assert.ok(pendingComment >= 0 && paint > pendingComment && write > paint, 'render local precede a la red');
  assert.match(client, /GUARDANDO SERIE /, 'estado pendiente explícito');
  assert.match(client, /Confirmando el registro de esta serie/, 'no se presenta como éxito');
});

test('T570-3 pending state blocks next-set and next-exercise controls', () => {
  const selection = client.slice(client.indexOf('var _pendingSetKey = null;'), client.indexOf('// ── Detecci', client.indexOf('var _pendingSetKey = null;')));
  assert.match(selection, /if \(_setSavePending\[_asKey\]\) \{ _pendingSetKey = _asKey; break; \}/);
  assert.match(client, /if \(activeSi === -1 && !_pendingSetKey && !isPartner\)/,
    'no se muestra avance de ejercicio mientras existe ack pendiente');
});

test('T570-4 timing diagnostics distinguish feedback, request and settlement', () => {
  for (const metric of ['clickToVisualFeedbackMs', 'clickToLocalStateUpdateMs', 'clickToFirestoreRequestStartMs', 'firestoreRequestDurationMs', 'clickToFinalSettlementMs', 'renderTimeAfterSaveMs']) {
    assert.match(client, new RegExp(metric), metric + ' se registra');
  }
  assert.match(client, /position:sticky/, 'acción de guardado permanece sticky');
  assert.match(client, /safe-area-inset-bottom/, 'respeta safe area');
});
