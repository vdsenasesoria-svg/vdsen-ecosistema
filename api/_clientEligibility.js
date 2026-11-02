'use strict';

// T685: Smart eligibility, verifiable App Cliente activity detection, active-plan validation,
// and progressive cohort planning for the VDSEN autonomous progression engine.
// Server/Fleet helper module (prefixed with `_` so Vercel does not expose it as a separate endpoint).

var shadow = require('../assets/progression-auto-apply-shadow.js');
var consumer = require('../assets/progression-application-consumer.js');

var RELEASE_SCHEMA = 'vdsen-autonomous-release-v1';
var RELEASE_MAX_CLIENTS = 10;
var RELEASE_MAX_TTL_MS = 31 * 24 * 3600 * 1000;
var ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

var DEFAULT_WINDOW_DAYS = 14;
var DEFAULT_INACTIVE_DAYS = 28;
var DEFAULT_NEW_CLIENT_DAYS = 14;
var DEFAULT_RECURRENT_SESSIONS_MIN = 2;
var WALL_CLOCK_FLOOR_MS = 946684800000; // 2000-01-01T00:00:00.000Z (separates real epoch ms from synthetic test counters 1, 2, 3)

var SUSPENDED_STATUSES = Object.freeze(['suspended', 'revoked', 'cancelled', 'canceled', 'archived', 'inactive', 'deleted', 'disabled', 'draft', 'template', 'pending']);
var NON_CLIENT_SOURCES = Object.freeze([
  'synthetic', 'imported', 'import', 'historical_import', 'historical', 'legacy_import',
  'coach_admin', 'coach', 'server', 'server_generated', 'system', 'migration', 'admin',
  'seed', 'demo', 'test', 'mock', 'bot', 'script', 'trusted-progressor'
]);
var NON_CLIENT_ACTORS = Object.freeze(['coach', 'server', 'admin', 'system', 'trusted-progressor']);
var PRIORITY_RANK = Object.freeze({ PRIORITY_A: 1, PRIORITY_B: 2, PRIORITY_C: 3 });

function parseWallClockMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= WALL_CLOCK_FLOOR_MS ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    var parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= WALL_CLOCK_FLOOR_MS ? parsed : null;
  }
  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') {
      try {
        var d = value.toDate();
        var t = d && d.getTime();
        if (Number.isFinite(t) && t >= WALL_CLOCK_FLOOR_MS) return t;
      } catch (_) {}
    }
    if (typeof value.toMillis === 'function') {
      var ms = value.toMillis();
      return Number.isFinite(ms) && ms >= WALL_CLOCK_FLOOR_MS ? ms : null;
    }
    if (typeof value.seconds === 'number') {
      var secMs = value.seconds * 1000 + (value.nanoseconds ? value.nanoseconds / 1e6 : 0);
      return Number.isFinite(secMs) && secMs >= WALL_CLOCK_FLOOR_MS ? secMs : null;
    }
    if (typeof value._seconds === 'number') {
      var adminMs = value._seconds * 1000 + (value._nanoseconds ? value._nanoseconds / 1e6 : 0);
      return Number.isFinite(adminMs) && adminMs >= WALL_CLOCK_FLOOR_MS ? adminMs : null;
    }
  }
  return null;
}

function releaseUnexpired(expiresAt, nowIso) {
  if (typeof expiresAt !== 'string' || !ISO_UTC.test(expiresAt)) return false;
  var exp = Date.parse(expiresAt), now = typeof nowIso === 'number' ? nowIso : Date.parse(nowIso || new Date().toISOString());
  return Number.isFinite(exp) && Number.isFinite(now) && exp > now && exp - now <= RELEASE_MAX_TTL_MS;
}

function isClientStatusValid(client) {
  if (!client || typeof client !== 'object') return false;
  if (client.suspended === true || client.revoked === true || client.active === false || client.archived === true || client.inactive === true || client.deleted === true) return false;
  if (typeof client.status === 'string' && SUSPENDED_STATUSES.indexOf(client.status.trim().toLowerCase()) >= 0) return false;
  return true;
}

function isPlanStatusValid(plan, client) {
  if (client !== undefined && !isClientStatusValid(client)) return false;
  if (!plan || typeof plan !== 'object') return false;
  if (plan.suspended === true || plan.revoked === true || plan.active === false ||
      plan.archived === true || plan.inactive === true || plan.deleted === true ||
      plan.draft === true) return false;

  var planId = (plan && plan.id) || null;
  var clientActivePlanId = (client && typeof client.activePlanId === 'string' && client.activePlanId.trim() !== '') ? client.activePlanId.trim() : null;

  if (typeof plan.status === 'string') {
    var st = plan.status.trim().toLowerCase();
    if (st === 'draft' || SUSPENDED_STATUSES.indexOf(st) >= 0) return false;
    if (st === 'active') return true;
    if (st === 'draft_approved') {
      // AI plan: draft_approved is only active when currently referenced by the client's activePlanId
      return !!(clientActivePlanId && (!planId || clientActivePlanId === planId));
    }
    return false;
  }

  // Legacy plans without explicit status field: require CANONICAL ACTIVATION EVIDENCE before admitting.
  // Never assume absence of status implies activation.
  // When client is provided, strictly verify that the client references this plan as activePlanId.
  if (client !== undefined) {
    if (!client || !clientActivePlanId) return false;
    if (planId && clientActivePlanId !== planId) return false;
  }

  var hasExplicitActivation = plan.active === true ||
    parseWallClockMs(plan.activatedAt) !== null ||
    parseWallClockMs(client && client.planActivatedAt) !== null ||
    parseWallClockMs(client && client.activePlanActivatedAt) !== null;

  var hasCanonicalTimestamp = Number.isFinite(Date.parse(plan.updatedAt || plan.createdAt));
  var hasStructure = Array.isArray(plan.days) && plan.days.length > 0;

  return hasExplicitActivation || hasCanonicalTimestamp || hasStructure;
}

