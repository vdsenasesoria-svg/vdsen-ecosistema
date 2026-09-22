'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

ok(client.includes('<button type="button" id="exnote_inline_'), 'standard workout inline note is a native button');
ok(client.includes('title="Editar nota del ejercicio">📝 '), 'standard inline note has an explicit edit label');
ok(/<button type="button" onclick="toggleUserNote\('\+di\+','\+ei\+'\)" title="Editar nota del ejercicio"/.test(client), 'performance workout inline note is a native button');
ok(!client.includes('<div id="exnote_inline_'), 'standard inline note no longer depends on a clickable div');
ok(!client.includes('<span onclick="toggleUserNote('), 'performance inline note no longer depends on a clickable span');

console.log('\nT378 — Inline exercise note keyboard access: ' + pass + ' assertions PASSED.');
