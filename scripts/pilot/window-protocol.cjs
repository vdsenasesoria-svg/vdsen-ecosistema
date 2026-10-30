'use strict';
// Pure gates and a non-secret transition plan. No credentials, network or production mutations.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const G = require('../release/numeric-guard.cjs');
const C = require('./ayrton-canary.cjs');
const UID_HASH = 'fb6c056b17d798c07d06878a857c359aa70828ea44debb1bcab5eb644701fe12';
const PROJECT = 'prj_ZHTPi2U4f8cgpL9YpAi86bVX3FRN', TEAM = 'team_VZc5H7Q1DBIJ3g0mwrSBz1o8';
const LEGACY_ARMED_DEPLOYMENT = 'dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const exactUid = uid => { C.validateUid(uid); assert.equal(hash(uid), UID_HASH, 'ONLY_AYRTON'); return uid; };
const sameUid = (x, uid) => x && Array.isArray(x.clientIds) && x.clientIds.length === 1 && x.clientIds[0] === uid;
function windowSpec(w, now = Date.now(), allowExpired = false) {
  assert.equal(w.schema, 'vdsen-ayrton-window-v1'); exactUid(w.uid);
  assert.match(w.runtimeSha || '', /^[a-f0-9]{40}$/); assert.match(w.deployment || '', /^dpl_[A-Za-z0-9]+$/);
  assert.match(w.operationId || '', /^[a-zA-Z0-9-]{8,80}$/);
  for (const key of ['coachId', 'planId']) assert.match(w[key] || '', /^[a-zA-Z0-9_-]{1,128}$/);
  assert.match(w.expiresAt || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const exp = Date.parse(w.expiresAt); assert.ok(Number.isFinite(exp), 'EXPIRY_INVALID');
  assert.ok(exp - now <= 168 * 3600e3 && (allowExpired || exp > now), 'EXPIRY_INVALID');
  return w;
}
function stateGate(w, s, mode, now = Date.now()) {
  windowSpec(w, now, mode === 'stop');
  assert.equal(s.uid, w.uid); if (mode !== 'stop') assert.equal(s.client.activePlanId, w.planId, 'PLAN_CHANGED');
  assert.equal(s.coachId, w.coachId, 'COACH_CHANGED');
  for (const fence of [s.release, s.coach.autoApplyCanary]) {
    if (fence) assert.ok(sameUid(fence, w.uid), 'FOREIGN_OR_MALFORMED_SCOPE');
  }
  if (mode === 'enable' && s.release && s.release.enabled === true && Date.parse(s.release.expiresAt) > now) {
    assert.equal(s.release.expiresAt, w.expiresAt, 'ACTIVE_WINDOW_NO_RENEWAL');
  }
  return true;
}
function effectiveGate(w, deployment, probe, now = Date.now()) {
  windowSpec(w, now);
  assert.equal(deployment.id, w.deployment, 'DEPLOYMENT_CHANGED');
  assert.equal(deployment.projectId, PROJECT); assert.equal(deployment.teamId, TEAM);
  assert.equal(deployment.sha, w.runtimeSha, 'RUNTIME_CHANGED');
  assert.equal(deployment.state, 'READY'); assert.equal(deployment.target, 'production');
  assert.equal(probe.schema, 'vdsen-progression-runtime-v1');
  assert.equal(probe.processingEnabled, true, 'EFFECTIVE_GLOBAL_OFF');
  assert.equal(probe.numericApplyEnabled, true, 'EFFECTIVE_NUMERIC_OFF');
  assert.equal(probe.cronConfigured, false, 'CRON_NOT_ALLOWED');
  assert.deepEqual(probe.pilotWindow, { uidHash: UID_HASH, planHash: hash(w.planId), expiresAt: w.expiresAt, operationId: w.operationId }, 'IMMUTABLE_RUNTIME_WINDOW_MISMATCH');
  return true;
}
// Metadata is deliberately projected before creating a plan. Never copy old flag values.
function offTransition(envs) {
  assert.ok(Array.isArray(envs), 'ENV_LIST_INCOMPLETE');
  const actions = [];
  for (const e of envs.filter(e => G.isProgressionName(e.key))) {
    assert.ok(Array.isArray(e.target) && e.target.length, 'ENV_SCOPE_INDETERMINATE');
    if (!e.target.includes('production')) continue;
    assert.ok(G.KNOWN_FLAGS.includes(e.key), 'UNKNOWN_PROGRESSION_VARIABLE');
    assert.ok(e.type !== 'shared' && !e.gitBranch && !e.configurationId && !e.customEnvironmentIds?.length, 'LINKED_OR_SCOPED_VARIABLE');
  }
  for (const key of G.KNOWN_FLAGS) {
    const entries = envs.filter(e => e.key === key && e.target?.includes('production'));
    assert.ok(entries.length <= 1, 'AMBIGUOUS_VARIABLE');
    const e = entries[0];
    if (!e || (e.type === 'plain' && (e.visibility === undefined || e.visibility === 'config') && e.value === 'false')) continue;
    assert.ok(e.id, 'ENV_ID_MISSING');
    assert.deepEqual(e.target, ['production'], 'SHARED_TARGET_REQUIRES_SEPARATE_REVIEW');
    actions.push({ key, id: e.id, type: e.type, updatedAt: e.updatedAt ?? null,
      transition: 'REPLACE_WITH_PLAIN_FALSE', target: ['production'], newValue: 'false' });
  }
  return { status: actions.length ? 'OWNER_AUTHORIZATION_REQUIRED' : G.evaluateProductionEnv(envs).status,
    actions, retrieveOldValues: false, restoreUnknownValues: false, redeploy: false };
}
module.exports = { exactUid, windowSpec, stateGate, effectiveGate, offTransition, PROJECT, TEAM, LEGACY_ARMED_DEPLOYMENT };