function isCardioExercise(ex) {
  if (!ex || typeof ex !== 'object') return false;
  return ex.exerciseType === 'cardio' || (!ex.exerciseType && ex.tipo === 'cardio');
}

function validateActivePlan(client, plan, requestedPlanId, clientId) {
  if (!client || typeof client !== 'object') return { valid: false, reason: 'NO_CLIENT_IDENTITY', planReady: false };
  if (!isClientStatusValid(client)) return { valid: false, reason: 'CLIENT_SUSPENDED_OR_INACTIVE', planReady: false };
  var activePlanId = typeof client.activePlanId === 'string' && client.activePlanId.trim() !== '' ? client.activePlanId.trim() : null;
  if (!activePlanId) return { valid: false, reason: 'NO_ACTIVE_PLAN', planReady: false };
  if (requestedPlanId !== undefined && requestedPlanId !== null && activePlanId !== requestedPlanId) {
    return { valid: false, reason: 'PLAN_MISMATCH', planReady: false, planId: activePlanId };
  }
  var coachId = typeof client.coachId === 'string' && client.coachId.trim() !== '' ? client.coachId.trim() : null;
  if (!coachId) return { valid: false, reason: 'NO_COACH_ASSIGNED', planReady: false, planId: activePlanId };
  if (!plan || typeof plan !== 'object') return { valid: false, reason: 'NO_ACTIVE_PLAN', planReady: false, planId: activePlanId, coachId: coachId };
  if (!isPlanStatusValid(plan, client)) return { valid: false, reason: 'PLAN_SUSPENDED_OR_REVOKED', planReady: false, planId: activePlanId, coachId: coachId };
  if (plan.id && plan.id !== activePlanId) return { valid: false, reason: 'PLAN_MISMATCH', planReady: false, planId: activePlanId, coachId: coachId };
  if (clientId && plan.clientId && plan.clientId !== clientId) return { valid: false, reason: 'PLAN_CLIENT_MISMATCH', planReady: false, planId: activePlanId, coachId: coachId };
  if (plan.coachId && plan.coachId !== coachId) return { valid: false, reason: 'PLAN_COACH_MISMATCH', planReady: false, planId: activePlanId, coachId: coachId };

  var exs = (plan.days || []).reduce(function(acc, d) { return acc.concat((d && d.exercises) || []); }, []);
  var pids = exs.map(function(e) { return e && e.prescriptionExerciseId; }).filter(function(x) { return typeof x === 'string' && x.length > 0; });
  var sameDayDup = (plan.days || []).some(function(d) {
    var dPids = ((d && d.exercises) || []).map(function(e) { return e && e.prescriptionExerciseId; }).filter(function(x) { return typeof x === 'string' && x.length > 0; });
    return new Set(dPids).size !== dPids.length;
  });
  var updatedMs = typeof plan.updatedAt === 'string' ? Date.parse(plan.updatedAt) : NaN;
  var planReady = exs.length > 0 && pids.length === exs.length && !sameDayDup && Number.isFinite(updatedMs);
  var priorities = !!(plan.musclePriorities && ((plan.musclePriorities.PRIORITARIO || []).length || (plan.musclePriorities.NO_PRIORITARIO || []).length));
  var ranges = exs.filter(function(e) { return e && e.repsRange; }).length;
  var createdMs = parseWallClockMs(plan.activatedAt) || parseWallClockMs(plan.createdAt) || (Number.isFinite(updatedMs) ? updatedMs : null);

  if (!planReady) {
    return {
      valid: false, reason: 'NEEDS_PLAN_PREP', planReady: false,
      planId: activePlanId, coachId: coachId, exercises: exs.length, withPid: pids.length,
      priorities: priorities, ranges: ranges
    };
  }
  return {
    valid: true, reason: 'ACTIVE_PLAN_VALID', planReady: true,
    planId: activePlanId, coachId: coachId, exercises: exs.length, withPid: pids.length,
    pids: pids, updatedMs: updatedMs, createdMs: createdMs, priorities: priorities, ranges: ranges
  };
}

