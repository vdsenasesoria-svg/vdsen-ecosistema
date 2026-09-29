// T527: lifecycle stays unreachable + final activation-candidate audit (flag off, single writer, no APPLIED, docs current).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const shadow = require(path.join(root, 'assets/progression-auto-apply-shadow.js'));
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const policy = require(path.join(root, 'assets/progression-magnitude-policy.js'));

test('T527.1 (superseded by T529) lifecycle states exist but APPLIED is unreachable with the shipped flag', () => {
  assert.deepEqual(Object.keys(shadow.STATES).sort(), ['APPLIED', 'CONSUMED', 'OVERRIDDEN', 'PENDING', 'REJECTED', 'REVERTED', 'STALE']);
  assert.equal(shadow.lifecycleTransition({ state: 'PENDING', revision: 1, events: [] }, 'APPLIED', { expectedRevision: 1, operationKey: 'x', at: 't' }).reasonCode, 'NUMERIC_APPLY_DISABLED');
});
test('T527.2 overlays have exactly one writer (tx.set); the client never writes them', () => {
  const src = read('assets/progression-application-consumer.js');
  assert.equal((src.match(/tx\.set\(/g) || []).length, 1);
  // T533: the athlete app READS overlays (flag-gated capture) but never writes them: only the consumer module writes.
  assert.ok(!/nextExposureOverlays\s*:/.test(read('vdsen-cliente.html')));
  assert.ok(src.indexOf('if (!NUMERIC_APPLY_ENABLED) return { written: false, reason: BLOCKERS.NUMERIC_APPLY_DISABLED };') < src.indexOf("status: 'APPLIED'"), 'overlays only become APPLIED behind the flag');
});
test('T527.3 all three flags are false; guard has 19 checks; no science gaps remain', () => {
  assert.deepEqual([shadow.NUMERIC_APPLY_ENABLED, policy.NUMERIC_APPLY_ENABLED, consumer.NUMERIC_APPLY_ENABLED, require('../assets/progression-effective-prescription.js').NUMERIC_APPLY_ENABLED], [false, false, false, false]);
  assert.equal(consumer.GUARD_CHECKS.length, 19);
  assert.equal(policy.SCIENCE_GAPS.length, 0);
});
test('T527.4 real catalog + no configured increments -> zero executable LOAD candidates (activation blocked by data)', () => {
  const f = require(path.join(root, 'scripts/generate-activation-docs.cjs')).facts();
  assert.equal(f.configured, 0); assert.equal(f.readyGroups, 0);
});
test('T527.5 lifecycle audit doc lists every missing transition; generated docs are current', () => {
  const d = read('docs/APPLIED_LIFECYCLE_AUDIT.md');
  for (const t of ['APPLIED', 'CONSUMED', 'OVERRIDDEN', 'REVERTED', 'STALE', 'READY_BEHIND_DISABLED_FLAG']) assert.ok(d.includes(t), t);
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/generate-activation-docs.cjs'), '--check']).status, 0);
});
