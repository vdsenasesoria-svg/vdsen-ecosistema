'use strict';
// T580: the offline equipment-increment validator uses the Coach's own import parser, is all-or-nothing, and never touches Firebase or the network.
// All numbers below are SYNTHETIC fixtures for the test; they describe no real gym equipment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'validate-equipment-increments.cjs');
const PILOT = path.join(__dirname, '..', 'docs', 'pilot', 'equipment-increments-pilot-template.csv');
const HEADER = 'equipmentId,name,scope,gymId,kind,unit,step,min,max,barWeight,smallestPlate,loads\n';
const run = (file, extra) => spawnSync(process.execPath, [SCRIPT, file].concat(extra || []), { encoding: 'utf8' });
const tmp = (name, body) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vdsen-t580-')); const f = path.join(d, name); fs.writeFileSync(f, body); return f; };

test('T580.1 the shipped pilot template is valid, has only blank value cells and unlocks nothing by itself', () => {
  const rows = fs.readFileSync(PILOT, 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(','));
  assert.equal(rows.length, 5, 'five priority equipment rows');
  rows.forEach(r => assert.ok(r.slice(4).every(c => c === ''), 'no invented numbers: ' + r[0]));
  const out = run(PILOT);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /omitidos \(en blanco\) 5/);
  assert.match(out.stdout, /LOAD seguirá bloqueado/);
});

test('T580.2 a valid synthetic file is accepted and reports the exercises each equipment unlocks; --out writes a COACH_CONFIGURED config', () => {
  const f = tmp('ok.csv', HEADER +
    'functional-dumbbells,Mancuernas,SHARED,,AVAILABLE_LOADS,KG,,,,,,10 12.5 15 17.5 20\n' +
    'functional-olympic-barbell,Barra olímpica,SHARED,,PLATE_LOADED_BAR,KG,,,,20,1.25,\n' +
    'functional-cable-station,Estación de Poleas,SHARED,,STEP,KG,5,0,100,,,\n');
  const outFile = path.join(path.dirname(f), 'config.json');
  const out = run(f, ['--out', outFile]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /VÁLIDO — agregados 3/);
  assert.match(out.stdout, /ADDED\s+functional-dumbbells.*: 14/, 'counts come from the same queue that produced docs/EQUIPMENT_DATA_REQUIRED_NEXT.md');
  assert.match(out.stdout, /ADDED\s+functional-olympic-barbell.*: 12/);
  const cfg = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(Object.keys(cfg.shared).length, 3);
  assert.equal(cfg.shared['functional-cable-station'].source, 'COACH_CONFIGURED');
  assert.equal(cfg.shared['functional-cable-station'].step, 5);
});

test('T580.3 one invalid row rejects the whole file (all or nothing) with a readable reason, exit 1', () => {
  const cases = [
    ['negative step', 'functional-cable-station,Estación de Poleas,SHARED,,STEP,KG,-5,,,,,'],
    ['missing unit', 'functional-cable-station,Estación de Poleas,SHARED,,STEP,,5,,,,,'],
    ['unknown equipment', 'not-a-real-equipment,Algo,SHARED,,STEP,KG,5,,,,,'],
    ['unknown kind', 'functional-cable-station,Estación de Poleas,SHARED,,MAGIC,KG,5,,,,,'],
  ];
  for (const [label, row] of cases) {
    const f = tmp('bad.csv', HEADER + 'functional-dumbbells,Mancuernas,SHARED,,AVAILABLE_LOADS,KG,,,,,,10 15\n' + row + '\n');
    const out = run(f);
    assert.equal(out.status, 1, label + '\n' + out.stdout + out.stderr);
    assert.match(out.stdout, /INVÁLIDO — no se aplicaría nada/, label);
    assert.match(out.stdout, /✗/, label);
  }
});

test('T580.4 usage error exits 2; the script reads local files only (no Firebase, no network)', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/firebase|fetch\(|https?:\/\/|XMLHttpRequest|child_process/.test(src.replace(/^\/\/.*$/gm, '')), 'no network / SDK / process spawning');
});
