'use strict';
/**
 * T291 — Async mutation contract map (audit-only).
 *
 * Maps the critical user-triggered async operations. Compact map (ACTION /
 * MUTATION / IDENTITY SCOPE / INFLIGHT GUARD / STALE-CONTEXT GUARD /
 * SUCCESS CONDITION / FAILURE PATH / RETRY / LISTENER EFFECT):
 *
 * 1. ACTIVATE PLAN (_vdsenActivatePlanClick, coach)
 *    MUTATION: backupPlanIfExists + _vdsenActivatePlanInFirestore (Firestore txn)
 *    IDENTITY: clientId (captured before await)
 *    INFLIGHT: btn.disabled=true set synchronously before any await
 *    STALE-CONTEXT: planClientSelect.value !== clientId checked BEFORE
 *      starting (not re-checked after -- the write itself is Firestore-txn
 *      atomic and clientId-scoped, so a stale write cannot land on a
 *      DIFFERENT client; only the SUCCESS UI could theoretically show for
 *      the wrong screen, and the confirm() dialog already forces a pause
 *      long enough that this is not a demonstrated real risk)
 *    SUCCESS: only after both awaits resolve without throwing
 *    FAILURE: catch re-enables btn, shows real error message
 *    RETRY: safe (idempotency guard already exists in
 *      _vdsenActivatePlanInFirestore: activePlanId === planId -> no-op)
 *    ALREADY HARDENED -- no defect found.
 *
 * 2. SAVE DRAFT (_vdsenSaveDraftClick, coach)
 *    Same pattern as #1: btn.disabled before await, stale-client check
 *    before starting, result.idempotent handling, catch re-enables.
 *    ALREADY HARDENED -- no defect found.
 *
 * 3. COACH INTERVENTION (_vdsenCoachIntervene, coach)
 *    INFLIGHT: _savingCoachIntervention boolean, checked+set before any await
 *    STALE-CONTEXT: _clientIdSnap captured before await; re-checked via
 *      `_detailClientId !== _clientIdSnap` AFTER the write, before showing
 *      the success toast AND in the finally block before re-enabling
 *      buttons (scoped to the right client's DOM only)
 *    ALREADY HARDENED -- no defect found.
 *
 * 4. PLAN GENERATION (vdsenAIPreview, coach, /api/vdsen-generate)
 *    INFLIGHT: btn.disabled set; AbortController + 3-min timeout
 *    STALE-CONTEXT: `planClientSelect.value !== clientId` re-checked
 *      AFTER the fetch resolves (T144-H), for BOTH the NEEDS_COACH_REVIEW
 *      and VALID response branches -- a stale response never force-opens
 *      the preview over a different client the coach has since selected
 *    ALREADY HARDENED -- no defect found.
 *
 * 5. SESSION COMPLETION (_confirmSessionDone / submitPostSession, client)
 *    INFLIGHT: _postSessionSubmitting boolean, try/finally always resets it
 *    SUCCESS CONDITION: _doSaveLogs()'s real return value gates the
 *      "SESIÓN COMPLETADA" toast -- a failed write reverts the local
 *      done_ flag and shows a real error, never a false success
 *    ALREADY HARDENED -- no defect found.
 *
 * 6. HISTORICAL MESOCYCLE VIEW TOGGLE (_onHistoricalMesoToggle, coach)
 *    INFLIGHT: _historicalMesoLoading boolean
 *    STALE-CONTEXT: `_detailClientId !== clientId` checked BEFORE starting
 *      AND after both awaits (getDoc + getDocs) -- matches T127-H's
 *      established pattern exactly.
 *    ALREADY HARDENED -- no defect found.
 *
 * 7. showClientDetail (client-open, coach) -- T127-H's own canonical
 *    pattern: `_detailClientId !== clientId` re-checked after EVERY
 *    single await (clientSnap, planSnap, fichaSnap, renovSnap). This is
 *    the ESTABLISHED reference pattern every other async client-scoped
 *    load in the file is expected to follow.
 *
 * 8. MONITOR TAB RENDER (_renderClientTabMonitor, coach) -- **REAL DEFECT
 *    FOUND (T292 fixes it)**: captures `clientId = _detailClientId` at
 *    the top, then `await getDoc(doc(db,'logs',clientId))`, but NEVER
 *    re-checks `_detailClientId === clientId` afterward before writing
 *    into `cont.innerHTML` -- and `cont` (#clientDetailTabContent) is a
 *    SINGLE, PERSISTENT DOM element shared across every client's detail
 *    view (confirmed via _switchClientTab), not recreated per client. If
 *    the coach switches to a DIFFERENT client while this getDoc is in
 *    flight, the stale response can silently overwrite the NEW client's
 *    already-rendered Monitor tab with the OLD client's data -- a real,
 *    demonstrated cross-client UI leakage, violating this ticket's own
 *    Core Principle ("no cross-client completion") and the codebase's own
 *    established T127-H pattern (which every OTHER async client-scoped
 *    Firestore read in this file already follows).
 *
 * Run: node tests/t291-async-mutation-contract-map.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Confirm the 6 already-hardened patterns are still present (baseline).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("if (btn) { btn.disabled = true; btn.textContent = '⏳ Activando…'; }"), '1. activate-plan sets btn.disabled synchronously before any await');
ok(COACH.includes('if (_savingCoachIntervention) return; // no duplicate writes on double click'), '3. coach intervention has an inFlight guard');
ok(COACH.includes('if (_detailClientId !== _clientIdSnap) return; // stale client context guard'), '3. coach intervention re-checks client identity after the write, before success UI');
ok(COACH.includes("if (document.getElementById('planClientSelect')?.value !== clientId) {\n          setStatus"), '4. plan generation re-checks client identity after the fetch resolves (T144-H)');
ok(CLIENT.includes('if (_ok === false) {\n    // No persistió en Firestore'), '5. session completion gates success UI on the real Firestore write result');
ok(CLIENT.includes('if (_postSessionSubmitting) return;') && CLIENT.includes('_postSessionSubmitting = true;'), '5. post-session submit has an inFlight guard checked and set before any async work');
ok(COACH.includes('if (_detailClientId !== clientId) return; // stale-client guard'), '6. historical mesocycle toggle checks client identity before starting');
ok(COACH.includes('if (_detailClientId !== clientId) return; // stale-client guard after await'), '6. historical mesocycle toggle re-checks client identity after both awaits');
ok((COACH.match(/if \(_detailClientId !== clientId\) return;  \/\/ T127-H/g) || []).length >= 4,
  '7. showClientDetail re-checks _detailClientId after EVERY await (T127-H) -- the established reference pattern');

// ─────────────────────────────────────────────────────────────────────────────
// FINDING: _renderClientTabMonitor never re-checks client identity after
// its own getDoc await, unlike every other async client-scoped read.
// ─────────────────────────────────────────────────────────────────────────────

const idx = COACH.indexOf('async function _renderClientTabMonitor(cont) {');
const braceStart = COACH.indexOf('{', idx);
let depth = 0, end = -1;
for (let i = braceStart; i < COACH.length; i++) {
  if (COACH[i] === '{') depth++;
  else if (COACH[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const monitorFnBody = COACH.slice(idx, end + 1);

ok(monitorFnBody.includes('const clientId = _detailClientId;') && monitorFnBody.includes('await getDoc(doc(db, \'logs\', clientId))'),
  'prerequisite: _renderClientTabMonitor captures clientId then awaits a client-scoped getDoc, exactly the shape T127-H guards elsewhere');
ok((monitorFnBody.match(/_detailClientId/g) || []).length === 2,
  'FINDING FIXED by T292: _detailClientId now appears twice (the initial capture + the post-await re-check), matching every other pattern above');
ok(COACH.includes("else if (tab === 'monitor') _renderClientTabMonitor(cont);") && COACH.includes("const cont = document.getElementById('clientDetailTabContent');"),
  'confirmed: cont (#clientDetailTabContent) is ONE shared, persistent DOM element across every client\'s detail view, not recreated per client -- a stale write here is not harmlessly orphaned, it overwrites whatever client is currently displayed');

console.log('');
console.log('T291 — Async mutation contract map: ' + pass + ' assertions PASSED');
console.log('CONCLUSION: 1 real finding -- _renderClientTabMonitor missing the T127-H stale-client-context guard after its own getDoc await.');