function isSyntheticOrNonClientEntry(entry, activePlanId) {
  if (!entry || typeof entry !== 'object') return true;
  // Explicit non-client boolean flags
  if (entry.synthetic === true || entry.isSynthetic === true ||
      entry.imported === true || entry.isImported === true ||
      entry.historicalImport === true || entry.legacyImport === true ||
      entry.migrated === true || entry.serverGenerated === true ||
      entry.coachAdmin === true || entry.adminCreated === true ||
      entry.seed === true || entry.demo === true || entry.mock === true) return true;

  // Source / Origin checks
  if (typeof entry.source === 'string' && NON_CLIENT_SOURCES.indexOf(entry.source.trim().toLowerCase()) >= 0) return true;
  if (typeof entry.origin === 'string' && NON_CLIENT_SOURCES.indexOf(entry.origin.trim().toLowerCase()) >= 0) return true;

  // Canonical actor / author evidence (overrides any user-supplied source claim)
  if (typeof entry.actor === 'string' && NON_CLIENT_ACTORS.indexOf(entry.actor.trim().toLowerCase()) >= 0) return true;
  if (typeof entry.actorId === 'string' && NON_CLIENT_ACTORS.indexOf(entry.actorId.trim().toLowerCase()) >= 0) return true;
  if (typeof entry.createdBy === 'string' && NON_CLIENT_ACTORS.indexOf(entry.createdBy.trim().toLowerCase()) >= 0) return true;
  if (typeof entry.author === 'string' && NON_CLIENT_ACTORS.indexOf(entry.author.trim().toLowerCase()) >= 0) return true;
  if (typeof entry.writer === 'string' && NON_CLIENT_ACTORS.indexOf(entry.writer.trim().toLowerCase()) >= 0) return true;

  // Plan scope mismatch
  if (activePlanId && typeof entry.planId === 'string' && entry.planId !== '' && entry.planId !== activePlanId) return true;
  return false;
}

// Verified server/database authority timestamps (governed by T603 rules, Firestore server timestamps, post-session records or receipts)
// T603 / T685.2: In Firestore Rules, free-form entries map fields (sts, ts, savedAt, completedAt, ackAt)
// are NEVER proven to be database time. The sole canonical authority for athlete exposure timing
// is the immutable start marker in logs/{uid}/starts/{startId} where `at == request.time`.
function entryVerifiedWallClockMs(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // If the object is an immutable start marker with `at` and `setKey`
  if (typeof entry.setKey === 'string' && entry.at !== undefined) {
    return parseWallClockMs(entry.at);
  }
  return null;
}

function validateStartMarker(skId, st, activePlanId, entries) {
  if (!st || typeof st !== 'object') return { valid: false, reason: 'INVALID_OBJECT' };
  var planId = st.planId;
  if (typeof planId !== 'string' || planId.trim() === '') {
    return { valid: false, reason: 'MISSING_PLAN_ID' };
  }
  if (activePlanId && planId !== activePlanId) {
    return { valid: false, reason: 'PLAN_MISMATCH' };
  }
  if (isSyntheticOrNonClientEntry(st, activePlanId)) return { valid: false, reason: 'SYNTHETIC_OR_NON_CLIENT' };
  var w = Number(st.week), d = Number(st.dayIndex), e = Number(st.exerciseIndex);
  if (!Number.isInteger(w) || w < 0 || !Number.isInteger(d) || d < 0 || !Number.isInteger(e) || e < 0) {
    return { valid: false, reason: 'INVALID_INDICES' };
  }
  var expectedId = planId + '_' + w + '_' + d + '_' + e;
  if (typeof skId !== 'string' || skId !== expectedId) {
    return { valid: false, reason: 'ID_MISMATCH' };
  }
  var expectedPrefix = 'log_' + w + '_' + d + '_' + e + '_';
  if (typeof st.setKey !== 'string' || st.setKey.indexOf(expectedPrefix) !== 0 || !/^log_\d+_\d+_\d+_s\d+$/.test(st.setKey)) {
    return { valid: false, reason: 'INVALID_SET_KEY' };
  }
  var atMs = parseWallClockMs(st.at);
  if (atMs === null) {
    return { valid: false, reason: 'NO_VALID_TIMESTAMP' };
  }
  // Working set verification: must always exist in entries, be completed, and non-synthetic
  if (!entries || typeof entries !== 'object') {
    return { valid: false, reason: 'WORKING_SET_NOT_FOUND' };
  }
  var ws = entries[st.setKey];
  if (!ws || typeof ws !== 'object') {
    return { valid: false, reason: 'WORKING_SET_NOT_FOUND' };
  }
  if (ws.done !== true) {
    return { valid: false, reason: 'WORKING_SET_NOT_DONE' };
  }
  if (isSyntheticOrNonClientEntry(ws, activePlanId)) {
    return { valid: false, reason: 'SYNTHETIC_OR_NON_CLIENT' };
  }
  return {
    valid: true,
    planId: planId,
    week: w,
    dayIndex: d,
    exerciseIndex: e,
    setKey: st.setKey,
    atMs: atMs,
    sessionKey: w + '_' + d
  };
}

function entryWallClockMs(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entryVerifiedWallClockMs(entry) ||
    parseWallClockMs(entry.ts) ||
    parseWallClockMs(entry.updatedAt) ||
    parseWallClockMs(entry.createdAt) ||
    parseWallClockMs(entry.timestamp) ||
    parseWallClockMs(entry.time) ||
    null;
}

// Removes imported, Coach-administrative, server-generated, or foreign-plan entries before progression materialization.
function sanitizeClientEntries(entries, plan, activePlanId) {
  if (!entries || typeof entries !== 'object') return {};
  var clean = {};
  var planCreatedMs = parseWallClockMs(plan && (plan.activatedAt || plan.createdAt));
  Object.keys(entries).forEach(function(key) {
    var e = entries[key];
    if (isSyntheticOrNonClientEntry(e, activePlanId)) return;
    // Historical entries explicitly stamped with an epoch wall-clock before the plan's creation/activation date
    // and marked as legacy/historical are excluded; note that live sets with skewed device clocks are governed by T603 markers.
    if (planCreatedMs && e && (e.legacy === true || e.historical === true)) {
      var ms = entryWallClockMs(e);
      if (ms !== null && ms < planCreatedMs) return;
    }
    clean[key] = e;
  });
  return clean;
}

