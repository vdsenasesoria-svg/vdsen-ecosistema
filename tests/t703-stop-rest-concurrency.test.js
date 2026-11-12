'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeStopRest, getFirestoreRestBaseUrl, unflattenFields } = require('../scripts/pilot/numeric-pilot-ops.cjs');
const { executeStop } = require('../scripts/pilot/numeric-stop-recovery.cjs');
const canary = require('../scripts/pilot/ayrton-canary.cjs');

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  return { stringValue: String(v) };
}

function setDeep(obj, path, val) {
  const parts = path.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!curr[parts[i]] || typeof curr[parts[i]] !== 'object') {
      curr[parts[i]] = {};
    }
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = val;
}

function getDeep(obj, path) {
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (!curr || typeof curr !== 'object') return undefined;
    curr = curr[part];
  }
  return curr;
}

/**
 * Creates an in-memory deterministic Firestore REST simulator.
 * Faithfully implements document existence, updateTime tracking,
 * and preconditions (currentDocument.exists=false, currentDocument.updateTime=...).
 */
function createRestSimulator(initialDocs = {}) {
  let clock = 1000;
  const docs = new Map();

  for (const [path, data] of Object.entries(initialDocs)) {
    const iso = new Date(clock++).toISOString();
    docs.set(path, {
      data: structuredClone(data),
      createTime: iso,
      updateTime: iso
    });
  }

  const fetcher = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const parsedUrl = new URL(url);
    // Extract relative document path from pathname
    // URL format: .../documents/{docPath}
    const docPath = parsedUrl.pathname.replace(/^.*\/documents\//, '');
    const searchParams = parsedUrl.searchParams;

    if (method === 'GET') {
      const doc = docs.get(docPath);
      if (!doc) {
        return {
          status: 404,
          text: async () => JSON.stringify({ error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } })
        };
      }
      const resp = {
        name: 'projects/demo/databases/(default)/documents/' + docPath,
        fields: Object.fromEntries(Object.entries(doc.data).map(([k, v]) => [k, enc(v)])),
        createTime: doc.createTime,
        updateTime: doc.updateTime
      };
      return {
        status: 200,
        text: async () => JSON.stringify(resp)
      };
    }

    if (method === 'PATCH') {
      const body = opts.body ? JSON.parse(opts.body) : {};
      const fields = body.fields ? canary.decDoc(body) : {};
      const doc = docs.get(docPath);

      // Check precondition: currentDocument.exists=false
      if (searchParams.get('currentDocument.exists') === 'false') {
        if (doc) {
          return {
            status: 409,
            text: async () => JSON.stringify({ error: { code: 409, message: 'Document already exists', status: 'ALREADY_EXISTS' } })
          };
        }
      }

      // Check precondition: currentDocument.exists=true
      if (searchParams.get('currentDocument.exists') === 'true') {
        if (!doc) {
          return {
            status: 404,
            text: async () => JSON.stringify({ error: { code: 404, message: 'Document does not exist', status: 'NOT_FOUND' } })
          };
        }
      }

      // Check precondition: currentDocument.updateTime
      const expectedUpdateTime = searchParams.get('currentDocument.updateTime');
      if (expectedUpdateTime) {
        if (!doc || doc.updateTime !== expectedUpdateTime) {
          return {
            status: 409,
            text: async () => JSON.stringify({ error: { code: 409, message: 'Precondition failed: updateTime mismatch', status: 'FAILED_PRECONDITION' } })
          };
        }
      }

      // Preconditions satisfied: apply patch
      const nowIso = new Date(clock++).toISOString();
      const existingData = doc ? structuredClone(doc.data) : {};
      const mask = searchParams.getAll('updateMask.fieldPaths');

      let nextData;
      if (mask && mask.length > 0) {
        nextData = { ...existingData };
        for (const m of mask) {
          const val = getDeep(fields, m);
          if (val !== undefined) {
            setDeep(nextData, m, val);
          }
        }
      } else {
        nextData = { ...existingData, ...fields };
      }

      docs.set(docPath, {
        data: nextData,
        createTime: doc ? doc.createTime : nowIso,
        updateTime: nowIso
      });

      const resp = {
        name: 'projects/demo/databases/(default)/documents/' + docPath,
        fields: Object.fromEntries(Object.entries(nextData).map(([k, v]) => [k, enc(v)])),
        createTime: doc ? doc.createTime : nowIso,
        updateTime: nowIso
      };
      return {
        status: 200,
        text: async () => JSON.stringify(resp)
      };
    }

    if (method === 'POST' && url.includes(':commit')) {
      const body = opts.body ? JSON.parse(opts.body) : {};
      const writes = Array.isArray(body.writes) ? body.writes : [];
      const writeResults = [];

      for (const w of writes) {
        const targetDocPath = (w.update && w.update.name || '').replace(/^.*\/documents\//, '');
        const doc = docs.get(targetDocPath);
        const curDocPre = w.currentDocument || {};

        if (curDocPre.exists === false && doc) {
          return {
            status: 400,
            text: async () => JSON.stringify({ error: { code: 400, message: 'Document already exists', status: 'FAILED_PRECONDITION' } })
          };
        }

        if (curDocPre.updateTime) {
          if (!doc || doc.updateTime !== curDocPre.updateTime) {
            return {
              status: 400,
              text: async () => JSON.stringify({ error: { code: 400, message: 'updateTime mismatch', status: 'FAILED_PRECONDITION' } })
            };
          }
        }

        const nowIso = new Date(clock++).toISOString();
        const existingData = doc ? structuredClone(doc.data) : {};
        const fields = w.update && w.update.fields ? canary.decDoc(w.update) : {};
        const mask = w.updateMask && w.updateMask.fieldPaths ? w.updateMask.fieldPaths : [];

        let nextData;
        if (mask && mask.length > 0) {
          nextData = { ...existingData };
          for (const m of mask) {
            const val = getDeep(fields, m);
            if (val !== undefined) setDeep(nextData, m, val);
          }
        } else {
          nextData = { ...existingData, ...fields };
        }

        docs.set(targetDocPath, {
          data: nextData,
          createTime: doc ? doc.createTime : nowIso,
          updateTime: nowIso
        });

        writeResults.push({ updateTime: nowIso });
      }

      return {
        status: 200,
        text: async () => JSON.stringify({ writeResults, commitTime: new Date(clock++).toISOString() })
      };
    }

    throw new Error('Unsupported method: ' + method);
  };

  return { docs, fetcher };
}

