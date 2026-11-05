'use strict';
/**
 * T332 — Performance / listener / read audit (audit; lowest priority per
 * the ticket's own ordering; no new code change this phase).
 *
 * Searched for: N+1 reads, duplicate listeners, listener-without-
 * unsubscribe, repeated whole-document fetches, snapshot recomputation
 * loops, render-triggered reads, client-list per-row reads, unbounded
 * historical scans, and unnecessary/leaking timers.
 *
 * FINDINGS (all pre-existing, confirmed unchanged, none require a fix):
 *
 *  - P2 (documented, not fixed -- real but low-urgency, per T325 finding
 *    7 / T334): loadClientList's per-client-row logs+plan fetch is
 *    N+1-SHAPED (one getDoc per client) but fully PARALLELIZED via
 *    Promise.all (line ~3162-3164), and every downstream per-row
 *    computation (attention state, weekly decision, reduced-effectiveness
 *    projection) explicitly reuses that same already-fetched data with 0
 *    additional Firestore reads per row (self-documented in-source as
 *    "CRITICAL PERFORMANCE RULE: no N+1" at the projection step). Not
 *    fixed: doing this in a single batched query is not supported by
 *    Firestore's document-id-keyed reads here (no query shape replaces N
 *    getDoc-by-id calls), and the ticket explicitly forbids inventing new
 *    collections/schema to work around it.
 *  - P3 (documented, not fixed -- one-time/rare admin ops, never a hot or
 *    render-triggered path): two sequential (non-parallelized)
 *    await-in-for-loop Firestore writes exist, both bounded, both
 *    infrequent: exercise-catalog seeding (BASE_EXERCISES, run once per
 *    coach) and a phone_index backfill migration scan. Correctness is
 *    unaffected; parallelizing either is a pure micro-optimization on a
 *    path a coach runs at most a handful of times total.
 *  - NOT FOUND, reconfirmed clean:
 *    - Listener lifecycle: T294's exactly-4-Coach/exactly-5-Client
 *      onSnapshot baseline is unchanged (re-verified in T326 already;
 *      re-verified again here for T332's own record).
 *    - Timer lifecycle: every setInterval/rAF-style polling site in both
 *      apps (Coach's live-badge auto-refresh, Client's rest/session
 *      timers) clears its own prior handle before reassigning AND
 *      self-terminates the moment its DOM anchor disappears -- no
 *      accumulating/leaking timers across repeated navigation. The
 *      Client's rest timer centralizes its clear+null guard inside
 *      stopRestTimer(), called at the top of startRestTimer() before every
 *      one of its 10 call sites reassigns _restTimer -- not inline
 *      clearInterval at each site, but equally safe against duplication.
 *    - The Coach live-badge auto-refresh timer performs 0 Firestore reads
 *      per tick -- it reads only from the already-cached
 *      window._clientCache built by loadClientList's own single batched
 *      fetch, and only touches DOM text content.
 *    - No render-triggered read: no getDoc/getDocs/onSnapshot call exists
 *      inside a function invoked directly from a render/paint path
 *      (search: sequential `for`/`for...of`/`.forEach(async` bodies
 *      containing an awaited Firestore read -- none found outside the two
 *      documented one-time admin ops above).
 *
 * Run: node tests/t332-performance-listener-read-audit.test.js
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const COACH  = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

// ── Listener baseline unchanged (T294, re-verified). ────────────────────────
const coachOnSnapshotCount = (COACH.match(/= onSnapshot\(/g) || []).length;
const clientOnSnapshotCount = (CLIENT.match(/FB\.onSnapshot\(/g) || []).length;
ok(coachOnSnapshotCount === 4, 'T294 baseline unchanged: exactly 4 real Coach onSnapshot sites');
ok(clientOnSnapshotCount === 5, 'T294 baseline unchanged: exactly 5 real Client onSnapshot sites');

// ── loadClientList: N+1-shaped but fully parallelized, 0 extra reads downstream. ──
const listIdx = COACH.indexOf('async function loadClientList() {');
const listSlice = COACH.slice(listIdx, listIdx + 3500);
ok(listSlice.includes('const _logPromises = _clientDocs.map(c => getDoc(doc(db, \'logs\', c.id)).catch(() => null));'),
  'loadClientList batches one logs getDoc per client into an array (N+1-shaped by document-id, unavoidable without a schema/query change)');
ok(listSlice.includes('const [_logSnaps, _planSnaps] = await Promise.all([Promise.all(_logPromises), Promise.all(_planPromises)]);'),
  'all per-client reads are fully parallelized via Promise.all -- not sequential, not N round-trips in series');
ok(listSlice.includes('PERFORMANCE RULE: no N+1'),
  'the downstream reduced-effectiveness projection step is explicitly self-documented as reusing already-fetched data, 0 new Firestore reads per row');

// ── Timer lifecycle: no accumulating/leaking interval across re-entry. ─────
ok(COACH.includes('if (window._liveTimer) clearInterval(window._liveTimer);') && COACH.includes('window._liveTimer = setInterval('),
  'Coach live-badge timer clears any prior handle before reassigning -- re-entering the client list cannot stack duplicate timers');
{
  const timerIdx = COACH.indexOf('window._liveTimer = setInterval(');
  const timerSlice = COACH.slice(timerIdx, timerIdx + 700);
  ok(timerSlice.includes('if (!window._clientCache) return;'), 'the live timer no-ops safely if the cache it depends on is gone');
  ok(timerSlice.includes('clearInterval(window._liveTimer); return;'), 'the live timer self-terminates the moment its DOM anchor is gone -- no infinite background tick after navigating away');
  ok(!/getDoc|getDocs|onSnapshot/.test(timerSlice), 'the live timer performs 0 Firestore reads per tick -- reads only the in-memory client cache');
}
{
  const clears = (CLIENT.match(/clearInterval\(window\._sesTimerInterval\)/g) || []).length;
  ok(clears >= 2, 'Client session timer (window._sesTimerInterval) is cleared before reassignment at ' + clears + ' site(s) -- no duplicate-timer accumulation across repeated session starts');
}
{
  // _restTimer's guard is centralized in stopRestTimer() (clearInterval + null),
  // called at the TOP of startRestTimer() before every (re)assignment -- not
  // inline clearInterval at each of the 10 startRestTimer call sites.
  const startIdx = CLIENT.indexOf('function startRestTimer(seconds, lastSetKey) {');
  const startBraceStart = CLIENT.indexOf('{', startIdx);
  let startFnSrc = '', depth = 0;
  for (let i = startBraceStart; i < CLIENT.length; i++) {
    if (CLIENT[i] === '{') depth++;
    else if (CLIENT[i] === '}') { depth--; if (depth === 0) { startFnSrc = CLIENT.slice(startIdx, i + 1); break; } }
  }
  ok(startFnSrc.indexOf('stopRestTimer();') < startFnSrc.indexOf('_restTimer = setInterval(_restTimerTick, 1000);'),
    'Client rest timer: startRestTimer() calls stopRestTimer() (which clears any running _restTimer) BEFORE reassigning it -- no duplicate-timer accumulation across repeated rest starts');
  ok(CLIENT.includes('if (_restTimer) { clearInterval(_restTimer); _restTimer = null; }'), 'stopRestTimer\'s own clear+null guard is present');
}

// ── No sequential await-in-loop Firestore read exists outside documented one-time ops. ──
const hotPathLoopRead = /for\s*\(\s*(const|let|var)\s+\w+\s+of\s+[^)]*\)\s*\{[^}]{0,200}await get(Doc|Docs)\(/.test(COACH)
  || /\.forEach\(async[^}]{0,200}await get(Doc|Docs)\(/.test(COACH);
ok(!hotPathLoopRead, 'no sequential (non-parallelized) per-item Firestore READ exists inside a for-of/forEach loop anywhere in the Coach app');
ok(COACH.includes('for (const ex of BASE_EXERCISES) {'), 'the one known sequential Firestore WRITE-in-loop (exercise-catalog seeding) is confirmed present and unchanged -- documented P3 debt, not a read, not a hot path, run at most a handful of times per coach');

console.log('');
console.log('T332 — Performance/listener/read audit: ' + pass + ' assertions PASSED.');
console.log('P1: 0. P2: 1 (loadClientList N+1-shaped-but-parallelized read, documented since T325, not fixable without a schema/query change the ticket forbids).');
console.log('P3 debt (documented only, per ticket rule): 2 sequential-write-in-loop admin/seed ops (exercise catalog seed, phone_index backfill), both bounded and non-hot-path.');