function extractRealAppActivity(input) {
  input = input || {};
  var entries = input.entries && typeof input.entries === 'object' ? input.entries : {};
  var starts = input.starts && typeof input.starts === 'object' ? input.starts : {};
  var receipts = input.receipts && typeof input.receipts === 'object' ? input.receipts : {};
  var plan = input.plan || null;
  var activePlanId = input.activePlanId || (plan && plan.id) || null;
  var nowMs = parseWallClockMs(input.now) || Date.now();
  var windowDays = Number.isFinite(input.windowDays) && input.windowDays > 0 ? input.windowDays : DEFAULT_WINDOW_DAYS;
  var windowStartMs = nowMs - windowDays * 86400000;

  var exs = (plan && Array.isArray(plan.days) ? plan.days : []).reduce(function(acc, d) { return acc.concat((d && d.exercises) || []); }, []);
  var pidSet = new Set();
  var cardioPidSet = new Set();
  exs.forEach(function(e) {
    if (e && typeof e.prescriptionExerciseId === 'string' && e.prescriptionExerciseId) {
      pidSet.add(e.prescriptionExerciseId);
      if (isCardioExercise(e)) cardioPidSet.add(e.prescriptionExerciseId);
    }
  });
  var updatedMs = plan && typeof plan.updatedAt === 'string' ? Date.parse(plan.updatedAt) : NaN;
  var planFloorMs = parseWallClockMs(plan && (plan.activatedAt || plan.createdAt)) || null;

  var realSetsCount = 0;
  var realStartsCount = 0;
  var realPostSessionsCount = 0;
  var realDoneSessionsCount = 0;
  var realReceiptsCount = 0;
  var ignoredSyntheticCount = 0;

  var sessionSetCounts = {};
  var sessionVerifiedTimestamps = {};
  var sessionDeviceTimestamps = {};
  var sessionTimestamps = {};
  var perPidComparable = {};
  var postSessions = [];
  var hasWallClockTimestamps = false;
  var hasVerifiedTimestamps = false;
  var lastActivityMs = null;
  var lastVerifiedActivityMs = null;

  // Evaluate immutable exposure start markers (logs/{uid}/starts/{planId}_{w}_{d}_{e})
  // These documents are governed by firestore.rules T603 (request.resource.data.at == request.time).
  Object.keys(starts).forEach(function(skId) {
    var st = starts[skId];
    var val = validateStartMarker(skId, st, activePlanId, entries);
    if (!val.valid) {
      ignoredSyntheticCount++;
      return;
    }
    if (planFloorMs !== null && val.atMs < planFloorMs) {
      ignoredSyntheticCount++;
      return;
    }
    realStartsCount++;
    hasVerifiedTimestamps = true;
    hasWallClockTimestamps = true;
    if (lastVerifiedActivityMs === null || val.atMs > lastVerifiedActivityMs) lastVerifiedActivityMs = val.atMs;
    if (lastActivityMs === null || val.atMs > lastActivityMs) lastActivityMs = val.atMs;
    sessionSetCounts[val.sessionKey] = (sessionSetCounts[val.sessionKey] || 0) + 1;
    if (sessionVerifiedTimestamps[val.sessionKey] === undefined || val.atMs > sessionVerifiedTimestamps[val.sessionKey]) {
      sessionVerifiedTimestamps[val.sessionKey] = val.atMs;
    }
  });

  Object.keys(entries).forEach(function(k) {
    var e = entries[k];
    if (isSyntheticOrNonClientEntry(e, activePlanId)) {
      ignoredSyntheticCount++;
      return;
    }
    var ms = entryWallClockMs(e);
    if (planFloorMs !== null && ms !== null && ms < planFloorMs) {
      ignoredSyntheticCount++;
      return;
    }

    var mSet = /^log_(\d+)_(\d+)_(\d+)_s\d+$/.exec(k);
    if (mSet) {
      if (e.done !== true || e.autoFilled === true || e.express === true || e.expressFinal === true) return;
      var pid = e.prescriptionExerciseId;
      var inPlanPid = typeof pid === 'string' && pidSet.has(pid);
      var isRealCardioLog = e.exerciseType === 'cardio' && (!pid || pidSet.size === 0 || inPlanPid);
      if (!inPlanPid && !isRealCardioLog) {
        ignoredSyntheticCount++;
        return;
      }
      var sk = mSet[1] + '_' + mSet[2];
      realSetsCount++;
      sessionSetCounts[sk] = (sessionSetCounts[sk] || 0) + 1;
      if (ms !== null) {
        hasWallClockTimestamps = true;
        if (lastActivityMs === null || ms > lastActivityMs) lastActivityMs = ms;
        if (sessionDeviceTimestamps[sk] === undefined || ms > sessionDeviceTimestamps[sk]) {
          sessionDeviceTimestamps[sk] = ms;
        }
      }

      // Comparable exposures for resistance progression (never cardio, never before plan.updatedAt)
      if (inPlanPid && !cardioPidSet.has(pid) && e.exerciseType !== 'cardio') {
        if (typeof e.ts === 'number' && Number.isFinite(updatedMs) && e.ts >= WALL_CLOCK_FLOOR_MS && e.ts < updatedMs) return;
        if (ms !== null && Number.isFinite(updatedMs) && ms < updatedMs) return;
        if (!perPidComparable[pid]) perPidComparable[pid] = new Set();
        perPidComparable[pid].add(sk);
      }
      return;
    }

    var mPost = /^postsession_(\d+)_(\d+)$/.exec(k);
    if (mPost) {
      if (e.autoClosed === true || e.partial === true) return;
      var psk = mPost[1] + '_' + mPost[2];
      realPostSessionsCount++;
      postSessions.push({ w: Number(mPost[1]), d: Number(mPost[2]), sk: psk, p: e });
      if (ms !== null) {
        hasWallClockTimestamps = true;
        if (lastActivityMs === null || ms > lastActivityMs) lastActivityMs = ms;
        if (sessionDeviceTimestamps[psk] === undefined || ms > sessionDeviceTimestamps[psk]) {
          sessionDeviceTimestamps[psk] = ms;
        }
      }
      return;
    }

    var mDone = /^done_(\d+)_(\d+)$/.exec(k);
    if (mDone) {
      if (e.autoClosed === true && e.skipped === true) return;
      var dsk = mDone[1] + '_' + mDone[2];
      if (!sessionSetCounts[dsk]) return; // Administrative/empty done_ marker without sets/starts does not count
      realDoneSessionsCount++;
      if (ms !== null) {
        hasWallClockTimestamps = true;
        if (lastActivityMs === null || ms > lastActivityMs) lastActivityMs = ms;
        if (sessionDeviceTimestamps[dsk] === undefined || ms > sessionDeviceTimestamps[dsk]) {
          sessionDeviceTimestamps[dsk] = ms;
        }
      }
      return;
    }
  });

  // Evaluate athlete consumption receipts
  Object.keys(receipts).forEach(function(rk) {
    var rc = receipts[rk];
    if (isSyntheticOrNonClientEntry(rc, activePlanId)) {
      ignoredSyntheticCount++;
      return;
    }
    var ms = entryWallClockMs(rc);
    if (planFloorMs !== null && ms !== null && ms < planFloorMs) {
      ignoredSyntheticCount++;
      return;
    }
    if (typeof rc.ackAt === 'string' && rc.ackAt.trim() !== '') {
      realReceiptsCount++;
      if (ms !== null) {
        hasWallClockTimestamps = true;
        if (lastActivityMs === null || ms > lastActivityMs) lastActivityMs = ms;
      }
    }
  });

  postSessions.sort(function(a, b) { return a.w - b.w || a.d - b.d; });
  var lastTwoPost = postSessions.slice(-2);
  var recentPain = lastTwoPost.some(function(s) {
    return !!(s.p && ((s.p.articularPain && s.p.articularPain.present) || s.p.articular === 'si'));
  });

  var realSessionKeys = Object.keys(sessionSetCounts);
  postSessions.forEach(function(ps) {
    if (realSessionKeys.indexOf(ps.sk) < 0 && sessionSetCounts[ps.sk]) realSessionKeys.push(ps.sk);
  });
  realSessionKeys.sort();

  // CRITICAL (Hallazgo 1 & 2): Reconcile session timestamps.
  // If a session has a verified timestamp from an immutable start marker, that verified timestamp
  // is authoritative and CANNOT be updated or overwritten by an unverified device mark.
  realSessionKeys.forEach(function(sk) {
    if (sessionVerifiedTimestamps[sk] !== undefined) {
      sessionTimestamps[sk] = sessionVerifiedTimestamps[sk];
    } else if (sessionDeviceTimestamps[sk] !== undefined) {
      sessionTimestamps[sk] = sessionDeviceTimestamps[sk];
    }
  });

  // Rolling window of verified sessions (14 days):
  // Only sessions backed by authorized, verified start markers within [windowStartMs, nowMs + 86400000] count!
  var windowSessionsCount = 0;
  if (hasVerifiedTimestamps) {
    realSessionKeys.forEach(function(sk) {
      var vms = sessionVerifiedTimestamps[sk];
      if (vms !== undefined && vms >= windowStartMs && vms <= nowMs + 86400000) {
        windowSessionsCount++;
      }
    });
  } else {
    // FAIL-CLOSED: Without verified wall-clock timestamps, NO sessions can be counted toward the rolling window.
    windowSessionsCount = 0;
  }

  var comparableCount = Object.keys(perPidComparable).filter(function(pid) {
    return perPidComparable[pid].size >= 2;
  }).length;

  var totalRealInteractions = realSetsCount + realStartsCount + realPostSessionsCount + realReceiptsCount;

  return {
    totalRealInteractions: totalRealInteractions,
    realSetsCount: realSetsCount,
    realStartsCount: realStartsCount,
    realPostSessionsCount: realPostSessionsCount,
    realDoneSessionsCount: realDoneSessionsCount,
    realReceiptsCount: realReceiptsCount,
    realSessionsCount: realSessionKeys.length,
    windowSessionsCount: windowSessionsCount,
    exercisesWithTwoExposures: comparableCount,
    recentPain: recentPain,
    hasWallClockTimestamps: hasWallClockTimestamps,
    hasVerifiedTimestamps: hasVerifiedTimestamps,
    lastActivityMs: lastActivityMs,
    lastVerifiedActivityMs: lastVerifiedActivityMs,
    lastActivityAt: lastActivityMs !== null ? new Date(lastActivityMs).toISOString() : null,
    ignoredSyntheticCount: ignoredSyntheticCount
  };
}

