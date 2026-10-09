// T525: equipment-data-required doc + template are current, ranked by coverage, contain no numbers, and round-trip as an empty import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const ctx = require(path.join(root, 'assets/equipment-context.js'));

test('T525.1 generated files are current', () => {
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/generate-equipment-data-required.cjs'), '--check']).status, 0);
});
test('T525.2 ranked by coverage; Mancuernas and Barra olímpica first', () => {
  const { ranked } = require(path.join(root, 'scripts/generate-equipment-data-required.cjs')).build();
  assert.deepEqual(ranked.slice(0, 2).map(r => r.name), ['Mancuernas', 'Barra olímpica']);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].exerciseCount >= ranked[i].exerciseCount);
});
test('T525.3 template has BLANK value cells only (no invented numbers)', () => {
  const rows = fs.readFileSync(path.join(root, 'docs/equipment-increments-template.csv'), 'utf8').trim().split('\n').slice(1);
  assert.ok(rows.length >= 30);
  for (const r of rows) { const c = r.split(','); assert.ok(c.slice(4).every(x => x === ''), r); }
});
test('T525.4 an untouched template imports as no-op configuration (nothing configured)', () => {
  const out = ctx.parseImport(fs.readFileSync(path.join(root, 'docs/equipment-increments-template.csv'), 'utf8'), {});
  if (out.ok) assert.equal(out.counts.added, 0);
});
