# VDSEN Dev State — Handoff Document
> Actualizado: 2026-08-30 · main HEAD: `2b6e927` · rama activa: `claude/client-app-improvements-qayy4n`

---

## Estado actual

| Item | Valor |
|------|-------|
| main HEAD | `2b6e927` — FASE 6 mergeada |
| Rama activa | `claude/client-app-improvements-qayy4n` (pendiente merge) |
| FASE 5 commit | `4a87e42` |
| FASE 6 commit | `2b6e927` (merge --no-ff) |
| Suite tests | **436/436 PASS** (P01–P185) |
| Vercel | producción en `2b6e927`; FASEs 7–11 pendientes merge a main |
| Siguiente fase | **FASE 12** (por definir) |

---

## FASES completadas

### FASE 5 (mergeada a main — `4a87e42`)
- Máquina de estados de workout en `vdsen-cliente.html`
- Algoritmo progresión v3.1 completo
- Check-in post-sesión + semanal
- Semana final = MESOCYCLE_CHECKPOINT únicamente.
  Deload es reactivo y requiere ≥2 deloadTriggers.
  La semana final sola nunca dispara deload.

### FASE 11 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Template Library + Apply to Current Client**

Storage audit: colección `templates` ya existía con reglas Firestore correctas. Schema: `{ name, coachId, weeks, days:[{label, exercises}], createdAt }`. Solo entrenamiento (sin nutrición/suplementación/farmacología). No se creó colección nueva. No se modificaron reglas.

Archivos modificados:
- `vdsen-coach.html` — botón `📚 Biblioteca` + 3 funciones nuevas
- `tests/progression-engine.test.js` — P176-P185 (31 assertions nuevas)

Funciones añadidas:
- `_filterTemplates(query, templates)` — substring CI, preserva orden, no muta input
- `_applyTemplateToClient(template, clientId, closeModal)` — restamp IDs → addDoc plans → updateDoc activePlanId (create-first, assign-after)
- `openPlanTemplateLibrary(clientId)` — modal DOM API (XSS-safe via textContent), 1 Firestore read al abrir, filtrado local, guard `applying` doble-click

Comportamiento añadido:
- Botón `📚 Biblioteca` en acciones del plan del cliente activo
- Modal responsive: loading → empty ("No tienes templates…") / error / lista
- Cada template: nombre + días · semanas · fecha (DOM API, sin innerHTML inseguro)
- "Usar →" aplica al cliente activo directamente, sin selector de cliente
- Plan creado antes de asignar activePlanId (transacción segura)
- Auto-agrega ejercicios del template al catálogo del coach
- `_saveCurrentPlanAsTemplate` ya pedía nombre (sin cambio necesario)

Limitaciones documentadas:
- 1 lectura Firestore al abrir biblioteca; no realtime listener
- No hay botón de eliminar template desde la biblioteca (existe en pestaña Plantillas existente)
- No hay paginación si el coach tiene >50 templates

---

### FASE 10 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Plan Editor UX: Autocomplete, Reorder, restSeconds**

Archivos modificados:
- `vdsen-coach.html` — 6 parches quirúrgicos en `_exRowHtml`, `_moveExRow`, `addExRow`, `renderTrainingEditor`, `toggleTrainingEditor`, `saveTrainingPlan`
- `tests/progression-engine.test.js` — P166-P175 (35 assertions nuevas)

Funciones añadidas:
- `_filterExerciseCatalog(query, catalog, limit)` — substring CI, max 6, sin Firestore reads
- `_moveArrayItem(items, from, to)` — reordenar array puro, no muta original
- `_parseRestSeconds(value)` — convierte string/undefined/negativo a número ≥ 0
- `_acShow(input)` / `_acHide(input)` — dropdown XSS-safe vía createElement/textContent
- `_updateReorderBtns(list)` — visibilidad ↑↓ por posición (primero oculta ↑, último oculta ↓)

Comportamiento añadido:
- **Autocomplete**: input de nombre usa custom dropdown (XSS-safe, no datalist). Fuente: `_allExercises` en memoria. Muestra nombre + motorPattern/equipment opcionales.
- **Reorder ↑↓**: botones ahora tienen `data-reorder="up/dn"`. Visibilidad actualizada al abrir editor, añadir ejercicio y después de cada movimiento. `prescriptionExerciseId` se preserva (viaja en `data-prescription-id` del DOM row).
- **restSeconds inline**: 4ª columna en grid de series. Carga de `sets[0].restSeconds`, guarda con `_parseRestSeconds`. Ya no hardcodeado a 90.

