'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

const repsPos = client.indexOf("id=\"reps_'+key+'\"");
const rirFocusPos = client.indexOf("getElementById(\\'rir_'+key", repsPos);
ok(repsPos >= 0 && rirFocusPos > repsPos, 'normal reps keyboard chain targets RIR before ICS');
ok(client.includes("id=\"rir_'+key+'\" type=\"number\"") && client.includes("enterkeyhint=\"next\""), 'normal RIR input remains a numeric next-step control');
ok(client.includes("getElementById(\\'ics_'+key"), 'normal RIR keyboard chain targets optional ICS');
const copyStart = client.indexOf('function copiarSerie(key, s, di, ei) {');
const copyEnd = client.indexOf('\\n}\\n\\n// Actualiza EXERCISE_HISTORY', copyStart);
const copySrc = client.slice(copyStart, copyEnd);
ok(copySrc.includes('var _copyFocus = rirEl || icsEl'), 'copy-series focus prioritizes the existing RIR control');
ok(copySrc.includes('_copyFocus.focus()'), 'copy-series moves focus without changing copied values');

console.log('\\nT383/T384 — Workout focus chain: ' + pass + ' assertions PASSED.');
