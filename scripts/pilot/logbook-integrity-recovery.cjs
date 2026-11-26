'use strict';
// T878 — Logbook Integrity Audit & DRY_RUN-Mandatory Recovery Tool.
// Classifies every client into Categories A/B/C/D/E without ever inventing training data:
//   A: Existing & visible (no recovery needed)
//   B: Existing & intact in storage but hidden by UI/query
//   C: Existing in logs/{uid} root but unlinked (missing logs/{uid}/mesos/{planId} mirror)
//   D: Overwritten/wiped with authorized backup/export source available
//   E: Overwritten/wiped (proven by immutable starts markers) with no accredited backup source
//
// Safety invariants:
// - DRY_RUN is the default and mandatory preview mode.
// - Never overwrites newer post-incident sets, never duplicates keys, strictly client-isolated,
//   deterministic SHA-256 before/after hashes, idempotent.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function stableHash(obj) {
  const norm = (v) => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm(obj))).digest('hex');
}

function extractEntryStats(doc) {
  const entries = (doc && doc.entries && typeof doc.entries === 'object') ? doc.entries : {};
  const logKeys = Object.keys(entries).filter(k => k.startsWith('log_')).sort();
  const doneKeys = Object.keys(entries).filter(k => k.startsWith('done_')).sort();
  const relevant = {};
  for (const k of [...logKeys, ...doneKeys]) relevant[k] = entries[k];
  return {
    planId: (doc && doc.planId) || null,
    logCount: logKeys.length,
    doneCount: doneKeys.length,
    logKeys,
    doneKeys,
    hash: stableHash(relevant),
    entries: relevant,
  };
}