// R1 — Creación concurrente
test('T703-R1: Creación concurrente — STOP recibe 404, pero otro actor crea RESERVED antes del PATCH sentinel', async () => {
  const initialFences = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-r1' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } }
  };
  const sim = createRestSimulator(initialFences);

  let initialGetDone = false;
  let concurrentActorRan = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/op-r1');
    const isCommit = url.includes(':commit') && opts && opts.body && opts.body.includes('op-r1');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET' && !initialGetDone) {
      initialGetDone = true;
      // Normal 404 response
      return sim.fetcher(url, opts);
    }

    if ((isCommit || (isOpDoc && method === 'PATCH')) && !concurrentActorRan) {
      concurrentActorRan = true;
      // Before STOP creates the sentinel, a concurrent actor creates the RESERVED operation document!
      const opDoc = {
        schema: 'vdsen-numeric-operations-ledger-v1',
        operationId: 'op-r1',
        status: 'RESERVED',
        uid: 'ath-1',
        planId: 'plan-1',
        pid: 'pid-1',
        history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z', actor: 'pilot-runner' }]
      };
      await sim.fetcher('https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents/releaseControl/numericPilot/operations/op-r1', {
        method: 'PATCH',
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(opDoc).map(([k, v]) => [k, enc(v)])) })
      });
      // Now the STOP attempt with currentDocument.exists=false will encounter the existing doc in sim.fetcher
    }

    return sim.fetcher(url, opts);
  };

  const rep = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r1', reason: 'SAFETY_HALT' }, interceptingFetcher);

  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.ledgerStopped, true);

  // Verify that the document was NOT replaced by a bare sentinel:
  // It must retain the reservation data (uid, planId, pid) and have 2 history events: RESERVED then STOPPED!
  const finalDoc = sim.docs.get('releaseControl/numericPilot/operations/op-r1');
  assert.ok(finalDoc, 'Operation document must exist');
  assert.equal(finalDoc.data.status, 'STOPPED');
  assert.equal(finalDoc.data.uid, 'ath-1', 'Must retain concurrent reservation uid');
  assert.equal(finalDoc.data.planId, 'plan-1', 'Must retain concurrent reservation planId');
  assert.equal(finalDoc.data.pid, 'pid-1', 'Must retain concurrent reservation pid');
  assert.equal(finalDoc.data.history.length, 2, 'History must contain both RESERVED and STOPPED in order');
  assert.equal(finalDoc.data.history[0].action, 'RESERVED');
  assert.equal(finalDoc.data.history[1].action, 'STOPPED');
});

