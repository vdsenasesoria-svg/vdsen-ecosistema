'use strict';
/**
 * VDSEN — T699 Phase P0 Durable Operations Ledger
 *
 * Provides transactional, atomic reservation, direct document uniqueness lookup,
 * and strict state machine lifecycle auditing for numeric operations
 * against the authoritative path: releaseControl/numericPilot/operations/{operationId}
 *
 * Safety Guarantees:
 * - Precondition of non-existence: atomic rejection of duplicate operationId.
 * - Direct document lookup: global uniqueness does NOT rely on truncated queries.
 * - Exact identity binding: reservation fields must match window fields byte-for-byte.
 * - Formal state machine: RESERVED -> COMPLETED | FAILED | STOPPED; terminal states are immutable.
 * - Zero bypass: release gate check is always enforced (no caller-controlled bypass).
 * - Append-only tamper-evident audit history.
 *
 * NOTE: Operates strictly in isolated Firebase Emulator or accredited test project.
 * Production remains BLOCKED until formal IAM and Firestore Rules are provisioned.
 */

const crypto = require('crypto');
const C = require('../../api/_numericPilotContract');
const {
  verifyAttestationAuthenticity,
  consumeAttestation,
  isAccreditedDemoEnvironment,
  isProductionTarget,
  attestRuntime
} = require('./numeric-attestation.cjs');

const LEDGER_SCHEMA = 'vdsen-numeric-operations-ledger-v1';
const OPERATIONS_COLLECTION = 'releaseControl/numericPilot/operations';

const REQUIRED_NUMERIC_FENCE_FIELDS = Object.freeze([
  'schema',
  'mode',
  'uid',
  'planId',
  'pid',
  'runtimeSha',
  'operationId',
  'startsAt',
  'expiresAt'
]);

const STATES = Object.freeze({
  RESERVED: 'RESERVED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED'
});

const TERMINAL_STATES = new Set([STATES.COMPLETED, STATES.FAILED, STATES.STOPPED]);

/**
 * Validates operation data with strict identity binding between root fields and window fields.
 */