function evaluateAuthorization(clientId, coachId, releaseDoc, coachDoc, nowIso) {
  var validClientId = typeof clientId === 'string' && clientId.trim() !== '' && clientId !== '*';
  var relIds = releaseDoc && Array.isArray(releaseDoc.clientIds) ? releaseDoc.clientIds : [];
  var relIdsValid = relIds.length > 0 && relIds.length <= RELEASE_MAX_CLIENTS && relIds.every(function(x) {
    return typeof x === 'string' && x.trim() !== '' && x !== '*';
  });
  var releaseFenceOpen = !!(
    validClientId &&
    releaseDoc &&
    releaseDoc.schema === RELEASE_SCHEMA &&
    releaseDoc.enabled === true &&
    releaseUnexpired(releaseDoc.expiresAt, nowIso) &&
    relIdsValid &&
    relIds.indexOf(clientId) >= 0
  );
  var scope = consumer.normalizeCanaryScope(coachDoc && coachDoc.autoApplyCanary);
  var coachCanaryOpen = !!(validClientId && scope.enabled && scope.clientIds.indexOf(clientId) >= 0);
  return {
    releaseFenceOpen: releaseFenceOpen,
    coachCanaryOpen: coachCanaryOpen,
    authorized: releaseFenceOpen && coachCanaryOpen,
    releaseClientCount: relIds.length,
    maxClientsPerWindow: RELEASE_MAX_CLIENTS,
    expiresAt: (releaseDoc && releaseDoc.expiresAt) || null
  };
}

