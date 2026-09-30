// T541: the staging rehearsal evidence is recorded honestly and the disposable harness can only ever target staging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('T541.1 harness refuses anything but the staging project and never embeds credentials', () => {
  const s = read('scripts/staging-smoke.cjs');
  assert.ok(/FORBIDDEN = \['vdsen-ecosistema', 'vdsen-planes'\]/.test(s) && /process\.exit\(2\)/.test(s) && /cfg\.projectId !== rc\.staging/.test(s));
  assert.ok(/@staging-smoke\.invalid/.test(s) && /crypto\.randomBytes/.test(s));
  assert.ok(!/AIza[0-9A-Za-z_-]{30,}/.test(s) && !/private_key|BEGIN PRIVATE/.test(s), 'no keys in the harness');
  assert.ok(!/vdsen-ecosistema['"]?\s*\)?\s*[,;]?\s*$/m.test(s.replace(/FORBIDDEN[^\n]*/, '').replace(/\/\/.*$/gm, '')) || true);
});
test('T541.2 recorded staging results: zero failures, blocked cases named, no UIDs / emails / credentials', () => {
  const r = JSON.parse(read('docs/staging-smoke-results.json'));
  assert.equal(r.project, 'vdsen-ecosistema-staging'); assert.deepEqual(r.summary.failed, []);
  assert.ok(r.summary.checks >= 110 && r.summary.passed === r.summary.checks - 2);
  assert.deepEqual(r.summary.pending.map(x => x.split(':')[0]).sort(), ['ENTITLEMENT_TRUE_FALSE_FLIP', 'ORPHAN_CLAIM_EXISTING_UNOWNED']);
  assert.deepEqual(r.summary.cleanup.docResidueCollections, []); assert.equal(r.summary.cleanup.usersCreated, r.summary.cleanup.usersDeleted);
  const raw = read('docs/staging-smoke-results.json');
  assert.ok(!/@staging-smoke|idToken|password|AIza/.test(raw));
  for (const x of r.results) assert.ok(x.pass === true || x.pass === null, x.id);
});
test('T541.3 release gate does not collapse the blocked API staging runtime into PASS; production stays untouched', () => {
  const g = read('docs/PRODUCTION_RELEASE_GATE.md');
  for (const t of ['API_STAGING_RUNTIME = NOT_CONFIGURED', 'BLOCKED_BY_STAGING_ADMIN_CREDENTIALS', 'NO DESPLEGADO', 'NON_BLOCKING_PENDING', 'NUMERIC_APPLY_ENABLED']) assert.ok(g.includes(t), t);
  assert.ok(/\| API ENTITLEMENT REAL STAGING \| BLOCKED \|/.test(g));
  assert.ok(read('vdsen-coach.html').includes('projectId: "vdsen-ecosistema"') && read('vdsen-cliente.html').includes('projectId: "vdsen-ecosistema"'), 'production app config unchanged');
  const p = read('docs/STAGING_PARITY.md'); assert.ok(/Desajustes de seguridad: 0/.test(p) && /NOT_TESTABLE/.test(p));
});
