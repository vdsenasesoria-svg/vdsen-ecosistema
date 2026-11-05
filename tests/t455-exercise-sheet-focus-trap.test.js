'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const start = client.indexOf('function _handleExerciseSheetKeydown(');
const end = client.indexOf("if (typeof document !== 'undefined')", start);
assert.ok(start >= 0 && end > start, 'exercise sheet must define an isolated keyboard handler');

let firstFocused = 0;
let lastFocused = 0;
let closed = 0;
const first = { focus(){ firstFocused++; } };
const last = { focus(){ lastFocused++; } };
const overlay = { classList:{ contains(name){ return name === 'open'; } } };
const dialog = { querySelectorAll(){ return [first, last]; }, focus(){} };
const sandbox = {
  document:{ activeElement:last, getElementById(id){ return id === 'exerciseSheetOverlay' ? overlay : id === 'exerciseSheetDialog' ? dialog : null; } },
  closeExerciseVisualSheet(){ closed++; }
};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

let prevented = 0;
sandbox._handleExerciseSheetKeydown({ key:'Tab', shiftKey:false, preventDefault(){ prevented++; } });
assert.strictEqual(prevented, 1, 'Tab at the last control is contained inside the modal');
assert.strictEqual(firstFocused, 1, 'forward Tab wraps to the first modal control');

sandbox.document.activeElement = first;
sandbox._handleExerciseSheetKeydown({ key:'Tab', shiftKey:true, preventDefault(){ prevented++; } });
assert.strictEqual(lastFocused, 1, 'Shift+Tab at the first control wraps to the last modal control');

sandbox._handleExerciseSheetKeydown({ key:'Escape', preventDefault(){ prevented++; } });
assert.strictEqual(closed, 1, 'Escape closes the modal through the same lifecycle path');

console.log('T455 — exercise sheet focus containment: PASS');
