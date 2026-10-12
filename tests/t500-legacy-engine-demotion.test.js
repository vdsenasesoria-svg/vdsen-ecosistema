// T500: compatibility recommendation paths never control an athlete input or
// prescription. The PID-exact, read-only next-exposure surface is covered by
// T558; legacy cards, positional references and operational application remain removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'vdsen-cliente.html'), 'utf8');
const coach = fs.readFileSync(path.join(__dirname, '..', 'vdsen-coach.html'), 'utf8');
const fn = (name) => { const i = client.indexOf('function ' + name + '('); assert.ok(i >= 0, name); return client.slice(i, client.indexOf('\n}\n', i) + 3); };

test('T500.1 legacy recommendation surfaces remain removed from the client', () => {
  for (const n of ['_buildNextExposureHtml', 'headerRecHtml', 'addSetsBannerHtml', 'RECOMENDACIÓN · NO APLICADA',
    'Recomendación (no aplicada)', 'El algoritmo recomienda', 'RECOMENDACIÓN (NO APLICADA)'])
    assert.ok(!client.includes(n), n);
});

test('T500.2 (T551) per-set reference shows only executed PID-exact history, never a recommended load', () => {
  const ctx = { _prevWeekReuseHtml: (key, unit) => '<button>USAR CARGA/REPS</button>' };
  vm.createContext(ctx);
  vm.runInContext(fn('_buildSetReferenceHtml') + '\nthis.f=_buildSetReferenceHtml;', ctx);
  assert.equal(ctx.f(null, null, 0, 'kg', 2, 3, undefined, ''), '', 'no key -> no reference block');
  assert.ok(!client.includes('function _buildSetReferenceHtml(progRec'), 'no recommendation parameter');
  const html = ctx.f({ carga: '80', unit: 'kg', reps: '8', rir_real: 2 }, null, 0, 'kg', 2, 3, undefined, 'k');
  assert.ok(html.includes('USAR CARGA/REPS') && !html.includes('80'), 'the positional `prev` argument is ignored; only the canonical resolver feeds the control');
  assert.ok(!html.includes('99'));
});

test('T500.3 post-session summary shows fatigue signals as informational, never recommendation rows', () => {
  const ctx = { _escHTml: (s) => String(s) };
  vm.createContext(ctx);
  vm.runInContext(fn('_buildProgreSummaryHtml') + '\nthis.f=_buildProgreSummaryHtml;', ctx);
  const rows = ctx.f({ recommendations: [{ action: 'increase_load', newLoad: 82.5, exerciseName: 'Remo' }], deloadTriggers: [] });
  assert.equal(rows, '', 'recommendations alone render nothing');
  const sig = ctx.f({ recommendations: [{ action: 'increase_load', newLoad: 82.5, exerciseName: 'Remo' }], deloadTriggers: ['EIMD alto'] });
  assert.ok(sig.includes('EIMD alto') && /INFORMATIVO/i.test(sig));
  assert.ok(!/AUMENTAR|82\.5|MANTENER|REDUCIR|SERIES|NO APLICADA/.test(sig));
});

test('T500.4 the legacy compatibility adapter has no UI consumer', () => {
  const calls = client.split('_getProgRecForExercise(').length - 1;
  assert.equal(calls, 1, 'only the definition remains (compat adapter, no UI consumer)');
  assert.ok(!client.includes('progHtml') && !client.includes('ÚLTIMA RECOMENDACIÓN'));
});

test('T500.5 legacy engine still produces progrec evidence (compatibility), Coach shows it only as collapsed legacy evidence', () => {
  assert.ok(client.includes("LOGS['progrec_'+CURRENT_WEEK+'_'+di]"));
  assert.ok(/<details[^>]*id="_legacyProgEvidence"/.test(coach));
});
