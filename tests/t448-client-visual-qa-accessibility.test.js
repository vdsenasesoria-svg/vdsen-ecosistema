'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

ok(client.includes('.tap-target{min-height:44px;min-width:44px}'), 'reusable touch targets meet the 44px mobile minimum');
ok(client.includes('class="tap-target" onclick="markWeekCompleteFromHistory()"')
  && client.includes('class="tap-target" onclick="markWeekDoneWithPartialData()"'), 'week-close actions use the mobile touch target');
ok(client.includes('<button class="tap-target" onclick="toggleExUnit('), 'exercise unit toggle is a keyboard-focusable button');
ok(client.includes('aria-label="Opciones del ejercicio"')
  && client.includes('aria-label="Mostrar calentamiento"')
  && client.includes('aria-label="Abrir mi nota del ejercicio"'), 'compact exercise controls expose accessible names');

ok(client.includes('return \'<div><label for="ci_\'+id+\'"'), 'legacy check-in number fields have associated labels');
ok(client.includes('<label for="ci_notas"') && client.includes('<textarea id="ci_notas"'), 'coach notes label is associated with its textarea');
ok(client.includes('data-icskey="\' + key + \'" aria-label="\' + _escHTml(ariaLabel'), 'ICS ratings receive contextual accessible names');
ok(client.includes('aria-label="Nombre del ejercicio"'), 'free-form ICS exercise name is labelled');
ok(client.includes('button:focus-visible,summary:focus-visible,a:focus-visible'), 'keyboard focus remains visible for interactive controls');

console.log('\nT448 — Client visual QA accessibility: ' + pass + ' assertions PASSED.');
