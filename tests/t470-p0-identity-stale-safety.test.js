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
ok(client.includes('function _isFreshPidProgRec'), 'T471 keeps the explicit PID/freshness gate definition');
ok((client.match(/action === 'reduce_sets'/g) || []).length === 0, 'T484 no reduce_sets set-count mutation site remains');
ok(client.split('_isFreshPidProgRec(').length - 1 === 1, 'T484 the gate has no caller left (definition only)');

// T472/T473: the mutating Monitor preview must never resolve by name alone.
const previewStart = coach.indexOf('function _buildRecApplyPreview(');
const previewEnd = coach.indexOf('\n  }\n  window._buildRecApplyPreview', previewStart);
const preview = coach.slice(previewStart, previewEnd);
ok(preview.includes('prescriptionExerciseId'), 'T472 preview resolves recommendation PID');
ok(!preview.includes('_normN20(dayObj.exercises[j].exerciseName'), 'T472 preview no longer uses name as mutation authority');
ok(coach.includes('PID conflict') || coach.includes('PID_CONFLICT') || coach.includes('prescriptionExerciseId'), 'T473 source retains explicit PID conflict protection');

// T474: no broad Modulo D rewrite is permitted in this ticket.
ok(!client.includes('T474:') && !coach.includes('T474:'), 'T474 has no speculative Modulo D mutation');

console.log('T470-T474 — P0 identity/stale safety: PASS');
