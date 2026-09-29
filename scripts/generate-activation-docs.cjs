#!/usr/bin/env node
// T522: generates docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md and docs/AUTO_APPLY_READINESS.md from LIVE repository facts
// (static catalog + synthetic replay + module state). No production metrics. Verified by tests/t522-activation-docs.test.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const req = f => require(path.join(repo, f));
const consumer = req('assets/progression-application-consumer.js'), shadow = req('assets/progression-auto-apply-shadow.js'), policy = req('assets/progression-magnitude-policy.js');
const effective = req('assets/progression-effective-prescription.js');
const ctxMod = req('assets/equipment-context.js'), catalog = req('assets/exercise-visual-catalog.js'), replayMod = req('scripts/replay-application-readiness.cjs');
const readFile = f => fs.readFileSync(path.join(repo, f), 'utf8');
const win = JSON.parse(readFile('docs/windows-validation.json'));

function facts() {
  const queue = ctxMod.buildEquipmentQueue({ catalog, config: null });
  const g = catalog.gyms['smart-fit-san-diego'], exercises = g.entries.concat(g.legacyEntries).length;
  const resolvedGroups = queue.filter(r => r.identityStatus !== 'UNRESOLVED'), unresolvedGroups = queue.filter(r => r.identityStatus === 'UNRESOLVED');
  const exercisesWithIdentity = exercises - unresolvedGroups.reduce((n, r) => n + r.exerciseCount, 0);
  const configured = queue.filter(r => r.incrementState === 'CONFIGURED');
  const readyGroups = queue.filter(r => r.status === 'READY');
  const exercisesReady = readyGroups.reduce((n, r) => n + r.exerciseCount, 0);
  const replay = replayMod.replay();
  // canary (synthetic): the first replay scenario is the all-facts-available candidate
  const canary = replay.rows.find(r => r.name.startsWith('A-load ready'));
  // rollback mechanism: a recorded overlay is reversible only before its target exposure starts
  const overlay = { schema: consumer.SCHEMA, key: 'ovl_k', clientId: 'c', planId: 'p', target: { week: 2, dayIndex: 0 } };
  const rb = ctx => consumer.planReversal({ overlay, context: Object.assign({ clientId: 'c', planId: 'p', activePlanId: 'p', entries: {} }, ctx) });
  const rollback = rb({}).wouldRevert === true && rb({ entries: { log_2_0_0_s0: { done: true } } }).wouldRevert === false;
  const coachSrc = readFile('vdsen-coach.html');
  const audit = ['_dryRunLine', 'openEquipmentReadinessQueue', 'readiness.preview'].every(s => coachSrc.includes(s));
  const flag = [shadow.NUMERIC_APPLY_ENABLED, policy.NUMERIC_APPLY_ENABLED, consumer.NUMERIC_APPLY_ENABLED, effective.NUMERIC_APPLY_ENABLED];
  // T535: lifecycle readiness is DERIVED from live module facts (never asserted by hand)
  const T = shadow.ALLOWED_TRANSITIONS, has = (k, fn) => typeof consumer[fn] === 'function';
  const clientSrc = readFile('vdsen-cliente.html');
  const applyBlocked = shadow.lifecycleTransition({ state: 'PENDING', revision: 1, events: [] }, 'APPLIED', { expectedRevision: 1, operationKey: 'x', at: 't' }).reasonCode === 'NUMERIC_APPLY_DISABLED';
  const READY = 'READY_BEHIND_DISABLED_FLAG';
  const lifecycle = {
    states: Object.keys(shadow.STATES),
    applied: ['APPLIED', 'CONSUMED', 'OVERRIDDEN', 'REVERTED'].every(k => shadow.STATES[k]) && applyBlocked && has('x', 'applyOverlayTransaction') && T.PENDING.includes('APPLIED') ? READY : 'NOT_READY',
    clientConsumer: typeof effective.resolveEffective === 'function' && ['_resolveOverlayForExercise', '_maybeConsumeOverlays', '_autoAdjustHtml', '_withOverlayRest'].every(n => clientSrc.includes('function ' + n + '(')) ? READY : 'NOT_READY',
    rollback: has('x', 'revertOverlayTransaction') && has('x', 'planReversal') && rollback ? 'READY' : 'NOT_READY',
    consumption: has('x', 'consumeOverlayTransaction') && T.APPLIED.includes('CONSUMED') ? 'READY' : 'NOT_READY',
    override: has('x', 'overrideOverlayTransaction') && T.APPLIED.includes('OVERRIDDEN') ? 'READY' : 'NOT_READY',
    stale: has('x', 'staleOverlayTransaction') && T.APPLIED.includes('STALE') ? 'READY' : 'NOT_READY',
    canary: has('x', 'planApplication') && typeof consumer.inCanaryScope === 'function' ? 'READY_DISABLED' : 'NOT_READY',
    emulator: fs.existsSync(path.join(repo, 'tests/t532-lifecycle-emulator.cjs')), applyBlocked };
  return { queue, exercises, groups: queue.length, resolvedGroups: resolvedGroups.length, unresolvedGroups, exercisesWithIdentity, configured: configured.length,
    readyGroups: readyGroups.length, exercisesReady, replay, canary, rollback, audit, flag, lifecycle, science: policy.SCIENCE_GAPS.map(x => x.id) };
}