Limitaciones documentadas:
- Editor usa un único restSeconds por ejercicio (aplicado igual a todos sus sets), consistente con el modelo actual de reps/RIR uniformes por ejercicio.
- Datalist `coach_exlist` eliminado; el autocomplete nativo queda reemplazado por el custom dropdown.

---

### FASE 9 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Contextual Rest Timer + Active Workout Flow**

Archivos modificados:
- `vdsen-cliente.html` — 8 parches quirúrgicos
- `tests/progression-engine.test.js` — P147-P165 (19 tests nuevos)

Funciones añadidas:
- `_scrollToNextPendingSet()` — query `[data-pending="1"]` en `#exPanel`, scrollIntoView smooth (200ms delay)
- `_nextSerie()` — botón SIGUIENTE ▶: `stopRestTimer()` + `_scrollToNextPendingSet()`
- `_refreshSessionDashboard()` — actualiza `#_sesDashboard` innerHTML in-place, 0 Firestore reads

Comportamiento añadido:
- **Rest timer contextual**: auto-arranca al completar una serie usando `ej.sets[si].restSeconds` como única fuente de verdad
- **Sin heurísticas de fallback**: si `restSeconds` falta o es inválido, no se inicia timer automáticamente
- **Semántica de técnica preservada**: Y3T s1 ≥210s, Y3T s2 ≥150s; FST7 40s entre series / 180s tras la final
- **Guard autoFilled**: si `prev.autoFilled === true` (estado pre-guardado), no iniciar timer
- **Dashboard inmediato**: `_refreshExPanelOnly()` llama `_refreshSessionDashboard()` en cada save de serie
- **Set pendiente resaltado**: `data-pending="1"` + borde accent `rgba(196,255,0,.4)` en la fila activa
- **Scroll automático**: al finalizar timer y al pulsar SIGUIENTE ▶, desplaza al siguiente set pendiente
- **Wrapper `id="_sesDashboard"`**: permite update in-place sin re-render completo

Limitaciones documentadas:
- Timer no persiste en Firestore — usa solo localStorage (`vdsen_restEnd`, `vdsen_restTotal`)
- Si recarga durante descanso: timer se resetea (documentado, no es bug)
- `data-pending="1"` se asigna al `activeSi` del ejercicio activo; si hay múltiples ejercicios con sets pendientes, solo el primero está marcado

---

### FASE 8 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Live Training + Client Session Dashboard**

Archivos modificados:
- `vdsen-coach.html` — `_getLiveInfo()` helper + enhanced live badge + live-aware sort
- `vdsen-cliente.html` — `_calcSessionStats()` + `_fmtElapsed()` + `_statCell()` + session dashboard strip + session timer
- `tests/progression-engine.test.js` — P129-P146 (18 tests nuevos)

Funcionalidades añadidas:
- `_getLiveInfo(entries, planData)` — 0 Firestore reads; mismo umbral 5 min que `isClientLiveTraining`; identifica día activo, ejercicio actual (via plan), sets completados/totales del día
- Coach live badge: ahora muestra "● EN VIVO · [ejercicio] N/Ms" en lugar de solo "● EN VIVO"
- Auto-refresh live timer actualizado para usar `_getLiveInfo` con `innerHTML` (no textContent)
- Sort coach: live bump = `_ATTN_PRIORITY[state] * 2 - (live ? 1 : 0)`; REVIEW siempre domina
- `_calcSessionStats(logs, di, week)` — completedSets, avgRIR (0-5), avgICS (1-10), sessionStart (min ts)
- Session dashboard strip en Tab Entrenamiento (solo semana activa `CURRENT_WEEK === REAL_WEEK`)
  - 4 celdas: Series N/Total · Tiempo mm:ss · RIR medio · ICS medio
  - Tiempo: `setInterval` cada 1s, limpiado en re-render; derivado del primer ts real del día
  - ICS coloreado: verde ≥8, dorado ≥7, rojo <7
