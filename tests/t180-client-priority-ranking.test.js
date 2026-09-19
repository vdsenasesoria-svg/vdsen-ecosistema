'use strict';
/**
 * T180 — Exception-first client ranking.
 *
 * Reuses two ALREADY-EXISTING deterministic classifications rather than
 * inventing a medical risk score:
 *   - _computeClientAttentionState (REVIEW/PROGRESSING/STABLE/NO_DATA) —
 *     already deployed in the client list (attnBadge), unmodified here.
 *   - _classifyWeeklyStatus (T177, PAIN_REVIEW/COACH_REVIEW/
 *     RECOVERY_LIMITED/ADHERENCE_LIMITED/PERFORMANCE_STALL/PROGRESSING/
 *     STABLE/DATA_INSUFFICIENT) — when available.
 *
 * _rankClientPriority(attnState, weeklyStatus) combines both into the 4
 * operational categories the ticket asks for: NEEDS_REVIEW / WATCH /
 * ON_TRACK / INSUFFICIENT_DATA. Deliberately NOT wired into the client-list
 * render loop in this pass — the existing attnBadge already serves "who
 * needs attention" per list item; batch-fetching ci_sem_/engine_state for
 * every client in that loop to feed the richer classification would be a
 * larger data-loading restructure than "reuse/extend minimally" warrants.
 * This delivers the pure, tested ranking function so it CAN be wired in
 * later without re-deriving the logic.
 *
 * Run: node tests/t180-client-priority-ranking.test.js
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

const priorityEnumSrc = COACH.slice(COACH.indexOf('var CLIENT_PRIORITY = {'), COACH.indexOf('function _rankClientPriority'));
const rankSrc = extractFunction(COACH, 'function _rankClientPriority(attnState, weeklyStatus)');
ok(rankSrc, '_rankClientPriority extracts cleanly');
const _rankClientPriority = new Function(priorityEnumSrc + ';\nreturn ' + rankSrc + ';')();

ok(COACH.includes('window._rankClientPriority = _rankClientPriority;'), '_rankClientPriority is exported for reuse elsewhere in the Coach app');
ok(COACH.includes("window._computeClientAttentionState = _computeClientAttentionState;"), 'regression: the existing _computeClientAttentionState export is unchanged');

(function testNeedsReview() {
  ok(_rankClientPriority('REVIEW', null) === 'NEEDS_REVIEW', 'existing attnState REVIEW -> NEEDS_REVIEW even with no weeklyStatus available');
  ok(_rankClientPriority('STABLE', 'PAIN_REVIEW') === 'NEEDS_REVIEW', 'weeklyStatus PAIN_REVIEW always -> NEEDS_REVIEW, regardless of attnState');
  ok(_rankClientPriority('PROGRESSING', 'COACH_REVIEW') === 'NEEDS_REVIEW', 'weeklyStatus COACH_REVIEW always -> NEEDS_REVIEW, even if attnState looked fine');
})();

(function testWatch() {
  ok(_rankClientPriority('STABLE', 'RECOVERY_LIMITED') === 'WATCH', 'RECOVERY_LIMITED (no pain/coach-review) -> WATCH, not NEEDS_REVIEW');
  ok(_rankClientPriority('STABLE', 'ADHERENCE_LIMITED') === 'WATCH', 'ADHERENCE_LIMITED -> WATCH');
  ok(_rankClientPriority('PROGRESSING', 'PERFORMANCE_STALL') === 'WATCH', 'PERFORMANCE_STALL -> WATCH even if the legacy attnState still says PROGRESSING (richer signal wins)');
})();

(function testOnTrack() {
  ok(_rankClientPriority('PROGRESSING', 'PROGRESSING') === 'ON_TRACK', 'clean progressing read on both systems -> ON_TRACK');
  ok(_rankClientPriority('STABLE', 'STABLE') === 'ON_TRACK', 'clean stable read -> ON_TRACK');
  ok(_rankClientPriority('PROGRESSING', null) === 'ON_TRACK', 'attnState alone (no weeklyStatus available) still resolves to ON_TRACK when positive');
})();

(function testInsufficientData() {
  ok(_rankClientPriority('NO_DATA', null) === 'INSUFFICIENT_DATA', 'no attention state and no weekly status -> INSUFFICIENT_DATA');
  ok(_rankClientPriority('NO_DATA', 'DATA_INSUFFICIENT') === 'INSUFFICIENT_DATA', 'both systems agree on insufficient data');
})();

(function testNoFakePrecisionScore() {
  ok(!rankSrc.includes('score') && !/\d\.\d/.test(rankSrc), '_rankClientPriority never computes or returns a numeric precision score — only one of 4 operational category strings');
})();

console.log('');
console.log('T180 — Exception-first client ranking: ' + pass + ' assertions PASSED');
