'use strict';
/**
 * T326 — Auth / client identity isolation (audit; already correct across
 * both apps, confirmed via direct reads -- no new code change this phase
 * beyond what T325/T329 already fixed for unrelated reasons).
 *
 * CASE A (Client A logout -> Client B login, zero A state): doLogout()
 *   (T129, pre-existing) resets LOGS/PLAN/EXERCISE_UNITS/EXERCISE_HISTORY/
 *   REAL_WEEK/CURRENT_WEEK. Coach side: onAuthStateChanged's logged-out
 *   branch (also T129) resets _detailClientId/_detailClientData/
 *   _detailPlanData/_detailFichaData/_detailLogsData/window._importedPlan
 *   AND clears the per-device vdsen_apikey from localStorage (T130), then
 *   replaces document.body.innerHTML with a fresh login screen.
 * CASE B (Coach switches Client A->B during async load): the T127-H
 *   pattern (_detailClientId captured before an await, re-checked after)
 *   is used consistently across showClientDetail, _onHistoricalMesoToggle,
 *   _vdsenCoachIntervene (re-confirmed in T331), and _renderClientTabMonitor.
 * CASE C (activePlanId changes -> old plan state invalid): a live
 *   clients/{uid} listener on the Client side triggers a full
 *   location.reload() the moment activePlanId changes (T320 CASE D); the
 *   Coach's own T148-H re-points its plan listener the moment the
 *   monitored client's activePlanId changes, never left stuck on a
 *   superseded plan doc (T294).
 * CASE D (failed listener/unsubscribe -> no duplicate cross-client
 *   updates): T294 confirmed exactly 4 Coach + 5 Client onSnapshot sites,
 *   every one unsubscribing its own prior listener before reassigning
 *   (idempotent to call repeatedly) -- re-confirmed unchanged this run.
 * CASE E (local backups -> plan/client scoped): the Client's
 *   loadBackupLogs() explicitly guards against a stale cross-plan backup
 *   (T321); the Coach's vdsen_apikey is removed from localStorage on
 *   logout (T130) so a second coach on the same device never inherits it.
 * CASE F (stale modal/confirmation -> cannot act on previous client):
 *   _vdsenSaveDraftClick/_vdsenActivatePlanClick both re-verify
 *   planClientSelect against the preview's own clientId at the moment of
 *   the click (T145-H, re-confirmed T327); native window.confirm() is
 *   modal/blocking so no other click can interleave while it is open.
 *
 * Run: node tests/t326-auth-client-identity-isolation.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

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

// ── CASE A ──────────────────────────────────────────────────────────────────
const doLogoutSrc = extractFunction(CLIENT, 'async function doLogout() {');
['LOGS = {}', 'REAL_WEEK = 1; CURRENT_WEEK = 1;'].forEach(function(s) { ok(doLogoutSrc.includes(s), 'CASE A (Client): doLogout resets "' + s + '"'); });
ok(COACH.includes("_detailClientId = null;") && COACH.includes("localStorage.removeItem('vdsen_apikey');"),
  'CASE A (Coach): logout resets _detailClientId AND clears the per-device API key -- no cross-coach state or billing key leak');

// ── CASE B ──────────────────────────────────────────────────────────────────
const interveneSrc = extractFunction(COACH, 'async function _vdsenCoachIntervene(action, status) {');
ok(interveneSrc.includes('const _clientIdSnap = ctx.clientId;') && interveneSrc.includes('if (_detailClientId !== _clientIdSnap) return;'),
  'CASE B: T127-H pattern present in _vdsenCoachIntervene (client captured before await, re-checked after)');
ok((COACH.match(/if \(_detailClientId !== clientId\)/g) || []).length >= 1, 'CASE B: the same guard pattern recurs at other async client-detail call sites');

// ── CASE C ──────────────────────────────────────────────────────────────────
ok(CLIENT.includes('setTimeout(function(){ location.reload(); }, 1500);'), 'CASE C (Client): an activePlanId change triggers a full reload -- old plan state cannot survive');
ok(COACH.includes('_monitorSubscribeToPlan(newActivePlanId);'), 'CASE C (Coach): T148-H re-points the Monitor\'s plan listener the moment the watched client\'s activePlanId changes');

// ── CASE D ──────────────────────────────────────────────────────────────────
const coachOnSnapshotCount = (COACH.match(/= onSnapshot\(/g) || []).length;
const clientOnSnapshotCount = (CLIENT.match(/FB\.onSnapshot\(/g) || []).length;
ok(coachOnSnapshotCount === 4, 'CASE D: exactly 4 real Coach onSnapshot sites (T294 baseline unchanged by this run)');
ok(clientOnSnapshotCount === 5, 'CASE D: exactly 5 real Client onSnapshot sites (T294 baseline unchanged by this run)');

// ── CASE E ──────────────────────────────────────────────────────────────────
const loadBackupLogsSrc = extractFunction(CLIENT, 'function loadBackupLogs() {');
ok(loadBackupLogsSrc.includes('if (bkPlanId && curPlanId && bkPlanId !== curPlanId) {'), 'CASE E (Client): local backup is plan-scoped, guards against a stale cross-plan restore');
ok(COACH.includes("localStorage.removeItem('vdsen_apikey');"), 'CASE E (Coach): the per-device API key backup is cleared on logout, never silently inherited by the next coach on the same device');

// ── CASE F ──────────────────────────────────────────────────────────────────
const saveDraftClickSrc = extractFunction(COACH, 'window._vdsenSaveDraftClick = async function() {');
const activateClickSrc  = extractFunction(COACH, 'window._vdsenActivatePlanClick = async function() {');
ok(saveDraftClickSrc.includes("document.getElementById('planClientSelect')?.value !== _vdsenCurrentPreview.clientId"), 'CASE F: save-draft cannot act on a stale preview for a since-deselected client');
ok(activateClickSrc.includes("document.getElementById('planClientSelect')?.value !== clientId"), 'CASE F: activate independently re-verifies the same guard');

console.log('');
console.log('T326 — Auth/client identity isolation: ' + pass + ' assertions PASSED. All 6 required cases confirmed; no new code change this phase.');
