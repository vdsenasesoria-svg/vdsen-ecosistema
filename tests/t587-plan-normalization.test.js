'use strict';
// T587 / FASE A3: the legacy-plan normalization procedure. Pure library + CLI with an injected in-memory Firestore REST (no network, no credentials).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/plans/plan-normalization-lib.cjs');
const cli = require('../scripts/plans/normalize-legacy-plans.cjs');

const UID1 = 'A'.repeat(28), UID2 = 'B'.repeat(28), UID3 = 'C'.repeat(28);
const S = (s) => ({ stringValue: s }), I = (n) => ({ integerValue: String(n) }), D = (n) => ({ doubleValue: n }), M = (f) => ({ mapValue: { fields: f } }), A = (v) => ({ arrayValue: { values: v } });
const set = (i) => M({ setIndex: I(i), repsTarget: I(10), rirTarget: I(2), load: D(7.5), restSeconds: I(90), tempo: S('3-1-1') });
const ex = (name, pid) => M(Object.assign({ exerciseName: S(name), technique: S('straight'), alternatives: A([]), sets: A([set(0), set(1)]), coachNote: S('nota') }, pid ? { prescriptionExerciseId: S(pid) } : {}));
const plan = (o) => ({ fields: Object.assign({ coachId: S('coachX'), clientId: S('c'), status: S('active'), weeks: I(6), createdAt: S('2026-09-01T00:00:00.000Z'), nested: M({ ts: { timestampValue: '2026-09-01T00:00:00Z' }, nul: { nullValue: null } }),
  days: A([M({ dayIndex: I(0), label: S('D1'), exercises: A([ex('Press', o.pids && o.pids[0]), ex('Remo', o.pids && o.pids[1])]) }), M({ dayIndex: I(2), label: S('D2'), exercises: A([ex('Curl', o.pids && o.pids[2])]) })]) },
  o.updatedAt === undefined ? { updatedAt: S('2026-09-26T00:00:00.000Z') } : (o.updatedAt === null ? {} : { updatedAt: o.updatedAt })), updateTime: o.updateTime || '2026-10-01T00:00:00.000000Z' });
const READY = () => plan({ pids: ['p1', 'p2', 'p3'] }), LEGACY = () => plan({ updatedAt: null }), PARTIAL = () => plan({ pids: ['p1', null, 'p1'], updatedAt: S('not-a-date') });
const exs = (d) => lib.listExercises(d);
const gen = () => { let n = 0; return () => 'new-' + (++n); };

test('T587-N1 assess: a plan is READY only with a PID per exercise (unique) and an ISO updatedAt', () => {
  assert.equal(lib.assessPlan(READY()).ready, true);
  const l = lib.assessPlan(LEGACY()); assert.deepEqual([l.ready, l.exercises, l.withPid, l.missingPid, l.updatedAtKind], [false, 3, 0, 3, 'ABSENT']);
  const p = lib.assessPlan(PARTIAL()); assert.deepEqual([p.withPid, p.duplicatePids, p.updatedAtKind], [2, 1, 'INVALID_STRING']);
  assert.equal(lib.assessPlan(plan({ pids: ['p1', 'p2', 'p3'], updatedAt: { timestampValue: '2026-09-26T00:00:00Z' } })).updatedAtKind, 'NOT_A_STRING', 'a Firestore Timestamp is NOT the contract');
});

test('T587-N2 patch: PIDs kept byte for byte, only missing / duplicated ones minted (unique), nothing else touched (doubles, timestamps, nulls, nested maps stay identical)', () => {
  const before = PARTIAL(), p = lib.planPatch(before, { nowIso: '2026-10-20T10:00:00.000Z', gen: gen() });
  assert.deepEqual(p.mask.sort(), ['days', 'updatedAt']); assert.equal(p.minted, 1); assert.equal(p.repaired, 1); assert.equal(p.updatedAt, '2026-10-20T10:00:00.000Z'); assert.equal(p.policy, 'now');
  const after = { fields: Object.assign({}, before.fields, p.fields) }, e = exs(after).map((x) => x.pid);
  assert.equal(e[0], 'p1'); assert.deepEqual(e.slice(1), ['new-1', 'new-2'].filter(Boolean).length === 2 ? e.slice(1) : []); assert.equal(new Set(e).size, 3);
  const v = lib.verifyAfter(before, after); assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(JSON.stringify(after.fields.nested), JSON.stringify(before.fields.nested)); assert.equal(exs(after)[0].fields.sets.arrayValue.values[0].mapValue.fields.load.doubleValue, 7.5);
});

