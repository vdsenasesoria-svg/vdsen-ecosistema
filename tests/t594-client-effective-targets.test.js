'use strict';
// Issue #124: the Client must expose the exact effective set target before
// execution.  This is intentionally independent from the progression engine:
// it protects the display boundary and proves that missing evidence never
// becomes a fabricated load or repetition range.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
function render(setSpec, provenance, unit, isIsometric) {
  const context = { Number, String, Object, _escHTml: value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])) };
  vm.createContext(context);
  vm.runInContext(fn('_effectiveSetTargetHtml'), context);
  return context._effectiveSetTargetHtml(setSpec, provenance, unit, isIsometric);
}

test('T594.1 Coach structure is explicit before an ordinary homogeneous set without claiming numerical load authority', () => {
  const html = render({ load: 100, repsTarget: 8, rirTarget: 2 }, 'COACH', 'KG', false);
  assert.match(html, /data-effective-target="1"/);
  assert.match(html, /data-target-source="COACH"/);
  assert.match(html, /ESTRUCTURA COACH/);
  assert.doesNotMatch(html, /CARGA 100 KG/);
  assert.match(html, />8<\/b> reps/);
  assert.match(html, /RIR 2/);
});

test('T594.2 canonical overlay targets identify VDSEN auto-adjustment without changing their values', () => {
  const html = render({ load: 102.5, repsTarget: 10, rirTarget: 1 }, 'AUTOAJUSTE VDSEN', 'KG', false);
  assert.match(html, /data-target-source="AUTOAJUSTE VDSEN"/);
  assert.match(html, /OBJETIVO AUTOAJUSTE VDSEN/);
  assert.match(html, /CARGA 102.5 KG/);
  assert.match(html, />10<\/b> reps/);
  assert.match(html, /RIR 1/);
});

test('T594.3 absent load and incomplete metadata stay explicitly absent; no numeric range or load is invented', () => {
  const html = render({ load: 0, repsTarget: 8 }, 'COACH', 'LB', false);
  assert.match(html, /ESTRUCTURA COACH/);
  assert.doesNotMatch(html, /CARGA/);
  assert.match(html, />8<\/b> reps/);
  assert.doesNotMatch(html, /RIR/);
  assert.doesNotMatch(html, /\d+[-–]\d+/);
  assert.equal(render(null, 'COACH', 'KG', false), '');
});

test('T594.4 the live per-set card invokes the target renderer for every set, not only heterogeneous programming', () => {
  const card = source.slice(source.indexOf('function _buildExCard('), source.indexOf('function _buildExCard(') + 60000);
  const target = "var _setTargetHtml = _effectiveSetTargetHtml(setSpec, _ovEff ? 'AUTOAJUSTE VDSEN' : 'COACH', unit, isIsometric,";
  const targetAt = card.indexOf(target);
  assert.ok(targetAt >= 0, 'per-set target renderer is wired');
  assert.doesNotMatch(card, /if \(_isHeteroSets && _psReps/);
  assert.ok(card.indexOf("'<div class=\"sp-fields\">'", targetAt) > targetAt, 'target appears before the execution inputs');
});

test('T594.5 the renderer is display-only: it does not derive recommendations or mutate logbook state', () => {
  const body = fn('_effectiveSetTargetHtml');
  for (const forbidden of ['LOGS', 'saveLogs', 'completeSet', 'setDoc', 'updateDoc', 'repsRange', 'Math.round']) assert.ok(!body.includes(forbidden), forbidden);
});
