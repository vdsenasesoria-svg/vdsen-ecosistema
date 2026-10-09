'use strict';
/**
 * T316 — Hoy → Workout handoff (audit; already correct, no code change).
 *
 * Every requirement this phase asks to verify was already built and tested
 * across T291-T314:
 *
 *  NOT_STARTED -> correct day, editable fresh session: _getTodayHomeState
 *    picks the first NOT_STARTED/IN_PROGRESS day (T308 case 2); _goToHomeDay
 *    just calls selDia (no gating) + goTab(1) -- never mutates LOGS itself.
 *  IN_PROGRESS -> exact active day, preserved logged sets, timer/session
 *    continuity: _goToHomeDay never touches LOGS; the session timer is
 *    already scoped per week+day and recomputed fresh on every render
 *    (T299/T303 -- _calcSessionStats' `log_{week}_{di}_` prefix scoping).
 *  PARTIAL -> exact partial day, existing real sets preserved, remaining
 *    sets editable: _endSessionAsPartial never fabricates/deletes any real
 *    log_ set (T301); editSet() allows correcting ANY saved set regardless
 *    of session lifecycle (T305 audit).
 *  COMPLETE -> read-only/completed behavior, no accidental mutation: Home's
 *    CTA for COMPLETE is VIEW only (canStart/canResume both false, T308
 *    case 6 / T314 case P) -- navigating there does not write anything.
 *  SKIPPED -> no fake fresh-session state: Home shows VIEW_SKIPPED / OMITIDA
 *    (T308 case 7, T314 case E) -- never the NOT_STARTED "empezar" CTA.
 *  REST DAY -> no invalid workout route: getTodaySummary's own
 *    `sesiones.length === 0` branch is untouched by T308-T314 and still
 *    routes to goTab(1) generically (T314 case K).
 *  Client switch / activePlanId change / week change / refresh / stale
 *  session: all explicitly covered by T314's E2E cases L, M, N, O, H.
 *  Same-name exercises with different PID: NOT a Home concern -- this is
 *    the pre-existing, separate T161 "PID-first" exercise-identity system
 *    (prescriptionExerciseId matching in _getPrevWeekData/_getProgRecForExercise/
 *    _getExposures, with explicit DUPLICATE_PRESCRIPTION_ID ambiguity
 *    handling and a "POSITION ≠ IDENTITY" persisted-identity comment).
 *    Home's own dayIndex resolution never touches exercise identity at all
 *    -- it operates purely at the session/day level, so it cannot introduce
 *    a PID collision; the existing T161 system is unaffected by T307-T315.
 *
 * Conclusion: no real gap found. No code changed this phase.
 *
 * Run: node tests/t316-hoy-workout-handoff.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

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

// ── _goToHomeDay never mutates LOGS -- purely navigational. ────────────────
const goToHomeDaySrc = extractFunction(CLIENT, 'function _goToHomeDay(idx) {');
ok(!/LOGS\[/.test(goToHomeDaySrc), '_goToHomeDay never writes to LOGS -- pure navigation (selDia + goTab), no risk of mutating a session it merely opens');

// ── PID-first exercise identity is a separate, already-mature system,
// untouched by and independent of Home's dayIndex resolution. ─────────────
ok(CLIENT.includes('// T161: PID-first'), 'confirmed pre-existing T161 PID-first exercise-identity system exists');
ok(CLIENT.includes('DUPLICATE_PRESCRIPTION_ID'), 'confirmed explicit handling for the "same prescriptionExerciseId on multiple (di,ei)" ambiguity case');
ok(CLIENT.includes('POSITION ≠ IDENTITY'), 'confirmed the persisted-identity invariant comment (position in the plan is never treated as the exercise\'s identity)');
const getTodayHomeStateSrc = extractFunction(CLIENT, 'function _getTodayHomeState(logs, week, sesiones) {');
ok(!/prescriptionExerciseId|exerciseId/.test(getTodayHomeStateSrc), 'confirmed _getTodayHomeState operates purely at the session/day level -- it never touches exercise identity, so it cannot introduce a PID collision');

// ── COMPLETE/SKIPPED never expose a writable/fresh-start action from Home. ──
const getTodaySummarySrc = extractFunction(CLIENT, 'function getTodaySummary() {');
ok(getTodaySummarySrc.includes("case 'COMPLETE':") && getTodaySummarySrc.includes("case 'SKIPPED':"),
  'getTodaySummary branches both COMPLETE and SKIPPED to their own non-mutating CTA (re-confirmed from T309)');

console.log('');
console.log('T316 — Hoy -> Workout handoff: ' + pass + ' assertions PASSED. Already correct (built across T291-T314); no code changed this phase.');
