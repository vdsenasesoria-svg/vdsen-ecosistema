#!/usr/bin/env node
// T510: activation-readiness report per canonical equipment, ranked by static catalog usage (no production data is
// read). Generated from the same queue the Coach sees; verified by tests/t510-equipment-readiness-queue.test.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const ctx = require(path.join(repo, 'assets/equipment-context.js'));
const catalog = require(path.join(repo, 'assets/exercise-visual-catalog.js'));

function render(queue) {
  const c = s => queue.filter(r => r.status === s).length;
  const lines = ['# Preparación de equipos para activación', '',
    'Generado por `node scripts/equipment-readiness-report.cjs` (sin datos de producción; ranking por uso en el catálogo estático).',
    'Cada fila es un equipo canónico (o un grupo de etiqueta sin identidad). Un equipo está `READY` solo con identidad resuelta e incremento explícito con fuente.', '',
    '- Equipos / grupos: **' + queue.length + '**',
    '- READY: **' + c('READY') + '** · INCREMENT_UNRESOLVED: **' + c('INCREMENT_UNRESOLVED') + '** · IDENTITY_UNRESOLVED: **' + c('IDENTITY_UNRESOLVED') + '**', '',
    '| # | Equipo | equipmentId | Sede | Alias | Ejercicios | Identidad | Incremento | Estado | Falta |', '|---|---|---|---|---|---|---|---|---|---|'];
  queue.forEach((r, i) => lines.push('| ' + [i + 1, r.name, r.equipmentId || '—', r.gymId || '—', r.aliases.join(' / '), r.exerciseCount,
    r.identityStatus + (r.identityReason ? ' (' + r.identityReason + ')' : ''), r.incrementState + (r.incrementSource ? ' · ' + r.incrementSource : ''), r.status, r.missing.join('; ') || '—'].join(' | ') + ' |'));
  lines.push('');
  return lines.join('\n');
}
const build = () => ctx.buildEquipmentQueue({ catalog, config: null });
module.exports = { build, render };
if (require.main === module) {
  const target = path.join(repo, 'docs', 'EQUIPMENT_ACTIVATION_READINESS.md');
  const out = render(build());
  if (process.argv.includes('--check')) process.exit(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === out ? 0 : 1);
  fs.writeFileSync(target, out); console.log('wrote docs/EQUIPMENT_ACTIVATION_READINESS.md');
}
