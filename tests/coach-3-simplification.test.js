'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFn(src, sig, nextSig) {
  const idx = src.indexOf(sig);
  assert.ok(idx !== -1, 'Missing signature: ' + sig);
  if (nextSig) {
    const endIdx = src.indexOf(nextSig, idx);
    assert.ok(endIdx > idx, 'Missing next boundary: ' + nextSig);
    return src.slice(idx, endIdx);
  }
  const open = src.indexOf('{', idx);
  let depth = 0, inSq = false, inDq = false, inTpl = false, esc = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && (inSq || inDq || inTpl)) { esc = true; continue; }
    if (ch === "'" && !inDq && !inTpl) inSq = !inSq;
    else if (ch === '"' && !inSq && !inTpl) inDq = !inDq;
    else if (ch === '`' && !inSq && !inDq) inTpl = !inTpl;
    else if (!inSq && !inDq) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return src.slice(idx, i + 1);
      }
    }
  }
  throw new Error('Unbalanced braces for ' + sig);
}

test('Coach 3.0 primary navigation has exactly 4 sections in desktop sidebar and mobile bottom nav', () => {
  const sidebarNavMatch = COACH.match(/<nav aria-label="Navegación principal"[\s\S]*?<\/nav>/);
  assert.ok(sidebarNavMatch, 'Desktop sidebar nav exists');
  const sidebarBtns = Array.from(sidebarNavMatch[0].matchAll(/data-section="([^"]+)"/g)).map(m => m[1]);
  assert.deepEqual(sidebarBtns, ['inicio', 'clientes', 'pendientes', 'mas']);

  const mobileNavMatch = COACH.match(/<div class="bottom-nav-mobile"[\s\S]*?<\/div>\s*\n/);
  assert.ok(mobileNavMatch, 'Mobile bottom nav exists');
  const mobileBtns = Array.from(mobileNavMatch[0].matchAll(/data-section="([^"]+)"/g)).map(m => m[1]);
  assert.deepEqual(mobileBtns, ['inicio', 'clientes', 'pendientes', 'mas']);

  // Zero nav emojis inside sidebar or bottom nav
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(sidebarNavMatch[0]), 'Sidebar nav uses SVG icons, no emojis');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(mobileNavMatch[0]), 'Mobile nav uses SVG icons, no emojis');
});

