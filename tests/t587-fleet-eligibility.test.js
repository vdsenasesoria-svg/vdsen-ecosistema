'use strict';
// T587 / FASE F1: automatic technical eligibility (read-only, no manual lists of exercises or machines, no activation).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../scripts/fleet/eligibility-report.cjs');

const T = (iso) => Date.parse(iso);
const plan = (o) => Object.assign({ updatedAt: '2026-09-26T00:00:00.000Z', days: [{ dayIndex: 0, exercises: [{ exerciseName: 'A', prescriptionExerciseId: 'p1' }, { exerciseName: 'B', prescriptionExerciseId: 'p2', repsRange: { min: 8, max: 12 } }] }] }, o || {});
const logs = (weeks, extra) => { const e = {}; weeks.forEach((w) => ['p1', 'p2'].forEach((pid, ei) => { e['log_' + w + '_0_' + ei + '_s0'] = { done: true, prescriptionExerciseId: pid, ts: T('2026-10-0' + w + 'T10:00:00Z') }; })); return Object.assign(e, extra || {}); };

test('T587-F1 classification: no plan / plan needs preparation / safety hold / needs evidence / eligible', () => {
  assert.equal(tool.classify(null, {}).state, 'NO_ACTIVE_PLAN');
  assert.equal(tool.classify({ days: [{ exercises: [{ exerciseName: 'A' }] }] }, {}).state, 'NEEDS_PLAN_PREP');
  assert.equal(tool.classify(plan({ updatedAt: undefined }), logs([1, 2])).state, 'NEEDS_PLAN_PREP', 'no ISO updatedAt: the engine fails closed');
  assert.equal(tool.classify(plan({ updatedAt: { seconds: 1 } }), logs([1, 2])).state, 'NEEDS_PLAN_PREP', 'a Timestamp object is not the contract');
  assert.equal(tool.classify(plan({ days: [{ exercises: [{ prescriptionExerciseId: 'p1' }, { prescriptionExerciseId: 'p1' }] }] }), {}).state, 'NEEDS_PLAN_PREP', 'duplicated PID');
  assert.equal(tool.classify(plan(), logs([1])).state, 'NEEDS_EVIDENCE');
  assert.equal(tool.classify(plan(), logs([1, 2])).state, 'ELIGIBLE');
  const pain = tool.classify(plan(), logs([1, 2], { postsession_2_0: { articularPain: { present: true } } })); assert.equal(pain.state, 'SAFETY_HOLD'); assert.equal(pain.recentPain, true);
  assert.equal(tool.classify(plan(), logs([1, 2, 3], { postsession_1_0: { articularPain: { present: true } }, postsession_2_0: {}, postsession_3_0: {} })).state, 'ELIGIBLE', 'pain older than the last two recorded sessions does not hold');
});

test('T587-F2 comparability: evidence before the last plan revision, express, autofilled and other identities never count', () => {
  const p = plan({ updatedAt: '2026-10-02T12:00:00.000Z' });
  assert.equal(tool.classify(p, logs([1, 2])).state, 'NEEDS_EVIDENCE', 'both exposures predate the plan revision');
  assert.equal(tool.classify(p, logs([1, 2, 3, 4])).state, 'ELIGIBLE', 'weeks 3 and 4 postdate it');
  const e = logs([3, 4]); Object.keys(e).forEach((k) => { e[k].express = true; }); assert.equal(tool.classify(plan(), e).state, 'NEEDS_EVIDENCE', 'express evidence is not canonical');
  const g = logs([3, 4]); Object.keys(g).forEach((k) => { g[k].prescriptionExerciseId = 'someone-else'; }); assert.equal(tool.classify(plan(), g).state, 'NEEDS_EVIDENCE');
});

test('T587-F3 the report is aggregate by default (no identifiers), read-only, and never enables anyone; --detail shows only a short prefix', async () => {
  const UID1 = 'Aa' + 'b'.repeat(26), UID2 = 'Cc' + 'd'.repeat(26), calls = [];
  const S = (s) => ({ stringValue: s }), enc = (v) => v === null ? { nullValue: null } : typeof v === 'string' ? S(v) : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  const docs = { 'plans/pl1': { fields: Object.fromEntries(Object.entries(plan()).map(([k, v]) => [k, enc(v)])) }, ['logs/' + UID1]: { fields: { entries: enc(logs([1, 2])) } } };
  const http = async (p) => { calls.push(p); return docs[p] ? { status: 200, body: docs[p] } : { status: 404, body: null }; };
  const list = async () => ({ documents: [{ name: 'x/clients/' + UID1, fields: { activePlanId: S('pl1') } }, { name: 'x/clients/' + UID2, fields: {} }] });
  const lines = []; const r = await tool.main([], { http, list, token: () => 't', log: (l) => lines.push(l) });
  assert.deepEqual(r.counts, { clientes: 2, NO_ACTIVE_PLAN: 1, NEEDS_PLAN_PREP: 0, SAFETY_HOLD: 0, NEEDS_EVIDENCE: 0, ELIGIBLE: 1 }); assert.ok(!lines.join('\n').includes(UID1.slice(0, 6)));
  const d = []; await tool.main(['--detail'], { http, list, token: () => 't', log: (l) => d.push(l) }); assert.ok(d.join('\n').includes('Aabbbb…')); assert.ok(!d.join('\n').includes(UID1));
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fleet', 'eligibility-report.cjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/(PATCH|POST|DELETE)|setDoc|updateDoc|vercel|CRON_SECRET/i.test(src), 'read-only, no activation'); assert.ok(!/catalog|equipment|increment|exerciseId/i.test(src.replace(/prescriptionExerciseId/g, '')), 'no manual lists of exercises or machines');
});
