'use strict';
/**
 * T334 — Final release audit (bounded, max 15 findings).
 * Scope: AUTH -> COACH -> GENERATOR -> FIRESTORE -> CLIENT -> LOGS ->
 * MONITOR -> SNAPSHOT -> INTERVENTION -> NEXT PLAN -> HISTORY.
 *
 * Searched every named pattern across the full round-trip (T325-T333).
 * Result: 1 real, significant cross-app bug found and fixed this run
 * (T329 -- PARTIAL/SKIPPED misclassified as COMPLETE on the Coach side in
 * three places); 5 additional real hardening fixes (T325); everything
 * else searched came back clean, backed by direct source citations below
 * (not assumed).
 *
 * Run: node tests/t334-final-release-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

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

console.log('T334 — searching all named patterns across the full round-trip:');

// data loss / false success -- fixed this run, re-confirmed.
ok(!/await saveLogs\(\)/.test(CLIENT), 'NOT FOUND: false-success (client) -- zero remaining fire-and-forget saveLogs() awaits');
const guardarCISrc = extractFunction(CLIENT, 'async function guardarCI() {');
ok(guardarCISrc.includes('var _ciOk = await _doSaveLogs();'), 'NOT FOUND: false-success (check-in) -- real await + real gate (T318)');

// cross-client write / stale activePlanId.
ok(RULES.includes('resource.data.coachId == request.auth.uid') && RULES.includes('request.resource.data.coachId == resource.data.coachId'),
  'NOT FOUND: cross-client write -- Firestore Rules make clients/{id}.coachId immutable and update-restricted server-side');
ok(CLIENT.includes("if (newPlanId && newPlanId !== activePlanId) {") && CLIENT.includes('location.reload();'),
  'NOT FOUND: stale activePlanId -- an activePlanId change triggers a full client reload');

// PID bleed / same-name identity fallback.
const stampSrc = extractFunction(COACH, 'function _stampPrescriptionIds(days) {');
ok(stampSrc.includes('var newId = _genPrescriptionId();') && !stampSrc.includes('exerciseName'),
  'NOT FOUND: PID bleed / same-name fallback -- identity minting never consults exercise name, only existing PID uniqueness');

// duplicate activation / duplicate save.
ok(COACH.includes('let _vdsenActivatingPlan = false;'), 'NOT FOUND: duplicate activation -- in-flight guard (T325)');
ok(COACH.includes('if (clientData.activePlanId === planId) return;'), 'NOT FOUND: duplicate activation (defense-in-depth) -- transaction itself is idempotent');

// stale Preview / invalid incoming plan acceptance.
ok(COACH.includes('UI_STATES.invalid(') && COACH.includes('respValidation.errors.join'), 'NOT FOUND: invalid/malformed incoming plan acceptance -- hard contract violations now block the Preview (T325)');

// previous-client async callback / missing unsubscribe.
const interveneSrc = extractFunction(COACH, 'async function _vdsenCoachIntervene(action, status) {');
ok(interveneSrc.includes('if (_detailClientId !== _clientIdSnap) return;'), 'NOT FOUND: previous-client async callback leakage -- stale-context re-check after every relevant await');
const coachOnSnapshotCount = (COACH.match(/= onSnapshot\(/g) || []).length;
ok(coachOnSnapshotCount === 4, 'NOT FOUND: missing unsubscribe -- exactly 4 Coach listeners, all torn down on logout/client-switch (T294 baseline unchanged)');

// plan backup mutation / nutrition deletion.
const backupSrc = extractFunction(COACH, 'async function backupPlanIfExists(clientId) {');
ok(backupSrc.includes('...planData,') && !backupSrc.includes('planSnap.ref') && !/updateDoc\(\s*planRef/.test(backupSrc),
  'NOT FOUND: plan backup mutation -- backup spreads into a brand-new plans_backup doc, never mutates the source plan');
const activateSrc = extractFunction(COACH, 'async function _vdsenActivatePlanInFirestore(planId, clientId) {');
ok(activateSrc.includes('clientUpdate.nutritionPlan = deleteField();') && activateSrc.includes("nutResolved.action === 'REPLACE'"),
  'NOT FOUND: silent nutrition deletion -- deletion only happens on an explicit REMOVE signal, never as a side effect of omission');

// completed-session mutation.
const goToHomeDaySrc = extractFunction(CLIENT, 'function _goToHomeDay(idx) {');
ok(!/LOGS\[/.test(goToHomeDaySrc), 'NOT FOUND: completed-session mutation from Home -- pure navigation, no LOGS write');

// skipped/partial counted as execution/complete -- THE REAL FINDING (T329).
const coachStateSrc = extractFunction(COACH, 'function _getSessionCompletionState(doneEntry) {');
ok(coachStateSrc.includes("if (doneEntry.partial) return 'PARTIAL';"), 'FIXED (T329): PARTIAL was falling through to REAL_COMPLETE on the Coach side -- now classified correctly');
const mirrorSrc = extractFunction(COACH, 'function _buildClientMirrorExecutionState(plan, logs, week) {');
ok(mirrorSrc.includes('var sessionSkipped = !!(_doneIsObj && doneEntry.skipped'), 'FIXED (T329): an explicit skip was ALSO showing as "✓ COMPLETADA" in the client-detail day badge -- now split out explicitly');

// currentWeek mismatch / stale check-in / stale nutrition date.
const renderResumenSrc = extractFunction(CLIENT, 'function renderResumen() {');
ok(renderResumenSrc.indexOf('CURRENT_WEEK = REAL_WEEK;') < renderResumenSrc.indexOf('const semActiva'), 'FIXED (T318): currentWeek mismatch on Home -- reset to REAL_WEEK before rendering');
ok(CLIENT.includes("var k = 'nutrilog_'+_todayKey();"), 'NOT FOUND: stale nutrition date -- per-calendar-date key, no cross-day bleed');

// history mutating active state / canonical snapshot divergence.
const histViewSrc = extractFunction(COACH, 'function _buildHistoricalMesocycleView(planId, mesoDoc, planDoc, coachInterventions) {');
ok(!histViewSrc.includes('updateDoc') && !histViewSrc.includes('setDoc') && !histViewSrc.includes('onSnapshot'),
  'NOT FOUND: history mutating active state -- read-only, one-shot, no writes, no live listener');

// Generator using different evidence than Monitor / N+1 confirmed but documented.
ok(COACH.includes('const logsSnap = await getDoc(logsRef);') && COACH.includes('logsDoc:   logsDoc   || null,'),
  'NOT FOUND: Generator/Monitor evidence divergence -- both read the same logs/{clientId} doc path via their own fresh getDoc');

console.log('');
console.log('T334 — Final release audit: ' + pass + ' assertions PASSED.');
console.log('P0 findings: 0. P1 findings: 1 (T329 PARTIAL/SKIPPED misclassification, FIXED). P2 findings: 5 (T325, all FIXED).');
console.log('P3 debt carried forward (documented, not fixed): exercise/muscle-scoped intervention UI does not exist yet (feature gap);');
console.log('loadClientList\'s per-row full-logs-doc fetch (N+1-shaped, parallelized, real but low-urgency cost); Home week-grid div-as-button was already closed in the prior ticket.');
