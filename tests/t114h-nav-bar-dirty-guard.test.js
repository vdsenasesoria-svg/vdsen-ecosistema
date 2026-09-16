/**
 * T114-H: _renderClientNavBar dirty-editor guard
 *
 * The nav-bar pills inside the client-detail modal previously called
 * showClientDetail() directly, which calls markEditorClean() immediately and
 * silently discards any unsaved plan edits.  The fix routes the click through
 * _navToClient(), which mirrors navClient()'s dirty-state prompt.
 *
 * Static-analysis tests — no browser or Firebase required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../vdsen-coach.html'),
  'utf8'
);

let failed = false;
function pass(id, msg) { console.log('PASS ' + id + ': ' + msg); }
function fail(id, msg) { console.error('FAIL ' + id + ': ' + msg); failed = true; }

// ─── T114-A: _navToClient function exists ─────────────────────────────────────
(function testNavToClientExists() {
  const id = 'T114-A';
  if (!src.includes('async function _navToClient(id)')) {
    return fail(id, '_navToClient function not found in source');
  }
  pass(id, '_navToClient function defined');
})();

// ─── T114-B: _navToClient checks _dirtyEditor before calling showClientDetail ─
(function testNavToClientDirtyCheck() {
  const id = 'T114-B';
  const fnIdx = src.indexOf('async function _navToClient(id)');
  if (fnIdx === -1) return fail(id, '_navToClient not found — skipping');
  // Grab up to the first showClientDetail call within the function
  const snippet = src.slice(fnIdx, fnIdx + 600);
  const dirtyPos         = snippet.indexOf('_dirtyEditor');
  const showClientPos    = snippet.indexOf('showClientDetail(id)');
  if (dirtyPos === -1) return fail(id, '_dirtyEditor check not present in _navToClient');
  if (showClientPos === -1) return fail(id, 'showClientDetail(id) call not found in _navToClient');
  if (dirtyPos > showClientPos) {
    return fail(id, '_dirtyEditor check appears AFTER showClientDetail — guard is ineffective');
  }
  pass(id, '_dirtyEditor guard precedes showClientDetail(id) inside _navToClient');
})();

// ─── T114-C: _navToClient discards editor changes when confirmed ───────────────
(function testNavToClientDiscardsEdits() {
  const id = 'T114-C';
  const fnIdx = src.indexOf('async function _navToClient(id)');
  if (fnIdx === -1) return fail(id, '_navToClient not found — skipping');
  const snippet = src.slice(fnIdx, fnIdx + 600);
  if (!snippet.includes('_discardEditorChanges()')) {
    return fail(id, '_discardEditorChanges() not called inside _navToClient');
  }
  if (!snippet.includes('markEditorClean()')) {
    return fail(id, 'markEditorClean() not called inside _navToClient');
  }
  pass(id, '_navToClient calls _discardEditorChanges + markEditorClean before navigating');
})();

// ─── T114-D: _navToClient returns early when coach cancels ────────────────────
(function testNavToClientEarlyReturn() {
  const id = 'T114-D';
  const fnIdx = src.indexOf('async function _navToClient(id)');
  if (fnIdx === -1) return fail(id, '_navToClient not found — skipping');
  const snippet = src.slice(fnIdx, fnIdx + 600);
  // Pattern: if (!ok) return;
  if (!(/if\s*\(!ok\)\s*return/.test(snippet))) {
    return fail(id, '_navToClient does not return early when coach cancels the confirm');
  }
  pass(id, '_navToClient returns early on cancel (navigation aborted)');
})();

// ─── T114-E: _renderClientNavBar uses _navToClient (not showClientDetail) ──────
(function testNavBarUsesWrapper() {
  const id = 'T114-E';
  const fnIdx = src.indexOf('function _renderClientNavBar(activeId)');
  if (fnIdx === -1) return fail(id, '_renderClientNavBar not found');
  // Grab function body (up to ~30 lines)
  const snippet = src.slice(fnIdx, fnIdx + 800);
  // The onclick attribute is built as a JS string: 'onclick="_navToClient(\'' + id + '\')"'
  // so in the raw source the substring '_navToClient(' will appear; look for that.
  if (snippet.includes('showClientDetail(\''+'+id+'+'\')')) {
    return fail(id, '_renderClientNavBar still uses showClientDetail() directly — dirty guard is bypassed');
  }
  if (!snippet.includes('_navToClient(')) {
    return fail(id, '_renderClientNavBar does not use _navToClient() in button onclick');
  }
  pass(id, '_renderClientNavBar routes nav-bar clicks through _navToClient');
})();

// ─── T114-F: _navToClient is exposed on window (callable from inline onclick) ──
(function testNavToClientOnWindow() {
  const id = 'T114-F';
  if (!src.includes('window._navToClient = _navToClient')) {
    return fail(id, '_navToClient is not exported to window — onclick will fail');
  }
  pass(id, 'window._navToClient exposed for onclick handlers');
})();

// ─── T114-G: navClient still has its own dirty guard (regression) ─────────────
(function testNavClientGuardPreserved() {
  const id = 'T114-G';
  const fnIdx = src.indexOf('async function navClient(dir)');
  if (fnIdx === -1) return fail(id, 'navClient function not found');
  const snippet = src.slice(fnIdx, fnIdx + 600);
  if (!snippet.includes('_dirtyEditor')) {
    return fail(id, 'navClient lost its _dirtyEditor guard — regression');
  }
  pass(id, 'navClient retains its own _dirtyEditor guard (no regression)');
})();

console.log('');
if (failed) {
  console.error('One or more T114-H tests FAILED.');
  process.exit(1);
}
console.log('All T114-H tests passed.');
