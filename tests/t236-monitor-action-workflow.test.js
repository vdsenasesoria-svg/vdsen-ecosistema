'use strict';
/**
 * T236 — Monitor action workflow: from the "Atención del Coach" card
 * (T229), 3 buttons (MANTENER/AJUSTAR/MARCAR REVISADO) let the Coach
 * explicitly resolve the flagged item. Reuses the EXACT established
 * persistence pattern already used by _inbodySave (read-modify-write on
 * the SAME clients/{uid} document, no new collection) and
 * saveTrainingPlan/coachNote's stale-client-context guard. No false-
 * success, no duplicate writes on double click, no cross-client leakage.
 *
 * Run: node tests/t236-monitor-action-workflow.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// Structural: exactly 3 buttons, mapped to real T234 model actions, no
// giant ticketing system, no free-form workflow.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("{ action: 'KEEP',             label: 'MANTENER',        status: 'RESOLVED' }"), 'MANTENER maps to the real KEEP action, status RESOLVED');
ok(COACH.includes("{ action: 'PAUSE_FOR_REVIEW', label: 'AJUSTAR',         status: 'REVIEWED' }"), 'AJUSTAR maps to the real PAUSE_FOR_REVIEW action, status REVIEWED');
ok(COACH.includes("{ action: 'NO_CHANGE',        label: 'MARCAR REVISADO', status: 'REVIEWED' }"), 'MARCAR REVISADO maps to the real NO_CHANGE action, status REVIEWED');
ok((COACH.match(/_intvBtn229_\$\{b\.action\}/g) || []).length === 1, 'exactly one button template generates all 3 buttons -- no separate ad-hoc markup per button');

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: reuses the exact _inbodySave pattern (read-modify-write on
// clients/{uid}, no arrayUnion/new import, no new collection).
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("const ref = doc(db, 'clients', _clientIdSnap);") && COACH.includes('const snap = await getDoc(ref);') && COACH.includes('existing.push(record);') && COACH.includes('await updateDoc(ref, { coachInterventions: existing });'),
  'persists via the SAME read-modify-write pattern already established for clients/{uid}.inbodyResults[] -- no arrayUnion import needed, no new collection');
ok(!COACH.includes('import { getFirestore, doc, getDoc, setDoc, collection, getDocs, query, where, orderBy, limit, updateDoc, addDoc, deleteDoc, onSnapshot, serverTimestamp, runTransaction, deleteField, arrayUnion }'),
  'no new Firestore SDK import was needed (arrayUnion avoided) -- minimal footprint');

// ─────────────────────────────────────────────────────────────────────────────
// No false-success: the toast only fires AFTER updateDoc resolves.
// ─────────────────────────────────────────────────────────────────────────────

const intervenFnSrc = COACH.slice(COACH.indexOf('async function _vdsenCoachIntervene'), COACH.indexOf('window._vdsenCoachIntervene = _vdsenCoachIntervene;'));
const updateDocPos = intervenFnSrc.indexOf('await updateDoc(ref, { coachInterventions: existing });');
const toastPos = intervenFnSrc.indexOf("showToast('✅ Intervención registrada');");
ok(updateDocPos !== -1 && toastPos !== -1 && updateDocPos < toastPos, 'the success toast is textually AFTER the awaited updateDoc call -- no false-success shown before persistence is confirmed');
ok(intervenFnSrc.includes('} catch (e) {') && intervenFnSrc.includes("showToast('Error: ' + e.message, true);"), 'a failed write shows a real error toast, never a silent failure or a false success');

// ─────────────────────────────────────────────────────────────────────────────
// No duplicate writes on double click: a single in-flight boolean guards
// the whole function, reset in a finally block.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('if (_savingCoachIntervention) return; // no duplicate writes on double click'), 'a double-click while a write is in flight is a no-op, not a second write');
ok(intervenFnSrc.includes('} finally {') && intervenFnSrc.includes('_savingCoachIntervention = false;'), 'the in-flight guard is always reset in a finally block, even on error -- never permanently stuck disabled');

// ─────────────────────────────────────────────────────────────────────────────
// Stale client context guard / no cross-client leakage: the client id is
// snapshotted BEFORE the await, and UI updates are skipped if the Coach
// switched clients mid-write -- same pattern as saveTrainingPlan/coachNote.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes('const _clientIdSnap = ctx.clientId; // T123-H-style snapshot: captured BEFORE any await'), 'the client id is captured before any await, mirroring the established T123-H pattern');
ok(intervenFnSrc.includes('if (_detailClientId !== _clientIdSnap) return; // stale client context guard'), 'UI refresh/success toast is skipped entirely if the Coach navigated to a different client mid-write -- no cross-client leakage');

// ─────────────────────────────────────────────────────────────────────────────
// Uses the real T234/T235 functions -- no second model/staleness engine.
// ─────────────────────────────────────────────────────────────────────────────

ok(intervenFnSrc.includes('_buildCoachIntervention({'), 'builds the record via the real T234 _buildCoachIntervention, no ad-hoc object literal');
ok(COACH.includes('const _activeInterv229 = (typeof window._findActiveIntervention === \'function\')') && COACH.includes('window._findActiveIntervention(_priorInterventions229, \'CLIENT\', clientId, (c && c.activePlanId) || null)'),
  'the button highlight state reuses the real T235 _findActiveIntervention, no ad-hoc "which button is active" logic');

// ─────────────────────────────────────────────────────────────────────────────
// No JSON embedded in onclick HTML attributes (XSS/escaping risk) -- the
// buttons pass only primitive strings, context comes from a stashed object.
// ─────────────────────────────────────────────────────────────────────────────

ok(COACH.includes("onclick=\"window._vdsenCoachIntervene('${b.action}','${b.status}')\""), 'button onclick handlers pass only primitive action/status strings, never embedded JSON');
ok(COACH.includes('window._vdsenSupervisionContext = {'), 'the rest of the context (clientId, priority, reason, plan scoping) is stashed in a plain object read by the handler, not serialized into HTML');

console.log('');
console.log('T236 — Monitor action workflow: ' + pass + ' assertions PASSED');
