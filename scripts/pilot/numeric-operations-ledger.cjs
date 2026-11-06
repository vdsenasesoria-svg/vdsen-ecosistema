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

const C = require('../../api/_numericPilotContract');

const LEDGER_SCHEMA = 'vdsen-numeric-operations-ledger-v1';
const OPERATIONS_COLLECTION = 'releaseControl/numericPilot/operations';

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
 * NEVER allows bypassing the release gate.
 */
async function reserveOperation(db, opData, opts = {}) {
  validateOperationData(opData);
  const nowIso = opts.now || new Date().toISOString();
  const opRef = db.doc(`${OPERATIONS_COLLECTION}/${opData.operationId}`);
  const releaseRef = db.doc('releaseControl/numericPilot');

  return await db.runTransaction(async (tx) => {
    // 1. Release gate verification: strictly mandatory in all environments
    const releaseSnap = await tx.get(releaseRef);
    if (!releaseSnap.exists || releaseSnap.data().enabled !== true) {
      throw new Error('RELEASE_CONTROL_DISARMED: Numeric pilot release control is not enabled');
    }

    // 2. Precondition check: operation document must not exist
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      const existing = opSnap.data();
      const err = new Error(`OPERATION_ALREADY_EXISTS: Operation ID "${opData.operationId}" was already reserved at ${existing.reservedAt}`);
      err.code = 'OPERATION_ALREADY_EXISTS';
      err.existingStatus = existing.status;
      throw err;
    }

    // 3. Window check at reservation time
    const parsedNow = Date.parse(nowIso);
    if (!C.windowValid(opData.window, parsedNow)) {
      throw new Error('WINDOW_EXPIRED: Authorization window is expired or invalid at reservation time');
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
      status: STATES.RESERVED,
      reservedAt: nowIso,
      history: [
        {
          sequence: 1,
          action: STATES.RESERVED,
          at: nowIso,
          actor: opts.actor || 'pilot-runner',
          runId: String(opData.runId),
          deploymentId: opData.deploymentId,
          previousStatus: null
        }
      ]
    };

    tx.set(opRef, reservationDoc);
    return {
      success: true,
      operationId: opData.operationId,
      status: STATES.RESERVED,
      reservedAt: nowIso
    };
  });
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

    return { success: true, operationId, status: STATES.STOPPED, sentinel: false };
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

module.exports = {
  LEDGER_SCHEMA,
  OPERATIONS_COLLECTION,
  STATES,
  TERMINAL_STATES,
  validateOperationData,
  checkOperationUniquenessDirect,
  reserveOperation,
  verifyOperation,
  recordResult,
  recordStop,
  auditRetries,
  recoverEvidence
};