function validateOperationData(data) {
  if (!data || typeof data !== 'object') throw new Error('INVALID_OPERATION_DATA: Payload must be an object');
  const { operationId, uid, planId, pid, runtimeSha, deploymentId, runId, window, scope } = data;

  // 1. operationId format
  if (!operationId || typeof operationId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(operationId)) {
    throw new Error('INVALID_OPERATION_DATA: operationId must be 8-80 alphanumeric/hyphen characters');
  }

  // 2. Identity authorization
  if (!uid || typeof uid !== 'string') throw new Error('INVALID_OPERATION_DATA: uid is required');
  if (uid !== C.UID) throw new Error('UNAUTHORIZED_IDENTIFIER: UID mismatch with numeric pilot contract');
  if (!planId || typeof planId !== 'string') throw new Error('INVALID_OPERATION_DATA: planId is required');
  if (planId !== C.PLAN) throw new Error('UNAUTHORIZED_IDENTIFIER: Plan mismatch with numeric pilot contract');
  if (!pid || typeof pid !== 'string') throw new Error('INVALID_OPERATION_DATA: pid is required');
  if (pid !== C.PID) throw new Error('UNAUTHORIZED_IDENTIFIER: PID mismatch with numeric pilot contract');

  // 3. runtimeSha
  if (!runtimeSha || typeof runtimeSha !== 'string' || !/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('INVALID_OPERATION_DATA: runtimeSha must be a valid 40-character hex string');
  }

  // 4. deploymentId accreditation format
  if (!deploymentId || typeof deploymentId !== 'string' || deploymentId.trim().length === 0) {
    throw new Error('INVALID_OPERATION_DATA: deploymentId is required');
  }
  if (!/^dpl_[A-Za-z0-9_]{6,50}$/.test(deploymentId) && !/^demo-dpl-[A-Za-z0-9-]{4,40}$/.test(deploymentId)) {
    throw new Error('INVALID_OPERATION_DATA: deploymentId must be an accreditable provider deployment identifier');
  }

  // 5. runId
  if (runId === undefined || runId === null || String(runId).trim().length === 0) {
    throw new Error('INVALID_OPERATION_DATA: runId is required');
  }

  // 6. window validation
  if (!window || typeof window !== 'object') {
    throw new Error('INVALID_OPERATION_DATA: window is required');
  }
  if (window.schema !== 'vdsen-numeric-pilot-v1') {
    throw new Error('INVALID_OPERATION_DATA: window schema must be vdsen-numeric-pilot-v1');
  }
  if (window.mode !== 'NUMERIC_APPLY') {
    throw new Error('INVALID_OPERATION_DATA: window mode must be NUMERIC_APPLY');
  }
  const starts = Date.parse(window.startsAt);
  const expires = Date.parse(window.expiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(expires) || expires <= starts) {
    throw new Error('INVALID_OPERATION_DATA: window startsAt and expiresAt must be valid chronological ISO dates');
  }
  if (expires - starts > 24 * 3600000) {
    throw new Error('INVALID_OPERATION_DATA: window duration exceeds maximum 24-hour limit');
  }

  // 7. Exact identity binding: root fields must match window fields exactly
  if (operationId !== window.operationId) {
    throw new Error(`IDENTITY_MISMATCH: root operationId "${operationId}" does not match window.operationId "${window.operationId}"`);
  }
  if (uid !== window.uid) {
    throw new Error(`IDENTITY_MISMATCH: root uid "${uid}" does not match window.uid "${window.uid}"`);
  }
  if (planId !== window.planId) {
    throw new Error(`IDENTITY_MISMATCH: root planId "${planId}" does not match window.planId "${window.planId}"`);
  }
  if (pid !== window.pid) {
    throw new Error(`IDENTITY_MISMATCH: root pid "${pid}" does not match window.pid "${window.pid}"`);
  }
  if (runtimeSha !== window.runtimeSha) {
    throw new Error(`IDENTITY_MISMATCH: root runtimeSha "${runtimeSha}" does not match window.runtimeSha "${window.runtimeSha}"`);
  }

  // 8. Scope validation
  if (!scope || typeof scope !== 'object' || scope.enabled !== true) {
    throw new Error('INVALID_OPERATION_DATA: scope must be an enabled object');
  }
  if (!Array.isArray(scope.clientIds) || scope.clientIds.length !== 1 || scope.clientIds[0] !== C.UID) {
    throw new Error('INVALID_OPERATION_DATA: scope.clientIds must contain exactly the single authorized UID');
  }
  if (!Array.isArray(scope.prescriptionExerciseIds) || scope.prescriptionExerciseIds.length !== 1 || scope.prescriptionExerciseIds[0] !== C.PID) {
    throw new Error('INVALID_OPERATION_DATA: scope.prescriptionExerciseIds must contain exactly the single authorized PID');
  }

  return true;
}

/**
 * Direct lookup of an operationId document without relying on collection listings.
 * @param {object} db - Firestore database instance
 * @param {string} operationId - Operation identifier
 * @returns {Promise<{exists: boolean, status: string|null, operation: object|null}>}
 */
async function checkOperationUniquenessDirect(db, operationId) {
  if (!operationId || typeof operationId !== 'string') {
    throw new Error('operationId must be a valid string');
  }
  const snap = await db.doc(`${OPERATIONS_COLLECTION}/${operationId}`).get();
  if (!snap.exists) {
    return { exists: false, status: null, operation: null };
  }
  const data = snap.data();
  return {
    exists: true,
    status: data.status || null,
    operation: data
  };
}

/**
 * Atomically reserves an operationId in Firestore.
 * Rejects with OPERATION_ALREADY_EXISTS if operationId was previously reserved.
 * NEVER allows bypassing the release gate or forging unverified attestation.
 */
