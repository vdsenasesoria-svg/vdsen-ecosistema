'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const start = client.indexOf('function _instructionValue(');
const end = client.indexOf('function _buildTechniqueAndInstructionsHtml(', start);
assert.ok(start >= 0 && end > start, 'exercise sheet adapter must be extractable');

const sandbox = {
  window:{},
  document:{ addEventListener(){}, getElementById(){ return null; }, body:{style:{}}, activeElement:null },
  PLAN:null, ACTIVE_GYM_NAME:'San Diego', _resolveExerciseVisualCatalog(){ return null; },
  _escHTml:(value) => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;')
};
vm.createContext(sandbox);
vm.runInContext(client.slice(start, end), sandbox);

const httpsHtml = sandbox._buildExerciseSheetMediaHtml({ imageUrl:'https://cdn.example.test/missing.jpg' });
assert.ok(httpsHtml.includes('_fallbackExerciseSheetImage(this)'), 'remote image errors must invoke the controlled placeholder fallback');

const assetHtml = sandbox._buildExerciseSheetMediaHtml({ assetRef:'assets/exercises/does-not-exist.svg' });
assert.ok(assetHtml.includes('_fallbackExerciseSheetImage(this)'), 'missing local asset errors must invoke the same fallback');

const unsafeHtml = sandbox._buildExerciseSheetMediaHtml({ imageUrl:'javascript:alert(1)', assetRef:'data:image/svg+xml,<svg onload=alert(1)>' });
assert.ok(!unsafeHtml.includes('javascript:') && !unsafeHtml.includes('data:image'), 'unsafe URL schemes are rejected');
assert.ok(unsafeHtml.includes('assets/exercises/pending-license.svg'), 'unsafe media degrades to the official placeholder');

const note = { style:{ display:'none' } };
const img = { src:'https://cdn.example.test/missing.jpg', alt:'Demo', onerror:function(){}, nextElementSibling:note };
sandbox._fallbackExerciseSheetImage(img);
assert.strictEqual(img.src, 'assets/exercises/pending-license.svg', 'runtime image failure swaps to the official placeholder');
assert.strictEqual(img.onerror, null, 'fallback disables recursion if the placeholder itself fails');
assert.strictEqual(note.style.display, 'block', 'fallback reveals the pending-license explanation');

console.log('T453 — exercise sheet media fallback: PASS');
