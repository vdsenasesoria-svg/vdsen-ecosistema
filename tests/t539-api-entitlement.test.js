// T539: the paid / generative API requires the server-managed entitlement coaches/{uid}.apiAccessEnabled === true. A coach APP account is not enough.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.join(__dirname, '..');
const { authenticateCoachRequest, ERR } = require(path.join(root, 'api/_vdsenAuth.js'));

// --- fake firebase-admin (loaded by the REAL api/_firebaseAdmin.js): a coaches collection in memory, optional read failure
async function withFakeAdmin(coaches, opts, fn) {
  const orig = Module._load;
  const admin = { apps: [{}], firestore: () => ({ collection: name => ({ doc: id => ({ get: async () => {
    if (opts.failRead) throw new Error('firestore unavailable');
    const d = name === 'coaches' ? coaches[id] : undefined; return { exists: d !== undefined, data: () => d };
  } }) }) }), auth: () => ({ verifyIdToken: async t => { if (t === 'bad') throw new Error('invalid'); return { uid: t }; } }) };
  Module._load = function(request, ...rest) { return request === 'firebase-admin' ? admin : orig.call(this, request, ...rest); };
  const saved = {}; for (const k of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) saved[k] = process.env[k];
  try { delete require.cache[require.resolve(path.join(root, 'api/_firebaseAdmin.js'))]; return await fn(require(path.join(root, 'api/_firebaseAdmin.js'))); }
  finally { Module._load = orig; for (const k in saved) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}
const deps = fb => ({ verifyIdToken: fb.verifyIdToken.bind(fb), isAuthorizedCoach: fb.isAuthorizedCoach });
const run = (coaches, uid, opts = {}) => withFakeAdmin(coaches, opts, fb => authenticateCoachRequest('Bearer ' + uid, deps(fb)));
const fb0 = { verifyIdToken: async t => ({ uid: t }) };

test('T539.1 isAuthorizedCoach is the ENTITLEMENT: document + apiAccessEnabled === true; everything else is false', async () => {
  const cases = [['no document', {}, false], ['document without the field', { u: { role: 'coach' } }, false], ['apiAccessEnabled false', { u: { apiAccessEnabled: false } }, false],
    ['string "true"', { u: { apiAccessEnabled: 'true' } }, false], ['number 1', { u: { apiAccessEnabled: 1 } }, false], ['null', { u: { apiAccessEnabled: null } }, false], ['true', { u: { apiAccessEnabled: true } }, true]];
  process.env.FIREBASE_PROJECT_ID = 'p'; process.env.FIREBASE_CLIENT_EMAIL = 'e'; process.env.FIREBASE_PRIVATE_KEY = 'k';
  for (const [why, coaches, want] of cases) assert.equal(await withFakeAdmin(coaches, {}, fb => fb.isAuthorizedCoach('u')), want, why);
});
test('T539.2 API decision matrix: no coach doc / missing entitlement / false -> 403; true -> allowed', async () => {
  process.env.FIREBASE_PROJECT_ID = 'p'; process.env.FIREBASE_CLIENT_EMAIL = 'e'; process.env.FIREBASE_PRIVATE_KEY = 'k';
  for (const coaches of [{}, { u: { role: 'coach' } }, { u: { apiAccessEnabled: false } }]) { const r = await run(coaches, 'u'); assert.deepEqual([r.ok, r.status, r.errorCode], [false, 403, ERR.AUTH_FORBIDDEN]); }
  const ok = await run({ u: { apiAccessEnabled: true } }, 'u'); assert.deepEqual([ok.ok, ok.uid], [true, 'u']);
});
test('T539.3 an athlete-created or self-promoted Coach doc still gets 403 (no entitlement without the Admin SDK)', async () => {
  process.env.FIREBASE_PROJECT_ID = 'p'; process.env.FIREBASE_CLIENT_EMAIL = 'e'; process.env.FIREBASE_PRIVATE_KEY = 'k';
  const selfPromoted = { athlete: { role: 'coach', displayName: 'x', email: 'a@x.com', createdAt: 'now' } };
  assert.equal((await run(selfPromoted, 'athlete')).status, 403);
});
test('T539.4 invalid / expired token keeps the existing 401 behavior; authorization failure fails CLOSED', async () => {
  process.env.FIREBASE_PROJECT_ID = 'p'; process.env.FIREBASE_CLIENT_EMAIL = 'e'; process.env.FIREBASE_PRIVATE_KEY = 'k';
  assert.equal((await run({ bad: { apiAccessEnabled: true } }, 'bad')).status, 401);
  const noHeader = await authenticateCoachRequest('', deps(fb0)); assert.equal(noHeader.status, 401);
  const fail = await run({ u: { apiAccessEnabled: true } }, 'u', { failRead: true });
  assert.equal(fail.ok, false); assert.equal(fail.status, 401);
  const noWiring = await authenticateCoachRequest('Bearer u', { verifyIdToken: async () => ({ uid: 'u' }) }); assert.deepEqual([noWiring.ok, noWiring.status], [false, 403]);
  for (const bad of [undefined, null, 'true', 1, {}]) { const r = await authenticateCoachRequest('Bearer u', { verifyIdToken: async () => ({ uid: 'u' }), isAuthorizedCoach: async () => bad }); assert.equal(r.ok, false); }
});
test('T539.5 REGRESSION SCAN: every route that spends the server OpenAI key authenticates through authenticateCoachRequest with the hardened helper; public routes are untouched', () => {
  const files = fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && !f.startsWith('_'));
  const paid = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, 'api', f), 'utf8');
    if (/process\.env\.OPENAI_API_KEY|process\.env\.ANTHROPIC/.test(src)) paid.push(f);
  }
  assert.deepEqual(paid, ['vdsen-generate.js'], 'the only route that spends the server key');
  const gen = fs.readFileSync(path.join(root, 'api/vdsen-generate.js'), 'utf8');
  assert.ok(/authenticateCoachRequest\(authHeader, authDeps \|\| \{\}\)/.test(gen));
  assert.ok(gen.indexOf('authenticateCoachRequest(authHeader') < gen.indexOf('process.env.OPENAI_API_KEY'), 'authentication precedes the paid call');
  assert.ok(/isAuthorizedCoach: function\(uid\) \{\s*var fbAdmin = require\('\.\/_firebaseAdmin'\);\s*return fbAdmin\.isAuthorizedCoach\(uid\);/.test(gen), 'the default wiring is the hardened helper');
  const fbAdmin = fs.readFileSync(path.join(root, 'api/_firebaseAdmin.js'), 'utf8');
  assert.ok(/apiAccessEnabled === true/.test(fbAdmin));
  // generate-plan.js forwards the CALLER's own OpenAI key (Bearer sk-...); it never reads a server key, so it spends nothing of VDSEN's
  const proxy = fs.readFileSync(path.join(root, 'api/generate-plan.js'), 'utf8');
  assert.ok(!/process\.env/.test(proxy));
  // the browser never grants the entitlement
  for (const f of ['vdsen-coach.html', 'vdsen-cliente.html', 'ficha-publica.html']) assert.ok(!/apiAccessEnabled/.test(fs.readFileSync(path.join(root, f), 'utf8')), f + ' never touches the entitlement');
});
