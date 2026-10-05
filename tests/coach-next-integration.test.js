'use strict';
// Combined Coach candidate (runtime hardening + Exportar cliente): interactions that neither feature tests alone.
// Behavioural proof in a real browser: scripts/coach-next-integration-e2e.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const UI = require('../assets/client-export/ui.js');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const body = name => { const i = HTML.indexOf(name); assert.ok(i > -1, name); let d = 0; const j = HTML.indexOf('{', i); for (let k = j; k < HTML.length; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}' && --d === 0) return HTML.slice(i, k + 1); } throw new Error('unbalanced'); };
function fakeDom() { const el = tag => ({ tag, children: [], style: {}, setAttribute() {}, appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; }, textContent: '', disabled: false }); return { createElement: el, getElementById: () => null, body: { appendChild(c) { return c; } } }; }

test('CN.1 logout parks the shell only after dismissing the export dialog, clearing the export/delete bindings, pickers, account box and caches', () => {
  const park = body('function _parkCoachShell()');
  for (const n of ['VDSEN_CE_UI.closeActive', 'modalExportClientBtn', '_x.onclick = null', '_clientExporter = null', '_clientExporterUid = null', '_clientIdList = []', '_clientNameMap = {}', 'select option', 'accountInfoBox', 'modalClientName', 'modalDeleteClientBtn'])
    assert.ok(park.includes(n), n);
  assert.ok(park.indexOf('closeActive') < park.indexOf('createDocumentFragment'), 'dialog dismissed BEFORE the shell is parked');
  assert.ok(park.indexOf("const _known = new Set(_clientIdList") < park.indexOf('_clientIdList = []'), 'client ids read before the cache is reset');
});

test('CN.2 an export dialog dismissed by logout / coach switch never downloads, toasts or re-enables itself', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const exporter = { busy: false, run: async () => { await gate; return { ok: true, filename: 'f.zip', bytes: new Uint8Array(1) }; } };
  const dl = [], toasts = [];
  const c = UI.open({ clientId: 'clientA1', clientName: 'Ana' }, { document: fakeDom(), exporter, toast: (m) => toasts.push(m), download: n => dl.push(n) });
  const p = c.confirmButton.onclick();
  UI.closeActive();                                         // what _parkCoachShell does on logout
  assert.ok(c.overlay.removed);
  release(); await p;
  assert.deepEqual(dl, []); assert.deepEqual(toasts, []);
  // and a fresh dialog afterwards works normally
  const ok = { busy: false, run: async () => ({ ok: true, filename: 'g.zip', bytes: new Uint8Array(1) }) };
  const c2 = UI.open({ clientId: 'clientB1', clientName: 'Bea' }, { document: fakeDom(), exporter: ok, toast: (m) => toasts.push(m), download: n => dl.push(n) });
  await c2.confirmButton.onclick(); assert.deepEqual(dl, ['g.zip']);
});

test('CN.3 opening a second dialog dismisses the first; closeActive is idempotent', () => {
  const env = { document: fakeDom(), exporter: { busy: false, run: async () => ({ ok: false }) }, toast() {}, download() {} };
  const a = UI.open({ clientId: 'x', clientName: 'X' }, env), b = UI.open({ clientId: 'y', clientName: 'Y' }, env);
  assert.ok(a.overlay.removed && !b.overlay.removed);
  UI.closeActive(); UI.closeActive(); assert.ok(b.overlay.removed);
});

test('CN.4 session/selection state resets on auth change; the stale-plan fallback and the export button coexist', () => {
  const auth = HTML.slice(HTML.indexOf('Sin auto-login') - 1800, HTML.indexOf('Sin auto-login'));
  for (const n of ['_detailClientId = null', '_detailClientData = null', '_detailPlanData = null', 'currentCoach = null']) assert.ok(auth.includes(n), n);
  const det = body('async function showClientDetail(');
  assert.ok(det.indexOf("_expReset.onclick = null") < det.indexOf('catch (_clientErr)'), 'binding cleared before the client read');
  assert.ok(det.indexOf("const _expBtn = document.getElementById('modalExportClientBtn')") < det.indexOf('catch (_planErr)'), 'export bound BEFORE the referenced-plan read, so a stale plan cannot hide it');
  assert.ok(HTML.includes('REFERENCED_PLAN_UNREADABLE') || fs.readFileSync(path.join(__dirname, '..', 'assets', 'client-export', 'collect.js'), 'utf8').includes('REFERENCED_PLAN_UNREADABLE'));
});

test('CN.5 logout also resets coach-private memory and every private list container of the parked shell', () => {
  const loggedOut = HTML.slice(HTML.indexOf('Sin auto-login') - 3200, HTML.indexOf('Sin auto-login'));
  for (const n of ['compendioText = ""', 'manualPlan = null', '_allExercises = []', '_editingPlanId = null', '_vdsenDraftPlanId = null', '_intakeCurrentClient = null', '_historicalMesoState = null', '_shadowMonitorContext = null', '_monitorUnsub', '_monitorPlanUnsub', '_monitorClientUnsub', '_fichasUnsub = null'])
    assert.ok(loggedOut.includes(n), n);
  const park = body('function _parkCoachShell()');
  for (const id of ['fichasRecibidas', 'templateList', 'exerciseCatalog', 'planBuilder', 'autoGenStatus', 'intakeActions', 'intakeForm', 'intakeStatus', 'compendioStatus', 'vdsenPreviewStatus', 'accountInfoBox', 'clientList', 'modalClientBody'])
    assert.ok(park.includes("'" + id + "'"), id);
});
