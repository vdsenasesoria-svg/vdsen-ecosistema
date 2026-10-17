'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const coach = fs.readFileSync('vdsen-coach.html', 'utf8');

function ok(v, m) { assert.ok(v, m); }

// T470: the reader must propagate the parent progrec timestamp to its child.
const reader = client.slice(client.indexOf('function _getProgRecForExercise('), client.indexOf('\n}\n\n// ── FASE 6', client.indexOf('function _getProgRecForExercise(')) + 2);
ok(reader.includes('calculatedAt'), 'T470 reader exposes parent calculatedAt to the resolved recommendation');
ok(reader.includes('Object.assign'), 'T470 reader returns an enriched child, not a second timestamp authority');

// T471 -> T484: reduce_sets used to mutate the rendered set count behind an exact-PID/freshness gate.
// T484 removed every such mutation (legacy recommendations are informational for set count); the
// shared gate stays defined for exact-PID freshness checks but no reduce_sets consumer remains.
ok(!client.includes('_isFreshPidProgRec'), 'T487 the reduce_sets PID/freshness gate was removed together with its last consumer');
ok((client.match(/action === 'reduce_sets'/g) || []).length === 0, 'T484 no reduce_sets set-count mutation site remains');
// (no gate caller can remain: the gate itself no longer exists)

// T472/T473 -> T487: the mutating Monitor preview (which once resolved recommendations by PID) was
// removed with the legacy apply-to-plan infrastructure: no recommendation can mutate a plan at all.
ok(!coach.includes('_buildRecApplyPreview') && !coach.includes('_resolveExerciseInFreshPlan'), 'T472 no mutating recommendation preview/resolver remains (no name authority possible)');
ok(coach.includes('PID conflict') || coach.includes('PID_CONFLICT') || coach.includes('prescriptionExerciseId'), 'T473 source retains explicit PID conflict protection');

// T474: no broad Modulo D rewrite is permitted in this ticket.
ok(!client.includes('T474:') && !coach.includes('T474:'), 'T474 has no speculative Modulo D mutation');

console.log('T470-T474 — P0 identity/stale safety: PASS');
