#!/usr/bin/env node
'use strict';
// T581: offline PROPOSAL of plan <-> catalog links for the Coach to review (it never applies anything).
//   node scripts/propose-plan-catalog-links.cjs <exported-plan.json> [--out <links-proposal.csv>] [--gym smart-fit-san-diego]
// Input: the active plan exported from the Coach (days[].exercises[] with prescriptionExerciseId). Output: a CSV in the format the Coach's
// "Vínculos plan ↔ catálogo" importer reads. Exact (normalized) name matches are pre-marked aprobar=SI; similar names are CANDIDATA (aprobar blank, review!);
// the rest stay unmatched. Local files only: no Firebase, no network.
const fs = require('node:fs');
const ctx = require('../assets/equipment-context.js');
const catalog = require('../assets/exercise-visual-catalog.js');
const idn = require('../assets/equipment-identity.js');

const file = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
if (!file || file.startsWith('--')) { console.error('usage: propose-plan-catalog-links.cjs <exported-plan.json> [--out <csv>] [--gym <gymId>]'); process.exit(2); }
const gymId = arg('gym', 'smart-fit-san-diego'), outFile = arg('out', null);
const plan = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const days = Array.isArray(plan.days) ? plan.days : (plan.plan && Array.isArray(plan.plan.days) ? plan.plan.days : null);
if (!days) { console.error('El JSON no tiene "days".'); process.exit(2); }

const n = idn.normalizeLabel;
const STOP = new Set(['de', 'la', 'el', 'en', 'con', 'y', 'a', 'al', 'del', 'maquina', 'agarre']);
const toks = (s) => new Set(n(s).split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)));
const jac = (a, b) => { let i = 0; a.forEach((x) => { if (b.has(x)) i++; }); return i / (a.size + b.size - i || 1); };
const entries = [];
Object.values(catalog.gyms).forEach((g) => (g.entries || []).concat(g.legacyEntries || []).forEach((e) => entries.push(e)));
const names = (e) => [e.exerciseName, e.name].concat(e.aliases || []).filter(Boolean);
const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

const lines = ['dia,ejercicio,prescriptionExerciseId,tipo_coincidencia,score,catalogExerciseId,catalogNombre,equipo,aprobar'];
const stats = { EXACTA: 0, CANDIDATA: 0, SIN: 0, sinPid: 0 };
days.forEach((d) => (d.exercises || []).forEach((e) => {
  const pid = typeof e.prescriptionExerciseId === 'string' ? e.prescriptionExerciseId : '';
  if (!pid) stats.sinPid++;
  const k = n(e.exerciseName || '');
  let hit = entries.filter((x) => names(x).some((a) => n(a) === k)), type = 'EXACTA', score = 1;
  if (!hit.length) {
    const t = toks(e.exerciseName || '');
    const ranked = entries.map((x) => ({ x, s: Math.max(0, ...names(x).map((a) => jac(t, toks(a)))) })).sort((a, b) => b.s - a.s);
    if (ranked[0] && ranked[0].s >= 0.34) { hit = [ranked[0].x]; type = 'CANDIDATA (revisar)'; score = Math.round(ranked[0].s * 100) / 100; } else { type = 'SIN COINCIDENCIA'; score = 0; }
  }
  if (!hit.length) { stats.SIN++; lines.push([q(d.label || ''), q(e.exerciseName || ''), pid, type, 0, '', '', '', ''].join(',')); return; }
  const ref = ctx.equipmentRefForExercise({ catalog, exerciseId: hit[0].exerciseId, config: ctx.emptyConfig(), gymId });
  if (type === 'EXACTA') stats.EXACTA++; else stats.CANDIDATA++;
  lines.push([q(d.label || ''), q(e.exerciseName || ''), pid, type, score, hit[0].exerciseId, q(hit[0].exerciseName || hit[0].name || ''), q(ref.identity.canonicalName || ref.identity.reason || ''), type === 'EXACTA' && pid ? 'SI' : ''].join(','));
}));
const csv = '﻿' + lines.join('\n') + '\n';
if (outFile) fs.writeFileSync(outFile, csv); else process.stdout.write(csv);
console.error('Ejercicios: ' + (lines.length - 1) + ' · EXACTA ' + stats.EXACTA + ' (aprobar=SI) · CANDIDATA ' + stats.CANDIDATA + ' (revisar a mano) · SIN COINCIDENCIA ' + stats.SIN + (stats.sinPid ? ' · SIN prescriptionExerciseId: ' + stats.sinPid + ' (no se pueden vincular)' : ''));