async function reserveOperation(db, opData, opts = {}) {
  validateOperationData(opData);

  // 0. Strict Temporal and Provider Boundary Check
  const hasInjectedTime = 'now' in opts || 'dynamicClock' in opts || 'clock' in opts || 'currentTime' in opts;
  if (hasInjectedTime) {
    if (!isAccreditedDemoEnvironment(db)) {
      throw new Error('CLOCK_TAMPERING_REJECTED: External clock or dynamicClock injection is strictly forbidden in production or non-demo environments');
    }
    // Reject any unauthorized temporal option keys
    if ('clock' in opts || 'currentTime' in opts) {
      throw new Error('CLOCK_TAMPERING_REJECTED: Unauthorized temporal option key rejected');
    }
  }

  if (opts.now !== undefined && opts.now !== null) {
    const parsed = Date.parse(opts.now);
    if (!Number.isFinite(parsed) || isNaN(parsed)) {
      throw new Error('INVALID_CLOCK_INJECTION: Injected now must be a valid UTC ISO string');
    }
    const normalized = new Date(parsed).toISOString();
    if (normalized !== opts.now && normalized.replace('.000Z', 'Z') !== opts.now) {
      throw new Error('INVALID_CLOCK_INJECTION: Injected now must be a valid UTC ISO string');
    }
  }

  if (opts.dynamicClock !== undefined && opts.dynamicClock !== null) {
    if (typeof opts.dynamicClock !== 'function') {
      throw new Error('INVALID_CLOCK_INJECTION: dynamicClock must be an executable function');
    }
  }

  // Pre-transaction structural and provenance verification
  if (!opts.attestation || typeof opts.attestation !== 'object') {
    throw new Error('ATTESTATION_MISSING: Runtime attestation object is mandatory for operation reservation');
  }
  const att = opts.attestation;
  if (att.attested === false || att.status === 'REJECTED' || att.status === 'BLOCKED') {
    throw new Error(`ATTESTATION_REJECTED: Attestation status is ${att.status || 'REJECTED'}`);
  }
  if (!att.operationId) {
    throw new Error('ATTESTATION_OPERATION_ID_MISSING: Attestation record lacks operationId');
  }
  if (!Array.isArray(att.checks) || att.checks.length === 0) {
    throw new Error('ATTESTATION_UNTRUSTED: Attestation lacks verified provider checks');
  }
  const initialAuthCheck = verifyAttestationAuthenticity(att);
  if (!initialAuthCheck.valid) {
    throw new Error(`${initialAuthCheck.reason}: ${initialAuthCheck.message}`);
  }
  if (att.operationId !== opData.operationId) {
    throw new Error(`ATTESTATION_MISMATCH: Attestation operationId "${att.operationId}" does not match operation operationId "${opData.operationId}"`);
  }
  if (att.deploymentId !== opData.deploymentId) {
    throw new Error(`ATTESTATION_MISMATCH: Attestation deploymentId "${att.deploymentId}" does not match operation deploymentId "${opData.deploymentId}"`);
  }
  const attSha = att.runtimeSha || att.sha;
  if (!attSha || attSha !== opData.runtimeSha) {
    throw new Error(`ATTESTATION_MISMATCH: Attestation runtimeSha "${attSha}" does not match operation runtimeSha "${opData.runtimeSha}"`);
  }
  if (att.pilotUid && att.pilotUid !== opData.uid) {
    throw new Error(`ATTESTATION_MISMATCH: Attestation pilotUid "${att.pilotUid}" does not match operation uid "${opData.uid}"`);
  }
  if (att.planId && att.planId !== opData.planId) {
    throw new Error(`ATTESTATION_MISMATCH: Attestation planId "${att.planId}" does not match operation planId "${opData.planId}"`);
  }
  if (att.pid && att.pid !== opData.pid) {
    throw new Error(`ATTESTATION_MISMATCH: Attestation pid "${att.pid}" does not match operation pid "${opData.pid}"`);
  }

  // Production environment boundary: in live production, token and live provider verification are mandatory
  if (!isAccreditedDemoEnvironment(db)) {
    if (!process.env.VERCEL_TOKEN) {
      throw new Error('BLOCKED: Live runtime attestation from accredited provider credentials required in non-demo environment');
    }
  }

  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${opData.operationId}`);
  const releaseRef = db.doc('releaseControl/numericPilot');

  // Unique, non-manipulable attempt identity generated for this specific attempt
  const reservationAttemptId = `att_attempt_${opData.operationId}_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;

  let commitSucceeded = false;
  let reservationResult = null;

  try {
    reservationResult = await db.runTransaction(async (tx) => {
      // P0.2: Dynamically revalidate time on EACH attempt/retry inside transaction
      let attemptNowIso;
      if (opts.dynamicClock) {
        const dynamicVal = opts.dynamicClock();
        if (typeof dynamicVal !== 'string') {
          throw new Error('INVALID_CLOCK_INJECTION: dynamicClock must return an ISO string timestamp');
        }
        const parsedDynamic = Date.parse(dynamicVal);
        if (!Number.isFinite(parsedDynamic) || isNaN(parsedDynamic)) {
          throw new Error('INVALID_CLOCK_INJECTION: dynamicClock returned non-finite or invalid timestamp');
        }
        const normalizedDynamic = new Date(parsedDynamic).toISOString();
        if (normalizedDynamic !== dynamicVal && normalizedDynamic.replace('.000Z', 'Z') !== dynamicVal) {
          throw new Error('INVALID_CLOCK_INJECTION: dynamicClock must return a valid UTC ISO string');
        }
        attemptNowIso = dynamicVal;
      } else if (opts.now) {
        attemptNowIso = opts.now;
      } else {
        // Real route: reliable operational system clock
        attemptNowIso = new Date().toISOString();
      }
      const parsedNow = Date.parse(attemptNowIso);

      // Revalidate window chronometry on every retry
      if (!C.windowValid(opData.window, parsedNow)) {
        throw new Error('WINDOW_EXPIRED: Authorization window is expired or invalid at reservation time');
      }

      // Revalidate attestation age/authenticity on every retry
      const attemptAuth = verifyAttestationAuthenticity(att, parsedNow);
      if (!attemptAuth.valid) {
        throw new Error(`${attemptAuth.reason}: ${attemptAuth.message}`);
      }

      // 1. Precondition check: operation document must not exist
      const opSnap = await tx.get(opRef);
      if (opSnap.exists) {
        const existing = opSnap.data();
        const err = new Error(`OPERATION_ALREADY_EXISTS: Operation ID "${opData.operationId}" was already reserved at ${existing.reservedAt} (status: ${existing.status})`);
        err.code = 'OPERATION_ALREADY_EXISTS';
        err.existingStatus = existing.status;
        throw err;
      }

      // 2. Numeric pilot release gate verification (exact 9 mandatory fields matching contract)
      const releaseSnap = await tx.get(releaseRef);
      if (!releaseSnap.exists || releaseSnap.data().enabled !== true) {
        throw new Error('RELEASE_CONTROL_DISARMED: Numeric pilot release control is not enabled');
      }
      const numFence = releaseSnap.data() || {};
      for (const k of REQUIRED_NUMERIC_FENCE_FIELDS) {
        if (numFence[k] === undefined || numFence[k] === null || numFence[k] === '') {
          throw new Error(`FENCE_FIELD_MISSING: numericPilot fence is missing required field "${k}"`);
        }
        if (numFence[k] !== opData.window[k]) {
          throw new Error(`FENCE_MISMATCH: numericPilot fence ${k} "${numFence[k]}" does not match window "${opData.window[k]}"`);
        }
      }

      // 3. General release fence verification: releaseControl/autonomousProgression
      const autoReleaseSnap = await tx.get(db.doc('releaseControl/autonomousProgression'));
      if (!autoReleaseSnap.exists) {
        throw new Error('RELEASE_CONTROL_DISARMED: Autonomous progression general release control document does not exist');
      }
      const autoData = autoReleaseSnap.data() || {};
      if (autoData.enabled !== true) {
        throw new Error('RELEASE_CONTROL_DISARMED: Autonomous progression general release is disabled');
      }
      if (!Array.isArray(autoData.clientIds) || autoData.clientIds.length !== 1 || autoData.clientIds[0] !== opData.uid) {
        throw new Error('UNAUTHORIZED_IDENTIFIER: Autonomous progression release clientIds must contain strictly the single authorized UID');
      }
      if (!autoData.expiresAt || autoData.expiresAt !== opData.window.expiresAt) {
        throw new Error(`FENCE_MISMATCH: Autonomous progression release expiresAt "${autoData.expiresAt}" does not match window "${opData.window.expiresAt}"`);
      }
      if (Date.parse(autoData.expiresAt) <= parsedNow) {
        throw new Error('RELEASE_CONTROL_DISARMED: Autonomous progression general release has expired');
      }

      // 4. Client and Coach Canary fence verification
      const clientRef = db.doc('clients/' + opData.uid);
      const clientSnap = await tx.get(clientRef);
      if (!clientSnap.exists) {
        throw new Error(`CLIENT_NOT_FOUND: Client document "clients/${opData.uid}" does not exist`);
      }
      const clientData = clientSnap.data() || {};
      if (!clientData.activePlanId || clientData.activePlanId !== opData.planId) {
        throw new Error(`PLAN_MISMATCH: Client activePlanId "${clientData.activePlanId}" does not match operation planId "${opData.planId}"`);
      }

      const coachId = clientData.coachId;
      if (!coachId || typeof coachId !== 'string' || coachId.trim().length === 0) {
        throw new Error('COACH_NOT_AUTHORIZED: Client document does not contain an accredited coachId');
      }

      const coachRef = db.doc('coaches/' + coachId);
      const coachSnap = await tx.get(coachRef);
      if (!coachSnap.exists) {
        throw new Error(`COACH_NOT_FOUND: Coach document "coaches/${coachId}" does not exist`);
      }
      const coachData = coachSnap.data() || {};
      const canary = coachData.autoApplyCanary;
      if (!canary || typeof canary !== 'object') {
        throw new Error('COACH_CANARY_NOT_FOUND: Coach document is missing autoApplyCanary');
      }
      if (canary.enabled !== true) {
        throw new Error('COACH_CANARY_DISARMED: Coach autoApplyCanary is disabled');
      }
      if (!Array.isArray(canary.clientIds) || canary.clientIds.length !== 1 || canary.clientIds[0] !== opData.uid) {
        throw new Error('COACH_CANARY_MISMATCH: Coach canary clientIds must contain exactly the single authorized UID');
      }
      if (!Array.isArray(canary.prescriptionExerciseIds) || canary.prescriptionExerciseIds.length !== 1 || canary.prescriptionExerciseIds[0] !== opData.pid) {
        throw new Error('COACH_CANARY_MISMATCH: Coach canary prescriptionExerciseIds must contain exactly the single authorized PID');
      }

      const reservationDoc = {
        schema: LEDGER_SCHEMA,
        contractVersion: opData.window.schema || 'vdsen-numeric-pilot-v1',
        operationId: opData.operationId,
        uid: opData.uid,
        planId: opData.planId,
        pid: opData.pid,
        runtimeSha: opData.runtimeSha,
        deploymentId: opData.deploymentId,
        runId: String(opData.runId),
        window: opData.window,
        scope: opData.scope,
        reservationAttemptId: reservationAttemptId,
        status: STATES.RESERVED,
        reservedAt: attemptNowIso,
        history: [
          {
            sequence: 1,
            action: STATES.RESERVED,
            at: attemptNowIso,
            actor: opts.actor || 'pilot-runner',
            runId: String(opData.runId),
            deploymentId: opData.deploymentId,
            reservationAttemptId: reservationAttemptId,
            previousStatus: null
          }
        ]
      };

      tx.set(opRef, reservationDoc);
      // NOTE: consumeAttestation is intentionally NOT called inside the transaction callback.
      // Irreversible in-memory side effects are executed only AFTER commit confirmation.

      return {
        success: true,
        operationId: opData.operationId,
        status: STATES.RESERVED,
        reservedAt: attemptNowIso,
        reservationAttemptId: reservationAttemptId
      };
    });

    commitSucceeded = true;
  } catch (err) {
    // Ambiguous commit result handling:
    const isAmbiguousNetworkError = err && (
      err.code === 14 || // UNAVAILABLE
      err.code === 4 ||  // DEADLINE_EXCEEDED
      err.code === 2 ||  // UNKNOWN
      /UNAVAILABLE|DEADLINE_EXCEEDED|network connection lost|ETIMEDOUT|ECONNRESET/i.test(err.message || '')
    );

    if (isAmbiguousNetworkError) {
      let directCheck;
      try {
        directCheck = await checkOperationUniquenessDirect(db, opData.operationId);
      } catch (readbackErr) {
        // Readback failed: commit state is truly unknown. Preserve UNKNOWN/BLOCKED.
        const unknownErr = new Error(`AMBIGUOUS_COMMIT_UNRESOLVED: Commit status is unknown due to primary network error (${err.message}) and readback failure (${readbackErr.message})`);
        unknownErr.code = 'AMBIGUOUS_COMMIT_UNRESOLVED';
        unknownErr.status = 'UNKNOWN';
        unknownErr.primaryError = err;
        unknownErr.readbackError = readbackErr;
        throw unknownErr;
      }

      if (directCheck && directCheck.exists) {
        const docData = directCheck.operation;

        // Check if the document was written by this specific attempt
        if (docData.reservationAttemptId === reservationAttemptId) {
          // Verify ALL immutable attributes:
          const isUidMatch = docData.uid === opData.uid;
          const isPlanMatch = docData.planId === opData.planId;
          const isPidMatch = docData.pid === opData.pid;
          const isShaMatch = docData.runtimeSha === opData.runtimeSha;
          const isDeploymentMatch = docData.deploymentId === opData.deploymentId;
          const isRunIdMatch = String(docData.runId) === String(opData.runId);
          const isOperationIdMatch = docData.operationId === opData.operationId;
          const isStatusReserved = docData.status === STATES.RESERVED;

          const isWindowMatch = docData.window &&
            docData.window.startsAt === opData.window.startsAt &&
            docData.window.expiresAt === opData.window.expiresAt &&
            docData.window.mode === opData.window.mode;
          const isScopeMatch = docData.scope &&
            docData.scope.enabled === opData.scope.enabled &&
            Array.isArray(docData.scope.clientIds) && docData.scope.clientIds[0] === opData.uid &&
            Array.isArray(docData.scope.prescriptionExerciseIds) && docData.scope.prescriptionExerciseIds[0] === opData.pid;

          if (isUidMatch && isPlanMatch && isPidMatch && isShaMatch && isDeploymentMatch &&
              isRunIdMatch && isOperationIdMatch && isStatusReserved && isWindowMatch && isScopeMatch) {
            // Unequivocal verified recovery of this attempt's commit!
            commitSucceeded = true;
            reservationResult = {
              success: true,
              operationId: opData.operationId,
              status: STATES.RESERVED,
              reservedAt: docData.reservedAt,
              reservationAttemptId: docData.reservationAttemptId,
              recoveredFromAmbiguity: true
            };
          } else {
            const corruptErr = new Error(`CORRUPTED_RESERVATION_STATE: Reservation document for "${opData.operationId}" matches attempt ID but contains contradictory attributes`);
            corruptErr.code = 'CORRUPTED_RESERVATION_STATE';
            corruptErr.status = 'BLOCKED';
            throw corruptErr;
          }
        } else {
          // The document exists, but was written by a different attempt / operation!
          const conflictErr = new Error(`OPERATION_ALREADY_EXISTS: Operation ID "${opData.operationId}" was already reserved by attempt "${docData.reservationAttemptId || 'unknown'}" at ${docData.reservedAt} (status: ${docData.status})`);
          conflictErr.code = 'OPERATION_ALREADY_EXISTS';
          conflictErr.existingStatus = docData.status;
          conflictErr.existingAttemptId = docData.reservationAttemptId;
          throw conflictErr;
        }
      } else {
        // Readback confirmed document does not exist: commit did not happen.
        throw err;
      }
    }

    if (!commitSucceeded) {
      // Transaction did NOT commit. Attestation remains unconsumed and valid for retry.
      throw err;
    }
  }

  // Post-commit logical consumption:
  if (commitSucceeded && reservationResult) {
    consumeAttestation(att);
    return reservationResult;
  }
}