// R2 — Finalización concurrente
test('T703-R2: Finalización concurrente — STOP lee RESERVED, pero otra transacción confirma COMPLETED antes del PATCH', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-r2' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } },
    'releaseControl/numericPilot/operations/op-r2': {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: 'op-r2',
      status: 'RESERVED',
      uid: 'ath-1',
      history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
    }
  };
  const sim = createRestSimulator(initialDocs);

  let firstGetDone = false;
  let concurrentCompleteRan = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/op-r2');
    const isCommit = url.includes(':commit') && opts && opts.body && opts.body.includes('op-r2');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET' && !firstGetDone) {
      firstGetDone = true;
      return sim.fetcher(url, opts);
    }

    if ((isCommit || (isOpDoc && method === 'PATCH')) && !concurrentCompleteRan) {
      concurrentCompleteRan = true;
      // Another transaction completes the operation concurrently, advancing updateTime
      const baseOpUrl = 'https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents/releaseControl/numericPilot/operations/op-r2';
      const completeData = {
        status: 'COMPLETED',
        completedAt: '2026-11-08T10:05:00Z',
        resultSummary: { success: true, count: 1 }
      };
      await sim.fetcher(baseOpUrl + '?updateMask.fieldPaths=status&updateMask.fieldPaths=completedAt&updateMask.fieldPaths=resultSummary', {
        method: 'PATCH',
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(completeData).map(([k, v]) => [k, enc(v)])) })
      });
    }

    return sim.fetcher(url, opts);
  };

  const rep = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r2', reason: 'SAFETY_HALT' }, interceptingFetcher);

  // Fences are disarmed
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.ledgerResult.status, 'COMPLETED', 'Must recognize and preserve COMPLETED status');
  assert.equal(rep.ledgerResult.modified, false, 'COMPLETED operation must not be modified');

  // Verify that the document retains COMPLETED and was NOT overwritten by STOPPED
  const finalDoc = sim.docs.get('releaseControl/numericPilot/operations/op-r2');
  assert.equal(finalDoc.data.status, 'COMPLETED');
  assert.equal(finalDoc.data.completedAt, '2026-11-08T10:05:00Z');
  assert.deepEqual(finalDoc.data.resultSummary, { success: true, count: 1 });
  assert.equal(finalDoc.data.history.length, 1, 'History must not have STOPPED appended after completion');
});

// R3 — Historial concurrente
test('T703-R3: Historial concurrente — después de GET, otra transacción agrega eventos al ledger; PATCH no los elimina', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-r3' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } },
    'releaseControl/numericPilot/operations/op-r3': {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: 'op-r3',
      status: 'RESERVED',
      appliedRecordKeys: [],
      history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
    }
  };
  const sim = createRestSimulator(initialDocs);

  let firstGetDone = false;
  let intermediateEventInjected = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/op-r3');
    const isCommit = url.includes(':commit') && opts && opts.body && opts.body.includes('op-r3');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET' && !firstGetDone) {
      firstGetDone = true;
      return sim.fetcher(url, opts);
    }

    if ((isCommit || (isOpDoc && method === 'PATCH')) && !intermediateEventInjected) {
      intermediateEventInjected = true;
      // Another actor appends a RECORD_APPLIED event to history before STOP commit arrives
      const baseOpUrl = 'https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents/releaseControl/numericPilot/operations/op-r3';
      const doc = sim.docs.get('releaseControl/numericPilot/operations/op-r3');
      const updatedHistory = [...doc.data.history, { sequence: 2, action: 'RECORD_APPLIED', recordKey: 'key-1', at: '2026-11-08T10:01:00Z' }];
      await sim.fetcher(baseOpUrl + '?updateMask.fieldPaths=history&updateMask.fieldPaths=appliedRecordKeys', {
        method: 'PATCH',
        body: JSON.stringify({ fields: { history: enc(updatedHistory), appliedRecordKeys: enc(['key-1']) } })
      });
    }

    return sim.fetcher(url, opts);
  };

  const rep = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r3', reason: 'HALT_MID_STREAM' }, interceptingFetcher);

  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.ledgerStopped, true);

  const finalDoc = sim.docs.get('releaseControl/numericPilot/operations/op-r3');
  assert.equal(finalDoc.data.status, 'STOPPED');
  // History must retain sequence 1 (RESERVED), sequence 2 (RECORD_APPLIED), and sequence 3 (STOPPED)!
  assert.equal(finalDoc.data.history.length, 3, 'Must retain intermediate RECORD_APPLIED event');
  assert.equal(finalDoc.data.history[0].action, 'RESERVED');
  assert.equal(finalDoc.data.history[1].action, 'RECORD_APPLIED');
  assert.equal(finalDoc.data.history[2].action, 'STOPPED');
  assert.deepEqual(finalDoc.data.appliedRecordKeys, ['key-1'], 'Must retain applied keys');
});

