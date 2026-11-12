#!/usr/bin/env node
// T501: inventory of the REAL equipment/catalog architecture with respect to load-increment metadata.
// Read-only. Reports, per gym + equipment label, what identity and explicit increment information exists.
// It never infers an increment from the equipment type or label: only explicit, sourced `loadIncrement`
// (kind STEP | PLATE_LOADED_BAR | AVAILABLE_LOADS + source) counts as known.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const catalog = require(path.join(repo, 'assets/exercise-visual-catalog.js'));
const resolver = require(path.join(repo, 'assets/progression-equipment-resolver.js'));
const identity = require(path.join(repo, 'assets/equipment-identity.js'));

function incrementStatus(entry, gymId, equipmentId) {
  const meta = resolver.lookupIncrement(null, gymId, equipmentId) || entry.loadIncrement || null;
  if (!meta) return { state: 'NONE', source: null };
  const grid = resolver.describeGrid(meta, meta.unit);
  return grid.ok ? { state: 'EXPLICIT_' + meta.kind, source: meta.source } : { state: 'INVALID_' + grid.reason, source: meta.source || null };
}

// One row per CANONICAL equipment (equipmentId) or per unresolved label group. Case/accent variants of a label
// (e.g. "Polea alta" / "Polea Alta") are the same identity by exact normalized match.
function buildInventory(cat) {
  cat = cat || catalog;
  const index = identity.buildIndex(cat);
  const rows = new Map();
  const seenGyms = new Set();
  Object.keys(cat.gyms || {}).forEach(gymKey => {
    const gym = cat.gyms[gymKey];
    const gymId = gym.gymId || gymKey;
    if (seenGyms.has(gymId)) return; // bugambilias shares the San Diego catalog object
    seenGyms.add(gymId);
    (gym.entries || []).concat(gym.legacyEntries || []).forEach(entry => {
      const id = identity.identify(index, { equipmentId: entry.equipmentId, exerciseId: entry.exerciseId, label: entry.equipment, gymId });
      const key = id.equipmentId ? id.equipmentId : 'unresolved|' + gymId + '|' + identity.normalizeLabel(entry.equipment);
      const inc = incrementStatus(entry, gymId, id.equipmentId);
      const row = rows.get(key) || { gymId, gym: gym.gym, equipment: id.canonicalName || entry.equipment, equipmentType: id.equipmentType || entry.equipmentType,
        equipmentId: id.equipmentId, identity: id.status, identityReason: id.reason, scope: id.scope, aliases: new Set(),
        incrementState: inc.state, incrementSource: inc.source, exercises: [] };
      row.aliases.add(entry.equipment);
      row.exercises.push(entry.exerciseId);
      rows.set(key, row);
    });
  });
  (cat.functionalEquipment || []).forEach(f => {
    if (![...rows.values()].some(r => r.equipmentId === f.equipmentId)) {
      const inc = incrementStatus(f, null, f.equipmentId);
      rows.set('functional|' + f.equipmentId, { gymId: null, gym: '(functional equipment, all gyms)', equipment: f.name, equipmentType: f.equipmentType,
        equipmentId: f.equipmentId, identity: 'EXPLICIT_ID', identityReason: null, scope: 'FUNCTIONAL', aliases: new Set([f.name].concat(f.aliases || [])),
        incrementState: inc.state, incrementSource: inc.source, exercises: [] });
    }
  });
  return [...rows.values()].map(r => Object.assign(r, { aliases: [...r.aliases].sort() }))
    .sort((a, b) => b.exercises.length - a.exercises.length || (a.gymId || '').localeCompare(b.gymId || '') || a.equipment.localeCompare(b.equipment));
}

function renderMarkdown(rows) {
  const total = rows.length, resolvedId = rows.filter(r => r.identity !== 'UNRESOLVED').length;
  const withInc = rows.filter(r => /^EXPLICIT_/.test(r.incrementState)).length;
  const lines = [
    '# Inventario de identidad y metadatos de incremento por equipo',
    '',
    'Generado por `node scripts/equipment-increment-inventory.cjs` (solo lectura; verificado por `tests/t501-equipment-inventory.test.js`).',
    'Identidad: `equipmentId` exacto > alias canónico exacto (mayúsculas/acentos/espacios normalizados, nunca similitud) > sin resolver.',
    'Solo cuenta un incremento **explícito con fuente** (`loadIncrement.kind` = STEP | PLATE_LOADED_BAR | AVAILABLE_LOADS y `source` =',
    'EXERCISE_METADATA | GYM_METADATA | COACH_CONFIGURED). El tipo de equipo nunca establece un incremento.',
    '',
    '- Equipos canónicos / grupos de etiqueta: **' + total + '**',
    '- Identidad resuelta: **' + resolvedId + '** · sin resolver: **' + (total - resolvedId) + '**',
    '- Con incremento explícito y fuente en el catálogo estático: **' + withInc + '**',
    '',
    '| Sede (gymId) | Equipo | Tipo | equipmentId | Identidad | Motivo sin resolver | Incremento | Fuente | Ejercicios | Alias |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ];
  rows.forEach(r => lines.push('| ' + [r.gymId || '—', r.equipment, r.equipmentType, r.equipmentId || '—', r.identity, r.identityReason || '—', r.incrementState,
    r.incrementSource || '—', r.exercises.length, r.aliases.join(' / ')].join(' | ') + ' |'));
  lines.push('', '## Datos que el Coach debe aportar (por equipo, solo valores reales)', '',
    '- `STEP`: paso del stack/placa integrada (`step`), mínimo/máximo opcional (`min`/`max`) y `unit`.',
    '- `PLATE_LOADED_BAR`: peso de la barra/brazo (`barWeight`), disco más pequeño (`smallestPlate`), `max` opcional y `unit`.',
    '- `AVAILABLE_LOADS`: lista de cargas disponibles (mancuernas / implementos fijos) y `unit`.',
    '- Se configura una vez por equipo (compartido o por sede) o, como excepción, por ejercicio; siempre con `source: COACH_CONFIGURED`.',
    '- Etiquetas sin identidad (familia de máquinas, "Máquina" genérica, accesorio) solo pueden configurarse por ejercicio.', '');
  return lines.join('\n');
}

module.exports = { buildInventory, renderMarkdown };

if (require.main === module) {
  const out = renderMarkdown(buildInventory());
  const target = path.join(repo, 'docs', 'EQUIPMENT_INCREMENT_INVENTORY.md');
  if (process.argv.includes('--check')) { process.exit(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === out ? 0 : 1); }
  fs.writeFileSync(target, out);
  console.log('wrote ' + path.relative(repo, target));
}