test('T587-N3 idempotent: a plan that already complies is NOT written (its revision date never moves); running twice changes nothing the second time', () => {
  assert.equal(lib.planPatch(READY(), { nowIso: 'x' }), null);
  const l = LEGACY(), p1 = lib.planPatch(l, { nowIso: '2026-10-20T10:00:00.000Z', gen: gen() }), applied = { fields: Object.assign({}, l.fields, p1.fields) };
  assert.equal(lib.assessPlan(applied).ready, true); assert.equal(lib.planPatch(applied, { nowIso: '2027-01-01T00:00:00.000Z' }), null);
  assert.equal(lib.planPatch(plan({ pids: ['p1', 'p2', 'p3'], updatedAt: S('2026-09-26T00:00:00.000Z') }), { nowIso: 'x' }), null, 'a valid existing updatedAt is never overwritten');
  const noDate = plan({ pids: ['p1', 'p2', 'p3'], updatedAt: null }), p = lib.planPatch(noDate, { nowIso: '2026-10-20T10:00:00.000Z' });
  assert.deepEqual(p.mask, ['updatedAt'], 'PIDs complete: only the revision date is added'); assert.ok(!('days' in p.fields));
});

test('T587-N4 updatedAt policy: `now` (default) vs `created` (only with a usable createdAt); the impact on the real logbook is measured BEFORE choosing', () => {
  assert.equal(lib.planPatch(LEGACY(), { nowIso: 'N', policy: 'created' }).updatedAt, '2026-09-01T00:00:00.000Z');
  const noCreated = LEGACY(); delete noCreated.fields.createdAt; assert.equal(lib.planPatch(noCreated, { nowIso: 'N', policy: 'created' }).skip, 'CREATED_AT_UNUSABLE');
  const d = plan({ pids: ['p1', 'p2', 'p3'], updatedAt: null }), T = (iso) => Date.parse(iso);
  const entries = {}; [['2026-09-10T00:00:00Z', 1], ['2026-09-17T00:00:00Z', 2], ['2026-10-19T00:00:00Z', 3]].forEach(([iso, w]) => [0, 1].forEach((s) => { entries['log_' + w + '_0_0_s' + s] = { done: true, prescriptionExerciseId: 'p1', ts: T(iso) }; }));
  entries.log_1_0_1_s0 = { done: true, prescriptionExerciseId: 'ghost', ts: T('2026-10-19T00:00:00Z') };
  const imp = lib.updatedAtImpact(d, entries, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(imp, { pidsWithHistory: 1, exposures: 3, comparableIfNow: 0, comparableIfCreated: 3 }, 'stamping `now` would discard all 3 comparable exposures of p1; `created` would keep them; unknown PIDs have no history');
});

test('T587-N5 verifyAfter catches tampering: changed content, changed existing PID, changed other field, lost readiness', () => {
  const b = LEGACY(), p = lib.planPatch(b, { nowIso: '2026-10-20T10:00:00.000Z', gen: gen() }), good = { fields: Object.assign({}, b.fields, p.fields) };
  const clone = () => JSON.parse(JSON.stringify(good));
  const t1 = clone(); t1.fields.days.arrayValue.values[0].mapValue.fields.exercises.arrayValue.values[0].mapValue.fields.exerciseName = S('OTRO'); assert.match(lib.verifyAfter(b, t1).problems.join(), /EXERCISE_CONTENT_CHANGED/);
  const t2 = clone(); t2.fields.weeks = I(8); assert.match(lib.verifyAfter(b, t2).problems.join(), /FIELD_CHANGED:weeks/);
  const t3 = clone(); delete t3.fields.updatedAt; assert.match(lib.verifyAfter(b, t3).problems.join(), /NOT_READY_AFTER/);
  const ready = READY(), t4 = JSON.parse(JSON.stringify(ready)); t4.fields.days.arrayValue.values[0].mapValue.fields.exercises.arrayValue.values[0].mapValue.fields.prescriptionExerciseId = S('changed'); assert.match(lib.verifyAfter(ready, t4).problems.join(), /EXISTING_PID_CHANGED/);
});

// ---------- CLI against an in-memory Firestore ----------
function world() {
  const docs = {}, calls = [];
  docs['clients/' + UID1] = { fields: { activePlanId: S('plan1'), coachId: S('coachX') }, updateTime: 't0' }; docs['plans/plan1'] = LEGACY();
  docs['clients/' + UID2] = { fields: { activePlanId: S('plan2'), coachId: S('coachX') }, updateTime: 't0' }; docs['plans/plan2'] = READY();
  docs['clients/' + UID3] = { fields: { activePlanId: S('plan3'), coachId: S('coachX') }, updateTime: 't0' }; docs['plans/plan3'] = PARTIAL();
  docs['logs/' + UID1] = { fields: { entries: M({ log_1_0_0_s0: M({ done: { booleanValue: true }, prescriptionExerciseId: S('zzz'), ts: I(Date.parse('2026-10-19T00:00:00Z')) }) }) }, updateTime: 't0' };
  let clock = 0;
  const http = async (method, p, tk, body, mask, ut) => {
    calls.push({ method, p, mask, ut });
    if (method === 'GET') { const d = docs[p]; return d ? { status: 200, body: Object.assign({ name: 'projects/x/databases/(default)/documents/' + p }, JSON.parse(JSON.stringify(d))) } : { status: 404, body: null }; }
    const d = docs[p]; if (!d) return { status: 404, body: null }; if (ut && d.updateTime !== ut) return { status: 409, body: null };
    (mask || []).forEach((k) => { if (body.fields[k]) d.fields[k] = body.fields[k]; else delete d.fields[k]; }); d.updateTime = 'u' + (++clock); return { status: 200, body: {} };
  };
  const list = async () => ({ documents: Object.keys(docs).filter((k) => k.startsWith('clients/')).map((k) => ({ name: 'projects/x/databases/(default)/documents/' + k, fields: docs[k].fields })) });
  return { docs, calls, http, list };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 't587-'));
