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

test('Responsive menu system: CSS contracts, mobile modal cascade order, and menu routing', () => {
  const baseModalPos = COACH.indexOf('.modal-overlay { position: fixed; inset: 0;');
  const mobileModalPos = COACH.indexOf('@media (max-width: 768px), (max-height: 520px)');
  assert.ok(baseModalPos > -1 && mobileModalPos > baseModalPos,
    'Mobile modal-overlay/modal-box rules must come AFTER base rules so desktop defaults do not shadow mobile bottom-sheet styles');

  assert.ok(COACH.includes('#vdsenMenuHost {'), 'Responsive portal host CSS present');
  assert.match(COACH, /#vdsenMenuHost\s*\{[\s\S]*?z-index:\s*2500;/, 'Portal host sits cleanly above modals and below confirm/toast layers');
  assert.match(COACH, /#vdsenMenuHost\[data-mode="sheet"\]\s+\.vdsen-menu-panel[\s\S]*?84dvh/, 'Sheet height adapts via dynamic viewport units (dvh)');
  assert.match(COACH, /#vdsenMenuHost\[data-mode="sheet"\]\s+\.vdsen-menu-body[\s\S]*?env\(safe-area-inset-bottom/, 'Sheet body respects device safe-area inset bottom');
  assert.match(COACH, /#vdsenMenuHost\[data-mode="sheet"\]\s+\.vdsen-menu-portaled\s+button[\s\S]*?min-height:\s*44px\s*!important/, 'Sheet menu items enforce 44px minimum touch height');
  assert.ok(!/#vdsenMenuHost\[data-mode="sheet"\]\s+\.vdsen-menu-portaled\s+button\s*\{[^}]*\bdisplay\s*:/.test(COACH),
    'Sheet item CSS must not force display so conditionally hidden items (Merge/Delete) remain hidden when toggled');

  // All 4 floating menus delegate to _vdsenMenu
  const planMoreStart = COACH.indexOf('window._togglePlanMoreMenu = function');
  const planMoreEnd = COACH.indexOf('window._togglePlanRenewalDrawer', planMoreStart);
  assert.ok(COACH.slice(planMoreStart, planMoreEnd).includes('window._vdsenMenu.toggle'), '#planMoreMenu delegates to _vdsenMenu');
  assert.ok(extractFn(COACH, 'function _toggleClientModalMoreMenu(forceClose)').includes('window._vdsenMenu.toggle'), '#modalMoreMenu delegates to _vdsenMenu');
  assert.ok(extractFn(COACH, 'function toggleImportPlanMenu()').includes('window._vdsenMenu.toggle'), '#importPlanMenu delegates to _vdsenMenu');
  const expStart = COACH.indexOf('window._toggleExportDropdown = function');
  assert.ok(expStart > -1 && COACH.slice(expStart, expStart + 700).includes('window._vdsenMenu.toggle'), '#exportDropdown delegates to _vdsenMenu');

  // Lifecycle cleanup and Escape priority
  assert.ok(extractFn(COACH, 'function _parkCoachShell()').includes('window._vdsenMenu.destroyHost()'), 'Logout shell parking destroys menu host cleanly');
  const escIdx = COACH.indexOf("if (ev.key !== 'Escape') return;");
  const escBlock = COACH.slice(escIdx, escIdx + 800);
  const vdsenEscPos = escBlock.indexOf('window._vdsenMenu.isOpen()');
  const modalEscPos = escBlock.indexOf('closeClientModal()');
  assert.ok(vdsenEscPos > -1 && modalEscPos > vdsenEscPos, 'Escape closes open responsive menu before closing #clientModal');
});

test('VM: _computeResponsiveMenuLayout handles mobile sheets, short landscape, edge clamping, and desktop upward flip', () => {
  const layoutFn = extractFn(COACH, 'function _computeResponsiveMenuLayout(viewport, triggerRect, menuSize, align)');
  const ctx = { window: {} };
  vm.runInNewContext(layoutFn, ctx);
  const compute = ctx._computeResponsiveMenuLayout;

  // All 5 mobile/landscape test viewports resolve to bottom sheet mode
  for (const vp of [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 844, height: 390 }
  ]) {
    const out = compute(vp, { top: 220, bottom: 264, left: 200, right: 310 }, { width: 250, height: 520 }, 'right');
    assert.equal(out.mode, 'sheet', `Viewport ${vp.width}x${vp.height} must use sheet mode`);
  }

  // Desktop 1440x900 with ample space below -> popover anchored downward & clamped inside viewport
  const deskDown = compute(
    { width: 1440, height: 900 },
    { top: 180, bottom: 220, left: 1200, right: 1380 },
    { width: 260, height: 480 },
    'right'
  );
  assert.equal(deskDown.mode, 'popover');
  assert.equal(deskDown.placement, 'bottom');
  assert.ok(deskDown.top === 226);
  assert.ok(deskDown.left >= 12 && deskDown.left + deskDown.width <= 1440 - 12);
  assert.ok(deskDown.maxHeight <= 900 - deskDown.top - 12);

  // Desktop near bottom edge -> popover automatically flips upward above trigger
  const deskFlip = compute(
    { width: 1440, height: 900 },
    { top: 820, bottom: 860, left: 30, right: 160 },
    { width: 260, height: 520 },
    'right'
  );
  assert.equal(deskFlip.mode, 'popover');
  assert.equal(deskFlip.placement, 'top');
  assert.ok(deskFlip.left >= 12, 'Clamps right-aligned menu away from left viewport edge');
  assert.ok(deskFlip.top >= 12 && deskFlip.top + Math.min(520, deskFlip.maxHeight) <= 820 - 6);
});