/**
 * Reads an operation from the durable ledger.
 */
async function verifyOperation(db, operationId) {
  return await checkOperationUniquenessDirect(db, operationId);
}

/**
 * Atomically updates operation status to COMPLETED or FAILED adhering to state machine.
 */
async function recordResult(db, operationId, resultData = {}, opts = {}) {
  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${operationId}`);
  const nowIso = opts.now || new Date().toISOString();

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    if (!snap.exists) {
      throw new Error(`OPERATION_NOT_FOUND: Operation "${operationId}" does not exist in ledger`);
    }
    const data = snap.data();

    // State machine transitions:
    // Only RESERVED can transition to COMPLETED or FAILED.
    // Terminal states cannot transition to COMPLETED or FAILED.
    if (data.status === STATES.STOPPED) {
      throw new Error(`INVALID_STATE_TRANSITION: Operation "${operationId}" is STOPPED and cannot transition to COMPLETED or FAILED`);
    }
    if (data.status === STATES.COMPLETED) {
      throw new Error(`INVALID_STATE_TRANSITION: Operation "${operationId}" is already COMPLETED`);
    }
    if (data.status === STATES.FAILED) {
      throw new Error(`INVALID_STATE_TRANSITION: Operation "${operationId}" is already FAILED`);
    }
    if (data.status !== STATES.RESERVED) {
      throw new Error(`INVALID_STATE_TRANSITION: Cannot record result from status "${data.status}"`);
    }

    const nextStatus = resultData.success ? STATES.COMPLETED : STATES.FAILED;
    const history = Array.isArray(data.history) ? [...data.history] : [];
    history.push({
      sequence: history.length + 1,
      action: nextStatus,
      at: nowIso,
      actor: opts.actor || 'pilot-runner',
      summary: resultData.summary || null,
      previousStatus: data.status
    });

    // Identity fields are strictly protected: only update status, completion timestamp, summary, history
    const updatePayload = {
      status: nextStatus,
      completedAt: nowIso,
      resultSummary: resultData.summary || null,
      history: history
    };

    tx.update(opRef, updatePayload);
    return { success: true, operationId, status: nextStatus, completedAt: nowIso };
  });
}

/**
 * Atomically marks an operation as STOPPED.
 * Idempotent: can be called multiple times; remains in STOPPED state with audit trail.
 */
async function recordStop(db, operationId, stopData = {}, opts = {}) {
  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${operationId}`);
  const nowIso = opts.now || new Date().toISOString();

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(opRef);
    if (!snap.exists) {
      // Sentinel STOPPED record if operation document did not exist yet
      const stopDoc = {
        schema: LEDGER_SCHEMA,
        operationId: operationId,
        status: STATES.STOPPED,
        stoppedAt: nowIso,
        stopReason: stopData.reason || 'MANUAL_STOP',
        history: [
          {
            sequence: 1,
            action: STATES.STOPPED,
            at: nowIso,
            actor: opts.actor || 'pilot-stop',
            reason: stopData.reason || 'MANUAL_STOP',
            previousStatus: null
          }
        ]
      };
      tx.set(opRef, stopDoc);
      return { success: true, operationId, status: STATES.STOPPED, sentinel: true };
    }

    const data = snap.data();

    // 1. Terminal states preservation: COMPLETED and FAILED must retain their status and result!
    // STOP global does NOT modify retrospectively a completed or failed operation.
    if (data.status === STATES.COMPLETED) {
      return {
        success: true,
        operationId,
        status: STATES.COMPLETED,
        modified: false,
        reason: 'ALREADY_COMPLETED',
        completedAt: data.completedAt,
        resultSummary: data.resultSummary
      };
    }

    if (data.status === STATES.FAILED) {
      return {
        success: true,
        operationId,
        status: STATES.FAILED,
        modified: false,
        reason: 'ALREADY_FAILED',
        completedAt: data.completedAt
      };
    }

    // 2. STOPPED -> STOPPED idempotence without duplicating events:
    if (data.status === STATES.STOPPED) {
      return {
        success: true,
        operationId,
        status: STATES.STOPPED,
        modified: false,
        duplicate: true
      };
    }

    // 3. RESERVED -> STOPPED transition
    const history = Array.isArray(data.history) ? [...data.history] : [];
    history.push({
      sequence: history.length + 1,
      action: STATES.STOPPED,
      at: nowIso,
      actor: opts.actor || 'pilot-stop',
      reason: stopData.reason || 'MANUAL_STOP',
      previousStatus: data.status
    });

    tx.update(opRef, {
      status: STATES.STOPPED,
      stoppedAt: nowIso,
      stopReason: stopData.reason || 'MANUAL_STOP',
      history: history
    });

    return { success: true, operationId, status: STATES.STOPPED, sentinel: false, modified: true };
  });
}

