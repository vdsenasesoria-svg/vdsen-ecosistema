// T126-H: _applyTemplateToClient must have try/catch so Firestore errors surface as toast
// Gap R6-GAP-04: without internal error handling, write failures were completely silent.
'use strict';
const assert = require('assert');
const fs = require('fs');

const COACH = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');

// Isolate the _applyTemplateToClient function body for targeted assertions.
// Capture everything from the function declaration up to the closing brace of
// the FASE 11 comment block that follows (i.e. the next async function declaration).
const fnMatch = COACH.match(/async function _applyTemplateToClient[\s\S]*?(?=\n\s*\/\/ FASE 11 — Modal de biblioteca)/);
assert.ok(fnMatch, 'Could not locate _applyTemplateToClient function in vdsen-coach.html');
const fnBody = fnMatch[0];

// 1. The function must contain a try block
assert.ok(
  /\btry\s*\{/.test(fnBody),
  '_applyTemplateToClient must have a try block'
);

// 2. The function must contain a catch block
assert.ok(
  /\}\s*catch\s*\(/.test(fnBody),
  '_applyTemplateToClient must have a catch block'
);

// 3. The catch block must contain error feedback (showToast with error flag)
// showToast(msg, true) is the error toast pattern used throughout the codebase
assert.ok(
  /catch\s*\([^)]+\)\s*\{[\s\S]*?showToast\s*\([\s\S]*?true\s*\)/.test(fnBody),
  'catch block must call showToast with error flag (true) for user feedback'
);

// 4. Success action (showClientDetail) must be inside the try block, not before it
// Strategy: the try keyword must appear BEFORE showClientDetail in the function body
const tryPos = fnBody.indexOf('try {');
const showClientDetailPos = fnBody.indexOf('showClientDetail');
assert.ok(tryPos !== -1, 'try block must exist');
assert.ok(showClientDetailPos !== -1, 'showClientDetail must exist in function');
assert.ok(
  tryPos < showClientDetailPos,
  'showClientDetail (success action) must appear after the try { opening, not before it'
);

// 5. Success toast must also be inside the try block (not a silent success on error path)
const successToastPos = fnBody.indexOf("showToast('Plan aplicado");
assert.ok(successToastPos !== -1, 'success toast must exist in function');
assert.ok(
  tryPos < successToastPos,
  'success toast must appear after the try { opening'
);

// 6. The catch block must appear AFTER the success toast (proving success actions are in try)
const catchPos = fnBody.indexOf('} catch(');
assert.ok(
  catchPos > successToastPos,
  'catch block must come after success actions (success is inside try, catch is outside)'
);

console.log('# T126-H PASS: _applyTemplateToClient has try/catch with proper error recovery');
