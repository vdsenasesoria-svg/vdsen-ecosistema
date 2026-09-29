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

function identityStatus(entry, functionalByLabel) {
  if (entry.equipmentId) return 'EXPLICIT_EQUIPMENT_ID';
  const label = String(entry.equipment || '').trim().toLowerCase();
  if (functionalByLabel[label]) return 'LABEL_MATCHES_FUNCTIONAL_EQUIPMENT';
  return 'NO_EQUIPMENT_ID';
}

function incrementStatus(entry, gymId, equipmentId) {
  const meta = resolver.lookupIncrement(null, gymId, equipmentId) || entry.loadIncrement || null;
  if (!meta) return { state: 'NONE', source: null };
  const grid = resolver.describeGrid(meta, meta.unit);
  return grid.ok ? { state: 'EXPLICIT_' + meta.kind, source: meta.source } : { state: 'INVALID_' + grid.reason, source: meta.source || null };
}

function buildInventory(cat) {
  cat = cat || catalog;
  const functionalByLabel = {};
  (cat.functionalEquipment || []).forEach(f => {
    [f.name].concat(f.aliases || []).forEach(l => { functionalByLabel[String(l).trim().toLowerCase()] = f.equipmentId; });
  });
  const rows = new Map();
  const seenGyms = new Set();
  Object.keys(cat.gyms || {}).forEach(gymKey => {
    const gym = cat.gyms[gymKey];
    const gymId = gym.gymId || gymKey;
    if (seenGyms.has(gymId)) return; // bugambilias shares the San Diego catalog object
    seenGyms.add(gymId);
    (gym.entries || []).concat(gym.legacyEntries || []).forEach(entry => {
      const identity = identityStatus(entry, functionalByLabel);
      const equipmentId = entry.equipmentId || (identity === 'LABEL_MATCHES_FUNCTIONAL_EQUIPMENT' ? functionalByLabel[String(entry.equipment).trim().toLowerCase()] : null);
      const inc = incrementStatus(entry, gymId, equipmentId);
      const key = [gymId, entry.equipment, entry.equipmentType, equipmentId || ''].join('|');
      const row = rows.get(key) || { gymId, gym: gym.gym, equipment: entry.equipment, equipmentType: entry.equipmentType,
        equipmentId: equipmentId, identity, incrementState: inc.state, incrementSource: inc.source, exercises: [] };
      row.exercises.push(entry.exerciseId);
      rows.set(key, row);
    });
  });
  (cat.functionalEquipment || []).forEach(f => {
    const gymId = null;
    const key = ['functional', f.name, f.equipmentType, f.equipmentId].join('|');
    if (![...rows.values()].some(r => r.equipmentId === f.equipmentId)) {
      const inc = incrementStatus(f, gymId, f.equipmentId);
      rows.set(key, { gymId: null, gym: '(functional equipment, all gyms)', equipment: f.name, equipmentType: f.equipmentType,
        equipmentId: f.equipmentId, identity: 'EXPLICIT_EQUIPMENT_ID', incrementState: inc.state, incrementSource: inc.source, exercises: [] });
    }
  });
  return [...rows.values()].sort((a, b) => (a.gymId || '').localeCompare(b.gymId || '') || a.equipment.localeCompare(b.equipment) ||
    String(a.equipmentId).localeCompare(String(b.equipmentId)));
}

function renderMarkdown(rows) {
  const total = rows.length, resolved = rows.filter(r => /^EXPLICIT_/.test(r.incrementState)).length;
  const lines = [
    '# Inventario de metadatos de incremento de carga por equipo',
    '',
    'Generado por `node scripts/equipment-increment-inventory.cjs` (solo lectura; verificado por `tests/t501-equipment-inventory.test.js`).',
    'Solo cuenta un incremento **explícito con fuente** (`loadIncrement.kind` = STEP | PLATE_LOADED_BAR | AVAILABLE_LOADS y `source` =',
    'EXERCISE_METADATA | GYM_METADATA | COACH_CONFIGURED). El tipo de equipo nunca establece un incremento.',
    '',
    '- Equipos/etiquetas inventariados: **' + total + '**',
    '- Con incremento explícito y fuente: **' + resolved + '**',
    '- Sin incremento (`UNRESOLVED_EQUIPMENT_INCREMENT`): **' + (total - resolved) + '**',
    '',
    '| Sede (gymId) | Equipo | Tipo | equipmentId | Identidad | Incremento | Fuente | Ejercicios |',
    '|---|---|---|---|---|---|---|---|'
  ];
  rows.forEach(r => lines.push('| ' + [r.gymId || '—', r.equipment, r.equipmentType, r.equipmentId || '—', r.identity, r.incrementState,
    r.incrementSource || '—', r.exercises.length].join(' | ') + ' |'));
  lines.push('', '## Datos que el Coach debe aportar (por equipo, solo valores reales)', '',
    '- `STEP`: paso del stack/placa integrada (`step`), mínimo/máximo opcional (`min`/`max`) y `unit`.',
    '- `PLATE_LOADED_BAR`: peso de la barra/brazo (`barWeight`), disco más pequeño (`smallestPlate`), `max` opcional y `unit`.',
    '- `AVAILABLE_LOADS`: lista de cargas disponibles (mancuernas / implementos fijos) y `unit`.',
    '- Cada valor se configura en el editor de incremento del Coach (T502) y queda con `source: COACH_CONFIGURED`.',
    '- Los equipos sin `equipmentId` explícito quedan identificados por ejercicio (`exercise:<id>`) hasta que se les asigne uno.', '');
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
