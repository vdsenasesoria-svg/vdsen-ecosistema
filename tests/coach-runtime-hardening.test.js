'use strict';
// Coach runtime hardening: source contracts for (1) shell restore after authentication and (2) stale activePlanId tolerance.
// The behavioural proof (real browser + Auth/Firestore emulators + firestore.rules) is scripts/coach-runtime-e2e.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const fn = name => { const i = HTML.indexOf(name); assert.ok(i > -1, 'missing ' + name); let d = 0; const j = HTML.indexOf('{', i); for (let k = j; k < HTML.length; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}' && --d === 0) return HTML.slice(i, k + 1); } throw new Error('unbalanced'); };

test('RH.1 the logged-out screen parks the live shell instead of destroying it; sign-in restores it before initCoachUI', () => {
  const park = fn('function _parkCoachShell()'), restore = fn('function _restoreCoachShell()');
  assert.ok(/window\._vdsenShellStash/.test(park) && /appendChild\(document\.body\.firstChild\)|appendChild\(frag\)/.test(park + restore) || park.includes('frag.appendChild'));
  assert.ok(restore.includes('document.body.appendChild(frag)') && restore.includes('window._vdsenShellStash = null'));
  const auth = HTML.slice(HTML.indexOf('onAuthStateChanged(auth, async (user) => {'), HTML.indexOf('onAuthStateChanged(auth, async (user) => {') + 1500);
  assert.ok(auth.indexOf('_restoreCoachShell()') > 0 && auth.indexOf('_restoreCoachShell()') < auth.indexOf('initCoachUI()'));
  const loggedOut = HTML.slice(HTML.indexOf('Sin auto-login'), HTML.indexOf('Sin auto-login') + 1200);
  assert.ok(loggedOut.indexOf('_parkCoachShell()') > -1 && loggedOut.indexOf('_parkCoachShell()') < loggedOut.indexOf('document.body.innerHTML'));
});

test('RH.2 parking removes everything the previous coach left in the shell (modals, list, detail title/body, buttons)', () => {
  const park = fn('function _parkCoachShell()');
  for (const needle of ['.modal-overlay', 'modalClientBody', 'clientList', 'clientNavBar', 'modalClientName', 'modalDeleteClientBtn']) assert.ok(park.includes(needle), needle);
  assert.ok(!/location\.reload/.test(HTML), 'no reload workaround');
});

test('RH.3 stale/unreadable activePlanId is tolerated only for the referenced plan read; no writes; clients/{id} still fails closed', () => {
  const det = fn('async function showClientDetail(');
  const planBlock = det.slice(det.indexOf('if (c.activePlanId) {'), det.indexOf('_detailFichaData = null;'));
  assert.ok(planBlock.includes('try {') && planBlock.includes('catch (_planErr)') && planBlock.includes('_detailPlanData = null'));
  for (const bad of ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'activePlanId =', 'activePlanId:']) assert.ok(!planBlock.includes(bad), 'plan fallback must not write: ' + bad);
  assert.ok(det.includes('catch (_clientErr)') && det.includes('No se pudo abrir este cliente.'));
  const clientCatch = det.slice(det.indexOf('catch (_clientErr)'), det.indexOf('catch (_clientErr)') + 400);
  assert.ok(/return;/.test(clientCatch) && !clientCatch.includes('_detailClientData'), 'ownership failure renders nothing and returns');
  assert.ok(HTML.includes('Referencia de plan rota'), 'existing broken-reference state is the degraded UI');
});
