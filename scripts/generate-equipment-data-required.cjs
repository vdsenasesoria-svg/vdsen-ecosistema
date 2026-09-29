#!/usr/bin/env node
// T525: docs/EQUIPMENT_DATA_REQUIRED_NEXT.md + docs/equipment-increments-template.csv, generated from the static catalog.
// Ranking = exercise coverage. No numeric values are written anywhere: every value cell is BLANK for the Coach to fill.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const repo = path.resolve(__dirname, '..');
const ctx = require(path.join(repo, 'assets/equipment-context.js')), catalog = require(path.join(repo, 'assets/exercise-visual-catalog.js'));

function build() {
  const queue = ctx.buildEquipmentQueue({ catalog, config: null }).filter(r => r.identityStatus !== 'UNRESOLVED');
  const ranked = queue.slice().sort((a, b) => b.exerciseCount - a.exerciseCount || a.name.localeCompare(b.name));
  const total = ranked.reduce((n, r) => n + r.exerciseCount, 0);
  const tpl = ctx.exportTemplate({ catalog, config: null, format: 'csv' });
  let acc = 0;
  const lines = ['# Datos de equipo requeridos (siguiente paso)', '',
    'Generado por `node scripts/generate-equipment-data-required.cjs`; verificado por `tests/t525-equipment-data-required.test.js`. **No contiene valores numéricos**: el Coach completa solo incrementos REALES de su gimnasio.', '',
    'Hoy 0 equipos tienen incremento; sin ellos no existe ningún candidato de carga ejecutable (la auto-aplicación de REST no depende de esto).', '',
    '## Cómo completarlo', '',
    '1. Coach → Monitor → cola de equipos → exportar plantilla (o usar `docs/equipment-increments-template.csv`, mismas columnas).',
    '2. `kind`: `STEP` (paso + unidad) · `PLATE_LOADED_BAR` (barra + disco mínimo + unidad) · `AVAILABLE_LOADS` (lista de cargas + unidad).',
    '3. Importar con la herramienta masiva (todo o nada; vista previa de impacto antes de guardar).', '',
    '## Prioridad por cobertura de ejercicios', '', '| # | Equipo | Ejercicios | Cobertura acum. | Tipo de dato a completar |', '|---|---|---|---|---|'];
  ranked.forEach((r, i) => { acc += r.exerciseCount; lines.push('| ' + (i + 1) + ' | ' + r.name + ' | ' + r.exerciseCount + ' | ' + Math.round(100 * acc / total) + '% | ' + (/barra ol/i.test(r.name) ? 'barra + disco mínimo + unidad' : 'kind + paso/cargas + unidad') + ' |'); });
  lines.push('', 'Prioridad inmediata: **Mancuernas**, **Barra olímpica**, y luego los equipos siguientes de la tabla. Equipos sin identidad canónica (' + ctx.buildEquipmentQueue({ catalog, config: null }).filter(r => r.identityStatus === 'UNRESOLVED').length + ' grupos) solo se configuran por ejercicio.', '');
  return { ranked, md: lines.join('\n'), csv: tpl.text };
}
if (require.main === module) {
  const o = build(), f = { 'docs/EQUIPMENT_DATA_REQUIRED_NEXT.md': o.md, 'docs/equipment-increments-template.csv': o.csv };
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const k of Object.keys(f)) {
    const p = path.join(repo, k);
    if (check) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== f[k]) { console.error('STALE ' + k); bad = 1; } } else fs.writeFileSync(p, f[k]);
  }
  process.exit(bad);
}
module.exports = { build };
