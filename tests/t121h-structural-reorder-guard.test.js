/**
 * T121-H — Structural reorder guard: protect active-log plans from position shift
 *
 * QA-R4-04: Log keys in vdsen-cliente.html are positional (log_W_D_ei_sN where ei
 * is the exercise index within a day). If a coach reorders exercises in an active plan
 * mid-week, existing log entries display under the wrong exercise.
 *
 * Fix: vdsen-coach.html now guards every operation that can change exercise position
 * in an active plan with _activeLogsExist(). Verified operations:
 *   - _moveExRow (↑↓ buttons) — BLOCKED when active logs exist
 *   - _exDragStart / _exDragOver (drag-and-drop) — BLOCKED when active logs exist
 *   - removeExRow — BLOCKED when active logs exist (deletion shifts subsequent indices)
 *   - showUpdatePlanModal apply — BLOCKED when per-day exercise count changes + logs exist;
 *                                  WARNING + confirmation when same count but possible reorder
 *
 * Safe operations confirmed unblocked:
 *   - addExRow — appends to END of day, never changes existing indices
 *
 * Run: node tests/t121h-structural-reorder-guard.test.js
 */
var assert = require('assert');
var fs = require('fs');
var PASS = 0, FAIL = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS ' + name); PASS++; }
  catch(e) { console.error('  FAIL ' + name + ' — ' + e.message); FAIL++; }
}

var src = fs.readFileSync(__dirname + '/../vdsen-coach.html', 'utf8');

function extractFnBody(src, fnDecl) {
  var idx = src.indexOf(fnDecl);
  if (idx === -1) return null;
  var start = src.indexOf('{', idx);
  var depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return src.slice(start, i + 1);
}

console.log('T121-H — Structural reorder guard (QA-R4-04)');

// ── _activeLogsExist helper ──

test('_activeLogsExist function is defined', function() {
  assert.ok(src.indexOf('function _activeLogsExist()') > -1, '_activeLogsExist function declaration found');
});

test('_activeLogsExist checks _detailLogsData', function() {
  var body = extractFnBody(src, 'function _activeLogsExist()');
  assert.ok(body, '_activeLogsExist body extracted');
  assert.ok(body.indexOf('_detailLogsData') > -1, 'references _detailLogsData');
});

test('_activeLogsExist returns false when _detailLogsData is null', function() {
  var body = extractFnBody(src, 'function _activeLogsExist()');
  assert.ok(body, '_activeLogsExist body extracted');
  assert.ok(
    body.indexOf('if (!_detailLogsData) return false') > -1,
    'returns false when _detailLogsData is null'
  );
});

test('_activeLogsExist checks entries and returns Object.keys length', function() {
  var body = extractFnBody(src, 'function _activeLogsExist()');
  assert.ok(body, '_activeLogsExist body extracted');
  assert.ok(
    body.indexOf('entries') > -1,
    'references entries field'
  );
  assert.ok(
    body.indexOf('Object.keys(entries).length') > -1,
    'checks Object.keys(entries).length'
  );
});

test('_activeLogsExist is exported to window', function() {
  assert.ok(
    src.indexOf('window._activeLogsExist = _activeLogsExist') > -1,
    'window._activeLogsExist export found'
  );
});

// ── _moveExRow guard ──

test('_moveExRow checks _activeLogsExist before reordering', function() {
  var body = extractFnBody(src, 'function _moveExRow(btn, dir)');
  assert.ok(body, '_moveExRow body extracted');
  assert.ok(
    body.indexOf('_activeLogsExist') > -1,
    '_moveExRow contains _activeLogsExist check'
  );
});

test('_moveExRow returns early when active logs exist', function() {
  var body = extractFnBody(src, 'function _moveExRow(btn, dir)');
  assert.ok(body, '_moveExRow body extracted');
  // The guard must appear BEFORE the DOM manipulation (insertBefore)
  var guardIdx = body.indexOf('_activeLogsExist');
  var domManipIdx = body.indexOf('insertBefore');
  assert.ok(guardIdx > -1, '_activeLogsExist check present');
  assert.ok(domManipIdx > -1, 'insertBefore present');
  assert.ok(guardIdx < domManipIdx, '_activeLogsExist guard appears before DOM manipulation');
});

test('_moveExRow shows toast when active logs exist', function() {
  var body = extractFnBody(src, 'function _moveExRow(btn, dir)');
  assert.ok(body, '_moveExRow body extracted');
  assert.ok(
    body.indexOf('showToast') > -1,
    '_moveExRow calls showToast when blocking'
  );
});

// ── _exDragStart guard ──

test('_exDragStart checks _activeLogsExist before allowing drag', function() {
  var body = extractFnBody(src, 'function _exDragStart(e)');
  assert.ok(body, '_exDragStart body extracted');
  assert.ok(
    body.indexOf('_activeLogsExist') > -1,
    '_exDragStart contains _activeLogsExist check'
  );
});

test('_exDragStart guard appears before setting _exDragSrc', function() {
  var body = extractFnBody(src, 'function _exDragStart(e)');
  assert.ok(body, '_exDragStart body extracted');
  var guardIdx = body.indexOf('_activeLogsExist');
  var dragSrcIdx = body.indexOf('_exDragSrc = e.currentTarget');
  assert.ok(guardIdx > -1, '_activeLogsExist check present');
  assert.ok(dragSrcIdx > -1, '_exDragSrc assignment present');
  assert.ok(guardIdx < dragSrcIdx, 'guard appears before _exDragSrc assignment');
});

// ── _exDragOver guard ──

test('_exDragOver checks _activeLogsExist before DOM reorder', function() {
  var body = extractFnBody(src, 'function _exDragOver(e)');
  assert.ok(body, '_exDragOver body extracted');
  assert.ok(
    body.indexOf('_activeLogsExist') > -1,
    '_exDragOver contains _activeLogsExist check'
  );
});