function evaluateClientEligibility(input) {
  input = input || {};
  var clientId = typeof input.clientId === 'string' && input.clientId.trim() !== '' ? input.clientId.trim() : null;
  var client = input.client || null;
  var plan = input.plan || null;
  var nowIso = typeof input.now === 'string' ? input.now : new Date(typeof input.now === 'number' ? input.now : Date.now()).toISOString();
  var nowMs = Date.parse(nowIso);
  var windowDays = Number.isFinite(input.windowDays) && input.windowDays > 0 ? input.windowDays : DEFAULT_WINDOW_DAYS;
  var inactiveDays = Number.isFinite(input.inactiveDays) && input.inactiveDays > 0 ? input.inactiveDays : DEFAULT_INACTIVE_DAYS;
  var newClientWindowDays = Number.isFinite(input.newClientWindowDays) && input.newClientWindowDays > 0 ? input.newClientWindowDays : DEFAULT_NEW_CLIENT_DAYS;
  var recurrentSessionsMin = Number.isFinite(input.recurrentSessionsMin) && input.recurrentSessionsMin > 0 ? input.recurrentSessionsMin : DEFAULT_RECURRENT_SESSIONS_MIN;

  var auth = evaluateAuthorization(clientId, client && client.coachId, input.releaseDoc, input.coachDoc, nowIso);
  var planCheck = validateActivePlan(client, plan, input.requestedPlanId, clientId);

  if (!clientId || !client) {
    return {
      clientId: clientId, eligible: false, priority: null, priorityRank: null,
      category: 'EXCLUDED', reason: 'NO_CLIENT_IDENTITY', technicalState: 'NO_ACTIVE_PLAN',
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: null
    };
  }

  if (!planCheck.valid) {
    var techState = planCheck.reason === 'NEEDS_PLAN_PREP' ? 'NEEDS_PLAN_PREP' : 'NO_ACTIVE_PLAN';
    return {
      clientId: clientId, coachId: client.coachId || null, planId: client.activePlanId || null,
      eligible: false, priority: null, priorityRank: null,
      category: 'EXCLUDED', reason: planCheck.reason, technicalState: techState,
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: null
    };
  }

  var activePlanId = planCheck.planId;
  var meso = input.meso || null;
  var root = input.root || null;
  var authority = (meso || root) ? shadow.selectLogAuthority(meso, root, activePlanId) : (input.entries ? { entries: input.entries } : null);
  var rawEntries = (authority && authority.entries) || input.entries || {};
  var receipts = (meso && meso.consumptionReceipts) || input.receipts || {};
  var starts = input.starts || {};

  var activity = extractRealAppActivity({
    entries: rawEntries,
    starts: starts,
    receipts: receipts,
    plan: plan,
    activePlanId: activePlanId,
    now: nowMs,
    windowDays: windowDays,
    inactiveDays: inactiveDays
  });

  if (activity.recentPain) {
    return {
      clientId: clientId, coachId: planCheck.coachId, planId: activePlanId,
      eligible: false, priority: null, priorityRank: null,
      category: 'EXCLUDED', reason: 'SAFETY_HOLD', technicalState: 'SAFETY_HOLD',
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: activity
    };
  }

  var onboardingMs = parseWallClockMs(client.onboardedAt) || parseWallClockMs(client.createdAt) ||
    parseWallClockMs(input.clientCreateTime) ||
    parseWallClockMs(plan.activatedAt) || parseWallClockMs(plan.createdAt) || null;
  var isNewClient = client.isNewClient === true ||
    (onboardingMs !== null && onboardingMs <= nowMs && (nowMs - onboardingMs) <= newClientWindowDays * 86400000);

  if (activity.totalRealInteractions === 0 || activity.realSessionsCount === 0) {
    var zeroReason = isNewClient ? 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY' : 'NO_VERIFIABLE_APP_USAGE';
    var zeroCat = isNewClient ? 'AWAITING_FIRST_ACTIVITY' : 'EXCLUDED';
    return {
      clientId: clientId, coachId: planCheck.coachId, planId: activePlanId,
      eligible: false, priority: null, priorityRank: null,
      category: zeroCat, reason: zeroReason, technicalState: 'NEEDS_EVIDENCE',
      isNewClient: isNewClient,
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: activity
    };
  }

  // LACK OF VERIFIED TEMPORAL EVIDENCE (Hallazgo 1 & 3):
  // If the client has entries/interactions but lacks verified start markers (lastVerifiedActivityMs === null):
  // Exclude from the engine. Never assign PRIORITY_C to unverified evidence.
  if (!activity.hasVerifiedTimestamps || activity.lastVerifiedActivityMs === null) {
    var unverifiedReason = isNewClient ? 'NEW_CLIENT_AWAITING_FIRST_ACTIVITY' : 'NEEDS_VERIFIED_ACTIVITY';
    var unverifiedCat = isNewClient ? 'AWAITING_FIRST_ACTIVITY' : 'EXCLUDED';
    return {
      clientId: clientId, coachId: planCheck.coachId, planId: activePlanId,
      eligible: false, priority: null, priorityRank: null,
      category: unverifiedCat, reason: unverifiedReason, technicalState: 'NEEDS_EVIDENCE',
      isNewClient: isNewClient,
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: activity
    };
  }

  // CONFIRMED INACTIVITY: Last verified activity is older than inactive window (default 28 days)
  if (!isNewClient && (nowMs - activity.lastVerifiedActivityMs) > inactiveDays * 86400000) {
    return {
      clientId: clientId, coachId: planCheck.coachId, planId: activePlanId,
      eligible: false, priority: null, priorityRank: null,
      category: 'EXCLUDED', reason: 'INACTIVE_CLIENT', technicalState: 'NEEDS_EVIDENCE',
      isNewClient: isNewClient,
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: activity
    };
  }

  var priority, category, reason;
  if (activity.windowSessionsCount >= recurrentSessionsMin) {
    priority = 'PRIORITY_A';
    category = 'RECURRENT_ACTIVE';
    reason = 'ELIGIBLE_PRIORITY_A';
  } else if (isNewClient && (activity.windowSessionsCount >= 1 || (nowMs - activity.lastVerifiedActivityMs) <= newClientWindowDays * 86400000)) {
    // New active client: Priority B after first accredited verified interaction
    priority = 'PRIORITY_B';
    category = 'NEW_CLIENT_ACTIVE';
    reason = 'ELIGIBLE_PRIORITY_B';
  } else if ((nowMs - activity.lastVerifiedActivityMs) <= inactiveDays * 86400000) {
    // Occasional active client whose recent activity is verified (< 28 days)
    priority = 'PRIORITY_C';
    category = 'OCCASIONAL_ACTIVE';
    reason = 'ELIGIBLE_PRIORITY_C';
  } else {
    return {
      clientId: clientId, coachId: planCheck.coachId, planId: activePlanId,
      eligible: false, priority: null, priorityRank: null,
      category: 'EXCLUDED', reason: 'NEEDS_VERIFIED_ACTIVITY', technicalState: 'NEEDS_EVIDENCE',
      isNewClient: isNewClient,
      readyForMotorProgression: false, authorized: false, authorization: auth,
      planValidation: planCheck, activity: activity
    };
  }

  var existingRecords = (meso && meso.progressionApplications) || {};
  var hasActiveRecords = Object.keys(existingRecords).some(function(k) {
    var r = existingRecords[k];
    return r && r.planId === activePlanId && (r.state === 'PENDING' || r.state === 'APPLIED');
  });
  var technicalState = activity.exercisesWithTwoExposures > 0 ? 'ELIGIBLE' : 'NEEDS_EVIDENCE';
  var readyForMotor = activity.exercisesWithTwoExposures > 0 || hasActiveRecords;

  return {
    clientId: clientId,
    coachId: planCheck.coachId,
    planId: activePlanId,
    eligible: true,
    priority: priority,
    priorityRank: PRIORITY_RANK[priority],
    category: category,
    reason: reason,
    technicalState: technicalState,
    isNewClient: isNewClient,
    readyForMotorProgression: readyForMotor,
    authorized: auth.authorized,
    authorization: auth,
    planValidation: planCheck,
    activity: activity
  };
}

