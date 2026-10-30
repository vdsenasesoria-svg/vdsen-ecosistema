'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('training render clamps a stale active day before reading the current session', () => {
  const source = fs.readFileSync('vdsen-cliente.html', 'utf8');
  const start = source.indexOf('function renderEntrenamiento() {');
  const sessionRead = source.indexOf('var ses = sesiones[DIA_ACTIVO];', start);
  const preamble = source.slice(start, sessionRead);
  assert.match(preamble, /DIA_ACTIVO < 0 \|\| DIA_ACTIVO >= sesiones\.length/);
  assert.match(preamble, /DIA_ACTIVO = 0;/);
  assert.match(preamble, /localStorage\.setItem\('vdsen_last_dia', DIA_ACTIVO\)/);
});
