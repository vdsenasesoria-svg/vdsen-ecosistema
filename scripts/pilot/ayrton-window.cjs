'use strict';
// Owner-operated wrapper: strict absolute window, actual GET-only runtime checks, canonical atomic fence writer.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const C = require('./ayrton-canary.cjs');
const P = require('./window-protocol.cjs');
const A = require('../release/app-live.cjs');
const state = () => JSON.parse(fs.readFileSync('.release/vdsen-client.json', 'utf8'));
async function assertLegacyRetired(s, read = A.deployment) {
  try { await read(s, P.LEGACY_ARMED_DEPLOYMENT); }
  catch (error) {
    // A permission/transport error does not prove retirement. Only the authenticated scoped API's 404 does.
    if (/HTTP 404(?:\D|$)/.test(String(error && error.message))) return true;
    throw new Error('LEGACY_RETIREMENT_UNVERIFIED');
  }
  throw new Error('LEGACY_ARMED_DEPLOYMENT_STILL_EXISTS');
}
async function runtimeEvidence(w, deps = {}) {
  const s = state(); assert.equal(s.production_project, P.PROJECT); assert.equal(s.vercel_team, P.TEAM);
  await (deps.assertLegacyRetired || assertLegacyRetired)(s);
  const d = await (deps.deployment || A.deployment)(s, w.deployment);
  assert.equal(d.id || d.uid, w.deployment); assert.equal(d.projectId, P.PROJECT);
  assert.equal(d.teamId || d.ownerId, P.TEAM);
  const host = d.url; assert.match(host || '', /^[A-Za-z0-9.-]+\.vercel\.app$/);
  const token = deps.idToken || process.env.VDSEN_PILOT_ID_TOKEN;
  assert.ok(token, 'Firebase ID token required in memory; never a dispatch input or artifact');
  const response = await (deps.fetch || fetch)('https://' + host + '/api/autonomous-progression-trigger?check=runtime', {
    headers: { authorization: 'Bearer ' + token }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'RUNTIME_PROBE_FAILED');
  const probe = await response.json();
  P.effectiveGate(w, { id: d.id || d.uid, projectId: d.projectId, teamId: d.teamId || d.ownerId,
    sha: d.meta && d.meta.githubCommitSha, state: d.readyState, target: d.target }, probe);
  assert.equal(await (deps.currentApp || A.currentApp)(s), w.deployment, 'ALIAS_CHANGED');
  return { deployment: w.deployment, runtimeSha: w.runtimeSha, flags: { processingEnabled: true, numericApplyEnabled: true, cronConfigured: false }, capturedAt: new Date().toISOString() };
}
async function main(argv, deps = {}) {
  const arg = n => argv[argv.indexOf('--' + n) + 1];
  assert.ok(argv.includes('--window'), 'Explicit immutable window file required');
  const w = JSON.parse(fs.readFileSync(arg('window'), 'utf8')), mode = arg('mode');
  assert.ok(['enable', 'stop'].includes(mode)); P.windowSpec(w, Date.now(), mode === 'stop');
  assert.ok(!argv.includes('--replace') && !argv.includes('--ttl-hours'), 'No replacement or relative renewal');
  let before, after, inspected, readback;
  const evidence = { operationId: w.operationId, mode, deployment: w.deployment, runtimeSha: w.runtimeSha, expiresAt: w.expiresAt, steps: [] };
  const record = (step, facts = {}) => {
    evidence.steps.push({ step, at: new Date().toISOString(), ...facts });
    fs.writeFileSync(arg('window') + '.evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  };
  const verify = async () => { before = await (deps.runtimeEvidence || runtimeEvidence)(w); record('EFFECTIVE_RUNTIME_BEFORE', { verified: true }); };
  const readFences = async ({ request, token }) => {
    const r = await request('GET', C.RELEASE_PATH, token), c = await request('GET', 'coaches/' + w.coachId, token);
    assert.equal(r.status, 200, 'POST_COMMIT_READ_FAILED'); assert.equal(c.status, 200, 'POST_COMMIT_READ_FAILED');
    const release = C.decDoc(r.body), coach = C.decDoc(c.body);
    readback = { release: r.body.updateTime || null, coach: c.body.updateTime || null, releaseEnabled: release.enabled, coachEnabled: coach.autoApplyCanary && coach.autoApplyCanary.enabled };
    record('FENCES_AFTER', readback); return { release, coach };
  };
  let result;
  try { result = await C.main(['--uid', w.uid, '--mode', mode, '--expires-at', w.expiresAt, ...(argv.includes('--confirm') ? ['--confirm'] : [])], {
    ...deps,
    authorize: async snapshot => {
      inspected = snapshot; P.stateGate(w, snapshot, mode);
      record('FENCES_BEFORE', { versions: snapshot.barrierVersions, releaseEnabled: snapshot.release && snapshot.release.enabled, coachEnabled: snapshot.coach.autoApplyCanary && snapshot.coach.autoApplyCanary.enabled });
      if (mode === 'enable') await verify(); // Revocation must work even if the runtime probe is broken.
    },
    beforeCommit: async () => { if (mode === 'enable') { P.windowSpec(w); await verify(); } record('COMMIT_INTENT'); },
    onUncertainCommit: async context => { try { await readFences(context); } catch (_) { record('READBACK_UNVERIFIED'); } },
    afterCommit: async context => {
      const { release, coach } = await readFences(context);
      P.stateGate(w, { ...inspected, release, coach }, mode);
      assert.equal(release.enabled, mode === 'enable'); assert.equal(coach.autoApplyCanary.enabled, mode === 'enable');
      if (mode === 'enable') { assert.equal(release.expiresAt, w.expiresAt); after = await (deps.runtimeEvidence || runtimeEvidence)(w); record('EFFECTIVE_RUNTIME_AFTER', { verified: true }); }
      else assert.ok(Date.parse(release.expiresAt) <= Date.now());
    },
  }); } catch (_) { record('STOPPED_VERIFY_OR_COMMIT_UNCERTAIN'); throw new Error('WINDOW_STOPPED_REVIEW_EVIDENCE_NO_RETRY'); }
  record(result.unchanged ? 'UNCHANGED_NO_RENEWAL' : result.wrote ? 'VERIFIED' : 'SIMULATION_NO_WRITES');
  return { mode, ...result, operationId: w.operationId, deployment: w.deployment, runtimeSha: w.runtimeSha,
    verifiedBefore: !!before, verifiedAfter: !!after, barrierVersionsBefore: inspected && inspected.barrierVersions,
    readback, expiresAt: w.expiresAt };
}
module.exports = { main, runtimeEvidence, assertLegacyRetired };
if (require.main === module) main(process.argv.slice(2)).then(x => console.log(JSON.stringify(x))).catch(() => {
  console.error('WINDOW_REJECTED_OR_UNCERTAIN: inspect gates and both fences; do not retry or renew blindly.'); process.exitCode = 1;
});
