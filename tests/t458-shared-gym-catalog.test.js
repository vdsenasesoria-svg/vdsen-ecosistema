const assert = require('node:assert/strict');
const catalog = require('../assets/exercise-visual-catalog.js');

const sanDiego = catalog.gyms['smart-fit-san-diego'];
const bugambilias = catalog.gyms.bugambilias;
assert.ok(sanDiego);
assert.strictEqual(bugambilias, sanDiego, 'both sites must resolve the same canonical catalog object');
assert.strictEqual(bugambilias.entries, sanDiego.entries, 'equipment definitions must not be copied');
assert.ok(sanDiego.aliases.includes('San Diego'));
assert.ok(sanDiego.aliases.includes('Smart Fit San Diego'));
assert.ok(sanDiego.aliases.includes('Bugambilias'));
assert.equal(new Set(sanDiego.entries.map(e => e.exerciseId)).size, sanDiego.entries.length);
console.log('T458 — San Diego/Bugambilias shared canonical gym catalog: PASS');
