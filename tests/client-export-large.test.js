'use strict';
// Large synthetic history: guards against pathological time / memory behaviour of the STORE-zip export. Synthetic data only.
// Default size runs in CI; CE_LARGE_SCALE=<n> multiplies the number of weeks for ad-hoc benchmarking (prints the same metrics).
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./helpers/client-export-fixture.js');
const { buildLarge } = require('./helpers/client-export-large.js');
const RUN = require('../assets/client-export/runner.js');

test('CE.31 large history exports within time/memory bounds, valid ZIP, correct counts', async () => {
  const scale = Math.max(1, Number(process.env.CE_LARGE_SCALE) || 1);
  const { db, sets } = buildLarge({ mesos: 4, weeks: 12 * scale, days: 5, exs: 8, sets: 4 });
  const io = fx.makeIo(db, fx.COACH_A);
  if (global.gc) global.gc();
  const rss0 = process.memoryUsage().rss, t0 = process.hrtime.bigint();
  const res = await RUN.createExporter({ io, coachUid: fx.COACH_A, now: () => new Date('2026-04-01T12:00:00Z') }).run({ clientId: fx.A1 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6, rssMb = (process.memoryUsage().rss - rss0) / 1048576;
  assert.equal(res.ok, true, res.message);
  const files = fx.readZip(res.bytes), m = JSON.parse(files['manifest.json'].toString('utf8'));
  assert.equal(m.record_counts.exercise_logs, sets); assert.equal(m.record_counts.mesocycles, 4); assert.equal(m.record_counts.sessions, 4 * 12 * scale * 5);
  assert.equal(JSON.parse(files['adherencia.json'].toString('utf8')).overall.completion_rate, 1);
  assert.equal(fx.parseCsv(files['rendimiento_sesiones.csv'].toString('utf8')).length, sets + 1);
  const mb = res.bytes.length / 1048576;
  console.log('# large export: set records=' + sets + ' sessions=' + m.record_counts.sessions + ' zip=' + mb.toFixed(2) + ' MiB time=' + Math.round(ms) + ' ms rss_delta=' + Math.round(rssMb) + ' MiB');
  assert.ok(ms < 20000 * scale, 'export took ' + ms + ' ms');
  assert.ok(rssMb < 1500, 'rss grew ' + rssMb + ' MiB');
});
