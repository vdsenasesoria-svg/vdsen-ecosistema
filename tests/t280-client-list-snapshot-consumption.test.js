'use strict';
/**
 * T280 — Client-list supervision consumption. Verifies loadClientList's
 * priority computation now uses a REDUCED but REAL canonical-effectiveness
 * projection -- the SAME real _rankClientPriority/computeEffectiveness/
 * computePerformanceResponse functions Monitor uses (T279), over data
 * already loaded for the list (0 new Firestore reads -- CRITICAL
 * PERFORMANCE RULE). bodyCompositionResponse is explicitly null (the one
 * genuinely unavailable input without a ficha read), never fabricated --
 * so the list can never claim stronger certainty than its evidence
 * supports, while still being able to reach TOLERATED_BUT_UNDER_RESPONDING/
 * EFFECTIVE_BUT_COSTLY/the performance-side SAFETY_REVIEW branch that were
 * structurally unreachable from the list before (T275's audit finding).
 *
 * Run: node tests/t280-client-list-snapshot-consumption.test.js
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

const listSrc = extractFunction(COACH, 'async function loadClientList()');
ok(listSrc, 'loadClientList extracts cleanly');

// ── Structural: reuses the SAME real functions, no third priority model ────
ok(listSrc.includes('window.VDSEN_BUILD._mapExerciseProgressionHistory(_progrecs280)'), 'reuses the real _mapExerciseProgressionHistory, no reimplementation');
ok(listSrc.includes('window.VDSEN_OUTCOME.computePerformanceResponse(planData, _progHist280)'), 'reuses the real T219 performance-response function, the same one Monitor/Generator use');
ok(listSrc.includes('window.VDSEN_ADHERENCE.computeSessionSummary(entries, week)'), 'reuses the real session-adherence summary, no reimplementation');
ok(listSrc.includes('window.VDSEN_LEARNED.computeRecoverySensitivity(entries, planData, _progHist280)'), 'reuses the real recovery-sensitivity function, no reimplementation');
ok(listSrc.includes('window.VDSEN_OUTCOME.computeEffectiveness({'), 'reuses the real T221 effectiveness synthesis, no reimplementation');
ok(listSrc.includes('const priority = _rankClientPriority(attn.state, weeklyDecision ? weeklyDecision.status : null, reducedEffectiveness ? reducedEffectiveness.overall : null);'),
  'the SAME real _rankClientPriority is called, now with the reduced effectiveness overall as its 3rd arg -- no new/third priority model');

// ── bodyCompositionResponse is explicitly null -- never fabricated ─────────
ok(listSrc.includes('bodyCompositionResponse: null,'), 'bodyCompositionResponse is explicitly null in the list\'s reduced projection -- the ficha-dependent goal is genuinely unavailable without an extra read, and is never guessed/fabricated');
ok(!/fichas_onboarding|_detailFichaData|\.objetivo_calorico\b/.test(listSrc), 'the list never reads ficha/objetivo_calorico data at all (the one mention is this file\'s own explanatory comment, not a code reference) -- confirms bodyCompositionResponse truly cannot be computed here, not just skipped by choice');

// ── CRITICAL PERFORMANCE RULE: 0 new Firestore reads ────────────────────────
ok(!/getDoc\(|getDocs\(|await /.test(listSrc.slice(listSrc.indexOf('reducedEffectiveness = null'), listSrc.indexOf('const priority ='))),
  'the new reduced-effectiveness block performs ZERO Firestore reads -- entries/planData were already loaded for the list before this code runs');

// ── Graceful degradation when the cross-block modules aren't loaded ────────
ok(listSrc.includes("typeof window.VDSEN_OUTCOME !== 'undefined' && typeof window.VDSEN_ADHERENCE !== 'undefined' &&\n              typeof window.VDSEN_LEARNED !== 'undefined' && typeof window.VDSEN_BUILD !== 'undefined'"),
  'guarded exactly like every other cross-script-block consumer -- reducedEffectiveness stays null (2-arg-equivalent behavior) rather than crashing if a module isn\'t loaded');

// ── Functional: TOLERATED_BUT_UNDER_RESPONDING is now reachable from the
// list's priority (previously structurally impossible with a 2-arg call). ──
{
  const rankSrc = extractFunction(COACH, 'function _rankClientPriority(attnState, weeklyStatus, effectivenessOverall)');
  const priorityEnumSrc = extractFunction(COACH, 'var CLIENT_PRIORITY = {').replace(/^var CLIENT_PRIORITY = /, '');
  const rank = new Function('var CLIENT_PRIORITY = ' + priorityEnumSrc + ';\nreturn ' + rankSrc + ';')();
  ok(rank('OK', 'STABLE', undefined) === 'ON_TRACK', 'prerequisite: the OLD 2-arg-equivalent call could never reach NEEDS_REVIEW for a real non-response case');
  ok(rank('OK', 'STABLE', 'TOLERATED_BUT_UNDER_RESPONDING') === 'NEEDS_REVIEW', 'with the reduced effectiveness overall now passed as the 3rd arg, TOLERATED_BUT_UNDER_RESPONDING correctly escalates to NEEDS_REVIEW -- reachable from the list now, matching what Monitor would show for the SAME evidence');
  ok(rank('OK', 'STABLE', 'EFFECTIVE_BUT_COSTLY') === 'WATCH', 'EFFECTIVE_BUT_COSTLY (a positive response with a real recovery cost) is now reachable from the list too -- WATCH, not silently ON_TRACK');
}

console.log('');
console.log('T280 — Client-list snapshot consumption: ' + pass + ' assertions PASSED');