function planCohortActivation(items, opts) {
  opts = opts || {};
  var maxPerWindow = Number.isInteger(opts.maxPerWindow) && opts.maxPerWindow > 0 && opts.maxPerWindow <= RELEASE_MAX_CLIENTS
    ? opts.maxPerWindow : RELEASE_MAX_CLIENTS;
  var initialCohortSize = Number.isInteger(opts.initialCohortSize) && opts.initialCohortSize > 0
    ? Math.min(opts.initialCohortSize, maxPerWindow) : Math.min(5, maxPerWindow);

  var evaluations = (items || []).map(function(item) {
    return item && typeof item.eligible === 'boolean' ? item : evaluateClientEligibility(item);
  });

  var eligible = [];
  var excluded = [];
  var byPriority = { PRIORITY_A: [], PRIORITY_B: [], PRIORITY_C: [] };
  var exclusionCounts = {};

  evaluations.forEach(function(ev) {
    if (ev && ev.eligible === true && PRIORITY_RANK[ev.priority]) {
      eligible.push(ev);
      byPriority[ev.priority].push(ev);
    } else if (ev) {
      excluded.push(ev);
      var r = ev.reason || 'UNKNOWN';
      exclusionCounts[r] = (exclusionCounts[r] || 0) + 1;
    }
  });

  function compareEligible(a, b) {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    if (a.readyForMotorProgression !== b.readyForMotorProgression) return a.readyForMotorProgression ? -1 : 1;
    var sa = (a.activity && a.activity.windowSessionsCount) || 0;
    var sb = (b.activity && b.activity.windowSessionsCount) || 0;
    if (sa !== sb) return sb - sa;
    var ea = (a.activity && a.activity.exercisesWithTwoExposures) || 0;
    var eb = (b.activity && b.activity.exercisesWithTwoExposures) || 0;
    if (ea !== eb) return eb - ea;
    var la = (a.activity && a.activity.lastActivityMs) || 0;
    var lb = (b.activity && b.activity.lastActivityMs) || 0;
    if (la !== lb) return lb - la;
    return String(a.clientId || '').localeCompare(String(b.clientId || ''));
  }

  eligible.sort(compareEligible);
  byPriority.PRIORITY_A.sort(compareEligible);
  byPriority.PRIORITY_B.sort(compareEligible);
  byPriority.PRIORITY_C.sort(compareEligible);

  var priorityAB = eligible.filter(function(e) { return e.priority === 'PRIORITY_A' || e.priority === 'PRIORITY_B'; });
  var stage1 = priorityAB.slice(0, 1);
  var stage2 = priorityAB.slice(0, initialCohortSize);
  var stage3 = eligible.slice(0, maxPerWindow);

  var windows = [];
  for (var i = 0; i < eligible.length; i += maxPerWindow) {
    windows.push({
      windowIndex: Math.floor(i / maxPerWindow) + 1,
      maxCapacity: maxPerWindow,
      count: Math.min(maxPerWindow, eligible.length - i),
      clientIds: eligible.slice(i, i + maxPerWindow).map(function(e) { return e.clientId; }),
      priorities: eligible.slice(i, i + maxPerWindow).map(function(e) { return e.priority; })
    });
  }

  return {
    schema: 'vdsen-cohort-activation-plan-v1',
    maxClientsPerWindow: maxPerWindow,
    stages: {
      stage1_firstEligibleClient: stage1.map(function(e) { return e.clientId; }),
      stage2_reducedActiveGroup: stage2.map(function(e) { return e.clientId; }),
      stage3_fullWindowCohort: stage3.map(function(e) { return e.clientId; })
    },
    windows: windows,
    capacityAnalysis: {
      maxClientsPerWindow: RELEASE_MAX_CLIENTS,
      totalEvaluated: evaluations.length,
      totalEligible: eligible.length,
      priorityACount: byPriority.PRIORITY_A.length,
      priorityBCount: byPriority.PRIORITY_B.length,
      priorityCCount: byPriority.PRIORITY_C.length,
      excludedCount: excluded.length,
      exclusionCounts: exclusionCounts,
      fitsSingleWindow: eligible.length <= RELEASE_MAX_CLIENTS,
      windowsRequired: eligible.length === 0 ? 0 : Math.ceil(eligible.length / maxPerWindow)
    },
    eligible: eligible,
    excluded: excluded
  };
}

