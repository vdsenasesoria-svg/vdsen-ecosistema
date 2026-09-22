'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

ok(client.includes('<label for="liEmail">Celular o correo</label>'), 'login identifier label is associated with its input');
ok(client.includes('<label for="liPass">Contraseña</label>'), 'login password label is associated with its input');
ok(/<input type="text" id="liEmail"/.test(client), 'login identifier keeps its stable input id');
ok(/<input type="password" id="liPass"/.test(client), 'login password keeps its stable input id');

console.log('\nT380 — Login label association: ' + pass + ' assertions PASSED.');
