'use strict';
// Numeric pilot preflight verification: determines GO, NO-GO, or BLOCKED prior to any numeric operations.
// Validates all identity fences, runtime attestation, window limits, single-operation bounds,
// and lack of concurrency conflicts or CRON triggers.
// Read-only by default. Rejects missing evidence with BLOCKED; never assumes success on absent data.

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
  if (!fences || typeof fences !== 'object') {
    return { valid: false, errors: ['Fences data object is missing or invalid.'] };
  }

  const rel = fences.releaseControl;
  const num = fences.numericPilot;
  const coach = fences.coach;

  if (!rel) errors.push('releaseControl/autonomousProgression fence is missing.');
  if (!num) errors.push('releaseControl/numericPilot fence is missing.');
  if (!coach) errors.push('coaches/{coachId} canary fence is missing.');

  if (errors.length) return { valid: false, errors };

  // Release fence: releaseControl/autonomousProgression
  if (Array.isArray(rel.clientIds)) {
    if (rel.clientIds.length !== 1 || rel.clientIds[0] !== C.UID) {
      errors.push('Release fence clientIds must strictly contain exactly Ayrton UID.');
    }
  } else {
    errors.push('Release fence clientIds must be an array.');
  }

  if (mode === 'active') {
    if (rel.enabled !== true) errors.push('Release fence must be enabled for active mode.');
    if (rel.expiresAt !== window.expiresAt) errors.push('Release fence expiresAt mismatch.');
  }

  // Numeric pilot fence: releaseControl/numericPilot
  if (num.uid && num.uid !== C.UID) errors.push('Numeric pilot fence UID mismatch.');
  if (num.planId && num.planId !== C.PLAN) errors.push('Numeric pilot fence planId mismatch.');
  if (num.pid && num.pid !== C.PID) errors.push('Numeric pilot fence PID mismatch.');

  if (mode === 'active') {
    if (num.enabled !== true) errors.push('Numeric pilot fence must be enabled for active mode.');
    if (num.runtimeSha !== window.runtimeSha) errors.push('Numeric pilot fence runtimeSha mismatch.');
    if (num.operationId !== window.operationId) errors.push('Numeric pilot fence operationId mismatch.');
    if (num.expiresAt !== window.expiresAt) errors.push('Numeric pilot fence expiresAt mismatch.');
  }

  // Coach Canary fence: coaches/{coachId}.autoApplyCanary
  if (!coach.autoApplyCanary) {
    errors.push('Coach document lacks autoApplyCanary field.');
  } else {
    const canary = coach.autoApplyCanary;
    if (Array.isArray(canary.clientIds)) {
      if (canary.clientIds.length !== 1 || canary.clientIds[0] !== C.UID) {
        errors.push('Coach canary clientIds must strictly contain exactly Ayrton UID.');
      }
    } else {
      errors.push('Coach canary clientIds must be an array.');
    }

    if (Array.isArray(canary.prescriptionExerciseIds)) {
      if (canary.prescriptionExerciseIds.length !== 1 || canary.prescriptionExerciseIds[0] !== C.PID) {
        errors.push('Coach canary prescriptionExerciseIds must strictly contain exactly Ayrton PID (' + C.PID + ').');
      }
    } else {
      errors.push('Coach canary prescriptionExerciseIds must be an array.');
    }

    if (mode === 'active' && canary.enabled !== true) {
      errors.push('Coach canary must be enabled for active mode.');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Conducts complete numeric preflight verification.
 * Requires genuine evidence for fences, concurrency, operation uniqueness, and provider attestation.
 * Returns BLOCKED if any critical evidence is missing.
 * @param {object} opts
 * @param {object} opts.window - Numeric window object
 * @param {string} opts.deploymentId - Vercel deployment ID
 * @param {object} opts.fences - Captured or mock Firestore fences
 * @param {Array} opts.activeRuns - List of running GitHub Action runs
 * @param {Array} opts.priorOperations - List of previously executed operation IDs
 * @param {boolean} [opts.readOnly=true] - Always true by default
 * @param {number} [opts.now] - Epoch millis
 * @param {object} [opts.io] - Pluggable I/O adapter for isolation
 * @returns {Promise<object>} Preflight decision record (GO | NO-GO | BLOCKED)
 */
async function runPreflight(opts) {
  opts = opts || {};
  const window = opts.window;
  if (opts.ledgerDb && opts.priorOperations === undefined) {
    if (opts.isEmulator !== true) {
      opts = {
        ...opts,
        priorOperations: [],
        priorOperationsSourceVerified: false,
        priorOperationsCoverageComplete: false
      };
    } else {
      try {
        const ledger = require('./numeric-operations-ledger.cjs');
        const targetOpId = window && window.operationId;
        if (targetOpId) {
          const directCheck = await ledger.checkOperationUniquenessDirect(opts.ledgerDb, targetOpId);
          if (directCheck.exists) {
            opts = {
              ...opts,
              priorOperations: [{ operationId: targetOpId, status: directCheck.status }],
              priorOperationsSourceVerified: true,
              priorOperationsCoverageComplete: true,
              directLookupChecked: true
            };
          } else {
            opts = {
              ...opts,
              priorOperations: [],
              priorOperationsSourceVerified: true,
              priorOperationsCoverageComplete: true,
              directLookupChecked: true
            };
          }
        }
      } catch (_) {}
    }
  }
  const now = opts.now || Date.now();
  const checks = [];
  const blockers = [];

  // 1. Window Specification & Limits
  const windowCheck = validateNumericWindow(window, now);
  checks.push({
    check: 'WINDOW_SPEC_AND_LIMITS',
    pass: windowCheck.valid,
    errors: windowCheck.errors
  });
  if (!windowCheck.valid) {
    blockers.push(...windowCheck.errors);
  }

  // 2. Concurrency Evidence Check (MANDATORY: missing evidence => BLOCKED)
  if (opts.activeRuns === undefined || opts.activeRuns === null || !Array.isArray(opts.activeRuns)) {
    return {
      schema: 'vdsen-numeric-preflight-v1',
      decision: 'BLOCKED',
      reason: 'CONCURRENCY_EVIDENCE_MISSING',
      message: 'Active runs evidence not provided; cannot verify absence of concurrent operations.',
      checks,
      evaluatedAt: new Date(now).toISOString()
    };
  }

  const activeConflicts = opts.activeRuns.filter(r => {
    if (!r) return false;
    if (opts.currentRunId && String(r.id) === String(opts.currentRunId)) {
      return false; // Current execution is not a conflict with itself
    }
    return r.status === 'in_progress' || r.status === 'queued';
  });
  const concurrencyPassed = activeConflicts.length === 0;
  checks.push({
    check: 'NO_CONCURRENT_OPERATIONS',
    pass: concurrencyPassed,
    currentRunId: opts.currentRunId || null,
    conflicts: activeConflicts.map(r => r.id)
  });
  if (!concurrencyPassed) {
    blockers.push('Concurrent operational workflow run in progress (Run ID: ' + activeConflicts[0].id + ').');
  }

  // 3. Operation Uniqueness History Check (MANDATORY: missing evidence => BLOCKED)
  if (opts.priorOperations === undefined || opts.priorOperations === null || !Array.isArray(opts.priorOperations)) {
    return {
      schema: 'vdsen-numeric-preflight-v1',
      decision: 'BLOCKED',
      reason: 'PRIOR_OPERATIONS_EVIDENCE_MISSING',
      message: 'Prior operations history not provided; cannot verify operationId uniqueness.',
      checks,
      evaluatedAt: new Date(now).toISOString()
    };
  }

  // Source must be verified and accredited; unverified source cannot authorize operation
  if (!opts.priorOperationsSourceVerified) {
    return {
      schema: 'vdsen-numeric-preflight-v1',
      decision: 'BLOCKED',
      reason: 'OPERATION_HISTORY_UNVERIFIED_SOURCE',
      message: 'Prior operations history source is not verified or lacks accredited durable records. Neither GitHub Actions /runs nor an arbitrary JSON claiming verifiedCoverage attests operationId uniqueness. Authoritative durable ledger required.',
      checks,
      evaluatedAt: new Date(now).toISOString()
    };
  }

  // Coverage must be complete (no unpaginated runs, retries, or incomplete history)
  if (opts.priorOperationsCoverageComplete === false || opts.hasMorePriorOperations === true) {
    return {
      schema: 'vdsen-numeric-preflight-v1',
      decision: 'BLOCKED',
      reason: 'OPERATION_HISTORY_INCOMPLETE_COVERAGE',
      message: 'Prior operations history lacks verified complete coverage (unpaginated runs or missing coverage proof).',
      checks,
      evaluatedAt: new Date(now).toISOString()
    };
  }

  if (window && window.operationId) {
    const matchingPrior = opts.priorOperations.find(p => {
      if (!p) return false;
      const opId = typeof p === 'string' ? p : p.operationId;
      return opId === window.operationId;
    });

    const alreadyRun = !!matchingPrior;
    checks.push({
      check: 'UNIQUE_OPERATION_ID',
      pass: !alreadyRun,
      operationId: window.operationId,
      priorRecord: matchingPrior || null
    });
    if (alreadyRun) {
      const runDetail = typeof matchingPrior === 'object'
        ? ' (Run: ' + (matchingPrior.runId || 'N/A') + ', Status: ' + (matchingPrior.status || 'N/A') + ', Scope: ' + (matchingPrior.scope || 'N/A') + ')'
        : '';
      const reasonMsg = 'Operation ID "' + window.operationId + '" has already been executed' + runDetail + '.';
      blockers.push(reasonMsg);
      return {
        schema: 'vdsen-numeric-preflight-v1',
        decision: 'NO-GO',
        reason: 'OPERATION_ALREADY_EXECUTED',
        message: reasonMsg,
        checks,
        blockers,
        evaluatedAt: new Date(now).toISOString()
      };
    }
  }

  // 4. Firestore Fences Evidence Check (MANDATORY: missing fences => BLOCKED)
  if (!opts.fences || typeof opts.fences !== 'object') {
    return {
      schema: 'vdsen-numeric-preflight-v1',
      decision: 'BLOCKED',
      reason: 'FENCES_UNAVAILABLE',
      message: 'Firestore fence data unavailable; reliable fence evidence is strictly required.',
      checks,
      evaluatedAt: new Date(now).toISOString()
    };
  }

  const fenceCheck = validateFences(opts.fences, window, opts.mode || 'preflight');
  checks.push({
    check: 'FIRESTORE_FENCES',
    pass: fenceCheck.valid,
    errors: fenceCheck.errors
  });
  if (!fenceCheck.valid) {
    blockers.push(...fenceCheck.errors);
  }

  // 5. Runtime Attestation (MANDATORY: provider attestation check)
  if (!opts.deploymentId) {
    return {
      schema: 'vdsen-numeric-preflight-v1',
      decision: 'BLOCKED',
      reason: 'DEPLOYMENT_ID_MISSING',
      message: 'Deployment ID is required for preflight attestation.',
      checks,
      evaluatedAt: new Date(now).toISOString()
    };
  }

  let attestationResult = null;
  if (window && window.runtimeSha) {
    attestationResult = await attestRuntime({
      deploymentId: opts.deploymentId,
      expectedSha: window.runtimeSha,
      expectedOperationId: window.operationId,
      expectedUid: window.uid,
      expectedPlanId: window.planId,
      expectedPid: window.pid,
      expectedExpiresAt: window.expiresAt,
      expectedStartsAt: window.startsAt,
      expectedAlias: opts.expectedAlias,
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