const run = (argv, w, extra) => { const lines = []; return cli.main(argv, Object.assign({ http: w.http, list: w.list, token: () => 'tok', log: (l) => lines.push(l), now: () => '2026-10-20T10:00:00.000Z' }, extra || {})).then((r) => Object.assign({ lines }, r)); };

test('T587-N6 preview is READ-ONLY and aggregate: counts, readiness, the effect of each updatedAt policy; no identifiers unless --detail', async () => {
  const w = world(), r = await run(['preview'], w); assert.ok(w.calls.every((c) => c.method === 'GET'));
  assert.deepEqual([r.summary.clientes, r.summary.planesListos, r.summary.planesPorPreparar, r.summary.sinUpdatedAt, r.summary.ejerciciosSinPid], [3, 1, 2, 2, 4]);
  assert.ok(!r.lines.join('\n').includes(UID1.slice(0, 6)), 'no identifiers in the aggregate'); assert.equal(r.wrote, 0);
  const d = await run(['preview', '--uid', UID1, '--detail'], w); assert.match(d.lines.join('\n'), /AAAAAA…/);
});

test('T587-N7 backup: local file with per-plan sha256 and updateTime; tampering is detected and apply refuses; backup never writes to Firestore', async () => {
  const w = world(), dir = tmp(), f = path.join(dir, 'b.json'); const r = await run(['backup', '--uids', UID1 + ',' + UID3, '--out', f], w);
  assert.ok(w.calls.every((c) => c.method === 'GET')); const m = JSON.parse(fs.readFileSync(f, 'utf8')); assert.equal(m.count, 2); assert.equal(m.docs[0].sha256.length, 64); assert.equal(m.manifestSha256, r.manifestSha256);
  m.docs[0].doc.fields.weeks = I(99); fs.writeFileSync(f, JSON.stringify(m));
  await assert.rejects(() => run(['apply', '--uids', UID1, '--backup', f, '--confirm', '--authorized-by-owner', 'ok'], w), /Respaldo inválido/);
});