// R4 — Resultado ambiguo
test('T703-R4: Resultado ambiguo — la escritura se confirma en Firestore pero la respuesta se pierde por caída de red', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-r4' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } },
    'releaseControl/numericPilot/operations/op-r4': {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: 'op-r4',
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
    }
  };
  const sim = createRestSimulator(initialDocs);

  let patchDroppedOnce = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/op-r4');
    const isCommit = url.includes(':commit') && opts && opts.body && opts.body.includes('op-r4');
    const method = opts && opts.method ? opts.method : 'GET';

    if ((isCommit || (isOpDoc && method === 'PATCH')) && !patchDroppedOnce) {
      patchDroppedOnce = true;
      // Apply the PATCH to the database...
      await sim.fetcher(url, opts);
      // ...but simulate network connection drop before the client receives the HTTP 200 response!
      throw new Error('ECONNRESET: Connection lost before response payload arrived');
    }

    return sim.fetcher(url, opts);
  };

  const rep = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r4', reason: 'AMBIGUOUS_TEST' }, interceptingFetcher);

  // Client recovers via checkDurableState, confirms STOPPED, and avoids throwing false failure
  assert.equal(rep.status, 'STOP_CONFIRMED');
  assert.equal(rep.allDisarmed, true);
  assert.equal(rep.ledgerStopped, true);
  assert.equal(rep.ledgerResult.status, 'STOPPED');
  assert.equal(rep.ledgerResult.verified, true);
});

// R5 — Fallo persistente
test('T703-R5: Fallo persistente — la escritura falla y la comprobación autoritativa confirma falta de STOP', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-r5' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } },
    'releaseControl/numericPilot/operations/op-r5': {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: 'op-r5',
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
    }
  };
  const sim = createRestSimulator(initialDocs);

  const failingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/op-r5');
    const isCommit = url.includes(':commit') && opts && opts.body && opts.body.includes('op-r5');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isCommit || (isOpDoc && method === 'PATCH')) {
      // Server error on write, not committed
      return {
        status: 503,
        text: async () => JSON.stringify({ error: { code: 503, message: 'Service Unavailable', status: 'UNAVAILABLE' } })
      };
    }

    return sim.fetcher(url, opts);
  };

  const rep = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r5', reason: 'PERSISTENT_FAILURE' }, failingFetcher);

  // Fences are disarmed, but ledger write failed and durable check showed it was not stopped
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.fencesDisarmed, true);
  assert.equal(rep.ledgerStopped, false);
  assert.equal(rep.allDisarmed, false);
  assert.equal(rep.status, 'STOP_INCOMPLETE');
  assert.ok(rep.errors.some(e => e.includes('Failed to record STOP in durable ledger')));
});

// R6 — STOP repetido / concurrente
test('T703-R6: STOP repetido — dos solicitudes STOP sobre la misma operación transicionan limpiamente e idempotentemente', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-r6' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } },
    'releaseControl/numericPilot/operations/op-r6': {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: 'op-r6',
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
    }
  };
  const sim = createRestSimulator(initialDocs);

  // First STOP execution
  const rep1 = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r6', reason: 'FIRST_STOP' }, sim.fetcher);
  assert.equal(rep1.status, 'STOP_CONFIRMED');
  assert.equal(rep1.ledgerStopped, true);
  assert.equal(rep1.ledgerResult.modified, true);

  // Second STOP execution (replay / idempotent call)
  const rep2 = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-r6', reason: 'SECOND_STOP' }, sim.fetcher);
  assert.equal(rep2.status, 'STOP_CONFIRMED');
  assert.equal(rep2.ledgerStopped, true);
  assert.equal(rep2.ledgerResult.status, 'STOPPED');
  assert.equal(rep2.ledgerResult.duplicate, true);
  assert.equal(rep2.ledgerResult.modified, false);

  const finalDoc = sim.docs.get('releaseControl/numericPilot/operations/op-r6');
  assert.equal(finalDoc.data.status, 'STOPPED');
  // Only 1 STOPPED event should be appended (length = 2: RESERVED, STOPPED)
  assert.equal(finalDoc.data.history.length, 2, 'History must not duplicate STOPPED event on replay');
});

