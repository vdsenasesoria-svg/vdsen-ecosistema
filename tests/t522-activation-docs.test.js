// T522: activation checklist + readiness report are generated from live facts and stay truthful; Windows validation is never
// emulated (PENDING until a real Windows run is recorded); the flag stays false.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const gen = require(path.join(root, 'scripts/generate-activation-docs.cjs'));

test('T522.1 both documents are generated and current', () => {
  assert.equal(spawnSync(process.execPath, [path.join(root, 'scripts/generate-activation-docs.cjs'), '--check']).status, 0, 'regenerate with: node scripts/generate-activation-docs.cjs');
});

test('T522.2 the checklist contains every required item and only claims what the facts support', () => {
  const c = read('docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md');
  for (const t of ['Identidades de equipo resueltas', 'Incrementos de equipo escritos por el Coach', 'Unidades compatibles', 'Elegibilidad de evidencia', 'Dirección consistente', 'Rama D/E y precedencia C→E resueltas',
    'serie representativa resuelta', 'Exposición destino exacta y no iniciada', 'Sin override del Coach', 'Seguridad despejada', 'Canario sintético', 'Validación del runner T478 en Windows',
    '`NUMERIC_APPLY_ENABLED` cambiado intencionalmente', 'Reversión verificada', 'Auditoría visible para el Coach']) assert.ok(c.includes(t), t);
  const line = t => c.split('\n').find(l => l.includes(t));
  assert.ok(line('Incrementos de equipo').startsWith('- [ ]'), 'no increments are authored');
  assert.ok(line('Rama D/E').startsWith('- [x]') && line('serie representativa').startsWith('- [x]'), 'closed as PRODUCT POLICY');
  assert.ok(/PRODUCT POLICY RESOLVED/.test(line('Rama D/E')) && /LAST_STANDARD_WORKING_SET/.test(line('serie representativa')) && /VDSEN_PRODUCT_POLICY/.test(line('serie representativa')));
  assert.ok(line('Validación del runner T478').startsWith('- [ ]') && /NON_BLOCKING_TECHNICAL_PENDING/.test(line('Validación del runner T478')), 'Windows is never marked PASS');
  assert.ok(line('NUMERIC_APPLY_ENABLED').startsWith('- [ ]'));
  assert.ok(line('Canario').startsWith('- [x]') && line('Reversión').startsWith('- [x]'));
  assert.ok(/17 de 22 cumplidos; pendientes bloqueantes: 4/.test(c) && /NO se activa/.test(c));
});

test('T522.3 the readiness report uses only static / synthetic evidence and states the flag', () => {
  const r = read('docs/AUTO_APPLY_READINESS.md');
  assert.ok(/no hay métricas de producción/.test(r));
  for (const t of ['39 / 41', '69 / 71', '0 / 39', 'NON_BLOCKING_TECHNICAL_PENDING', 'false (apagada en los 4 módulos)', 'solo alcanzable con la bandera activa', 'LAST_STANDARD_WORKING_SET', 'CÓDIGO / POLÍTICA', 'DATOS REALES DE EQUIPO', 'Bloqueos científicos abiertos | 0']) assert.ok(r.includes(t), t);
  const f = gen.facts();
  assert.deepEqual([f.resolvedGroups, f.groups, f.exercisesWithIdentity, f.exercises, f.configured, f.readyGroups], [39, 41, 69, 71, 0, 0]);
  assert.equal(f.rollback, true); assert.equal(f.audit, true); assert.deepEqual(f.flag, [false, false, false, false]);
});

test('T522.4 Windows validation: PENDING record; the recorder refuses to run off Windows (no emulation)', () => {
  const rec = JSON.parse(read('docs/windows-validation.json'));
  assert.equal(rec.status, 'PENDING'); assert.equal(rec.platform, null); assert.ok(Object.values(rec.checks).every(v => v === null));
  if (process.platform !== 'win32') {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/record-windows-validation.cjs')], { encoding: 'utf8' });
    assert.equal(r.status, 2); assert.match(r.stderr, /must run on Windows/);
    assert.equal(JSON.parse(read('docs/windows-validation.json')).status, 'PENDING', 'nothing was recorded');
  }
});

test('T522.5 the runner keeps its Windows-specific handling (static check only; not a substitute for a real Windows run)', () => {
  const s = read('scripts/test-auto-apply-emulator.cjs');
  for (const t of ["npm.cmd", 'taskkill', 'windowsHide: true', "'127.0.0.1'", 'JAR_SHA256', "METADATA_SERVER_DETECTION: 'none'", 'Emulator port']) assert.ok(s.includes(t), t);
  const ps = read('scripts/test-auto-apply-emulator.ps1');
  assert.ok(/test-auto-apply-emulator\.cjs/.test(ps));
});

test('T522.6 the activation flag is untouched by this tooling', () => {
  for (const f of ['scripts/generate-activation-docs.cjs', 'scripts/record-windows-validation.cjs']) assert.ok(!/NUMERIC_APPLY_ENABLED\s*=\s*true/.test(read(f)), f);
  assert.deepEqual(gen.facts().flag, [false, false, false, false]);
});
