'use strict';
/**
 * T256 — Mesocycle comparison. Only compares metrics reliably computable
 * from two _buildHistoricalMesocycleView (T252) outputs. Exercise-level
 * continuity is claimed ONLY for the exact same prescriptionExerciseId
 * appearing in both -- never by name. No artificial score, no automatic
 * better/worse conclusion.
 *
 * Run: node tests/t256-mesocycle-comparison.test.js
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

const cmpSrc = extractFunction(COACH, 'function _compareHistoricalMesocycles(viewA, viewB)');
ok(cmpSrc, '_compareHistoricalMesocycles extracts cleanly');
ok(COACH.includes('window._compareHistoricalMesocycles = _compareHistoricalMesocycles;'), 'exposed for reuse/testing');

// ─────────────────────────────────────────────────────────────────────────────
// No artificial score / no automatic verdict, anywhere in this function.
// ─────────────────────────────────────────────────────────────────────────────

ok(!/\bscore\b/i.test(cmpSrc), 'no "score" field or concept of any kind');
ok(!/mejor|peor|better|worse|winner|improved|declined/i.test(cmpSrc), 'no automatic better/worse/improved/declined conclusion of any kind -- raw numbers only');
ok(!cmpSrc.includes('updateDoc') && !cmpSrc.includes('setDoc'), 'pure function -- no Firestore writes');

const cmp = new Function(cmpSrc + '; return _compareHistoricalMesocycles;')();

// ─────────────────────────────────────────────────────────────────────────────
// Missing input -> null, never a fabricated comparison.
// ─────────────────────────────────────────────────────────────────────────────

ok(cmp(null, {}) === null, 'missing viewA -> null');
ok(cmp({}, null) === null, 'missing viewB -> null');

// ─────────────────────────────────────────────────────────────────────────────
// Safe global metrics: sessions/adherence/pain -- raw numbers side by side.
// ─────────────────────────────────────────────────────────────────────────────

(function testSafeGlobalMetrics() {
  const viewA = { planId: 'plan-A', sessionsCompleted: 20, totalSessions: 24, adherence: 83, painSignals: [{ week: 3 }], exercises: [] };
  const viewB = { planId: 'plan-B', sessionsCompleted: 22, totalSessions: 24, adherence: 92, painSignals: [], exercises: [] };
  const result = cmp(viewA, viewB);
  ok(result.sessionsCompleted.a === 20 && result.sessionsCompleted.b === 22, 'sessionsCompleted compared as raw numbers, both sides preserved verbatim');
  ok(result.adherence.a === 83 && result.adherence.b === 92, 'adherence compared as raw numbers');
  ok(result.painIncidents.a === 1 && result.painIncidents.b === 0, 'pain incident counts compared as raw numbers');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Exercise continuity ONLY for the exact same PID appearing in both --
// never a name-based guess, even when names are identical.
// ─────────────────────────────────────────────────────────────────────────────

(function testExerciseContinuityPidExactOnly() {
  const viewA = {
    planId: 'plan-A', sessionsCompleted: 0, totalSessions: 0, adherence: null, painSignals: [],
    exercises: [
      { prescriptionExerciseId: 'pid-continuing', exerciseName: 'Sentadilla', hasEvidence: true, progressionSummary: { history: [{ week: 1 }, { week: 2 }] } },
      { prescriptionExerciseId: 'pid-old-only', exerciseName: 'Peso Muerto', hasEvidence: true, progressionSummary: { history: [{ week: 1 }] } }
    ]
  };
  const viewB = {
    planId: 'plan-B', sessionsCompleted: 0, totalSessions: 0, adherence: null, painSignals: [],
    exercises: [
      { prescriptionExerciseId: 'pid-continuing', exerciseName: 'Sentadilla', hasEvidence: true, progressionSummary: { history: [{ week: 1 }] } },
      { prescriptionExerciseId: 'pid-new-b-only', exerciseName: 'Peso Muerto', hasEvidence: true, progressionSummary: { history: [{ week: 1 }] } } // SAME NAME as pid-old-only, DIFFERENT pid
    ]
  };
  const result = cmp(viewA, viewB);
  ok(result.sharedExercises.length === 1 && result.sharedExercises[0].prescriptionExerciseId === 'pid-continuing',
    'exactly 1 shared exercise -- the one with the literal SAME PID in both mesociclos');
  ok(result.sharedExercises[0].weeksExecutedA.join(',') === '1,2' && result.sharedExercises[0].weeksExecutedB.join(',') === '1',
    'per-mesociclo weeks-executed data is preserved separately for the shared PID, never merged/averaged');
  const sharedIds = result.sharedExercises.map(function(s) { return s.prescriptionExerciseId; });
  ok(sharedIds.indexOf('pid-old-only') === -1 && sharedIds.indexOf('pid-new-b-only') === -1,
    '"Peso Muerto" in A (pid-old-only) and "Peso Muerto" in B (pid-new-b-only) are NEVER claimed as continuous despite the identical name -- different PIDs are simply absent from sharedExercises, not merged');
})();

// ─────────────────────────────────────────────────────────────────────────────
// No shared exercises at all -> empty array, never fabricated.
// ─────────────────────────────────────────────────────────────────────────────

(function testNoSharedExercises() {
  const viewA = { planId: 'plan-A', sessionsCompleted: 0, totalSessions: 0, adherence: null, painSignals: [], exercises: [{ prescriptionExerciseId: 'pid-1', hasEvidence: true, progressionSummary: { history: [] } }] };
  const viewB = { planId: 'plan-B', sessionsCompleted: 0, totalSessions: 0, adherence: null, painSignals: [], exercises: [{ prescriptionExerciseId: 'pid-2', hasEvidence: true, progressionSummary: { history: [] } }] };
  const result = cmp(viewA, viewB);
  ok(Array.isArray(result.sharedExercises) && result.sharedExercises.length === 0, 'completely different PIDs -> empty sharedExercises, no fabricated continuity');
})();

console.log('');
console.log('T256 — Mesocycle comparison: ' + pass + ' assertions PASSED');
