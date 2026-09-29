// T487: the legacy recommendation-apply infrastructure is gone; live PID helpers are kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const count = (src, s) => src.split(s).length - 1;

test('T487.1 removed Coach apply infrastructure has no definition, export, caller or button', () => {
  for (const name of ['_applyRecLoadsToMonitor', '_applyAllModuloD', '_buildRecApplyPreview', '_confirmApplyRecModal',
    '_resolveExerciseInFreshPlan', '_buildPlanChangeSummary', '_findDayByIndex', '_normN20', '_moduloDPending', '_moduloDDayIndex',
    'applyRecLoadsBtn', '_mon-apply-single', 'Aplicar ajustes al plan', 'Aplicar cargas al plan'])
    assert.ok(!coach.includes(name), name);
});

test('T487.2 removed Client legacy gates/banners have no trace', () => {
  for (const name of ['_buildSessionTargetBanner', '_isFreshPidProgRec', '_progAutoApply', '_progRecStale', '_progCargaConv', '_progRepsApply'])
    assert.ok(!client.includes(name), name);
});

test('T487.3 live PID helpers were kept and still have runtime callers', () => {
  assert.ok(count(coach, '_resolveExerciseRowId(') >= 2, '_resolveExerciseRowId defined and called (AUTO OPEN action)');
  assert.ok(count(coach, '_deepLinkToExercise(') >= 3, '_deepLinkToExercise defined, exported and called');
  assert.ok(coach.includes('return pidCount === 1 ? foundByPid : null;'));
  assert.ok(count(client, '_getProgRecForExercise(') >= 3, 'informational recommendation lookup remains in use');
});

test('T487.4 both apps still parse after the removals', () => {
  for (const src of [coach, client]) {
    const re = /<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g;
    let m, n = 0;
    while ((m = re.exec(src))) { if (m[1].trim()) { n++; assert.doesNotThrow(() => new vm.Script(m[1])); } }
    assert.ok(n >= 1);
  }
});
