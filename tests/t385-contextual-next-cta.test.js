'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

ok(client.includes("return { type: 'NEXT_EXERCISE', label: nex.exerciseName || nex.nombre || '', ei: nei };"), 'next-exercise resolver carries the existing target index');
ok(client.includes('function _continueNextWorkoutAction()'), 'one contextual continuation handler exists');
ok(client.includes("action.type === 'NEXT_EXERCISE' && Number.isInteger(action.ei)"), 'next-exercise CTA uses the resolver target');
ok(client.includes('setEjActivo(action.ei);'), 'next-exercise CTA reuses existing exercise navigation');
ok(client.includes("action.type === 'SESSION_DONE'"), 'session-complete action is recognized');
ok((client.match(/onclick="_continueNextWorkoutAction\(\)"/g) || []).length >= 2, 'both rest overlays share the contextual CTA');

console.log('\\nT385 — Contextual next CTA: ' + pass + ' assertions PASSED.');
