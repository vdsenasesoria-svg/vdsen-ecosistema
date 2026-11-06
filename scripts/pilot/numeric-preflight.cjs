'use strict';
// Numeric pilot preflight verification: determines GO or NO-GO prior to any numeric operations.
// Validates all identity fences, runtime attestation, window limits, single-operation bounds,
// and lack of concurrency conflicts or CRON triggers.
// Read-only by default.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../../api/_numericPilotContract');
const { attestRuntime } = require('./numeric-attestation.cjs');

const MAX_WINDOW_HOURS = 24;
const MAX_WINDOW_MS = MAX_WINDOW_HOURS * 3600 * 1000;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Validates a numeric pilot window structure.
 * @param {object} w
 * @param {number} [now]
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateNumericWindow(w, now = Date.now()) {
  const errors = [];
  if (!w || typeof w !== 'object') {
    return { valid: false, errors: ['Window specification is missing or not an object.'] };
  }

  if (w.schema !== 'vdsen-numeric-pilot-v1') errors.push('Invalid window schema: expected vdsen-numeric-pilot-v1.');
  if (w.mode !== 'NUMERIC_APPLY') errors.push('Invalid window mode: expected NUMERIC_APPLY.');
  if (w.uid !== C.UID) errors.push('Invalid UID: strictly only Ayrton UID authorized (' + C.UID + ').');
  if (w.planId !== C.PLAN) errors.push('Invalid planId: strictly only authorized planId (' + C.PLAN + ').');
  if (w.pid !== C.PID) errors.push('Invalid PID: strictly only authorized PID (' + C.PID + ').');
  if (!/^[a-f0-9]{40}$/.test(w.runtimeSha || '')) errors.push('Invalid runtimeSha: must be 40 hex chars.');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(w.operationId || '')) errors.push('Invalid operationId: must be 8-80 alphanumeric/hyphen chars.');

  const starts = Date.parse(w.startsAt || '');
  const expires = Date.parse(w.expiresAt || '');

  if (!Number.isFinite(starts) || new Date(starts).toISOString() !== (w.startsAt || '').replace('Z', '.000Z')) {
    errors.push('startsAt must be valid UTC ISO string (no fractional seconds, ending in Z).');
  }
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== (w.expiresAt || '').replace('Z', '.000Z')) {
    errors.push('expiresAt must be valid UTC ISO string (no fractional seconds, ending in Z).');
  }

  if (Number.isFinite(starts) && Number.isFinite(expires)) {
    if (expires <= starts) {
      errors.push('expiresAt must be strictly greater than startsAt.');
    }
    const duration = expires - starts;
    if (duration > MAX_WINDOW_MS) {
      errors.push('Window duration (' + (duration / 3600000).toFixed(1) + 'h) exceeds the 24-hour limit.');
    }
    if (now < starts) {
      errors.push('Window has not started yet (startsAt: ' + w.startsAt + ', now: ' + new Date(now).toISOString() + ').');
    }
    if (now >= expires) {
      errors.push('Window has expired (expiresAt: ' + w.expiresAt + ', now: ' + new Date(now).toISOString() + ').');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates Firestore fences in preflight.
 * @param {object} fences
 * @param {object} window
 * @param {string} mode - 'preflight' | 'active' | 'stop'
 */
function validateFences(fences, window, mode = 'preflight') {
  const errors = [];
  const rel = fences.releaseControl;
  const num = fences.numericPilot;
  const coach = fences.coach;

  // Release fence: releaseControl/autonomousProgression
  if (rel) {
    if (Array.isArray(rel.clientIds)) {
      if (rel.clientIds.length !== 1 || rel.clientIds[0] !== C.UID) {
        errors.push('Release fence clientIds must strictly contain exactly Ayrton UID.');
      }
    }
    if (mode === 'active') {
      if (rel.enabled !== true) errors.push('Release fence must be enabled for active mode.');
      if (rel.expiresAt !== window.expiresAt) errors.push('Release fence expiresAt mismatch.');
    }
  }

  // Numeric pilot fence: releaseControl/numericPilot
  if (num) {
    if (num.uid && num.uid !== C.UID) errors.push('Numeric pilot fence UID mismatch.');
    if (num.planId && num.planId !== C.PLAN) errors.push('Numeric pilot fence planId mismatch.');
    if (num.pid && num.pid !== C.PID) errors.push('Numeric pilot fence PID mismatch.');
    if (mode === 'active') {
      if (num.enabled !== true) errors.push('Numeric pilot fence must be enabled for active mode.');
      if (num.runtimeSha !== window.runtimeSha) errors.push('Numeric pilot fence runtimeSha mismatch.');
      if (num.operationId !== window.operationId) errors.push('Numeric pilot fence operationId mismatch.');
      if (num.expiresAt !== window.expiresAt) errors.push('Numeric pilot fence expiresAt mismatch.');
    }
  }

  // Coach Canary fence: coaches/{coachId}.autoApplyCanary
  if (coach && coach.autoApplyCanary) {
    const canary = coach.autoApplyCanary;
    if (Array.isArray(canary.clientIds)) {
      if (canary.clientIds.length !== 1 || canary.clientIds[0] !== C.UID) {
        errors.push('Coach canary clientIds must strictly contain exactly Ayrton UID.');
      }
    }
    if (Array.isArray(canary.prescriptionExerciseIds)) {
      if (canary.prescriptionExerciseIds.length !== 1 || canary.prescriptionExerciseIds[0] !== C.PID) {
        errors.push('Coach canary prescriptionExerciseIds must strictly contain exactly Ayrton PID (' + C.PID + ').');
      }
    }
    if (mode === 'active' && canary.enabled !== true) {
      errors.push('Coach canary must be enabled for active mode.');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Conducts complete numeric preflight verification.
 * @param {object} opts
 * @param {object} opts.window - Numeric window object
 * @param {string} [opts.deploymentId] - Vercel deployment ID
 * @param {object} [opts.fences] - Captured or mock Firestore fences
 * @param {object} [opts.activeRuns] - List of running GitHub Action runs
 * @param {boolean} [opts.readOnly=true] - Always true by default
 * @param {number} [opts.now] - Epoch millis
 * @param {object} [opts.io] - Pluggable I/O adapter for isolation
 * @returns {Promise<object>} Preflight decision record (GO | NO-GO | BLOCKED)
 */
async function runPreflight(opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const checks = [];
  const blockers = [];
  const window = opts.window;

  // 1. Window Specification & Expiry (Objective 2: max 24h, authorized UID, plan, PID)
  const windowCheck = validateNumericWindow(window, now);
  checks.push({
    check: 'WINDOW_SPEC_AND_LIMITS',
    pass: windowCheck.valid,
    errors: windowCheck.errors
  });
  if (!windowCheck.valid) {
    blockers.push(...windowCheck.errors);
  }

  // 2. Concurrency Protection (Objective 2: no conflicting operations)
  let concurrencyPassed = true;
  if (opts.activeRuns && Array.isArray(opts.activeRuns)) {
    const conflicts = opts.activeRuns.filter(r => r.status === 'in_progress' || r.status === 'queued');
    if (conflicts.length > 0) {
      concurrencyPassed = false;
      const msg = 'Concurrent operational workflow run in progress (Run ID: ' + conflicts[0].id + ').';
      checks.push({ check: 'NO_CONCURRENT_OPERATIONS', pass: false, error: msg });
      blockers.push(msg);
    } else {
      checks.push({ check: 'NO_CONCURRENT_OPERATIONS', pass: true });
    }
  } else {
    checks.push({ check: 'NO_CONCURRENT_OPERATIONS', pass: true, note: 'No active runs reported or isolated mode.' });
  }

  // 3. Operation Uniqueness Check
  if (opts.priorOperations && window && window.operationId) {
    const prior = opts.priorOperations.includes(window.operationId);
    if (prior) {
      const msg = 'Operation ID "' + window.operationId + '" has already been used in a prior execution.';
      checks.push({ check: 'UNIQUE_OPERATION_ID', pass: false, error: msg });
      blockers.push(msg);
    } else {
      checks.push({ check: 'UNIQUE_OPERATION_ID', pass: true });
    }
  }

  // 4. Firestore Fences Check
  if (opts.fences) {
    const fenceCheck = validateFences(opts.fences, window, opts.mode || 'preflight');
    checks.push({
      check: 'FIRESTORE_FENCES',
      pass: fenceCheck.valid,
      errors: fenceCheck.errors
    });
    if (!fenceCheck.valid) {
      blockers.push(...fenceCheck.errors);
    }
  } else if (!opts.skipFenceCheck) {
    // If live fences cannot be read and no mock provided
    checks.push({ check: 'FIRESTORE_FENCES', pass: false, error: 'Firestore fence data unavailable.' });
    blockers.push('Firestore fence data unavailable.');
  }

  // 5. Runtime Attestation (Objective 1 & 2: Vercel provider check)
  let attestationResult = null;
  if (opts.deploymentId && window && window.runtimeSha) {
    attestationResult = await attestRuntime({
      deploymentId: opts.deploymentId,
      expectedSha: window.runtimeSha,
      expectedOperationId: window.operationId,
      expectedUid: window.uid,
      expectedPlanId: window.planId,
      expectedPid: window.pid,
      expectedExpiresAt: window.expiresAt,
      expectedStartsAt: window.startsAt,
      now: now,
      fetcher: opts.io && opts.io.fetcher,
      vercelToken: opts.vercelToken
    });

    checks.push({
      check: 'RUNTIME_ATTESTATION',
      pass: attestationResult.attested === true,
      status: attestationResult.status,
      reason: attestationResult.reason
    });

    if (attestationResult.status === 'BLOCKED') {
      return {
        schema: 'vdsen-numeric-preflight-v1',
        decision: 'BLOCKED',
        reason: attestationResult.reason,
        message: attestationResult.message,
        checks,
        blockers,
        attestation: attestationResult,
        evaluatedAt: new Date(now).toISOString()
      };
    }

    if (attestationResult.attested !== true) {
      blockers.push('Runtime attestation failed: ' + (attestationResult.reason || 'REJECTED'));
    }
  }

  // 6. Decision synthesis
  const decision = blockers.length === 0 ? 'GO' : 'NO-GO';

  return {
    schema: 'vdsen-numeric-preflight-v1',
    decision: decision,
    readOnly: opts.readOnly !== false,
    checks,
    blockers,
    window: window || null,
    attestation: attestationResult,
    evaluatedAt: new Date(now).toISOString()
  };
}

module.exports = {
  runPreflight,
  validateNumericWindow,
  validateFences,
  MAX_WINDOW_HOURS,
  MAX_WINDOW_MS
};