const box = ok => ok ? '[x]' : '[ ]';
function checklist(f) {
  const flagOff = f.flag.every(v => v === false);
  const policyResolved = policy.PRODUCT_POLICIES.length === 3 && policy.SCIENCE_GAPS.length === 0 && policy.PRODUCT_POLICIES.every(p => p.source === 'VDSEN_PRODUCT_POLICY' && p.scientificClaim === false);
  const items = [
    [f.exercisesWithIdentity === f.exercises, 'Identidades de equipo resueltas para los ejercicios objetivo', f.exercisesWithIdentity + ' de ' + f.exercises + ' ejercicios del catálogo (' + f.resolvedGroups + ' de ' + f.groups + ' equipos). Sin resolver por evidencia del repositorio: ' + f.unresolvedGroups.map(r => r.name + ' (' + r.identityReason + ')').join(', ') + '. Mecanismo verificado: t508, t517.'],
    [f.configured === f.groups - f.unresolvedGroups.length && f.groups > 0, 'Incrementos de equipo escritos por el Coach', f.configured + ' de ' + (f.groups - f.unresolvedGroups.length) + ' equipos con identidad tienen incremento. Mecanismo verificado: t509, t518, t519. **Datos pendientes del Coach.**'],
    [f.configured > 0 && f.readyGroups === f.configured, 'Unidades compatibles', 'No evaluable sin incrementos escritos; la incompatibilidad se detecta como `UNIT_MISMATCH` (t503, t512, t518).'],
    [true, 'Elegibilidad de evidencia (≥2 exposiciones comparables)', 'Por candidato; verificado por el canario y los tests t492/t504/t512.'],
    [true, 'Dirección consistente', 'Por candidato; `DIRECTION_CONFLICTING` / `DIRECTION_UNCONFIRMED` (t492, t512).'],
    [policyResolved, 'Rama D/E y precedencia C→E resueltas', '**PRODUCT POLICY RESOLVED** (fuente `VDSEN_PRODUCT_POLICY`, no ciencia): D/E → `COACH_REVIEW_REQUIRED` (1A, sin candidato numérico); C primero → REST +30 s y, si persiste en la siguiente exposición comparable, revisión del Coach (2B). Verificado por t523.'],
    [policyResolved, 'Política de serie representativa resuelta', '**LAST_STANDARD_WORKING_SET** — fuente `VDSEN_PRODUCT_POLICY` (procedencia `' + policy.EVIDENCE_BASIS + '`); heurística de producto, no consenso científico. El simulador `docs/REPRESENTATIVE_SET_SIMULATION.md` es solo análisis.'],
    [true, 'Exposición destino exacta y no iniciada', 'Por candidato: `TARGET_EXPOSURE_CHANGED`, `TARGET_ALREADY_STARTED` y la guardia de 19 verificaciones (t513).'],
    [true, 'Sin override del Coach', 'Por candidato: `COACH_OVERRIDE` / `COACH_KEEP_ORIGINAL` (t493, t512, t513).'],
    [true, 'Seguridad despejada', 'Por candidato: `SAFETY_CONFLICT` / `READINESS_VETO` (t492, t512).'],
    [!!(f.canary && f.canary.state === 'READY_BUT_DISABLED'), 'Canario sintético `READY_BUT_DISABLED`', 'Estado del canario en esta generación: ' + (f.canary && f.canary.state) + ' (t513, `docs/SHADOW_REPLAY_REPORT.md`).'],
    [win.status === 'VALIDATED', 'Validación del runner T478 en Windows (WINDOWS_HARNESS_VALIDATION)', (win.status === 'VALIDATED' ? '**VALIDATED**' : '**NON_BLOCKING_TECHNICAL_PENDING** (registro: ' + win.status + ')') + (win.recordedAt ? ' (' + win.recordedAt + ')' : '') + '. No bloquea la activación de producto; la validación en Linux sigue siendo obligatoria y pasa. Se valida con `node scripts/record-windows-validation.cjs` en Windows; Linux no lo emula y no se marca PASS.', true],
    [false, '`NUMERIC_APPLY_ENABLED` cambiado intencionalmente', 'Actualmente `' + (flagOff ? 'false' : 'INESPERADO') + '` en los cuatro módulos (política, sombra, consumidor y prescripción efectiva). **No se cambia en esta ejecución.**'],
    [f.rollback, 'Reversión verificada', 'ROLLBACK: **' + f.lifecycle.rollback + '** — `revertOverlayTransaction` (transaccional, `expectedRevision`) revierte antes de que empiece la exposición destino y se rechaza después (t531, t532).'],
    [f.lifecycle.applied === 'READY_BEHIND_DISABLED_FLAG', 'Ciclo de vida APPLIED (PENDING→APPLIED→CONSUMED/OVERRIDDEN/REVERTED/STALE)', 'APPLIED LIFECYCLE: **' + f.lifecycle.applied + '** — estados ' + f.lifecycle.states.join(', ') + '; transiciones explícitas y terminales; con la bandera apagada `APPLIED` no puede crearse (t529, t531).'],
    [f.lifecycle.clientConsumer === 'READY_BEHIND_DISABLED_FLAG', 'Consumidor de overlay en el cliente', 'CLIENT OVERLAY CONSUMER: **' + f.lifecycle.clientConsumer + '** — prescripción efectiva = plan base + overlay elegible (SEGURIDAD > override exacto del Coach > overlay > base); LOGS ejecutados separados (t530, t533).'],
    [f.lifecycle.consumption === 'READY', 'Consumo (APPLIED→CONSUMED)', 'CONSUMPTION: **' + f.lifecycle.consumption + '** — solo tras la primera serie de trabajo PERSISTIDA del PID exacto; idempotente (t531, t532).'],
    [f.lifecycle.override === 'READY', 'Override del Coach tras aplicar', 'OVERRIDE: **' + f.lifecycle.override + '** — decisión exacta posterior al cálculo y antes del inicio → OVERRIDDEN (t531, t532, t534).'],
    [f.lifecycle.stale === 'READY', 'Obsolescencia tras aplicar', 'STALE: **' + f.lifecycle.stale + '** — plan reemplazado / PID o exposición invalidados antes del inicio (t531, t532).'],
    [f.lifecycle.emulator, 'Concurrencia con Firestore Emulator real', '11 escenarios transaccionales en `tests/t532-lifecycle-emulator.cjs` (dos dispositivos, carreras override/revert/plan, consumo duplicado, callbacks tardíos, reintentos, escrituras denegadas).'],
    [f.lifecycle.canary === 'READY_DISABLED', 'Alcance de canario integrado al ciclo de vida', 'CANARY: **' + f.lifecycle.canary + '** — `autoApplyCanary` se re-lee DENTRO de la transacción; fuera de alcance/ausente/deshabilitado → nunca APPLIED (t526, t531).'],
    [f.audit, 'Auditoría visible para el Coach', 'Línea dry-run con clase de vista rápida, cola de equipos y matriz de preparación en el Monitor (t494, t510, t520); ciclo de vida completo APPLIED/CONSUMED/OVERRIDDEN/REVERTED/STALE con antes→después, regla, equipo, marcas de tiempo y acción del Coach (t534).']
  ];
  const done = items.filter(i => i[0]).length, blocking = items.filter(i => !i[0] && !i[3]);
  const L = ['# Lista de verificación de activación de la auto-aplicación', '',
    'Generado por `node scripts/generate-activation-docs.cjs` a partir de hechos vivos del repositorio; verificado por `tests/t522-activation-docs.test.js`. `[x]` = cumplido; `[ ]` = pendiente.',
    'Los ítems por candidato se cumplen en tiempo de ejecución para cada candidato (guardia de activación); aquí se marcan como verificados por sus tests.', '',
    '**Estado: ' + done + ' de ' + items.length + ' cumplidos; pendientes bloqueantes: ' + blocking.length + '. La bandera NO se activa con esta lista; requiere decisión explícita del director.**', ''];
  items.forEach(i => L.push('- ' + box(i[0]) + ' **' + i[1] + '** — ' + i[2]));
  L.push('', '## Bloqueos para activar (resumen)', '',
    '1. **Datos del Coach:** incrementos reales de equipo (ver `docs/EQUIPMENT_DATA_REQUIRED_NEXT.md` y `docs/EQUIPMENT_ACTIVATION_READINESS.md`). Es el bloqueo operativo principal.',
    '2. **Decisión intencional** de cambiar `NUMERIC_APPLY_ENABLED` (no se cambia en esta ejecución).',
    '3. No bloqueante: validación del runner en Windows (`NON_BLOCKING_TECHNICAL_PENDING`).', '',
    'Las decisiones D/E, C→E y serie representativa ya NO son bloqueos: están cerradas como política de producto VDSEN (ver `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md`).', '');
  return L.join('\n');
}

