const assert = require('node:assert/strict');
const editor = require('../assets/exercise-visual-metadata-editor.js');

const base = { gym:'Smart Fit San Diego', equipment:'Matrix · placas', assetRef:'assets/exercises/pending-license.svg', imageUrl:'', instructions:' cue ', setup:'setup', execution:'execution', technicalObjective:'objective', commonErrors:'error 1\nerror 2', variants:'[{"name":"agarre neutro"}]' };
const patch = editor.buildPatch(base);
assert.equal(patch.gym, 'Smart Fit San Diego');
assert.deepEqual(patch.commonErrors, ['error 1', 'error 2']);
assert.equal(patch.variants[0].name, 'agarre neutro');
assert.throws(() => editor.buildPatch({ ...base, imageUrl:'javascript:alert(1)' }), /HTTPS|asset local/);
assert.throws(() => editor.buildPatch({ ...base, instructions:'<script>alert(1)</script>' }), /HTML/);
assert.throws(() => editor.buildPatch({ ...base, assetRef:'data:image/svg+xml;base64,abc' }), /HTTPS|asset local/);
assert.throws(() => editor.buildPatch({ ...base, variants:'not json' }), /JSON/);
console.log('T457 — coach visual metadata validation and patch isolation: PASS');