function classifyClientLogbook({ uid, activePlanId, rootDoc, mesosById, startsDocs, backupEntries }) {
  const rootStats = extractEntryStats(rootDoc);
  const activeMesoDoc = activePlanId && mesosById ? (mesosById[activePlanId] || null) : null;
  const activeMesoStats = extractEntryStats(activeMesoDoc);
  const activeStarts = (startsDocs || []).filter(s => s && s.planId === activePlanId);
  const prevMesos = Object.entries(mesosById || {})
    .filter(([id]) => id !== activePlanId)
    .map(([id, doc]) => ({ planId: id, ...extractEntryStats(doc) }));

  // Category D or E: Active plan has immutable start markers but 0 logged entries in both root & active meso
  if (activePlanId && activeStarts.length > 0 && activeMesoStats.logCount === 0 && rootStats.logCount === 0) {
    if (backupEntries && typeof backupEntries === 'object' && Object.keys(backupEntries).length > 0) {
      const merged = Object.assign({}, backupEntries, activeMesoStats.entries);
      return {
        uid,
        activePlanId,
        category: 'D',
        reason: 'ACTIVE_MESO_WIPED_BACKUP_AVAILABLE',
        recoverable: true,
        activeStartsCount: activeStarts.length,
        before: { activeMesoLogs: activeMesoStats.logCount, rootLogs: rootStats.logCount, hash: activeMesoStats.hash },
        after: { activeMesoLogs: Object.keys(merged).filter(k => k.startsWith('log_')).length, hash: stableHash(merged) },
        prevMesosPreserved: prevMesos.reduce((a, m) => a + m.logCount, 0),
        plannedAction: { type: 'RESTORE_FROM_BACKUP', targetPath: `logs/${uid}/mesos/${activePlanId}`, entriesToAdd: Object.keys(backupEntries).sort() },
      };
    }
    return {
      uid,
      activePlanId,
      category: 'E',
      reason: 'ACTIVE_MESO_WIPED_NO_ACCREDITED_BACKUP',
      recoverable: false,
      activeStartsCount: activeStarts.length,
      missingSessionStarts: activeStarts.map(s => ({ id: s.id || null, week: s.week, dayIndex: s.dayIndex, exerciseIndex: s.exerciseIndex, setKey: s.setKey, at: s.at || null })),
      before: { activeMesoLogs: 0, rootLogs: 0, hash: activeMesoStats.hash },
      after: { activeMesoLogs: 0, hash: activeMesoStats.hash },
      prevMesosPreserved: prevMesos.reduce((a, m) => a + m.logCount, 0),
      plannedAction: null,
    };
  }

  // Category C: Root has logs for a plan whose mesos/{planId} mirror is missing or has fewer entries
  if (rootStats.logCount > 0 && rootStats.planId) {
    const targetMeso = mesosById ? mesosById[rootStats.planId] : null;
    const targetStats = extractEntryStats(targetMeso);
    const missingKeys = [...rootStats.logKeys, ...rootStats.doneKeys].filter(k => !Object.prototype.hasOwnProperty.call(targetStats.entries, k));
    if (missingKeys.length > 0) {
      const merged = Object.assign({}, targetStats.entries);
      for (const k of missingKeys) merged[k] = rootStats.entries[k];
      return {
        uid,
        activePlanId,
        category: 'C',
        reason: 'ROOT_LOGS_UNLINKED_FROM_MESO_MIRROR',
        recoverable: true,
        before: { targetPlanId: rootStats.planId, targetMesoLogs: targetStats.logCount, rootLogs: rootStats.logCount, hash: targetStats.hash },
        after: { targetPlanId: rootStats.planId, targetMesoLogs: Object.keys(merged).filter(k => k.startsWith('log_')).length, hash: stableHash(merged) },
        prevMesosPreserved: prevMesos.reduce((a, m) => a + m.logCount, 0),
        plannedAction: {
          type: 'BACKFILL_MESO_MIRROR_FROM_ROOT',
          targetPath: `logs/${uid}/mesos/${rootStats.planId}`,
          missingKeysCount: missingKeys.length,
          missingKeys,
        },
      };
    }
  }

  // Category B: Active meso has logs but root is empty/stale for the active plan
  if (activePlanId && activeMesoStats.logCount > 0 && rootStats.planId === activePlanId && rootStats.logCount < activeMesoStats.logCount) {
    const missingKeys = [...activeMesoStats.logKeys, ...activeMesoStats.doneKeys].filter(k => !Object.prototype.hasOwnProperty.call(rootStats.entries, k));
    const merged = Object.assign({}, rootStats.entries);
    for (const k of missingKeys) merged[k] = activeMesoStats.entries[k];
    return {
      uid,
      activePlanId,
      category: 'B',
      reason: 'ACTIVE_MESO_INTACT_ROOT_BEHIND',
      recoverable: true,
      before: { activeMesoLogs: activeMesoStats.logCount, rootLogs: rootStats.logCount, hash: rootStats.hash },
      after: { activeMesoLogs: activeMesoStats.logCount, rootLogs: Object.keys(merged).filter(k => k.startsWith('log_')).length, hash: stableHash(merged) },
      prevMesosPreserved: prevMesos.reduce((a, m) => a + m.logCount, 0),
      plannedAction: {
        type: 'RECONCILE_ROOT_FROM_ACTIVE_MESO',
        targetPath: `logs/${uid}`,
        missingKeysCount: missingKeys.length,
        missingKeys,
      },
    };
  }

  // Category A: Intact & visible
  return {
    uid,
    activePlanId,
    category: 'A',
    reason: 'INTACT_AND_VISIBLE',
    recoverable: false,
    before: { activeMesoLogs: activeMesoStats.logCount, rootLogs: rootStats.logCount, hash: activeMesoStats.hash },
    after: { activeMesoLogs: activeMesoStats.logCount, rootLogs: rootStats.logCount, hash: activeMesoStats.hash },
    prevMesosPreserved: prevMesos.reduce((a, m) => a + m.logCount, 0),
    plannedAction: null,
  };
}

// Idempotent, non-destructive merge helper (used by both DRY_RUN simulation and authorized APPLY).
// Never overwrites existing keys, never deletes keys, never duplicates entries.
function applyNonDestructiveMerge(existingEntries, sourceEntries) {
  const existing = (existingEntries && typeof existingEntries === 'object') ? existingEntries : {};
  const source = (sourceEntries && typeof sourceEntries === 'object') ? sourceEntries : {};
  const merged = Object.assign({}, existing);
  const addedKeys = [];
  const skippedExistingKeys = [];
  for (const k of Object.keys(source).sort()) {
    if (Object.prototype.hasOwnProperty.call(existing, k)) {
      skippedExistingKeys.push(k);
    } else {
      merged[k] = source[k];
      addedKeys.push(k);
    }
  }
  return {
    merged,
    addedKeys,
    skippedExistingKeys,
    beforeHash: stableHash(existing),
    afterHash: stableHash(merged),
    deletedCount: 0,
    overwrittenCount: 0,
    duplicatedCount: 0,
  };
}

