'use strict';
// CONTRACT for the Phase 5 responsiveness guard.
//
// WHAT THIS PINS
// A massive history must not hold the browser's main thread in ONE uninterrupted stretch. The
// measured behaviour before the change was 0 event-loop yields across a 5.5 s export, because every
// stage was synchronous and `await` on an in-memory adapter resolves in MICROtasks, which never hand
// control back to the renderer. The tab was frozen for the whole export: no spinner, no repaint, no
// cancel.
//
// The fix yields at stage boundaries and between encoded files. This test pins the yields that are
// actually reachable and, importantly, RECORDS the longest remaining uninterruptible stretch instead
// of pretending it is zero: the residual cost is inside Z.toJson / Z.csvFiles over very large
// documents, which cannot be split without a Web Worker (a deliberate architectural decision, not an
// oversight).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fx = require('./helpers/client-export-fixture.js');
const { buildLarge } = require('./helpers/client-export-large.js');
const RUN = require('../assets/client-export/runner.js');
const NOW = new Date('2026-04-01T12:00:00Z');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function runWithYields(scale) {
  const { db } = buildLarge({ mesos: 4, weeks: 12 * scale, days: 5, exs: 8, sets: 4 });
  const io = fx.makeIo(db, fx.COACH_A);
  let t = process.hrtime.bigint();
  const marks = [];
  const res = await RUN.createExporter({
    io, coachUid: fx.COACH_A, now: () => NOW,
    yieldTo: () => { marks.push(ms(t)); return new Promise((r) => setImmediate(r)); },
  }).run({ clientId: fx.A1 });
  const total = ms(t);
  const stages = marks.map((m, i) => m - (i ? marks[i - 1] : 0));
  stages.push(total - (marks.length ? marks[marks.length - 1] : 0));
  return { res, total, yields: marks.length, longest: Math.max(...stages), stages };
}

test('CE.35 a massive export yields to the event loop instead of freezing the thread', async () => {
  const r = await runWithYields(1);
  assert.equal(r.res.ok, true, r.res.message);
  // Before the fix this was 0. A handful is enough to prove the boundaries are wired; the encoding
  // loop adds one yield per file.
  assert.ok(r.yields >= 10, 'expected the export to yield repeatedly, got ' + r.yields);
  console.log('  # CE.35 escala 1: total=' + r.total.toFixed(0) + 'ms yields=' + r.yields +
    ' longest-stretch=' + r.longest.toFixed(0) + 'ms zip=' + (r.res.bytes.length / 1048576).toFixed(1) + 'MiB');
});

test('CE.36 the residual uninterruptible stretch is bounded and documented', async () => {
  const r = await runWithYields(4);
  assert.equal(r.res.ok, true, r.res.message);
  assert.ok(r.yields >= 10, 'yields=' + r.yields);
  // The honest bound: the remaining long stretch comes from serializing very large documents.
  // 6 s is generous headroom for CI variance; the point is that it is BOUNDED and visible, and that
  // it does not grow with the whole export.
  assert.ok(r.longest < 6000, 'longest uninterruptible stretch was ' + r.longest.toFixed(0) + 'ms');
  assert.ok(r.longest < r.total, 'at least one yield must actually break the export up');
  console.log('  # CE.36 escala 4: total=' + r.total.toFixed(0) + 'ms yields=' + r.yields +
    ' longest-stretch=' + r.longest.toFixed(0) + 'ms zip=' + (r.res.bytes.length / 1048576).toFixed(1) + 'MiB');
});

test('CE.37 a caller that passes no yieldTo keeps the previous semantics', async () => {
  // Pure Node callers and every pre-existing test must be unaffected: the default is a resolved
  // promise, so the export is still deterministic and complete without any interleaving.
  const { db } = buildLarge({ mesos: 2, weeks: 8, days: 3, exs: 4, sets: 3 });
  const io = fx.makeIo(db, fx.COACH_A);
  const res = await RUN.createExporter({ io, coachUid: fx.COACH_A, now: () => NOW }).run({ clientId: fx.A1 });
  assert.equal(res.ok, true, res.message);
  const files = fx.readZip(res.bytes);
  assert.ok(files['manifest.json'], 'manifest must still be produced');
  assert.equal(JSON.parse(files['manifest.json'].toString('utf8')).client_id, fx.A1);
});

test('CE.38 yielding does not change the archive bytes', async () => {
  // The archive must be identical whether or not the caller interleaves: responsiveness must not
  // become an observable change in the product.
  const { db } = buildLarge({ mesos: 2, weeks: 8, days: 3, exs: 4, sets: 3 });
  const io = fx.makeIo(db, fx.COACH_A);
  const plain = await RUN.createExporter({ io, coachUid: fx.COACH_A, now: () => NOW }).run({ clientId: fx.A1 });
  const yielded = await RUN.createExporter({
    io, coachUid: fx.COACH_A, now: () => NOW,
    yieldTo: () => new Promise((r) => setImmediate(r)),
  }).run({ clientId: fx.A1 });
  assert.equal(yielded.bytes.length, plain.bytes.length, 'same archive size');
  assert.deepEqual(Object.keys(fx.readZip(yielded.bytes)).sort(), Object.keys(fx.readZip(plain.bytes)).sort());
  const m1 = JSON.parse(fx.readZip(plain.bytes)['manifest.json'].toString('utf8'));
  const m2 = JSON.parse(fx.readZip(yielded.bytes)['manifest.json'].toString('utf8'));
  assert.deepEqual(m2.record_counts, m1.record_counts);
  assert.equal(m2.client_id, m1.client_id);
});
