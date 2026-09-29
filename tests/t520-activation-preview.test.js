// T520: quick-scan activation preview classes (Coach), with the precise blocker codes kept underneath.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const consumer = require(path.join(root, 'assets/progression-application-consumer.js'));
const R = require(path.join(root, 'scripts/replay-application-readiness.cjs'));
const coach = fs.readFileSync(path.join(root, 'vdsen-coach.html'), 'utf8');
const B = consumer.BLOCKERS;

test('T520.1 every blocker (except the activation flag) belongs to exactly one preview class', () => {
  const flat = [].concat(...Object.values(consumer.PREVIEW_CLASSES));
  assert.equal(flat.length, new Set(flat).size, 'no blocker in two classes');
  for (const c of Object.values(B).filter(c => c !== 'NUMERIC_APPLY_DISABLED')) assert.ok(flat.includes(c), c);
  assert.deepEqual(Object.keys(consumer.PREVIEW_CLASSES), ['BLOCKED_SAFETY', 'BLOCKED_CONTEXT', 'BLOCKED_EVIDENCE', 'BLOCKED_SCIENCE_POLICY', 'BLOCKED_EQUIPMENT_DATA']);
});

test('T520.2 replay scenarios classify as expected; precise blockers remain available', () => {
  const by = Object.fromEntries(R.replay().rows.map(r => [r.name, r]));
  const cls = (n) => by[n].previewClass;
  assert.equal(cls('A-load ready (synthetic shared step)'), 'READY_BUT_DISABLED');
  assert.equal(cls('C rest ready (independent of equipment)'), 'READY_BUT_DISABLED');
  for (const n of ['A-load, equipment increment not configured', 'A-load, equipment identity unresolved (generic label)', 'A-load, increment unit mismatch', 'A-load, grid step swallows the move', 'A-load, above equipment maximum'])
    assert.equal(cls(n), 'BLOCKED_EQUIPMENT_DATA', n);
  for (const n of ['D/E branch unresolved (science)', 'D branch unresolved (science)']) assert.equal(cls(n), 'BLOCKED_SCIENCE_POLICY', n);
  for (const n of ['single exposure only', 'direction unconfirmed by prior exposure', 'direction conflicting across exposures']) assert.equal(cls(n), 'BLOCKED_EVIDENCE', n);
  assert.equal(cls('safety conflict'), 'BLOCKED_SAFETY');
  for (const n of ['Coach override after evidence', 'target exposure already started']) assert.equal(cls(n), 'BLOCKED_CONTEXT', n);
  assert.ok(by['single exposure only'].blockers.includes('EVIDENCE_COUNT_INSUFFICIENT'));
});

test('T520.3 priority when several classes apply: SAFETY > CONTEXT > EVIDENCE > SCIENCE > EQUIPMENT', () => {
  const both = consumer.planApplication({ record: { key: 'x' }, context: {} });
  assert.equal(both.readiness.preview.primary, 'BLOCKED_CONTEXT');
  assert.deepEqual(Object.keys(consumer.PREVIEW_CLASSES).slice(0, 2), ['BLOCKED_SAFETY', 'BLOCKED_CONTEXT']);
});

test('T520.4 the Coach audit shows the class badge next to the dry-run line; nothing is written', () => {
  const line = coach.slice(coach.indexOf('function _dryRunLine'), coach.indexOf('function _renderShadowAutoFeed'));
  for (const c of Object.keys(consumer.PREVIEW_CLASSES).concat(['READY_BUT_DISABLED', 'EXECUTABLE'])) assert.ok(line.includes(c), c);
  assert.ok(line.includes('pvBadge') && !/updateDoc|setDoc|addDoc/.test(line));
});

test('T520.5 the flag off never yields EXECUTABLE', () => {
  for (const r of R.replay().rows) assert.notEqual(r.previewClass, 'EXECUTABLE');
});
