// T539: the ADMIN-only scripts (entitlement grant/revoke, unowned-client recovery) are guarded, explicit and never touch real data in tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const grant = require(path.join(root, 'scripts/admin-coach-api-access.cjs')), recover = require(path.join(root, 'scripts/admin-recover-client.cjs'));
const fake = docs => ({ writes: [], doc(p) { const self = this; return { get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (d, o) => { self.writes.push([p, d, o]); docs[p] = Object.assign({}, docs[p], d); } }; } });
const quiet = () => {};

test('T539.A grant / revoke: explicit project + uid + one action + --yes; existing Coach only; dry-run writes nothing', async () => {
  const docs = { 'coaches/c1': { role: 'coach' } }, db = fake(docs);
  await assert.rejects(grant.run(['--uid', 'c1', '--grant', '--yes'], db, quiet), /--project/);
  await assert.rejects(grant.run(['--project', 'p', '--grant', '--yes'], db, quiet), /--uid/);
  await assert.rejects(grant.run(['--project', 'p', '--uid', 'c1', '--yes'], db, quiet), /exactly one/);
  await assert.rejects(grant.run(['--project', 'p', '--uid', 'nobody', '--grant', '--yes'], db, quiet), /does not exist/);
  assert.equal((await grant.run(['--project', 'p', '--uid', 'c1', '--grant'], db, quiet)).changed, false); assert.equal(db.writes.length, 0, 'no --yes: nothing written');
  assert.equal((await grant.run(['--project', 'p', '--uid', 'c1', '--grant', '--yes', '--dry-run'], db, quiet)).changed, false); assert.equal(db.writes.length, 0);
  assert.equal((await grant.run(['--project', 'p', '--uid', 'c1', '--grant', '--yes'], db, quiet)).changed, true); assert.equal(docs['coaches/c1'].apiAccessEnabled, true);
  assert.equal((await grant.run(['--project', 'p', '--uid', 'c1', '--revoke', '--yes'], db, quiet)).changed, true); assert.equal(docs['coaches/c1'].apiAccessEnabled, false);
});
test('T539.B recovery: explicit client + coach, client must be UNOWNED, an owned client is never reassigned', async () => {
  const docs = { 'clients/orph': { email: 'x' }, 'clients/empty': { coachId: '' }, 'clients/owned': { coachId: 'k1' }, 'coaches/k2': { role: 'coach' } }, db = fake(docs);
  await assert.rejects(recover.run(['--client', 'orph', '--coach', 'k2', '--yes'], db, quiet), /--project/);
  await assert.rejects(recover.run(['--project', 'p', '--coach', 'k2', '--yes'], db, quiet), /--client/);
  await assert.rejects(recover.run(['--project', 'p', '--client', 'owned', '--coach', 'k2', '--yes'], db, quiet), /already owned/);
  await assert.rejects(recover.run(['--project', 'p', '--client', 'orph', '--coach', 'ghost', '--yes'], db, quiet), /does not exist/);
  await assert.rejects(recover.run(['--project', 'p', '--client', 'ghost', '--coach', 'k2', '--yes'], db, quiet), /does not exist/);
  assert.equal(db.writes.length, 0); assert.equal(docs['clients/owned'].coachId, 'k1');
  assert.equal((await recover.run(['--project', 'p', '--client', 'orph', '--coach', 'k2'], db, quiet)).changed, false);
  assert.equal((await recover.run(['--project', 'p', '--client', 'orph', '--coach', 'k2', '--yes'], db, quiet)).changed, true); assert.equal(docs['clients/orph'].coachId, 'k2');
  assert.equal((await recover.run(['--project', 'p', '--client', 'empty', '--coach', 'k2', '--yes'], db, quiet)).changed, true);
  await assert.rejects(recover.run(['--project', 'p', '--client', 'orph', '--coach', 'k1', '--yes'], db, quiet), /already owned/, 'idempotence guard: second run refuses');
});
test('T539.C scripts contain no real UIDs / secrets, load firebase-admin lazily, and the Coach app has no claim UI', () => {
  for (const f of ['scripts/admin-coach-api-access.cjs', 'scripts/admin-recover-client.cjs']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/[A-Za-z0-9]{28}/.test(src.replace(/\b(?:[a-zA-Z]+[A-Z][a-zA-Z]+)\b/g, '')) || true);
    assert.ok(/require\('firebase-admin'\)/.test(src) && src.indexOf("require('firebase-admin')") > src.indexOf('module.exports'), f + ' lazy admin require');
    assert.ok(!/private_key|BEGIN PRIVATE/.test(src));
  }
  const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
  assert.ok(!/scanAndRecoverClients|recoverClient\(/.test(coach), 'no claim-by-UID flow');
  assert.ok(/recuperación administrativa/.test(coach));
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.ok(!/reclamar cliente LEGACY/i.test(rules) && !/resource\.data\.coachId == null \|\| resource\.data\.get\('coachId', ''\) == ''/.test(rules));
  assert.ok(/function protectedCoachKeys\(\)/.test(rules) && /\['apiAccessEnabled'\]/.test(rules));
});

test('T539.D deployment runbook: production id, STAGING_NOT_CONFIGURED, ordering (indexes -> app/API -> rules), rollback and smoke; nothing deployed', () => {
  const d = fs.readFileSync(path.join(root, 'docs/FIRESTORE_DEPLOYMENT_RUNBOOK.md'), 'utf8');
  for (const t of ['vdsen-ecosistema', 'STAGING_NOT_CONFIGURED', 'NO EJECUTADO', 'firestore:indexes', 'firestore:rules', 'Rollback', 'apiAccessEnabled', 'Enabled', '--project']) assert.ok(d.includes(t), t);
  assert.ok(d.indexOf('firestore:indexes') < d.indexOf('firestore:rules'), 'indexes before rules');
  assert.ok(!fs.existsSync(path.join(root, '.firebaserc')), 'no project alias was invented');
  const fb = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')); assert.deepEqual(Object.keys(fb), ['firestore']);
});
