'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const start = client.indexOf('var _exerciseSheetPreviousFocus');
const end = client.indexOf("if (typeof document !== 'undefined')", start);
assert.ok(start >= 0 && end > start, 'exercise sheet lifecycle must be extractable');

const overlay = {
  classList:{
    open:true,
    contains(name){ return name === 'open' && this.open; },
    add(name){ if (name === 'open') this.open = true; },
    remove(name){ if (name === 'open') this.open = false; }
  }
};
const title = { textContent:'CLIENTE A · BELT SQUAT' };
const body = { innerHTML:'<img src="asset-a"><p>Metadata A</p>' };
const dialog = { focus(){} };
const close = { focus(){} };
const elements = {
  exerciseSheetOverlay:overlay, exerciseSheetTitle:title, exerciseSheetBody:body,
  exerciseSheetDialog:dialog, exerciseSheetClose:close
};
let focusRestored = 0;
const sandbox = {
  window:{},
  document:{
    body:{ style:{ overflow:'hidden' } },
    activeElement:null,
    getElementById(id){ return elements[id] || null; }
  },
  setTimeout(fn){ fn(); },
  PLAN:null, ACTIVE_GYM_NAME:'',
  _instructionText(){ return ''; }, _safeClientMediaUrl(){ return ''; }, _normalizeExerciseInstructions(){ return null; },
  _escHTml(value){ return String(value); }, _resolveExerciseVisualCatalog(){ return null; }
};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

sandbox._exerciseSheetPreviousFocus = { focus(){ focusRestored++; } };
sandbox._exerciseSheetPreviousBodyOverflow = 'auto';
sandbox.closeExerciseVisualSheet();

assert.strictEqual(overlay.classList.open, false, 'close removes the open state');
assert.strictEqual(sandbox.document.body.style.overflow, 'auto', 'close restores the body overflow value that existed before opening');
assert.strictEqual(body.innerHTML, '', 'close removes previous-client instructions and asset markup from the DOM');
assert.strictEqual(title.textContent, 'Ejercicio', 'close removes the previous-client exercise name');
assert.strictEqual(focusRestored, 1, 'close returns focus to the invoking control');

const lifecycle = client.slice(start, end);
['LOGS', 'saveLogs(', '_doSaveLogs(', 'startRestTimer(', 'CURRENT_WEEK =', 'DIA_ACTIVO =', 'EJ_ACTIVO ='].forEach((forbidden) => {
  assert.ok(!lifecycle.includes(forbidden), 'exercise sheet lifecycle must not mutate session state: ' + forbidden);
});
assert.ok(client.includes("ACTIVE_GYM_ID = ''; ACTIVE_GYM_NAME = '';"), 'logout clears active gym state');
assert.ok(client.includes('PRESCRIPTION_EXERCISE_CATALOG_BY_ID = {}; AMBIGUOUS_PRESCRIPTION_EXERCISE_IDS = {};'), 'logout clears prescription-scoped visual metadata');

console.log('T454 — exercise sheet lifecycle and user isolation: PASS');