test('Coach 3.0 design palette, sticky mobile header, and protected modal menu are wired cleanly', () => {
  assert.match(COACH, /--bg-base:\s*#0A0A0A;/, 'Off-Black palette token set');
  assert.match(COACH, /--text-primary:\s*#F4F4F0;/, 'Hueso palette token set');
  assert.match(COACH, /--accent:\s*#C6FF00;/, 'Lima ácido palette token set');
  assert.match(COACH, /--danger:\s*#C93B3B;/, 'Rojo metálico danger token set');
  assert.ok(COACH.includes('id="mobileHeader"'), 'Compact mobile sticky header preserved');
  assert.ok(COACH.includes('id="activeClientContextBar"'), 'Persistent selected-client context pill exists');

  const moreMenuMatch = COACH.match(/<div id="modalMoreMenu"[\s\S]*?<\/div>/);
  assert.ok(moreMenuMatch, 'Secondary client modal overflow menu exists');
  assert.ok(moreMenuMatch[0].includes('id="modalDeleteClientBtn"'), 'Delete client action stays inside protected secondary menu');
  assert.ok(moreMenuMatch[0].includes('id="modalMergeClientBtn"'), 'Merge client action stays inside secondary menu');
});

test('Client Expediente simplifies 7 tabs down to 4 tabs while preserving legacy tab redirects', () => {
  const detailFn = extractFn(COACH, 'async function showClientDetail(clientId, opts)', '  // FASE 24 — helper puro:');
  const ctabs = Array.from(detailFn.matchAll(/id="(ctab_[a-z]+)"/g)).map(m => m[1]);
  assert.deepEqual(ctabs, ['ctab_ficha', 'ctab_plan', 'ctab_seguimiento', 'ctab_monitor']);
  assert.ok(detailFn.includes('role="tablist"'), 'Expediente tabs expose ARIA tablist');

  const switchFn = extractFn(COACH, 'async function _switchClientTab(tab)', '  window._switchClientTab = _switchClientTab;');
  assert.match(switchFn, /requestedTab === 'notas' \? 'ficha'/);
  assert.match(switchFn, /requestedTab === 'inbody' \? 'seguimiento'/);
  assert.match(switchFn, /requestedTab === 'renovar' \? 'plan'/);
  assert.ok(switchFn.includes('expedienteNotasSection'), 'Legacy notas redirect scrolls to embedded notes section');
  assert.ok(switchFn.includes('seguimientoInBodyPanel'), 'Legacy inbody redirect scrolls to embedded InBody panel');
  assert.ok(switchFn.includes('_togglePlanRenewalDrawer'), 'Legacy renovar redirect opens contextual renewal drawer');

  const fichaFn = extractFn(COACH, 'function _renderClientTabFicha(cont)', '  window._renderClientTabFicha = _renderClientTabFicha;');
  assert.ok(fichaFn.includes('id="expedienteNotasSection"'), 'Expediente tab embeds Coach notes');
  assert.ok(fichaFn.includes('_vdsenCopyExpedienteForGenerator'), 'Expediente offers Copy Expediente for external Generator');

  const planFn = extractFn(COACH, 'function _renderClientTabPlan(cont)', '  // ========== FASE 58');
  assert.ok(planFn.includes('Autorización del motor:'), 'Plan activo renders plain-Spanish engine authorization');
  assert.ok(planFn.includes('_validateActivePlanModal'), 'Plan activo includes Validar plan action');
  assert.ok(planFn.includes('id="planRenewalDrawer"'), 'Plan activo embeds contextual renewal drawer');
});

test('JSON plan importer is provider-agnostic and keeps 4-step workflow & existing validators', () => {
  assert.ok(!/generado por Claude|Pegar JSON \(Claude\)/i.test(COACH), 'Coach UI no longer hardcodes Claude in JSON importer copy');
  assert.ok(COACH.includes('Importar plan JSON'), 'Primary CTA renamed to Importar plan JSON');

  const modalImportFn = COACH.slice(
    COACH.indexOf('window._modalImportPlan = function(mode, clientId)'),
    COACH.indexOf('window._submitModalImport = async function(mode, clientId)')
  );
  assert.ok(modalImportFn.includes('_vdsenCopyExpedienteForGenerator'), 'Step 1: Copy expediente button available');
  assert.ok(modalImportFn.includes('accept=".json,application/json"'), 'Step 2: Local .json file picker supported');
  assert.ok(modalImportFn.includes('window._previewModalImportJson'), 'Step 3: Validate & preview action wired');
  assert.ok(modalImportFn.includes("_submitModalImport('json'"), 'Step 4: Save & activate button preserved');
});

test('Secondary features are relocated under Mas/Mantenimiento cleanly without auto-execution', () => {
  const masHtml = COACH.slice(COACH.indexOf('<!-- 4. MÁS:'), COACH.indexOf('<!-- SECUNDARIA: Evaluación'));
  assert.ok(masHtml.includes("showSection('templates')"));
  assert.ok(masHtml.includes("showSection('catalogo')"));
  assert.ok(masHtml.includes("showSection('config',{focus:'compendio'})"));
  assert.ok(masHtml.includes("showSection('crearPlan')"));
  assert.ok(masHtml.includes("showSection('evaluacion')"));
  assert.ok(masHtml.includes("showSection('config',{focus:'mantenimiento'})"));

  const initFn = extractFn(COACH, 'async function initCoachUI()', '  // CN1 — Ciclo de vida del shell:');
  assert.ok(!initFn.includes('loadExerciseCatalog()'), 'Catalog is lazy-loaded rather than eagerly loaded on init');
  assert.ok(!initFn.includes('loadTemplates()'), 'Templates are lazy-loaded rather than eagerly loaded on init');
  assert.ok(!initFn.includes('getDoc(doc(db, "compendio"'), 'Compendio is lazy-loaded rather than eagerly loaded on init');
  const initWithoutHandlers = initFn.replace(/\.onclick\s*=\s*\(\)\s*=>\s*repairPhoneIndexAll\(\)/g, '');
  assert.ok(!/diagFirebaseOut|repairPhoneIndexAll\(\)|applyFichaPatch\(\)/.test(initWithoutHandlers), 'Maintenance tools never run automatically');

  const showSecFn = extractFn(COACH, 'async function showSection(sectionId, opts)');
  assert.ok(showSecFn.includes('manualPlan || window._importedPlan'), 'Leaving crearPlan checks both manualPlan and unsaved _importedPlan');
  assert.ok(showSecFn.includes('_ensureSecondaryLoaded(sectionId)'), 'Secondary sections trigger lazy loaders');
  assert.ok(showSecFn.includes('history.replaceState'), 'Navigation persists via URL hash without extra localStorage keys');

  const fichasLoader = extractFn(COACH, 'async function _loadCoachClientFichas(box)');
  const intakeLoader = extractFn(COACH, 'async function loadIntakeClients()');
  assert.ok(fichasLoader.includes('_readCoachClientsInFlight()'), 'Fichas client scan shares in-flight client query');
  assert.ok(intakeLoader.includes('_readCoachClientsInFlight()'), 'Intake selector shares in-flight client query');
});

test('VM: _resolveCoachClientLogAuthority enforces active-meso parity, distinguishes read_error vs no_activity, and preserves seguimientoSummary', () => {
  const selFn = extractFn(COACH, 'function _selectCoachLogForActivePlan(rootData, activePlanId, mesoData)');
  const authFn = extractFn(COACH, 'function _resolveCoachClientLogAuthority(rootRead, mesoRead, activePlanId)');
  const segCountFn = extractFn(COACH, 'function _getSegPendingCount(logData)');
  const actMetaFn = extractFn(COACH, 'function _resolveLastActivityMeta(logData, readError, hasActivity)');

  const ctx = { window: {} };
  vm.runInNewContext([selFn, authFn, segCountFn, actMetaFn].join('\n'), ctx);

  const mkSnap = (data) => ({ exists: () => data != null, data: () => data });

  // Case 1: Active meso mirror wins over stale root AND preserves root seguimientoSummary
  const res1 = ctx._resolveCoachClientLogAuthority(
    {
      status: 'fulfilled',
      value: mkSnap({
        planId: 'plan-old',
        currentWeek: 6,
        entries: { log_6_0_0_s0: { done: true, carga: 100 } },
        seguimientoSummary: { pendingReviewCount: 2 }
      })
    },
    {
      status: 'fulfilled',
      value: mkSnap({
        planId: 'plan-new',
        currentWeek: 2,
        entries: { log_2_0_0_s0: { done: true, carga: 82.5, ts: Date.now() } }
      })
    },
    'plan-new'
  );
  assert.equal(res1.source, 'active_meso');
  assert.equal(res1.activityState, 'active');
  assert.equal(res1.readError, false);
  assert.equal(res1.logData.planId, 'plan-new');
  assert.equal(res1.logData.currentWeek, 2);
  assert.equal(ctx._getSegPendingCount(res1.logData), 2);
  assert.equal(ctx._getSegPendingCount({ seguimientoSummary: { pendingCount: 1 } }), 1);

  // Case 2: Both reads fulfilled cleanly, no sessions recorded (only autoFilled or empty) -> no_activity (NOT read_error)
  const res2 = ctx._resolveCoachClientLogAuthority(
    {
      status: 'fulfilled',
      value: mkSnap({
        planId: 'plan-new',
        currentWeek: 1,
        entries: { log_1_0_0_s0: { autoFilled: true } }
      })
    },
    { status: 'fulfilled', value: mkSnap(null) },
    'plan-new'
  );
  assert.equal(res2.readError, false);
  assert.equal(res2.hasActivity, false);
  assert.equal(res2.activityState, 'no_activity');
  assert.equal(ctx._resolveLastActivityMeta(res2.logData, res2.readError, res2.hasActivity).label, 'Sin actividad');

  // Case 3: Both/active log read rejected -> readError true, activityState === 'read_error'
  const res3 = ctx._resolveCoachClientLogAuthority(
    { status: 'rejected', reason: new Error('permission-denied') },
    { status: 'rejected', reason: new Error('permission-denied') },
    'plan-new'
  );
  assert.equal(res3.readError, true);
  assert.equal(res3.source, 'read_error');
  assert.equal(res3.activityState, 'read_error');
  assert.equal(ctx._resolveLastActivityMeta(res3.logData, res3.readError, res3.hasActivity).label, 'Bitácora no disponible');
});
