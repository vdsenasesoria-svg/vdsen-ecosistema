// T538: static guards for tenant isolation (the behavior itself is proven on the emulator by tests/t538-tenant-isolation.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const rules = read('firestore.rules'), coach = read('vdsen-coach.html');
const { functionSource } = require('./helpers/coach-materializer.js');

const blocks = () => { const out = {}; const re = /^\s{4}match \/([a-z_]+)\/\{[^}]+\} \{/gm; let m, idx = []; while ((m = re.exec(rules))) idx.push([m[1], m.index]);
  idx.forEach(([n, i], k) => { out[n] = rules.slice(i, k + 1 < idx.length ? idx[k + 1][1] : rules.length); }); return out; };
const B = blocks();

test('T538.1 no private collection is open to "any signed-in user" or to "any coach" (only the documented global/public ones)', () => {
  const scan = rules.replace(B.exercises || '', '');   // exercises: read-only global catalog (writes are owner-only)
  const lines = scan.split('\n').filter(l => /allow /.test(l) && !/^\s*\/\//.test(l));
  for (const l of lines) assert.ok(!/if request\.auth != null;/.test(l), 'open to every signed-in user: ' + l.trim());
  assert.ok(/allow read: if request\.auth != null;/.test(B.exercises) && !/allow (write|create|update|delete)[^\n]*request\.auth != null;/.test(B.exercises));
  // allowed global collections: exercises (read), plans (own filter), diag_pings, fichas_publicas (public create), phone_index (public read)
  for (const name of ['logs', 'fichas_onboarding', 'fichas_renovacion', 'compendio', 'templates', 'plans_backup', 'fichas_publicas']) assert.ok(B[name], name);
  assert.ok(!B.sessions, 'sessions is closed (default deny)');
});

test('T538.2 logs / forms / phone index are gated by tenant ownership, not by coach existence', () => {
  for (const n of ['logs']) for (const l of B[n].split('\n').filter(x => /allow /.test(x))) assert.ok(/isSelfOrOwnerCoach|ownsClient|request\.auth\.uid == userId/.test(l), l.trim());
  for (const n of ['fichas_onboarding', 'fichas_renovacion']) assert.ok(/isSelfOrOwnerCoach\(docId\)/.test(B[n]));
  assert.ok(/ownsClient\(request\.resource\.data\.uid\)/.test(B.phone_index) && /ownsClient\(resource\.data\.uid\)/.test(B.phone_index));
  assert.ok(/allow read: if request\.auth != null && \(request\.auth\.uid == clientId \|\| resource\.data\.get\('coachId', ''\) == request\.auth\.uid\);/.test(B.clients));
  assert.ok(/!exists\(\/databases\/\$\(database\)\/documents\/clients\/\$\(coachId\)\)/.test(B.coaches), 'an athlete account cannot create a coach document');
});

test('T538.3 the Coach app only issues tenant-scoped queries on tenant-scoped collections (rules would reject an unscoped list)', () => {
  const unscoped = coach.match(/(getDocs|onSnapshot)\((?:query\()?collection\(db, ?['"](clients|fichas_publicas|templates|plans_backup|compendio)['"]\)[^\n]*/g) || [];
  for (const q of unscoped) assert.ok(/where\(['"]coachId['"]/.test(q), 'unscoped query: ' + q.slice(0, 120));
  assert.ok(/collection\(db,'fichas_publicas'\), where\('coachId','==',currentCoach\.uid\)/.test(coach));
  const idx = JSON.parse(read('firestore.indexes.json')).indexes.find(i => i.collectionGroup === 'plans_backup');
  assert.deepEqual(idx.fields.map(f => f.fieldPath), ['coachId', 'clientId', 'backedUpAt']);
  assert.ok(/where\('coachId', '==', currentCoach\.uid\),[^\n]*\n\s*where\('clientId', '==', clientId\),\s*\n\s*orderBy\('backedUpAt', 'desc'\)/.test(coach));
});

test('T538.4 client deletion removes tenant-gated documents BEFORE the client document (ownership needs clients/{uid})', () => {
  for (const fn of ['deleteClient', 'mergeClients']) {
    const src = functionSource(coach, fn), c = src.lastIndexOf("doc(db, 'clients'");
    for (const col of ["'logs'", "'phone_index'", "'fichas_onboarding'"]) { const i = src.indexOf('deleteDoc(doc(db, ' + col); if (i >= 0) assert.ok(i < c, fn + ' ' + col); }
  }
});

test('T538.5 identity model audit is documented and states what is NOT solved (open coach registration / API gate)', () => {
  const d = read('docs/FIRESTORE_WRITE_BOUNDARY.md');
  for (const t of ['Modelo de identidad', 'registro abierto', 'onAuthStateChanged', 'isAuthorizedCoach', 'FIRESTORE_TENANT_ISOLATION', 'custom claims']) assert.ok(d.includes(t), t);
});
