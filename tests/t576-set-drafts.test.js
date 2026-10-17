// T576: contract of the unsaved-set draft layer (static; the browser behaviour is proven by scripts/t576-draft-e2e.cjs against staging).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const start = html.indexOf('var _SET_DRAFTS = Object.create(null);'), end = html.indexOf('function _showSaveOk()');
const block = html.slice(start, end);

test('T576.1 drafts are in-memory only: no storage API, no network, no Firestore', () => {
  assert.ok(start > 0 && end > start);
  assert.ok(!/localStorage|sessionStorage|indexedDB|FB\.|fetch\(|setDoc|updateDoc/.test(block));
});
test('T576.2 identity is the exact set input id (week/day/exercise/set) and only carga/reps/ics are covered', () => {
  assert.ok(block.includes(String.raw`/^(carga|reps|ics)_log_\d+_\d+_\d+_s\d+$/`));
});
test('T576.3 a draft is restored only into an EMPTY input and is dropped when emptied, saved (LOGS done) or on logout', () => {
  assert.ok(/if \(!i\.value && RX\.test\(i\.id\) && _SET_DRAFTS\[i\.id\] !== undefined\) i\.value = _SET_DRAFTS\[i\.id\]/.test(block));
  assert.ok(/t\.value === '' \|\| t\.value == null\) delete _SET_DRAFTS\[t\.id\]/.test(block));
  assert.ok(/LOGS\[k\] && LOGS\[k\]\.done === true\) delete _SET_DRAFTS\[id\]/.test(block));
  const logout = html.slice(html.indexOf('async function doLogout()'), html.indexOf('async function doLogout()') + 900);
  assert.ok(logout.includes('_SET_DRAFTS = Object.create(null)'));
});
test('T576.4 the layer never writes values to LOGS (execution stays what the athlete saved)', () => {
  assert.ok(!/LOGS\s*\[[^\]]+\]\s*=|LOGS\.[a-z_]+\s*=/i.test(block));
});
test('T576.5 short-viewport rule: the sticky save bar flows with the form when the keyboard is open', () => {
  assert.ok(/@media \(max-height:560px\)\{\s*\.workout-set-current \.set-actions,\.setpanel \.set-actions\{position:static/.test(html));
});
