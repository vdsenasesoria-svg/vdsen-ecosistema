'use strict';
// Coach Next v2 — Coach runtime hardening: source contracts for
//   CN1  shell restore after authentication (login without reload)
//   CN2  nothing of the previous coach survives in the parked shell
//   CN3  stale activePlanId tolerance + coach-private MEMORY scrub
//
// The behavioural proof (real browser + emulator + firestore.rules) lives in the browser harness;
// these are the contracts that must hold in the shipped file.
//
// PORTED FROM claude/coach-next-integration-v1 (commits 0c8ddef, 9e9e87d, 939366b) onto the current
// canonical file. The INTENT was ported, not the old line numbers: every canonical anchor was
// re-verified, and the ids the old branch parked that DO NOT EXIST in canonical are deliberately
// absent here instead of being copied blindly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function fn(name) {
  const i = HTML.indexOf(name);
  assert.ok(i > -1, 'missing ' + name);
  const j = HTML.indexOf('{', i);
  let d = 0;
  for (let k = j; k < HTML.length; k++) {
    if (HTML[k] === '{') d++;
    else if (HTML[k] === '}') { d--; if (d === 0) return HTML.slice(i, k + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

test('CN1.1 the logged-out screen PARKS the live shell instead of destroying it', () => {
  const park = fn('function _parkCoachShell()');
  assert.ok(/window\._vdsenShellStash/.test(park), 'el shell se guarda en un stash');
  assert.ok(/document\.createDocumentFragment\(\)/.test(park), 'usa un fragmento con los nodos vivos');
  assert.ok(/appendChild\(document\.body\.firstChild\)/.test(park), 'mueve los nodos existentes (asi sobreviven los listeners)');
  assert.ok(/if \(window\._vdsenShellStash \|\| !document\.getElementById\('clientList'\)\) return;/.test(park),
    'idempotente: no re-estaciona si ya esta estacionado');
});

test('CN1.2 sign-in restores the shell BEFORE initCoachUI', () => {
  const auth = HTML.slice(HTML.indexOf('onAuthStateChanged(auth, async (user) => {'));
  const body = auth.slice(0, 3000);
  const restore = body.indexOf('_restoreCoachShell()');
  const init = body.indexOf('initCoachUI()');
  assert.ok(restore > -1, 'se restaura el shell al iniciar sesion');
  assert.ok(init > -1, 'se inicializa la UI');
  assert.ok(restore < init, 'se restaura ANTES de inicializar: si no, initCoachUI escribe sobre el login');
});

test('CN1.3 the logout branch parks before replacing document.body', () => {
  const i = HTML.indexOf('Sin auto-login');
  assert.ok(i > -1);
  const block = HTML.slice(i, i + 1500);
  const park = block.indexOf('_parkCoachShell()');
  const replace = block.indexOf('document.body.innerHTML');
  assert.ok(park > -1, 'se estaciona en el logout');
  assert.ok(replace > -1, 'se muestra la pantalla de login');
  assert.ok(park < replace, 'estaciona ANTES de reemplazar el body');
});

test('CN1.4 there is NO reload workaround', () => {
  assert.ok(!/location\.reload|location\.href\s*=\s*['"]/.test(HTML), 'el login no puede depender de una recarga');
});

test('CN2.1 parking clears everything the previous coach left rendered', () => {
  const park = fn('function _parkCoachShell()');
  for (const id of ['modalClientBody', 'clientList', 'dashSummary', 'clientNavBar', 'accountInfoBox',
    'fichasRecibidas', 'templateList', 'exerciseCatalog', 'planBuilder', 'compendioStatus']) {
    assert.ok(park.includes(id), 'parking debe limpiar ' + id);
  }
  assert.ok(/modal-overlay/.test(park), 'cierra cualquier modal abierto');
  assert.ok(/modalClientName/.test(park), 'borra el titulo del cliente previo');
  assert.ok(/modalDeleteClientBtn/.test(park), 'desenlaza el boton de borrar cliente');
  assert.ok(/_d\.onclick = null/.test(park), 'el boton de borrar no puede quedar apuntando al cliente anterior');
  assert.ok(park.includes('accountInfoBox'), 'el email/uid del coach previo no puede reaparecer');
});

test('CN2.2 parking never clears the shell root itself', () => {
  const park = fn('function _parkCoachShell()');
  assert.ok(!/getElementById\('clientModal'\)/.test(park), 'no vacia el modal completo');
  assert.ok(!/document\.body\.innerHTML = ''/.test(park), 'no vacia el body dentro de park');
});

test('CN3.1 stale/unreadable activePlanId is tolerated ONLY for the referenced plan read', () => {
  const det = fn('async function showClientDetail(');
  const start = det.indexOf('if (c.activePlanId) {');
  assert.ok(start > -1, 'existe el bloque del plan referenciado');
  const planBlock = det.slice(start, det.indexOf('_detailFichaData = null;', start));
  assert.ok(planBlock.includes('try {') && planBlock.includes('catch (_planErr)'), 'la lectura del plan es tolerante');
  assert.ok(planBlock.includes('_detailPlanData = null'), 'queda sin plan en vez de abortar');
  for (const bad of ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'writeBatch', 'activePlanId =', 'activePlanId:']) {
    assert.ok(!planBlock.includes(bad), 'el camino tolerante no debe escribir: ' + bad);
  }
  assert.equal((planBlock.match(/_detailClientId !== clientId/g) || []).length, 2, 'los guards T127-H siguen en ambos caminos');
});

test('CN3.2 an unreadable clients/{id} still FAILS CLOSED with no raw Firebase error', () => {
  const det = fn('async function showClientDetail(');
  assert.ok(det.includes('catch (_clientErr)'), 'la lectura del cliente esta protegida');
  const cc = det.slice(det.indexOf('catch (_clientErr)'), det.indexOf('catch (_clientErr)') + 500);
  assert.ok(/return;/.test(cc), 'retorna');
  assert.ok(!cc.includes('_detailClientData'), 'no deja datos del cliente previo');
  assert.ok(/No se pudo abrir este cliente/.test(cc), 'mensaje amable');
  assert.ok(!/permission-denied|FirebaseError/.test(cc), 'nunca muestra el error crudo de Firebase');
  assert.ok(HTML.includes('Referencia de plan rota'), 'el estado degradado ya existente es la UI del plan roto');
});

test('CN3.3 logout scrubs coach-private MEMORY, not just the DOM', () => {
  const i = HTML.indexOf('window._importedPlan = null;');
  assert.ok(i > -1);
  const block = HTML.slice(i, i + 1800);
  for (const v of ['compendioText', 'manualPlan', '_allExercises', '_editingPlanId', '_vdsenDraftPlanId',
    '_intakeCurrentClient', '_historicalMesoState', '_shadowMonitorContext']) {
    assert.ok(new RegExp('\\b' + v + '\\b').test(block), 'debe limpiar ' + v);
  }
});

test('CN3.4 live listeners are CLOSED before their references are dropped', () => {
  const i = HTML.indexOf('window._importedPlan = null;');
  const block = HTML.slice(i, i + 1800);
  assert.ok(/typeof window\[k\] === 'function'/.test(block), 'se comprueba que el unsubscribe sea invocable');
  assert.ok(/_fichasUnsub\(\)/.test(block), 'se cierra la suscripcion de fichas');
  const invoke = block.indexOf('try { window[k](); }');
  const nullify = block.indexOf('window[k] = null');
  assert.ok(invoke > -1 && nullify > invoke, 'se cierra y DESPUES se suelta la referencia');
});

test('CN3.5 every variable the scrub reassigns is actually reassignable', () => {
  for (const v of ['compendioText', 'manualPlan', '_allExercises', '_editingPlanId', '_vdsenDraftPlanId',
    '_intakeCurrentClient', '_historicalMesoState', '_shadowMonitorContext', '_fichasUnsub']) {
    assert.ok(!new RegExp('^\\s*const\\s+' + v + '\\b', 'm').test(HTML), v + ' no puede ser const');
    assert.ok(new RegExp('^\\s*(var|let)\\s+' + v + '\\b', 'm').test(HTML), v + ' debe declararse con var/let');
  }
});

test('CN3.6 ids the old branch parked that do NOT exist in canonical are not copied blindly', () => {
  for (const id of ['prospectList', 'intakeClientBox', 'monitorBox']) {
    assert.ok(!HTML.includes('id="' + id + '"'), id + ' no existe en canonical');
  }
  const park = fn('function _parkCoachShell()');
  for (const id of ['prospectList', 'intakeClientBox', 'monitorBox']) {
    assert.ok(!park.includes(id), 'no se debe estacionar un id inexistente: ' + id);
  }
});

test('CN3.7 NUMERIC_APPLY_ENABLED sigue en false', () => {
  for (const m of ['progression-effective-prescription', 'progression-application-consumer', 'progression-auto-apply-shadow', 'progression-magnitude-policy']) {
    assert.equal(require('../assets/' + m + '.js').NUMERIC_APPLY_ENABLED, false, m);
  }
});