- XSS: `exerciseName` escapado con `_escH` en render del live badge (data layer retorna raw)

Limitaciones documentadas:
- Session start derivado del mínimo ts de logs reales del día; si recargas sin logs previos, timer empieza desde la primera serie guardada post-reload
- Tiempo sesión no persiste en Firestore — no se añade campo nuevo (spec: no cambiar schema)
- Live detection threshold 5 min: cliente sin actividad reciente aparece como no-live aunque esté en sesión

---

### FASE 7 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Coach Attention Monitor**

Archivos modificados:
- `vdsen-coach.html` — helpers de atención + redesign lista clientes + parche panel rendimiento
- `tests/progression-engine.test.js` — P110-P128 (19 tests nuevos)

Funcionalidades añadidas:
- `_ATTN_PRIORITY` / `_ATTN_BADGE` — constantes de estado visual (REVIEW/PROGRESSING/STABLE/NO_DATA)
- `_computeClientAttentionState(entries, planData, currentWeek)` — estado determinístico, 0 Firestore reads
  - Escanea semana actual y anterior (scanWeeks = [cw, cw-1])
  - REVIEW signals: deloadTriggers ≥ 2, action='deload', reason='TOO_HARD_REPEATED', reason='PERFORMANCE_REGRESSION', postsession.articular=true, postsession.eimd ≥ 3
  - `reduce_load` solo NO es REVIEW — requiere reason=TOO_HARD_REPEATED
  - PROGRESSING signals: action='increase_load', reason='REPS_PROGRESSING'
  - Dedup por (code + ex); máx 3 reasons devueltos
  - Prioridad: REVIEW > PROGRESSING > STABLE > NO_DATA
- Lista de clientes rediseñada (dos pasadas: build rowData → sort → render)
  - Header resumen: `🔴 N revisar 🟢 N progresando ⚪ N estables ◌ N sin datos`
  - Ordenada por _ATTN_PRIORITY → alpha
  - Badge de atención + reasons inline por cliente
  - XSS: r.ex y r.label escapados con `_escH` en render
- Panel "Rendimiento por ejercicio": auto-abre `<details>` si hay REVISAR; filas REVISAR destacadas con fondo rojo tenue + nombre en rojo bold; contador "↓ N a revisar" en summary

Bugs corregidos en self-review:
1. **XSS** — `r.label` puede contener `ps.patron` (data Firestore); escapado con `_escH` en render de reasons

---

### FASE 6 (mergeada a main — `2b6e927`)
**Performance History UX + Next Exposure**

Archivos modificados:
- `vdsen-cliente.html` — helpers de historial + bloque HOY
- `vdsen-coach.html` — panel rendimiento por ejercicio (`<details>` collapsible)
- `tests/progression-engine.test.js` — P88-P109 (22 tests nuevos)

Funcionalidades añadidas:
- `_getExposures(prescId, di, ei, nombre, max)` — últimas N exposiciones comparables
  - Confidence HIGH cuando prescriptionExerciseId match único por posición
  - Confidence LOW cuando cae a path positional legacy (con guard de nombre normalizado)
  - Ordena sets por setIdx (S0→S1→S2) en path HIGH
- `_calcTrend(exposures)` — PROGRESANDO | ESTABLE | REVISAR | NEW
  - REVISAR requiere ≥3 exposiciones con 2 descensos consecutivos
  - Una sesión mala → ESTABLE (no REVISAR)
- `_calcPR(exposures)` — mejor carga histórica
- `_buildNextExposureHtml(progrec, unit, nombre)` — bloque HOY inline
  - Consume progrec existente, nunca recalcula
  - Guard nombre vs progrec.exerciseName (stale-progrec protection)
  - Muestra unidad real KG/LB (no hardcoded)
- `showExHistory(di, ei)` — modal bottom-sheet historial (últimas 5)
  - Escapa nombre con `_escHTml` (XSS protection)
  - Botón "📈 Historial" en menú opciones de ejercicio

Bugs corregidos en self-review:
1. **XSS** — `nombre` escapado con `_escHTml()` en innerHTML del modal
2. **Unidad hardcoded** — `_buildNextExposureHtml` acepta `unit`, lo usa en display
3. **Stale progrec** — guard `_normName(progrec.exerciseName) !== _normName(nombre)` → fallback a nueva referencia
4. **Orden de sets** — HIGH confidence path ordena candidateSets por setIdx antes de mapear

