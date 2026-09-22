'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const start = client.indexOf('function _showPresessionCheck(di) {');
const end = client.indexOf('\nwindow._showPresessionCheck', start);
const source = client.slice(start, end);
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; console.log('  ✓ ' + message); }

ok(source.includes("ov.setAttribute('role', 'dialog')"), 'pre-session overlay exposes dialog semantics');
ok(source.includes("ov.setAttribute('aria-modal', 'true')"), 'pre-session overlay identifies itself as modal');
ok(source.includes("ov.setAttribute('aria-label', 'Check-in antes de entrenar')"), 'pre-session overlay has an accessible name');
ok(source.indexOf("document.body.appendChild(ov);") < source.indexOf("firstRating.focus()"), 'pre-session overlay focuses an in-dialog rating after mounting');
ok(source.includes("document.getElementById('preE1')"), 'initial focus targets the first available rating control');

console.log('\nT379 — Pre-session modal focus: ' + pass + ' assertions PASSED.');