function buildRecoveryPlan(clientSnapshots, opts = {}) {
  const mode = opts.mode || 'DRY_RUN';
  if (mode !== 'DRY_RUN') {
    throw new Error('RECOVERY_APPLY_BLOCKED: live production writes require explicit owner authorization');
  }
  const results = (clientSnapshots || []).map(snap => classifyClientLogbook(snap));
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const r of results) counts[r.category] = (counts[r.category] || 0) + 1;
  return {
    schema: 'vdsen-logbook-recovery-plan-v1',
    mode: 'DRY_RUN',
    totalInspected: results.length,
    countsByCategory: counts,
    clients: results,
    generatedAt: new Date().toISOString(),
  };
}

// T879-C: Controlled, idempotent Category C backfill (logs/{uid} -> logs/{uid}/mesos/{planId}).
// Requires an explicit DRY_RUN manifest + matching authorizationToken. Never overwrites existing
// entries, never deletes entries, never touches non-Category-C clients, and verifies post-write SHA-256.
async function executeControlledCategoryCBackfill(opts = {}) {
  const { manifest, authorizationToken, expectedAuthToken, readDoc, mergeWriteDoc, targetUid } = opts;
  if (!manifest || manifest.schema !== 'vdsen-logbook-recovery-plan-v1' || manifest.mode !== 'DRY_RUN') {
    throw new Error('RECOVERY_MANIFEST_REQUIRED');
  }
  if (!authorizationToken || !expectedAuthToken || authorizationToken !== expectedAuthToken) {
    throw new Error('RECOVERY_AUTHORIZATION_REQUIRED');
  }
  if (typeof readDoc !== 'function' || typeof mergeWriteDoc !== 'function') {
    throw new Error('RECOVERY_IO_HANDLERS_REQUIRED');
  }

  const targets = (manifest.clients || []).filter(c =>
    c && c.category === 'C' &&
    c.plannedAction && c.plannedAction.type === 'BACKFILL_MESO_MIRROR_FROM_ROOT' &&
    (!targetUid || c.uid === targetUid)
  );
  const executed = [];
  let totalAdded = 0;
  for (const item of targets) {
    const uid = item.uid;
    const planId = item.before && item.before.targetPlanId;
    if (!uid || !planId) continue;
    const rootDoc = await readDoc(`logs/${uid}`);
    const mesoPath = `logs/${uid}/mesos/${planId}`;
    const mesoDoc = await readDoc(mesoPath);
    const rootStats = extractEntryStats(rootDoc);
    const mesoStats = extractEntryStats(mesoDoc);
    if (rootStats.planId !== planId) {
      executed.push({ uid, planId, status: 'SKIPPED_PLAN_CHANGED', added: 0, deleted: 0, overwritten: 0 });
      continue;
    }
    const merged = applyNonDestructiveMerge(mesoStats.entries, rootStats.entries);
    if (merged.addedKeys.length === 0) {
      executed.push({ uid, planId, status: 'ALREADY_SYNCED_IDEMPOTENT', added: 0, deleted: 0, overwritten: 0, hash: merged.afterHash });
      continue;
    }
    const entriesPatch = {};
    for (const k of merged.addedKeys) entriesPatch[k] = merged.merged[k];
    await mergeWriteDoc(mesoPath, {
      planId,
      currentWeek: (mesoDoc && mesoDoc.currentWeek) || (rootDoc && rootDoc.currentWeek) || 1,
      entries: entriesPatch,
      updatedAt: (rootDoc && rootDoc.updatedAt) || Date.now(),
    }, merged.addedKeys);

    const postMeso = await readDoc(mesoPath);
    const postStats = extractEntryStats(postMeso);
    if (postStats.hash !== merged.afterHash) {
      throw new Error('RECOVERY_POST_VERIFY_HASH_MISMATCH:' + uid + ':' + planId);
    }
    totalAdded += merged.addedKeys.length;
    executed.push({
      uid,
      planId,
      status: 'BACKFILLED_VERIFIED',
      added: merged.addedKeys.length,
      deleted: 0,
      overwritten: 0,
      duplicated: 0,
      beforeHash: merged.beforeHash,
      afterHash: postStats.hash,
    });
  }
  return {
    schema: 'vdsen-logbook-recovery-apply-v1',
    mode: 'CONTROLLED_APPLY',
    clientsProcessed: executed.length,
    totalEntriesBackfilled: totalAdded,
    deletedCount: 0,
    overwrittenCount: 0,
    duplicatedCount: 0,
    results: executed,
    completedAt: new Date().toISOString(),
  };
}

module.exports = {
  stableHash,
  extractEntryStats,
  classifyClientLogbook,
  applyNonDestructiveMerge,
  buildRecoveryPlan,
  executeControlledCategoryCBackfill,
};
