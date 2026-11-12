// T540: environment configuration guards: distinct production / staging aliases, no ambiguous default, Auth as code (Email/Password only), staging SDK config kept apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const j = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

test('T540.1 .firebaserc has explicit, distinct production and staging aliases and no default', () => {
  const rc = j('.firebaserc');
  assert.deepEqual(Object.keys(rc.projects).sort(), ['production', 'staging']);
  assert.equal(rc.projects.production, 'vdsen-ecosistema'); assert.match(rc.projects.staging, /staging/);
  assert.notEqual(rc.projects.staging, rc.projects.production); assert.ok(!Object.values(rc.projects).includes('vdsen-planes'));
  assert.equal(rc.projects.default, undefined);
});
test('T540.2 firebase.json declares rules, indexes and Auth (Email/Password only)', () => {
  const fb = j('firebase.json');
  assert.deepEqual(fb.firestore, { rules: 'firestore.rules', indexes: 'firestore.indexes.json' });
  assert.deepEqual(fb.auth, { providers: { emailPassword: true } });
  for (const f of [fb.firestore.rules, fb.firestore.indexes]) assert.ok(fs.existsSync(path.join(root, f)), f);
});
test('T540.3 the staging SDK config is separate, points only to staging, and no app source loads it', () => {
  const c = j('config/firebase-staging.config.json'), rc = j('.firebaserc');
  assert.equal(c.projectId, rc.projects.staging); assert.match(c.authDomain, /staging/);
  for (const f of ['vdsen-coach.html', 'vdsen-cliente.html', 'ficha-publica.html', 'sw.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!s.includes(c.projectId) && !s.includes('firebase-staging'), f + ' still targets production only');
  }
  assert.ok(fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8').includes('projectId: "vdsen-ecosistema"'));
});
