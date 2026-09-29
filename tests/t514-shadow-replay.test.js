// T514: deterministic shadow replay report over synthetic fixtures: why candidates would / would not apply.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const R = require(path.join(root, 'scripts/replay-application-readiness.cjs'));

test('T514.1 the replay is deterministic', () => {
  assert.equal(JSON.stringify(R.replay()), JSON.stringify(R.replay()));
});

test('T514.2 summary counts and reason breakdown are explicit', () => {
  const s = R.replay().summary;
  assert.deepEqual([s.candidates, s.readyButDisabled, s.blocked, s.executable], [15, 2, 13, 0]);
  assert.equal(s.equipmentBlocked, 5); assert.equal(s.scienceBlocked, 2);
  assert.ok(!('NOT_ELIGIBLE' in s.blockersByReason), 'no generic NOT_ELIGIBLE hides a precise fact');
  assert.ok(!('NUMERIC_APPLY_DISABLED' in s.blockersByReason), 'the flag is reported as READY_BUT_DISABLED, not as a blocker');
  assert.ok(Object.values(s.blockersByReason).every(n => n >= 1));
});

test('T514.3 each scenario reports its precise blocker; Rule A/C candidates are not science-blocked', () => {
  const by = Object.fromEntries(R.replay().rows.map(r => [r.name, r]));
  const only = (n, code) => assert.deepEqual(by[n].blockers, [].concat(code), n);
  only('A-load, equipment increment not configured', 'UNRESOLVED_EQUIPMENT_INCREMENT');
  only('A-load, equipment identity unresolved (generic label)', 'EQUIPMENT_IDENTITY_UNRESOLVED');
  only('A-load, increment unit mismatch', 'UNIT_MISMATCH');
  only('A-load, grid step swallows the move', 'DIRECTION_NOT_REALIZABLE');
  only('A-load, above equipment maximum', 'EQUIPMENT_OUT_OF_RANGE');
  only('single exposure only', 'EVIDENCE_COUNT_INSUFFICIENT');
  only('direction unconfirmed by prior exposure', 'DIRECTION_UNCONFIRMED');
  only('direction conflicting across exposures', 'DIRECTION_CONFLICTING');
  only('safety conflict', 'SAFETY_CONFLICT');
  only('Coach override after evidence', 'COACH_OVERRIDE');
  only('target exposure already started', 'TARGET_ALREADY_STARTED');
  assert.deepEqual(by['D/E branch unresolved (science)'].blockers, ['MAGNITUDE_BRANCH_UNRESOLVED', 'SCIENCE_POLICY_UNRESOLVED']);
  for (const n of ['A-load ready (synthetic shared step)', 'C rest ready (independent of equipment)']) { assert.equal(by[n].state, 'READY_BUT_DISABLED', n); assert.deepEqual(by[n].scienceGaps, []); }
  assert.equal(by['C rest ready (independent of equipment)'].dimension, 'REST');
});

test('T514.4 the report document is generated and current; fixtures never touch the shipped catalog', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/replay-application-readiness.cjs'), '--check']);
  assert.equal(r.status, 0, 'regenerate with: node scripts/replay-application-readiness.cjs');
  assert.deepEqual(Object.keys(require(path.join(root, 'assets/progression-equipment-resolver.js')).INCREMENT_METADATA), []);
});