// T705-E3 — Respuesta GET sin updateTime válido
test('T705-E3: Respuesta GET existente sin updateTime nunca provoca PATCH al ledger y termina en STOP_INCOMPLETE', async () => {
  const initialDocs = {
    'releaseControl/numericPilot': { enabled: true, operationId: 'op-e3' },
    'releaseControl/autonomousProgression': { enabled: true, clientIds: ['ath-1'] },
    'coaches/coach-1': { autoApplyCanary: { enabled: true, clientIds: ['ath-1'], prescriptionExerciseIds: ['pid-1'] } },
    'releaseControl/numericPilot/operations/op-e3': {
      schema: 'vdsen-numeric-operations-ledger-v1',
      operationId: 'op-e3',
      status: 'RESERVED',
      history: [{ sequence: 1, action: 'RESERVED', at: '2026-11-08T10:00:00Z' }]
    }
  };
  const sim = createRestSimulator(initialDocs);

  let patchAttempted = false;

  const interceptingFetcher = async (url, opts) => {
    const isOpDoc = url.includes('releaseControl/numericPilot/operations/op-e3');
    const isCommit = url.includes(':commit') && opts && opts.body && opts.body.includes('op-e3');
    const method = opts && opts.method ? opts.method : 'GET';

    if (isOpDoc && method === 'GET') {
      const res = await sim.fetcher(url, opts);
      const json = JSON.parse(await res.text());
      // Explicitly delete updateTime to simulate missing updateTime from provider
      delete json.updateTime;
      return {
        status: 200,
        text: async () => JSON.stringify(json)
      };
    }

    if (isCommit || (isOpDoc && method === 'PATCH')) {
      patchAttempted = true;
    }

    return sim.fetcher(url, opts);
  };

  const rep = await executeStopRest('demo', 'token', { coachId: 'coach-1', operationId: 'op-e3', reason: 'NO_UPDATE_TIME' }, interceptingFetcher);

  // Fences must be disarmed
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.fencesDisarmed, true);
  // Ledger must NOT have been updated
  assert.equal(patchAttempted, false, 'Must NEVER attempt PATCH on the ledger when updateTime is missing');
  assert.equal(rep.ledgerStopped, false);
  assert.equal(rep.allDisarmed, false);
  assert.equal(rep.status, 'STOP_INCOMPLETE');
  assert.equal(rep.ledgerResult.error, 'MISSING_UPDATE_TIME');

  // Verify document in store remained untouched
  const finalDoc = sim.docs.get('releaseControl/numericPilot/operations/op-e3');
  assert.equal(finalDoc.data.status, 'RESERVED');
  assert.equal(finalDoc.data.history.length, 1);
});

// T705-E4 — Adaptador incompleto (executeStop sin io.recordStop)
test('T705-E4: executeStop sin io.recordStop no escribe al ledger, reporta ledgerStopped=false y STOP_INCOMPLETE', async () => {
  const store = new Map();
  let ledgerWriteAttempted = false;

  const mockIo = {
    writeFence: async (path, data, opts) => {
      if (path.includes('operations')) {
        ledgerWriteAttempted = true;
      }
      const prev = store.get(path) || {};
      store.set(path, { ...prev, ...data });
      return true;
    },
    readFence: async (path) => store.get(path)
    // recordStop is explicitly omitted!
  };

  const rep = await executeStop({
    coachId: 'coach-1',
    operationId: 'op-incomplete-adapter',
    reason: 'INCOMPLETE_ADAPTER_TEST'
  }, mockIo);

  // Fences are disarmed
  assert.equal(rep.primaryFenceDisarmed, true);
  assert.equal(rep.fencesDisarmed, true);
  // Ledger was NOT written via writeFence
  assert.equal(ledgerWriteAttempted, false, 'Must NEVER write to ledger via writeFence fallback');
  assert.equal(rep.ledgerStopped, false);
  assert.equal(rep.allDisarmed, false);
  assert.equal(rep.status, 'STOP_INCOMPLETE');
  assert.ok(rep.ledgerError.includes('ADAPTER_MISSING_RECORD_STOP'));
});