---

## Invariantes permanentes (NUNCA cambiar)

### Identidad de ejercicios
```
HIGH  → prescriptionExerciseId exact match (preferido, stable UUID)
LOW   → positional (di/ei) + guard exact normalized name (legacy)
NONE  → mismatch/ambiguo → no history shown
```

### Log key format
`log_{W}_{D}_{E}_s{S}` — NUNCA cambiar. Metadata en entries es aditiva.

### RIR sign convention (CONGELADO)
```
rir_error = avgRIR - rirObj
> 0  → TOO_EASY  → candidato a subir carga
< 0  → TOO_HARD  → no subir
|err| ≤ 1 → PRESCRIPTION_MATCH
```

### Variables de semana
- `REAL_WEEK` — semana real en Firestore. NUNCA mutada por navegación.
- `CURRENT_WEEK` — semana vista. Puede diferir de `REAL_WEEK` (modo lectura pasado/futuro).

### Exclusiones del motor (CONGELADO)
- `autoFilled: true` → excluido de historial y observationsCount
- Una exposición mala ≠ regresión (requiere 3 consecutivas)
- NO recalcular progrec en path de historial (consume el ya existente)

### Program Mutation (CONGELADO)
- `add_sets` = recommendation only — nunca muta el plan activo
- `deload` = recommendation only — nunca muta el plan activo
- `reduce_sets` = renderer/session-local only (no persiste)
- Progression Engine nunca persiste cambios automáticos de volumen/frecuencia al plan activo

### Load Sources
```
A  plan.sets[].load     → placeholder / prescripción técnica
B  LOGS.carga           → carga real ejecutada
C  progrec.newLoad      → sugerencia de próxima exposición
```
Nunca mezclar A, B, C. Cada fuente tiene semántica independiente.

### Colecciones Firestore (NO cambiar)
- Sin nuevas colecciones
- Sin migración destructiva
- `activePlanId` intocable
- `logs/{uid}` — doc único por cliente

### Arquitectura
- **SINGLE-COACH permanente.**
  No diseñar multicoach / workspaces / transfers salvo instrucción explícita.

---

## Backlog ordenado (NO implementar sin autorización)

```
A. Coach Attention Monitor
B. Live Training indicator
C. Client Session Dashboard
D. Contextual Rest Timer
E. Check-in / body-history UX
F. Active-session exercise substitution (sin perder historial)
G. CSV logs export
H. Push notifications
I. Plan editor drag-and-drop
J. Photo progress
```

---

## Deuda técnica

**P1 FUTURE — logs/{uid} crecimiento de documento único**
`logs/{uid}.entries` crece en un documento Firestore único sin límite.
No migrar ahora — sin impacto operativo en volúmenes actuales.
Futuro: session/checkin subcollections con migración versionada y flag de versión.

---

## Restricciones de arquitectura

- **Stack**: HTML single-file, Tailwind CDN, Firebase SDK v10.12.0 modular — SIN bundler, SIN framework
- **Deploy**: Vercel estático, auto-deploy en push a main
- **Regla de edición**: NUNCA reescribir archivos completos. str_replace quirúrgico.
- **Colecciones activas**: coaches, clients, exercises, plans, logs, compendio
- **Merge a main**: requiere autorización explícita del usuario

---

## Tests

```bash
node tests/progression-engine.test.js
# → 255/255 PASS
```

Rangos:
- P01–P60: Progression core / RIR / deload / safeguards
- P61–P87: Stable Exercise Identity + legacy/history hardening + consistency tests
- P88–P105: FASE 6 Performance History UX
- P106–P109: FASE 6 self-review fixes
- P110–P128: FASE 7 Coach Attention Monitor
- P129–P146: FASE 8 Live Training + Session Dashboard

---

## Comandos de referencia

```bash
# Ver rama actual y último commit
git log --oneline -5

# Correr tests
node tests/progression-engine.test.js
# → 296/296 PASS

# Diff vs main
git diff main...HEAD --stat

# Push rama
git push -u origin claude/client-app-improvements-qayy4n
```