module.exports = {
  RELEASE_SCHEMA: RELEASE_SCHEMA,
  RELEASE_MAX_CLIENTS: RELEASE_MAX_CLIENTS,
  RELEASE_MAX_TTL_MS: RELEASE_MAX_TTL_MS,
  DEFAULT_WINDOW_DAYS: DEFAULT_WINDOW_DAYS,
  DEFAULT_INACTIVE_DAYS: DEFAULT_INACTIVE_DAYS,
  DEFAULT_NEW_CLIENT_DAYS: DEFAULT_NEW_CLIENT_DAYS,
  DEFAULT_RECURRENT_SESSIONS_MIN: DEFAULT_RECURRENT_SESSIONS_MIN,
  PRIORITY_RANK: PRIORITY_RANK,
  parseWallClockMs: parseWallClockMs,
  releaseUnexpired: releaseUnexpired,
  isClientStatusValid: isClientStatusValid,
  isPlanStatusValid: isPlanStatusValid,
  validateActivePlan: validateActivePlan,
  isSyntheticOrNonClientEntry: isSyntheticOrNonClientEntry,
  sanitizeClientEntries: sanitizeClientEntries,
  extractRealAppActivity: extractRealAppActivity,
  evaluateAuthorization: evaluateAuthorization,
  evaluateClientEligibility: evaluateClientEligibility,
  validateStartMarker: validateStartMarker,
  entryVerifiedWallClockMs: entryVerifiedWallClockMs,
  planCohortActivation: planCohortActivation
};
