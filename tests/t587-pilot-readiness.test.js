'use strict';
// T587 / FASE E1: the pilot readiness tool is READ-ONLY, prints booleans and counts, never the full UID, and reports each check truthfully. In-memory REST, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../scripts/pilot/pilot-readiness.cjs');

const UID = 'Qq' + 'r'.repeat(26);
const S = (s) => ({ stringValue: s }), I = (n) => ({ integerValue: String(n) }), B = (b) => ({ booleanValue: b }), M = (f) => ({ mapValue: { fields: f } }), A = (v) => ({ arrayValue: { values: v } });
const ex = (n, pid, extra) => M(Object.assign({ exerciseName: S(n) }, pid ? { prescriptionExerciseId: S(pid) } : {}, extra || {}));
function world(o) {
  o = o || {}; const d = {};
  d['clients/' + UID] = { fields: { coachId: S('coachId1'), activePlanId: S('plan1') } };
  d['plans/plan1'] = { fields: Object.assign({ coachId: S('coachId1'), rirByWeek: M({ 1: I(3) }), days: A([M({ dayIndex: I(0), exercises: A([ex('A', 'p1', o.range ? { repsRange: M({ min: I(8), max: I(12) }) } : {}), ex('B', o.missingPid ? null : 'p2')]) })]) },
    o.noUpdatedAt ? {} : { updatedAt: S('2026-09-26T00:00:00.000Z') }, o.prio ? { musclePriorities: M({ PRIORITARIO: A([S('pectoral')]), NO_PRIORITARIO: A([]) }) } : {}) };
  d['logs/' + UID] = { fields: { entries: M({ log_1_0_0_s0: M({ done: B(true) }), log_1_0_0_s1: M({ done: B(true) }), done_1_0: B(true) }) } };
  d['releaseControl/autonomousProgression'] = { fields: { schema: S('vdsen-autonomous-release-v1'), enabled: B(o.releaseOff ? false : true), clientIds: A((o.extraIds || []).concat([S(UID)])), expiresAt: S(o.expired ? '2020-01-01T00:00:00Z' : new Date(Date.now() + 36e5).toISOString()) } };
  d['coaches/coachId1'] = { fields: { autoApplyCanary: M({ enabled: B(o.canaryOff ? false : true), clientIds: A([S(UID)]) }) } };
  d['logs/' + UID + '/mesos'] = { list: [{ fields: { planId: S('plan1'), progressionApplications: M({ k1: M({ state: S('APPLIED') }), k2: M({ state: S('PENDING') }) }), nextExposureOverlays: M({ o1: M({ dimension: S('SETS') }) }) } }] };
  const calls = []; const http = async (p) => { calls.push(p); const key = p.replace(/\?.*$/, ''); const x = d[key]; if (key.endsWith('/mesos')) return { status: 200, body: { documents: d[key].list } }; return x ? { status: 200, body: x } : { status: 404, body: null }; };
  return { http, calls };
}
const run = async (o, argv) => { const w = world(o), lines = []; const R = await tool.main(argv || ['--uid', UID], { http: w.http, token: () => 't', log: (l) => lines.push(l) }); return { R, lines, calls: w.calls }; };

test('T587-P1 a ready pilot: plan integrity, fences, logbook and engine states are reported as booleans / counts; the tool performs GET reads only', async () => {
  const { R, lines, calls } = await run({ prio: true, range: true });
  assert.equal(R.checks.plan_listo_para_progresion, true); assert.equal(R.checks.prioridades_musculares_persistidas, true); assert.equal(R.checks.rangos_de_repeticiones_disponibles, true);
  assert.equal(R.checks.barrera_release_abierta_para_el_atleta, true); assert.equal(R.checks.allowlist_solo_el_piloto, true); assert.equal(R.checks.barrera_canario_abierta_para_el_atleta, true); assert.equal(R.checks.bitacora_con_registro, true);
  assert.deepEqual(R.counts.estados, { PENDING: 1, APPLIED: 1, CONSUMED: 0, REJECTED: 0, STALE: 0 }); assert.deepEqual(R.counts.overlaysPorDimension, { SETS: 1 });
  assert.ok(calls.length > 5 && calls.every((p) => typeof p === 'string'), 'reads only (the injected transport has no write method)');
  assert.ok(!lines.join('\n').includes(UID), 'the UID is never printed');
});

test('T587-P2 truthful negatives: undeclared priorities / ranges, missing PID or updatedAt, closed fences, extra clients in the allowlist, absent logbook are reported as FALLA with the reason', async () => {
  const a = (await run({})).R.checks; assert.equal(a.prioridades_musculares_persistidas, false); assert.equal(a.rangos_de_repeticiones_disponibles, false);
  const b = (await run({ missingPid: true, noUpdatedAt: true })).R.checks; assert.equal(b.plan_listo_para_progresion, false);
  const c = (await run({ releaseOff: true, canaryOff: true })).R.checks; assert.equal(c.barrera_release_abierta_para_el_atleta, false); assert.equal(c.barrera_canario_abierta_para_el_atleta, false);
  const d = (await run({ extraIds: [S('someoneElse12345678901234')] })).R.checks; assert.equal(d.allowlist_solo_el_piloto, false, 'the pilot allowlist must list ONLY the pilot');
});

test('T587-P3 contract: a malformed UID is rejected; no write API, no Vercel / IAM / credentials / CRON in the tool (static)', async () => {
  await assert.rejects(() => tool.main(['--uid', '*'], { http: async () => ({ status: 404 }), token: () => 't', log: () => {} }), /--uid requerido/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pilot', 'pilot-readiness.cjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/PATCH|POST|DELETE|vercel|CRON_SECRET|setIamPolicy/i.test(src.replace(/Vercel/g, '')), 'read-only'); assert.ok(!/z82E/.test(src), 'no real UID stored');
});

test('T657 readiness reports the release fence expiry: valid => OK, expired or absent => FALLA', async () => {
  const ok = await run({}); assert.ok(ok.lines.some((l) => /barrera_release_con_caducidad_vigente/.test(l) && /OK/.test(l)), ok.lines.join(' | '));
  const bad = await run({ expired: true }); assert.ok(bad.lines.some((l) => /barrera_release_con_caducidad_vigente/.test(l) && /FALLA/.test(l)), bad.lines.join(' | '));
});
