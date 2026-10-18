#!/usr/bin/env node
'use strict';
// T580: offline validator for the Coach's equipment-increment file (CSV from docs/pilot/ or JSON from the Coach export).
//   node scripts/validate-equipment-increments.cjs <file.csv|file.json> [--out <config.json>]
// Uses the SAME parser the Coach bulk import uses (assets/equipment-context.js parseImport): all-or-nothing, strict, nothing defaulted.
// It reads local files only: no Firebase, no network, no writes except the optional --out file. Exit 0 = valid, 1 = errors, 2 = usage.
const fs = require('node:fs');
const path = require('node:path');
const ctx = require('../assets/equipment-context.js');
const catalog = require('../assets/exercise-visual-catalog.js');

const file = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
if (!file || file.startsWith('--')) { console.error('usage: validate-equipment-increments.cjs <file.csv|file.json> [--out <config.json>]'); process.exit(2); }

const text = fs.readFileSync(file, 'utf8');
const res = ctx.parseImport(text, { catalog, config: ctx.emptyConfig(), uid: 'offline-validator', now: new Date().toISOString() });

// exercises per canonical equipment id (how many catalog exercises each configured row would unlock for LOAD)
const perEquipment = {};
ctx.buildEquipmentQueue({ catalog, config: ctx.emptyConfig() }).forEach((q) => { if (q.equipmentId) perEquipment[q.equipmentId] = q.exerciseCount; });

console.log('Archivo: ' + path.basename(file));
if (!res.ok) {
  console.log('RESULTADO: INVÁLIDO — no se aplicaría nada (todo o nada).');
  res.errors.forEach((e) => console.log('  ✗ ' + e));
  process.exit(1);
}
const c = res.counts;
console.log('RESULTADO: VÁLIDO — agregados ' + c.added + ' · cambiados ' + c.changed + ' · quitados ' + c.removed + ' · sin cambio ' + c.unchanged + ' · omitidos (en blanco) ' + c.skipped);
res.rows.forEach((r) => {
  if (r.action === 'ADDED' || r.action === 'CHANGED' || r.action === 'REMOVED') {
    console.log('  ' + r.action.padEnd(8) + r.equipmentId + (r.scope === 'GYM' ? ' [' + r.gymId + ']' : '') + ' — ejercicios del catálogo con este equipo: ' + (perEquipment[r.equipmentId] || 0));
  }
});
if (!(c.added + c.changed)) console.log('  (ninguna fila con valores: la plantilla sigue en blanco; sin incrementos LOAD seguirá bloqueado)');
if (outFile) {
  fs.writeFileSync(outFile, JSON.stringify(res.nextConfig, null, 2) + '\n');
  console.log('Config resultante escrita en ' + outFile + ' (formato coaches/{uid}.equipmentIncrements; este script NO la sube a Firestore).');
}
process.exit(0);