/**
 * Returns audit trail of an operation.
 */
async function auditRetries(db, operationId) {
  const { exists, operation } = await verifyOperation(db, operationId);
  if (!exists || !operation) return [];
  return operation.history || [];
}

/**
 * Returns sanitized, structured evidence of an operation.
 */
async function recoverEvidence(db, operationId) {
  const { exists, operation } = await verifyOperation(db, operationId);
  if (!exists || !operation) return null;

  const { operationId: id, status, reservedAt, completedAt, stoppedAt, runtimeSha, deploymentId, runId, history, resultSummary } = operation;
  return {
    operationId: id,
    status,
    reservedAt,
    completedAt: completedAt || null,
    stoppedAt: stoppedAt || null,
    runtimeSha,
    deploymentId,
    runId,
    history: history || [],
    resultSummary: resultSummary || null
  };
}

/**
 * High-level orchestration that conducts external provider attestation first,
 * then atomically reserves the operation in Firestore without performing network calls in transaction.
 */
async function reserveVerifiedOperation(db, opData, verifierOpts = {}, ledgerOpts = {}) {
  // 1. Outside Firestore transaction: query and attest runtime with provider
  const attestation = await attestRuntime({
    deploymentId: opData.deploymentId,
    expectedSha: opData.runtimeSha,
    expectedOperationId: opData.operationId,
    expectedAlias: verifierOpts.expectedAlias,
    expectedUid: opData.uid,
    expectedPlanId: opData.planId,
    expectedPid: opData.pid,
    vercelToken: verifierOpts.vercelToken,
    fetcher: verifierOpts.fetcher,
    now: ledgerOpts.now ? (typeof ledgerOpts.now === 'number' ? ledgerOpts.now : Date.parse(ledgerOpts.now)) : undefined
  });

  if (!attestation || attestation.attested !== true || attestation.status !== 'ATTESTED') {
    const err = new Error(`ATTESTATION_VERIFICATION_FAILED: Provider verification failed (${attestation && attestation.reason})`);
    err.code = attestation && attestation.reason;
    err.attestation = attestation;
    throw err;
  }

  // 2. Inside Firestore transaction: execute reservation with the sealed attestation
  return await reserveOperation(db, opData, {
    ...ledgerOpts,
    attestation
  });
}

module.exports = {
  LEDGER_SCHEMA,
  OPERATIONS_COLLECTION,
  REQUIRED_NUMERIC_FENCE_FIELDS,
  STATES,
  TERMINAL_STATES,
  validateOperationData,
  checkOperationUniquenessDirect,
  reserveOperation,
  reserveVerifiedOperation,
  verifyOperation,
  recordResult,
  recordStop,
  auditRetries,
  recoverEvidence
};
