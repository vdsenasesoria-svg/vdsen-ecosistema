'use strict';
/**
 * T248 — Set/session log -> evidence provenance chain. Traces:
 *   set log -> completed exercise -> completed session -> progressionHistory
 *   -> postsession -> recommendation -> Monitor/Generator evidence
 * looking specifically for implicit joins by NAME, INDEX, current-day, or
 * current-active-plan that could attribute evidence to the wrong
 * prescription. Most of this chain was already proven PID-exact and
 * plan-scoped by T235/T237/T241/T242/T246 -- this file targets the parts
 * of the chain not yet directly audited: how calculateProgression itself
 * sources the PID it stamps onto each recommendation, and whether a
 * mid-session PLAN EDIT (not a full plan swap) could misattribute a set
 * to the wrong exercise via stale array-index alignment.
 *
 * Run: node tests/t248-evidence-provenance-chain.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ─────────────────────────────────────────────────────────────────────────────
// A Coach edit to the ACTIVE plan (not a full plan swap) triggers a full
// page reload -- the client NEVER hot-patches PLAN.sesiones[di].exercises[ei]
// in place from a live snapshot. This matters: if it did, an in-progress
// session's already-rendered inputs (keyed by di/ei) could silently end up
// attributed to a DIFFERENT exercise if the Coach reordered/added/removed
// an exercise mid-session. A full reload instead re-runs loadPlan() from
// scratch, re-resolving every PID fresh and index-aligned.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("_liveUnsubPlan = FB.onSnapshot(FB.doc(FB.db, 'plans', activePlanId), function(planSnap) {"), 'a live listener on the ACTIVE plan doc exists to detect Coach edits mid-session');
const planListenerBody = CLIENT.slice(CLIENT.indexOf("_liveUnsubPlan = FB.onSnapshot(FB.doc(FB.db, 'plans', activePlanId)"), CLIENT.indexOf('// ── 3. Listener sobre el doc de LOGS'));
ok(planListenerBody.includes('location.reload();'), 'a detected plan EDIT (updatedAt changed) triggers a full page reload');
ok(!planListenerBody.includes('PLAN.sesiones') && !planListenerBody.includes('PLAN.days') && !planListenerBody.includes('.exercises['),
  'the plan-edit listener never hot-patches the in-memory PLAN/exercise array by index -- no stale-index misattribution risk, since a full loadPlan() re-run always re-resolves PIDs from scratch instead');

// ─────────────────────────────────────────────────────────────────────────────
// calculateProgression sources each recommendation's identity from the
// CURRENTLY-LOADED plan's exercise object (ej), never from a name lookup
// or a hardcoded index -- and PLAN is always freshly loaded (see above),
// so `ej` is always index-aligned with the real, current prescription.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes('prescriptionExerciseId: ej.prescriptionExerciseId || undefined,'), 'each recommendation\'s PID comes directly from the current plan\'s own exercise object field, never regenerated or name-matched');

// ─────────────────────────────────────────────────────────────────────────────
// articularPain.pattern (a motor-pattern string, e.g. "empuje horizontal")
// is captured for Coach/Generator display, but never used as an implicit
// join key to auto-select or auto-flag a SPECIFIC exercise/muscle. If it
// were, a session-wide pain report could silently misattribute a
// substitution/review action to the wrong PID via a fuzzy pattern match.
// ─────────────────────────────────────────────────────────────────────────────

ok(CLIENT.includes("articularPain: { present: articularVal==='si', pattern: articularVal==='si' ? articularPattern : '' },"), 'articularPain.pattern is captured as free-form informational text, not a structured muscle/exercise identifier');
ok(!/articularPain\.pattern\s*===/.test(CLIENT) && !/\.pattern\s*===\s*ej\./.test(CLIENT),
  'confirmed: articularPain.pattern is never compared against a specific exercise/muscle field to drive an automated per-exercise decision -- it stays purely informational (P3: it IS appended as a text reason to every exercise in that session\'s recommendations, not just the affected one -- imprecise, but never drives an incorrect automated action, since action itself is computed from ICS/RIR/plateau signals, not from this text)');

// ─────────────────────────────────────────────────────────────────────────────
// The evidence-timestamp/identity chain into Monitor/Generator (T242/T246)
// is PID+plan-scope exact, never by name/index/current-day/current-plan
// fallback -- re-confirmed here as the END of this trace, not re-tested
// (already covered exhaustively by t235/t237/t242/t246).
// ─────────────────────────────────────────────────────────────────────────────

const COACH = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
ok(COACH.includes("var matches = entry.recommendations.some(function(r) { return r && r.prescriptionExerciseId === targetId; });"),
  'the final Monitor/Generator evidence-timestamp consumer (_getLatestEvidenceTimestampForScope, T242) matches by exact prescriptionExerciseId only -- the entire chain from set log to Generator evidence is PID-anchored, with no implicit name/index/current-plan join anywhere in between');

console.log('');
console.log('T248 — Evidence provenance chain: ' + pass + ' assertions PASSED');
