'use strict';
/**
 * T254 — Coach Monitor historical mesocycle UI. A discrete, collapsed-by-
 * default "Historial de mesociclos" section, lazy-loaded only on first
 * expand, strictly READ-ONLY. Its own state (_historicalMesoState) is
 * kept entirely separate from _detailPlanData/_detailClientData -- viewing
 * history never touches the active plan's state, and is invalidated on
 * every client switch.
 *
 * Run: node tests/t254-coach-monitor-history-ui.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

function extractFunction(src, decl) {
  const idx = src.indexOf(decl);
  if (idx === -1) return null;
  const braceStart = src.indexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
  }
  return null;
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Progressive disclosure: a <details> section, collapsed by default, not a
// giant table -- reusing the SAME <details>/<summary> pattern already
// established elsewhere in this render function (KEEP exercises).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes(`<details class="mt-4" id="_historicalMesoDetails" ontoggle="window._onHistoricalMesoToggle('\${clientId}', this.open)">`),
  'the section is a collapsed-by-default <details> element, matching the established progressive-disclosure convention in this same render function');
ok(COACH.includes('📜 Historial de mesociclos'), 'discrete summary label, not a Monitor redesign');

// ─────────────────────────────────────────────────────────────────────────────
// Lazy loading: data is fetched ONLY inside the toggle handler (on first
// expand), never unconditionally inside _renderClientTabMonitor itself.
// ─────────────────────────────────────────────────────────────────────────────

const renderMonitorSrc = extractFunction(COACH, 'async function _renderClientTabMonitor(cont)');
ok(renderMonitorSrc && !renderMonitorSrc.includes("collection(db, 'logs'") , '_renderClientTabMonitor itself never queries the mesos subcollection -- the historical section is purely a placeholder + a deferred trigger until the Coach actually expands it');

const toggleSrc = extractFunction(COACH, 'window._onHistoricalMesoToggle = async function(clientId, isOpen)');
ok(toggleSrc, '_onHistoricalMesoToggle extracts cleanly');
ok(toggleSrc.includes("getDocs(collection(db, 'logs', clientId, 'mesos'))"), 'the mesos query only runs inside the toggle handler -- confirmed lazy, on-demand load');
ok(toggleSrc.includes('if (!isOpen) return;'), 'collapsing the section does no work at all -- no wasted reads on close');
ok(toggleSrc.includes('if (_historicalMesoState && _historicalMesoState.clientId === clientId)'), 're-opening an already-loaded client\'s history does not re-fetch -- cached in module state, not recomputed on every expand/collapse');

// ─────────────────────────────────────────────────────────────────────────────
// Strictly read-only: no write of any kind anywhere in the 4 new UI
// functions, no edit affordance in the rendered HTML.
// ─────────────────────────────────────────────────────────────────────────────

const selectSrc = extractFunction(COACH, 'window._onHistoricalMesoSelect = async function(planId)');
const listSrc   = extractFunction(COACH, 'function _renderHistoricalMesoList()');
const detailSrc = extractFunction(COACH, 'function _renderHistoricalMesoDetailHtml(view)');
ok([toggleSrc, selectSrc, listSrc, detailSrc].every(Boolean), 'all 4 new Monitor-history UI functions extract cleanly');

[toggleSrc, selectSrc, listSrc, detailSrc].forEach(function(src, i) {
  ok(!/\bsetDoc\(|\bupdateDoc\(|\baddDoc\(|\bdeleteDoc\(|\brunTransaction\(/.test(src), 'function #' + (i + 1) + ' performs zero writes of any kind -- strictly read-only');
});
ok(!detailSrc.includes('<button') && !detailSrc.includes('onclick="window._vdsenCoachIntervene') && !detailSrc.includes('editar') && !detailSrc.includes('Editar'),
  'the rendered historical detail HTML has no edit button and never reuses the active-plan intervention/edit handlers');

// ─────────────────────────────────────────────────────────────────────────────
// State isolation: never assigns _detailPlanData/_detailClientId/
// activePlanId/currentWeek -- only ever READS _detailClientId for its
// stale-client guard, never writes to any active-plan state.
// ─────────────────────────────────────────────────────────────────────────────

[toggleSrc, selectSrc, listSrc, detailSrc].forEach(function(src, i) {
  ok(!/_detailPlanData\s*=(?!=)/.test(src) && !/_detailClientId\s*=(?!=)/.test(src) && !/\bactivePlanId\s*:/.test(src) && !/CURRENT_WEEK\s*=(?!=)/.test(src),
    'function #' + (i + 1) + ' never assigns to _detailPlanData/_detailClientId/activePlanId/CURRENT_WEEK (only compares with === for its stale-client guard) -- read-only against the active state');
});

ok(toggleSrc.includes('if (_detailClientId !== clientId) return;'), '_onHistoricalMesoToggle guards against a stale client (Coach switched clients before this resolved)');
ok(selectSrc.includes('if (_detailClientId !== clientId) return;'), '_onHistoricalMesoSelect guards against a stale client too');
ok(toggleSrc.includes('if (_detailClientId !== clientId) return; // stale-client guard after await'), 'the guard is re-checked AFTER the await, not just before it -- catches a client switch that happens mid-fetch');

// ─────────────────────────────────────────────────────────────────────────────
// Invalidation on client switch: _historicalMesoState is reset to null
// exactly where the active client changes (showClientDetail), the same
// place other per-client transient state is already cleared.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("window._importedPlan = null; // R8-GAP-02: clear stale imported-plan state from a previous client\n    _historicalMesoState = null; // T254: invalidate the previous client's historical-mesocycle context"),
  '_historicalMesoState is invalidated on every client switch, in the SAME place and pattern as the pre-existing per-client state reset');

// ─────────────────────────────────────────────────────────────────────────────
// Reuses the REAL T252/T253 functions -- no second engine, no
// reimplementation of the historical model or discovery logic.
// ─────────────────────────────────────────────────────────────────────────────

ok(toggleSrc.includes('_sortHistoricalMesocycles(mesosDocs, activePlanId)'), 'reuses the real T253 sort/annotate function');
ok(selectSrc.includes('_buildHistoricalMesocycleView(planId, mesoDoc, planDoc,'), 'reuses the real T252 historical model builder');

console.log('');
console.log('T254 — Coach Monitor history UI: ' + pass + ' assertions PASSED');