test('T587-N8 apply: SIMULATION by default; without --confirm AND --authorized-by-owner nothing is written; it needs a backup that is still current', async () => {
  const w = world(), dir = tmp(), f = path.join(dir, 'b.json'); await run(['backup', '--uids', UID1 + ',' + UID2 + ',' + UID3, '--out', f], w);
  const sim = await run(['apply', '--uids', UID1 + ',' + UID3, '--backup', f], w); assert.equal(sim.wrote, 0); assert.equal(sim.dry, true); assert.ok(w.calls.filter((c) => c.method === 'PATCH').length === 0); assert.match(sim.lines.join('\n'), /SIMULACIÓN/);
  const half = await run(['apply', '--uids', UID1, '--backup', f, '--confirm'], w); assert.equal(half.wrote, 0, '--confirm alone is not authorization');
  w.docs['plans/plan1'].updateTime = 'edited-by-coach';   // the Coach touched it after the backup
  const stale = await run(['apply', '--uids', UID1, '--backup', f, '--confirm', '--authorized-by-owner', 'propietario'], w); assert.equal(stale.wrote, 0); assert.match(stale.lines.join('\n'), /cambió después del respaldo/);
});

test('T587-N9 apply (authorized): only plans/{active} of the listed UIDs; mask days+updatedAt with updateTime precondition; verified; idempotent on the second run; ready plans untouched', async () => {
  const w = world(), dir = tmp(), f = path.join(dir, 'b.json'), lf = path.join(dir, 'log.json'); await run(['backup', '--uids', UID1 + ',' + UID2 + ',' + UID3, '--out', f], w);
  const before2 = JSON.stringify(w.docs['plans/plan2']);
  const r = await run(['apply', '--uids', UID1 + ',' + UID2 + ',' + UID3, '--backup', f, '--log', lf, '--confirm', '--authorized-by-owner', 'propietario 2026-10-20'], w);
  assert.equal(r.wrote, 2); const patches = w.calls.filter((c) => c.method === 'PATCH'); assert.deepEqual(patches.map((c) => c.p).sort(), ['plans/plan1', 'plans/plan3']); assert.ok(patches.every((c) => c.ut && c.mask.every((k) => k === 'days' || k === 'updatedAt')));
  assert.equal(JSON.stringify(w.docs['plans/plan2']), before2, 'the ready plan was not written'); assert.ok(w.calls.every((c) => c.method === 'GET' || /^plans\//.test(c.p)), 'no other collection is ever written');
  assert.equal(lib.assessPlan(w.docs['plans/plan1']).ready, true); assert.equal(lib.assessPlan(w.docs['plans/plan3']).ready, true); assert.equal(exs(w.docs['plans/plan3'])[0].pid, 'p1', 'the existing PID is kept');
  const log = JSON.parse(fs.readFileSync(lf, 'utf8')); assert.ok(log.done.filter((x) => x.mask).every((x) => x.verified === true)); assert.equal(log.authorizedBy, 'propietario 2026-10-20');
  const again = await run(['apply', '--uids', UID1 + ',' + UID3, '--backup', f, '--log', lf, '--confirm', '--authorized-by-owner', 'x'], w);
  assert.equal(again.wrote, 0, 'second run: the backup is stale for those plans (they changed) and they already comply => nothing written');
  const v = await run(['verify', '--backup', f], w); assert.equal(v.wrote, 0); assert.ok(v.results.every((x) => x.ok));
});

test('T587-N10 STOP file halts between plans and leaves a log; --max limits a run; a failed precondition (409) stops the whole run', async () => {
  const w = world(), dir = tmp(), f = path.join(dir, 'b.json'); await run(['backup', '--uids', UID1 + ',' + UID3, '--out', f], w);
  fs.writeFileSync(path.join(dir, 'STOP'), '1'); const r = await run(['apply', '--uids', UID1 + ',' + UID3, '--backup', f, '--confirm', '--authorized-by-owner', 'x', '--log', path.join(dir, 'l.json')], w);
  assert.equal(r.wrote, 0); assert.equal(r.log.stopped, true); fs.unlinkSync(path.join(dir, 'STOP'));
  const r2 = await run(['apply', '--uids', UID1 + ',' + UID3, '--backup', f, '--confirm', '--authorized-by-owner', 'x', '--max', '1', '--log', path.join(dir, 'l2.json')], w); assert.equal(r2.wrote, 1);
  const w2 = world(), f2 = path.join(tmp(), 'b.json'); await run(['backup', '--uids', UID1, '--out', f2], w2); const http = w2.http; w2.http = async (m, p, ...rest) => (m === 'PATCH' ? { status: 409, body: null } : http(m, p, ...rest));
  const r3 = await run(['apply', '--uids', UID1, '--backup', f2, '--confirm', '--authorized-by-owner', 'x', '--log', path.join(tmp(), 'l.json')], w2); assert.equal(r3.wrote, 0); assert.equal(r3.log.stopped, true);
});

test('T587-N11 rollback restores exactly what was changed (a field that was ABSENT is deleted again) and refuses when the Coach edited the plan after the apply', async () => {
  const w = world(), dir = tmp(), f = path.join(dir, 'b.json'), lf = path.join(dir, 'log.json'); await run(['backup', '--uids', UID1 + ',' + UID3, '--out', f], w);
  const orig1 = JSON.stringify(w.docs['plans/plan1'].fields), orig3 = JSON.stringify(w.docs['plans/plan3'].fields);
  await run(['apply', '--uids', UID1 + ',' + UID3, '--backup', f, '--log', lf, '--confirm', '--authorized-by-owner', 'x'], w);
  const dry = await run(['rollback', '--backup', f, '--log', lf], w); assert.equal(dry.wrote, 0); assert.equal(dry.dry, true);
  w.docs['plans/plan3'].updateTime = 'coach-edit';
  const rb = await run(['rollback', '--backup', f, '--log', lf, '--confirm', '--authorized-by-owner', 'x'], w);
  assert.equal(rb.wrote, 1); assert.equal(JSON.stringify(w.docs['plans/plan1'].fields), orig1, 'plan1 is back to its exact original, including the ABSENT updatedAt'); assert.notEqual(JSON.stringify(w.docs['plans/plan3'].fields), orig3, 'plan3 was edited after the apply: not reverted');
  assert.match(rb.lines.join('\n'), /el Coach lo editó/);
});

test('T587-N12 contract: UID validation, per-run cap, no wildcard; the procedure never mentions other collections, variables, IAM or credentials (static)', () => {
  assert.throws(() => cli.validateUids('*'), /UID inválido/); assert.throws(() => cli.validateUids(UID1 + ',' + UID1), /repetido/); assert.throws(() => cli.validateUids(Array.from({ length: 51 }, (_, i) => String(i).padStart(28, 'x')).join(',')), /Máximo/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'plans', 'normalize-legacy-plans.cjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/vercel|CRON_SECRET|iam|NUMERIC_APPLY|DELETE|env add/i.test(src)); assert.deepEqual(Object.keys(cli).sort(), ['MAX_PER_RUN', 'PROJECT', 'main', 'validateUids']);
  assert.equal([...src.matchAll(/request\('PATCH', '([^']+)/g)].every((m) => m[1].startsWith('plans/')), true);
});