test('_exDragOver guard appears before insertBefore', function() {
  var body = extractFnBody(src, 'function _exDragOver(e)');
  assert.ok(body, '_exDragOver body extracted');
  var guardIdx = body.indexOf('_activeLogsExist');
  var domIdx = body.indexOf('insertBefore');
  assert.ok(guardIdx > -1, '_activeLogsExist check present');
  assert.ok(domIdx > -1, 'insertBefore present');
  assert.ok(guardIdx < domIdx, 'guard appears before DOM manipulation');
});

// ── removeExRow guard ──

test('removeExRow checks _activeLogsExist before deleting exercise', function() {
  var body = extractFnBody(src, 'async function removeExRow(di, ei)');
  assert.ok(body, 'removeExRow body extracted');
  assert.ok(
    body.indexOf('_activeLogsExist') > -1,
    'removeExRow contains _activeLogsExist check'
  );
});

test('removeExRow guard appears before el.remove()', function() {
  var body = extractFnBody(src, 'async function removeExRow(di, ei)');
  assert.ok(body, 'removeExRow body extracted');
  var guardIdx = body.indexOf('_activeLogsExist');
  var removeIdx = body.indexOf('el.remove()');
  assert.ok(guardIdx > -1, '_activeLogsExist check present');
  assert.ok(removeIdx > -1, 'el.remove() present');
  assert.ok(guardIdx < removeIdx, 'guard appears before el.remove()');
});

test('removeExRow shows toast when active logs exist', function() {
  var body = extractFnBody(src, 'async function removeExRow(di, ei)');
  assert.ok(body, 'removeExRow body extracted');
  assert.ok(
    body.indexOf('showToast') > -1,
    'removeExRow calls showToast when blocking'
  );
});

// ── showUpdatePlanModal structural guard ──

test('showUpdatePlanModal checks _activeLogsExist when applying update', function() {
  var fnIdx = src.indexOf('async function showUpdatePlanModal(');
  assert.ok(fnIdx > -1, 'showUpdatePlanModal found');
  var fnEnd = src.indexOf('\n  async function ', fnIdx + 10);
  var fnChunk = fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 8000);
  assert.ok(
    fnChunk.indexOf('_activeLogsExist') > -1,
    'showUpdatePlanModal contains _activeLogsExist check'
  );
});

test('showUpdatePlanModal blocks when per-day exercise count differs with active logs', function() {
  var fnIdx = src.indexOf('async function showUpdatePlanModal(');
  assert.ok(fnIdx > -1, 'showUpdatePlanModal found');
  var fnEnd = src.indexOf('\n  async function ', fnIdx + 10);
  var fnChunk = fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 8000);
  // Check that curExCounts and newExCounts comparison exists
  assert.ok(
    fnChunk.indexOf('curExCounts') > -1,
    'curExCounts variable present (per-day exercise count check)'
  );
  assert.ok(
    fnChunk.indexOf('newExCounts') > -1,
    'newExCounts variable present (per-day exercise count check)'
  );
  assert.ok(
    fnChunk.indexOf('exCountMismatch') > -1,
    'exCountMismatch variable present'
  );
});

test('showUpdatePlanModal warns and requires second confirmation when same count but logs exist', function() {
  var fnIdx = src.indexOf('async function showUpdatePlanModal(');
  assert.ok(fnIdx > -1, 'showUpdatePlanModal found');
  var fnEnd = src.indexOf('\n  async function ', fnIdx + 10);
  var fnChunk = fnEnd > -1 ? src.slice(fnIdx, fnEnd) : src.slice(fnIdx, fnIdx + 8000);
  // Two-click confirmation: dataset.logsWarned
  assert.ok(
    fnChunk.indexOf('logsWarned') > -1,
    'logsWarned dataset flag present for two-click confirmation'
  );
});

// ── addExRow is NOT guarded (safe: appends to end) ──

test('addExRow does NOT check _activeLogsExist (safe append-to-end)', function() {
  var body = extractFnBody(src, 'function addExRow(di)');
  assert.ok(body, 'addExRow body extracted');
  assert.ok(
    body.indexOf('_activeLogsExist') === -1,
    'addExRow does NOT contain _activeLogsExist check (adding to end is safe)'
  );
});

test('addExRow uses list.children.length as new index (appends to end)', function() {
  var body = extractFnBody(src, 'function addExRow(di)');
  assert.ok(body, 'addExRow body extracted');
  assert.ok(
    body.indexOf('list.children.length') > -1,
    'addExRow uses list.children.length as exercise index (confirms end-append)'
  );
});

// ── removeExercise (manual plan builder) is NOT guarded — it's for new plans ──

test('removeExercise (manual builder) is distinct from removeExRow (inline editor)', function() {
  // removeExercise works on manualPlan (new plan, never yet active)
  // removeExRow works on the inline training editor (active plan)
  assert.ok(
    src.indexOf('function removeExercise(di, ei)') > -1,
    'removeExercise (manual builder) found'
  );
  assert.ok(
    src.indexOf('async function removeExRow(di, ei)') > -1,
    'removeExRow (inline editor) found'
  );
  // removeExercise operates on manualPlan, not an active plan
  var body = extractFnBody(src, 'function removeExercise(di, ei)');
  assert.ok(body, 'removeExercise body extracted');
  assert.ok(
    body.indexOf('manualPlan') > -1,
    'removeExercise references manualPlan (new plan, never activated)'
  );
});

console.log('\n' + PASS + '/' + (PASS + FAIL) + ' passed' + (FAIL ? ' — ' + FAIL + ' FAILED' : ''));
if (FAIL > 0) process.exit(1);