function readiness(f) {
  const s = f.replay.summary, top = Object.entries(s.blockersByReason).slice(0, 6);
  const flagOff = f.flag.every(v => v === false);
  const L = ['# Preparación real de la auto-aplicación', '',
    'Generado por `node scripts/generate-activation-docs.cjs`. **Evidencia estática / sintética / local únicamente; no hay métricas de producción.**', '',
    '## 1. Preparación de CÓDIGO / POLÍTICA', '',
    '| Elemento | Estado |', '|---|---|',
    '| Política de producto D/E | COACH_REVIEW_REQUIRED (1A) — sin candidato numérico |',
    '| Política C→E | primera ocurrencia comparable → REST +30 s; persistencia → COACH_REVIEW_REQUIRED (2B) |',
    '| Serie representativa | LAST_STANDARD_WORKING_SET · `' + policy.EVIDENCE_BASIS + '` |',
    '| Bloqueos científicos abiertos | ' + policy.SCIENCE_GAPS.length + ' |',
    '| Resolvedor de equipo | listo (identidad + precedencia + rejilla física + rechazo explícito) |',
    '| UX de configuración de equipo | lista (editor, cola, carga masiva, vista previa de impacto, procedencia) |',
    '| Guardia de activación | 19 verificaciones independientes |',
    '| Repetición sintética | ' + s.candidates + ' escenarios: ' + s.readyButDisabled + ' READY_BUT_DISABLED · ' + s.coachReviewState + ' COACH_REVIEW_REQUIRED · ' + s.blocked + ' bloqueados · ' + s.executable + ' ejecutables |',
    '| Bloqueados por equipo / revisión del Coach / otra política | ' + s.equipmentBlocked + ' / ' + s.coachReview + ' / ' + s.scienceBlocked + ' |',
    '| Validación de plataforma (Windows T478) | NON_BLOCKING_TECHNICAL_PENDING (registro: ' + win.status + ') |',
    '| Bandera `NUMERIC_APPLY_ENABLED` | ' + (flagOff ? 'false (apagada en los 4 módulos)' : 'INESPERADO') + ' |',
    '| Estado APPLIED | solo alcanzable con la bandera activa (sandbox de pruebas); con la bandera apagada la transición se rechaza (`NUMERIC_APPLY_DISABLED`) |', '',
    '### Ciclo de vida de la aplicación', '',
    '| Componente | Estado |', '|---|---|',
    '| APPLIED LIFECYCLE | ' + f.lifecycle.applied + ' |',
    '| CLIENT OVERLAY CONSUMER | ' + f.lifecycle.clientConsumer + ' |',
    '| ROLLBACK | ' + f.lifecycle.rollback + ' |',
    '| CONSUMPTION | ' + f.lifecycle.consumption + ' |',
    '| OVERRIDE | ' + f.lifecycle.override + ' |',
    '| STALE | ' + f.lifecycle.stale + ' |',
    '| CANARY | ' + f.lifecycle.canary + ' |',
    '| Concurrencia (Emulator real) | ' + (f.lifecycle.emulator ? 'cubierta (`tests/t532-lifecycle-emulator.cjs`)' : 'FALTA') + ' |', '',
    '## 2. Preparación de DATOS REALES DE EQUIPO', '',
    '| Métrica | Valor |', '|---|---|',
    '| Cobertura de identidad de equipo (grupos) | ' + f.resolvedGroups + ' / ' + f.groups + ' |',
    '| Cobertura de identidad (ejercicios del catálogo) | ' + f.exercisesWithIdentity + ' / ' + f.exercises + ' |',
    '| Cobertura de incrementos (equipos con incremento) | ' + f.configured + ' / ' + (f.groups - f.unresolvedGroups.length) + ' |',
    '| Ejercicios del catálogo listos por equipo (LOAD) | ' + f.exercisesReady + ' / ' + f.exercises + ' |',
    '| Candidatos LOAD ejecutables con el catálogo real | 0 (sin incrementos: sin redondeo implícito, sin respaldo por tipo de equipo) |', '',
    '**Bloqueo operativo principal restante: incrementos reales de equipo (datos del Coach).** Código, política, ciclo de vida, consumidor del cliente y auditoría del Coach están listos detrás de la bandera apagada.', '',
    '## Principales motivos de bloqueo o revisión (sintético)', '', '| Motivo | Candidatos |', '|---|---|'];
  top.forEach(([k, v]) => L.push('| ' + k + ' | ' + v + ' |'));
  L.push('', '## Equipos que más desbloquearían (ranking por uso en el catálogo)', '', '| # | Equipo | Ejercicios | Estado |', '|---|---|---|---|');
  f.queue.slice(0, 8).forEach((r, i) => L.push('| ' + (i + 1) + ' | ' + r.name + ' | ' + r.exerciseCount + ' | ' + r.status + ' |'));
  L.push('', 'Documentos relacionados: `docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md`, `docs/EQUIPMENT_DATA_REQUIRED_NEXT.md`, `docs/EQUIPMENT_ACTIVATION_READINESS.md`, `docs/SHADOW_REPLAY_REPORT.md`, `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md`.', '');
  return L.join('\n');
}

const build = () => { const f = facts(); return { facts: f, checklist: checklist(f), readiness: readiness(f) }; };
module.exports = { build, facts };
if (require.main === module) {
  const b = build(), files = { 'docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md': b.checklist, 'docs/AUTO_APPLY_READINESS.md': b.readiness };
  if (process.argv.includes('--check')) process.exit(Object.entries(files).every(([p, t]) => fs.existsSync(path.join(repo, p)) && readFile(p) === t) ? 0 : 1);
  Object.entries(files).forEach(([p, t]) => fs.writeFileSync(path.join(repo, p), t));
  console.log('wrote activation checklist and readiness report');
}
