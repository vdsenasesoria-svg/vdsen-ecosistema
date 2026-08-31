# VDSEN Dev State — Handoff Document
> Actualizado: 2026-08-31 · rama `claude/client-app-improvements-qayy4n` · FASE 26 implementada · siguiente = audit + merge → main

---

## Documentos de referencia

| Documento | Cuándo leer |
|-----------|-------------|
| `docs/VDSEN_DEV_STATE.md` | Siempre (estado técnico del ecosistema) |
| `docs/CONTEXTO_GENERADOR.md` | Solo para tareas de generación, validación, adaptación longitudinal o contratos del Motor |

Generator contract: `docs/CONTEXTO_GENERADOR.md` — leer únicamente para tareas de generación, validación, adaptación longitudinal o contratos del Motor.

---

## Estado actual

| Item | Valor |
|------|-------|
| main HEAD | `2b36630` — Audit fixes 22/23/24 |
| Rama activa | `claude/client-app-improvements-qayy4n` |
| FASE 12–15 | MERGED |
| FASE 16 | MERGED — commit `3e277d1` |
| FASE 17 | MERGED — commit `604894c` |
| FASE 18 | MERGED — commit `e8c91c2` |
| FASE 19 | MERGED — commit `4575a7c` |
| FASE 20 | MERGED — commit `0d4be7c` |
| FASE 21 | MERGED — commit `b4e4a91` |
| FASE 22–24 | MERGED — commit `2b36630` |
| FASE 25 | MERGED — commit `cbb5691` |
| FASE 26 | EN RAMA — pendiente re-audit (NEEDS_DECISION: composite index) |
| Suite tests | **1008/1008 PASS** (P01–P404) |
| Vercel | auto-deploy en push a main |
| Siguiente fase | FASE 27 (post-audit FASE 26) |

---

## FASES completadas

### FASE 26 — Coach Plan Comparison / Current vs Previous Prescription (rama `claude/client-app-improvements-qayy4n`)
**Herramienta READ-ONLY para el coach: comparar plan actual vs prescripción anterior**

Archivos modificados:
- `vdsen-coach.html` — 4 edits: state var `_detailPrevPlanData`, reset en `showClientDetail`, sección HTML `#planCompareSection`, bloque de funciones FASE 26
- `tests/progression-engine.test.js` — P378-P399 (22 test cases, 36 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

**Funciones puras (XSS-safe, 0 lecturas Firestore extra al abrir modal):**
- `_normNameF26(s)` — normalización de nombre: lower, sin tildes, sin especiales, trim
- `_buildExMap26(days)` — indexa ejercicios por `prescriptionExerciseId` (PID) y por nombre normalizado
- `_resolveMatchF26(prevEx, curMap, prevMap)` — PID primario; nombre único en ambos planes como fallback; null si ambiguo (duplicado en alguno)
- `_compareExSets26(curEx, prevEx, exName, pid, di)` — diffs por set: LOAD_CHANGED, RIR_CHANGED, REST_CHANGED, SETS_CHANGED
- `_comparePlans(curPlan, prevPlan)` — función principal pura; emite ADDED, REMOVED + diffs de sets
- `_renderPlanComparison(diffs, container)` — renderer DOM (textContent, XSS-safe)
- `_togglePlanCompare(clientId)` — async toggle; lazy load de `plans_backup` en primer click; JS sort por `backedUpAt`

**Diff types soportados:** ADDED, REMOVED, LOAD_CHANGED, SETS_CHANGED, RIR_CHANGED, REST_CHANGED (EXERCISE_REPLACED reservado, nunca auto-inferido)

**Invariantes:** POSITION ≠ IDENTITY · nombre duplicado en cualquier plan → ambigüedad → REMOVED+ADDED · `plan.sets[].load` únicamente, nunca `logs.carga` · sin new Firestore reads al abrir modal

---

### FASE 25 — Client Workout / Next Action UX (MERGED `cbb5691`)
**Resolver determinista de siguiente acción en workout + hint contextual en rest timer**

Archivos modificados:
- `vdsen-cliente.html` — 5 parches quirúrgicos
- `tests/progression-engine.test.js` — P351-P370 (35 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

**`_resolveNextWorkoutAction(di, exercises, lastEi, lastSi, logs, currentWeek, totalWeeks)`**
- Función pura, sin I/O, sin lecturas Firestore adicionales
- Devuelve `{ type, label }` con tipo: `SUPERSET_PARTNER` → `NEXT_SET` → `NEXT_EXERCISE` → `SESSION_DONE` → `NONE`
- Prioridad exacta: partner SS primero; mismo ejercicio; ejercicio siguiente activo; sesión completa
- Omite ejercicios donde `isTechniqueActive = false` o `getEffectiveSets = []`

**`_renderNextWorkoutAction(action)`**
- Renderiza en `#nextActionHint` (overlay full-screen) y `#nextActionHintCompact` (overlay compacto)
- Usa `textContent` exclusivamente — XSS-safe
- Oculta el hint si `type === 'NONE'`

**Integración rest timer**
- `startRestTimer` → llamada inmediata a `_renderNextWorkoutAction` en `completeSet`
- `stopRestTimer` → limpia ambos hints vía `textContent = ''`
- 0 nuevas colecciones Firestore, 0 nuevos listeners, 0 polling

**Tests P351-P370**: 20 casos (35 assertions) — resolver puro: NONE, NEXT_SET, NEXT_EXERCISE, SESSION_DONE, SUPERSET_PARTNER, prioridades, idempotencia, currentWeek, di, stubs isTechniqueActive/getEffectiveSets

**Tests P371-P377 (Audit Fix)**: 7 casos (18 assertions) — integración `completeSet`: SUPERSET_PARTNER se renderiza antes del early return, autoFilled no dispara render, restTime=0 renderiza NEXT_SET/NEXT_EXERCISE/SESSION_DONE, restTime>0 mantiene timer + hint, partner + timer lógico → no timer real

---

### AUDIT FIX 22/23/24 (rama `claude/client-app-improvements-qayy4n`)
**Correcciones post-audit sobre FASEs 22, 23, 24**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos
- `tests/progression-engine.test.js` — P331-P350 (36 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

**FIX MEDIUM — FASE 22: `_resolveExerciseRowId` prefiere PID**
- Firma ampliada: `_resolveExerciseRowId(exerciseName, planCache, pid?)`
- Si `pid` provisto → búsqueda primaria por `prescriptionExerciseId` en todo el plan
- Si no encontrado por PID (o pid vacío/null) → fallback al nombre normalizado (comportamiento legacy)
- Botón ✏️ del Monitor ahora emite `data-expid` con el PID resuelto desde `_activePlanCache.days[lastRecDay]` en tiempo de render
- `_deepLinkToExercise(exerciseName, pid?)` acepta PID opcional y lo pasa a `_resolveExerciseRowId`
- Tests P331-P340: 10 casos (duplicado por nombre, PID exacto, PID vacío, PID bogus, fallback legacy)

**FIX HIGH — FASE 23: `_discardEditorChanges()` explícito**
- Nueva función `_discardEditorChanges()` — reconstruye `#training-editor` desde `_detailPlanData.days` vía `renderTrainingEditor`
- `_switchClientTab`: al confirmar abandono llama `_discardEditorChanges()` ANTES de `markEditorClean()`
- El discard es ahora explícito e inmediato, no implícito en el siguiente render del tab Plan
- Tests P341-P350: 10 casos de regresión (secuencia dirty→discard→clean, invariante triple condición, flujo completo)

**FASE 24 integration:** sin cambios adicionales (pasó el audit; integración correcta verificada por tests)

Suite: **908/908 PASS** (P01–P350)

---

### FASE 24 (rama `claude/fase-24-dirty-plan-indicator` — MERGED en main `950434e`)
**Dirty Plan Indicator — indicador visual ● en tab Plan cuando hay cambios sin guardar**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos
- `tests/progression-engine.test.js` — P321-P330 (16 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_planTabLabel(isDirty, baseLabel?)`** — puro, exportado en `window`  
- Retorna `baseLabel + ' ●'` si `isDirty === true`, de lo contrario `baseLabel`  
- Fallback: `'🏋️ Plan'` si `baseLabel` es vacío/null

**`_updateDirtyTabUI(isDirty)`** — DOM function, exportada en `window`  
- Busca `#dirtyPlanDot` y alterna su atributo `hidden`  
- 0 reads Firestore · seguro si el elemento no existe

Cambios UI:
- `ctab_plan` button ahora contiene `<span id="dirtyPlanDot" hidden>●</span>` (naranja)
- `markEditorDirty()` y `markEditorClean()` llaman `_updateDirtyTabUI` automáticamente
- `showClientDetail()` llama `markEditorClean()` al abrir nuevo cliente (reset de estado)

Invariantes preservados:
- `_dirtyEditor` y `markEditorClean/Dirty` ya existían — sin nueva infraestructura
- 0 reads Firestore nuevos
- Sin cambios en algoritmos de progresión

Suite: **872/872 PASS** (P01–P330)

---

### FASE 23 (rama `claude/fase-23-unsaved-changes-guard` — MERGED en main `ce276ee`)
**Unsaved Changes Guard — aviso al cambiar de tab con plan sin guardar**

Archivos modificados:
- `vdsen-coach.html` — 1 parche quirúrgico
- `tests/progression-engine.test.js` — P311-P320 (10 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_shouldWarnDirtyLeave(fromTab, toTab, isDirty)`** — puro, exportado en `window`  
- Retorna `true` solo si `isDirty === true && fromTab === 'plan' && toTab !== 'plan'`  
- 0 reads Firestore · no tiene side effects

Cambio UI:
- `_switchClientTab` ahora es `async` y usa `_shouldWarnDirtyLeave` antes de cambiar
- Si el usuario está en tab Plan con cambios pendientes y cambia a otro tab → modal `_askConfirm` "¿Salir sin guardar?"
- Si cancela: permanece en Plan. Si confirma: `markEditorClean()` + switch
- `beforeunload` guard (ya existente desde antes) se mantiene intacto para recarga/cierre

Invariantes preservados:
- `calculateProgression` sin cambios
- `_dirtyEditor` y `markEditorClean` ya existían — solo se usa, no se crea infraestructura nueva
- 0 reads Firestore nuevos

Suite: **856/856 PASS** (P01–P320)

---

### FASE 22 (rama `claude/fase-22-monitor-editor-deeplink` — MERGED en main `e49dfe3`)
**Coach Monitor → Plan Editor Deep Link — botón ✏️ por ejercicio en Monitor**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P301-P310 (21 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_resolveExerciseRowId(exerciseName, planCache, pid?)`** — puro, exportado en `window`  
- Input: nombre de ejercicio + `_activePlanCache` + PID opcional (ver Audit Fix)
- Input original: nombre de ejercicio + `_activePlanCache`  
- Output: `{ di, ei, pid }` o `null`  
- Normalización: lowercase + trim + colapso de espacios (igual que `_normN20`)  
- 0 reads Firestore · no muta planCache

**`_deepLinkToExercise(exerciseName)`** — DOM function, exportada en `window`  
- Llama `_switchClientTab('plan')` → abre training-editor si cerrado → scroll+highlight de la fila  
- Highlight: `outline: 2px solid #44BB88` por 2 s  
- Fallback: si no resuelve `prescriptionExerciseId`, usa `exrow_${di}_${ei}`

Cambio UI:
- Cada tarjeta de recomendación en Monitor ahora tiene botón ✏️ en la cabecera (junto al badge de acción)
- Atributo `data-exname` en el botón para evitar inyección JS (XSS-safe)

Invariantes preservados:
- 0 reads Firestore nuevos
- `calculateProgression` sin cambios
- Load semantics intacto
- Sin cambios en claves de logs

Suite: **846/846 PASS** (P01–P310)

---

### FASE 21 (merge commit `b4e4a91` — MERGED a main)
**Coach Monitor: Plan Change Preview — vista de cambios antes de confirmar aplicación de cargas**

Archivos modificados:
- `vdsen-coach.html` — 3 parches quirúrgicos
- `tests/progression-engine.test.js` — P290-P300 (30 assertions nuevas)
- `docs/VDSEN_DEV_STATE.md` — este bloque

Helpers añadidos:

**`_buildPlanChangeSummary(preview, selectedPids?)`** — puro, exportado en `window`  
- Input: array de preview entries + opcional array de IDs seleccionadas (pid || String(ei))  
- Output: `{ exerciseCount, setCount, changes }` — sin mutar el preview  
- Usado por el modal para header dinámico y por los tests

Cambios en **`_buildRecApplyPreview`** (extensión quirúrgica):
- `setCount`: número real de sets del ejercicio en el plan  
- `mixedCurrentLoads`: `true` si distintos sets tienen cargas diferentes  
- `unit`: primera unidad encontrada en sets del plan (`null` si no existe)  
- Filtro no-op: si `!mixedCurrentLoads && currentLoad === recommendedLoad` → excluida  

Cambios en **`_confirmApplyRecModal`** (reemplazo quirúrgico):
- Header "REVISAR CAMBIOS" + resumen dinámico (`N ejercicios cambiarán · M sets afectados`)  
- Resumen se actualiza en tiempo real al desmarcar checkboxes (`change` event)  
- Cada fila muestra: nombre ejercicio / carga actual → carga propuesta / N sets  
- Cargas mixtas: muestra "Variable → 85" (no oculta complejidad)  
- Unidades: muestra `kg`/`lb` si existe en el plan; si no, solo número  
- Botones: "Confirmar cambios" / "Cancelar"  
- Todo el contenido dinámico escapado con `_escH()`  

Performance:
- Preview: 0 lecturas Firestore  
- Confirmación: mantiene 1 fresh read existente de FASE 20  
- 0 listeners extras, 0 polling  

Invariantes preservados:
- `calculateProgression()` SIN CAMBIOS  
- FASE 20 identity contract (LEGACY/AMBIGUOUS/NONE) intacto  
- FASE 20 race guard (fresh read antes del write) intacto  
- Filtro de acciones (solo increase_load/reduce_load) intacto  
- Set preservation (Object.assign) intacto  
- 0 nuevas colecciones Firestore  
- Schema vdsen-plan-v2 sin cambios  
- Auth sin cambios  

Limitaciones:
- `unit` toma el valor del primer set con unidad en el plan; sets con unidades mixtas no son comunes pero no se validan
- Nombres de ejercicio muy largos se truncan con `text-overflow:ellipsis` en el modal

---

### FASE 20 (merge commit `0d4be7c` — MERGED a main)
**Coach Monitor: Aplicar cargas recomendadas al plan activo (hardened)**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos (hardening)
- `tests/progression-engine.test.js` — P269-P289 (57 assertions nuevas)
- `docs/CONTEXTO_GENERADOR.md` — sección 5 Load Semantics (contrato formal)
- `docs/VDSEN_DEV_STATE.md` — este bloque

#### Contrato de identidad (identity contract)

| Nivel | Condición | Resultado |
|-------|-----------|-----------|
| LEGACY | nombre normalizado, coincidencia ÚNICA en el día | incluida; extrae `prescriptionExerciseId` del plan |
| AMBIGUOUS | 2+ ejercicios con mismo nombre en el día | excluida, sin aplicar |
| NONE | 0 coincidencias de nombre | excluida |
| HIGH (futuro) | `prescriptionExerciseId` directo en recomendación | no implementado aún — `calculateProgression` SIN CAMBIOS |

Nota: `calculateProgression` no emite `prescriptionExerciseId` en sus recomendaciones (congelado). El matching actual es siempre LEGACY: nombre → plan exercise → extrae ID del plan exercise como ancla.

#### Contrato de load semantics

Formalizado en `docs/CONTEXTO_GENERADOR.md` sección 5:
- `plan.sets[].load` = carga prescrita vigente, modificable SOLO por acción explícita del Coach
- `logs.carga` = carga real ejecutada — nunca toca el plan
- `progrec.newLoad` = sugerencia del Engine — no vinculante, nunca auto-aplicada

#### Guard de race condition (fresh-read)

Antes de `updateDoc`, se re-lee el plan desde Firestore. Para cada selección confirmada:
- Si `sel.prescriptionExerciseId` existe → re-busca por ID en plan fresco; si no está → SKIP
- Si no hay ID → fallback posicional; si índice fuera de rango → SKIP
Implementado en `_resolveExerciseInFreshPlan(sel, freshDayExercises)`.

#### Filter de acciones

Solo `increase_load` y `reduce_load` pueden mutar `plan.sets[].load`.  
`maintain`, `freeze_load`, `add_sets`, `reduce_sets`, `deload`, `progress_reps` → excluidas del preview.

#### Preservación de sets

`Object.assign({}, s, { load: match.recommendedLoad })` — solo `load` cambia.  
`repsTarget`, `rirTarget`, `restSeconds`, `setIndex` preservados intactos.

Invariantes preservados:
- `calculateProgression()` SIN CAMBIOS
- 0 nuevas colecciones Firestore
- Schema `vdsen-plan-v2` sin cambios
- Claves de logs sin cambios
- `_classifyBlocks`, `parsePlanFromJSON`, `_normalizeTrainingPlan` sin tocar
- Auth sin cambios
- Single-coach permanente

---

### FASE 19 (merge commit `4575a7c` — MERGED a main)
**Client Post-Session: Resumen de recomendaciones de progresión en el overlay de sesión completa**

Archivos modificados:
- `vdsen-cliente.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P261-P268 (28 assertions nuevas)

Helper puro añadido (exportado como `window._buildProgreSummaryHtml`):
- `_buildProgreSummaryHtml(progrec)` — genera HTML del resumen de recomendaciones post-sesión. Retorna `''` si progrec es null/undefined o si no tiene recommendations ni deloadTriggers. XSS-safe via `_escHTml`. Formatea newLoad: entero sin decimales, decimal con 1 decimal. Muestra deloadTriggers si presentes. No muta el input.

Punto de inserción en `vdsen-cliente.html`:
- `_buildProgreSummaryHtml` insertado después de `_coachNoteHtml` (línea ~12464)
- En `showSessionSummary(di)`: lee `LOGS['progrec_'+CURRENT_WEEK+'_'+di]` (ya calculado por `submitPostSession` antes de llamar a esta función), genera HTML de recomendaciones, lo añade al overlay. Si hay recomendaciones: elimina el auto-dismiss de 8s (el cliente puede leerlas sin presión de tiempo; cierra con ×).

Flujo de datos (ya existía — solo faltaba el display post-sesión):
```
submitPostSession()
  → calculateProgression(di, postData) → LOGS['progrec_W_D']
  → _confirmSessionDone(di)
  → showSessionSummary(di) → _buildProgreSummaryHtml(LOGS['progrec_W_D']) → overlay
```

Invariantes preservados:
- 0 nuevas lecturas Firestore
- `_buildProgreSummaryHtml` pura (determinista, sin side effects)
- XSS: usa `_escHTml`
- No modifica el progrec existente ni el schema
- No duplica la lógica del "block HOY" (`_buildSessionTargetBanner`) — esa muestra el objetivo por ejercicio ANTES de la sesión; esta muestra el resumen de acciones DESPUÉS de completarla
- Schema vdsen-plan-v2 sin cambios
- Colecciones Firestore sin cambios
- Progression Engine sin cambios
- Auth sin cambios

Limitaciones:
- Auto-dismiss eliminado solo cuando hay recomendaciones; si no hay progrec (primera sesión sin historial previo) el overlay mantiene el dismiss de 8s
- Nombre del ejercicio puede truncarse con text-overflow en nombres muy largos (legibilidad en móvil)

---

### FASE 18 (merge commit `e8c91c2` — MERGED a main)
**Client Workout: Notas del coach visibles durante el entrenamiento**

Archivos modificados:
- `vdsen-cliente.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P253-P260 (22 assertions nuevas)

Helper puro añadido (exportado como `window._coachNoteHtml`):
- `_coachNoteHtml(note)` — genera HTML del banner de nota del coach. Retorna `''` si `note` es null/undefined/blank. Escapa XSS con `_escHTml`. Preserva saltos de línea via `white-space:pre-line`. Visual: borde izquierdo azul, label "NOTA DEL COACH" en caps, texto multilinea.

Punto de inserción en `vdsen-cliente.html`:
- Llamada a `_coachNoteHtml(ej.coachNote)` en `_exRowHtml`, después del bloque `_exNoteInline` y antes del badge Y3T

Flujo de datos (ya existía — solo faltaba el display):
```
plan.exercises[].coachNote
  → loadPlan (líneas 1429, 1439: coachNote: e.coachNote || '')
  → ej.coachNote en el render
  → _coachNoteHtml(ej.coachNote) → HTML inline durante workout
```

Invariantes preservados:
- 0 nuevas lecturas Firestore
- `_coachNoteHtml` pura (determinista, sin side effects)
- XSS: usa `_escHTml` (escaper correcto en cliente)
- `coachNote` es readonly para el cliente (inmutable durante sesión)
- Schema vdsen-plan-v2 sin cambios — `coachNote` ya era campo del editor del coach (FASE 10)
- Colecciones Firestore sin cambios
- Progression Engine sin cambios
- Auth sin cambios

Limitaciones:
- Banner solo visible si el coach guardó nota en el editor de ejercicios
- Sin truncado de notas largas (se muestra íntegra con scroll de página)

---

### FASE 17 (merge commit `604894c` — MERGED a main)
**Coach Monitor: Exportación CSV operativa por cliente**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P238-P251 (78 assertions nuevas)

Helpers puros añadidos (exportados en `window`):
- `_escapeCsvCell(value)` — RFC4180 + neutralización de formula injection (`=`, `+`, `-`, `@`)
- `_safeExportFilename(name, date)` — sanitiza nombre del cliente, formato `vdsen_<name>_<YYYY-MM-DD>.csv`
- `_normalizeTimestamp(ts)` — acepta Date, ms, ISO string, Firestore Timestamp stub; devuelve ISO string o ''
- `_buildPlanLookup(planData)` — construye `{byPrescId, byPos}` para resolución de nombres
- `_resolveExerciseName(entry, di, ei, lookup)` — tres niveles: `exerciseNameSnapshot` → `byPrescId` → `byPos`
- `_buildOperationalExportRows(entries, planData)` — construye array de filas con `recordType` (SET/POSTSESSION/CHECKIN/PROGRESSION), ordena por week → day → typeOrder → setIndex
- `_toCsvString(rows, columns)` — genera CSV RFC4180 con BOM (`﻿`) para Excel
- `exportClientCsv(clientData, logs, planData)` — orquesta descarga; muestra toast si sin datos o error

UI añadida:
- Botón `⬇ Exportar CSV` en Monitor (a la derecha de "Ver plan"), aparece con el cliente activo
- 0 Firestore reads; usa `_activePlanCache` existente
- `autoFilled` exportado como flag `true/false` (no excluido — trazabilidad de auditoría)

Columnas CSV (25):
`recordType, week, day, exerciseName, prescriptionExerciseId, setIndex, load, unit, reps, rir_real, ics, pump, autoFilled, done, weight, hrv, who5, sleep, eimd, articular, patron, rpe, progressionAction, progressionReason, timestamp`

Invariantes preservados:
- 0 lecturas Firestore nuevas
- Todos los helpers son puros
- `_classifyBlocks`, `_normalizeTrainingPlan`, `parsePlanFromJSON` sin cambios
- Schema vdsen-plan-v2 sin cambios
- Colecciones Firestore sin cambios

---

### FASE 16 (merge commit `3e277d1` — MERGED a main)
**Coach Plan Editor: Safe Exercise Substitution Workflow**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P226-P237 (35 assertions nuevas)

Helper puro añadido (exportado como `window._replacePrescriptionExercise`):
- `_replacePrescriptionExercise(exercise, replacement, generateId)` — devuelve nuevo objeto sin mutar el original. Preserva sets, restSeconds, supersetGroup, coachNote y toda metadata estructural. Genera nueva `prescriptionExerciseId` solo si la identidad cambia. Si misma identidad (mismo `exerciseId` canónico o mismo nombre normalizado) → no regenera ID.

UI añadida:
- Botón `⇄` en cada ejercicio del Plan Editor (entre ↓ y ×)
- Modal de sustitución: ejercicio actual, buscador (substring case-insensitive), resultados del catálogo (`_filterExerciseCatalog` FASE 10), confirmación con nota "historial independiente", cancelar
- `openSubstModal(di, ei)` / `closeSubstModal()` — sin side effects en cancelar
- `_substApply()` — actualiza solo `data-prescription-id` y nombre en el DOM; llama `markEditorDirty()`; persistencia ocurre en "Guardar" normal

Semántica de identidad:
- OLD_ID → NEW_ID en la instancia sustituida únicamente
- Hermanos (siblings) no se tocan
- Reorder-safe: identidad no depende de posición
- Mismo ejercicio seleccionado → "Ya es el ejercicio seleccionado", sin nuevo ID
- 0 Firestore reads por keystroke / 0 listeners nuevos

Invariantes preservados:
- `_classifyBlocks`, `_normalizeTrainingPlan`, `parsePlanFromJSON` sin cambios
- Progression Engine sin cambios
- Schema vdsen-plan-v2 sin cambios
- Colecciones Firestore sin cambios

---

### FASE 14 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Coach Monitor: Bitácora completa de entrenamiento por sesión**

Archivos modificados:
- `vdsen-coach.html` — 2 parches quirúrgicos
- `tests/progression-engine.test.js` — P206-P215 (33 assertions nuevas)

Helper añadido (antes de `_coachGetWeeklyCheckins`):
- `_coachBuildBitacora(logs, week, planData)` — organiza todos los sets registrados en una semana por día → ejercicio → set. Incluye sets autoFilled (marcados). Incluye flags `done` y objeto `postsession` por día. Nombres de ejercicio y targets desde el plan si disponible, fallback genérico. 0 lecturas Firestore.

Comportamiento añadido en Monitor:
- `<details>` "📋 Bitácora completa — Sem N" al final del Monitor (colapsado por defecto)
- Muestra todos los días con datos, con header (✓/○ + label + RPE/EIMD/sueño del postsession)
- Por ejercicio: nombre, reps target, RIR target, tabla de sets con carga/reps/RIR real/ICS/pump
- ICS coloreado (verde/amarillo/rojo). Sets autoFilled marcados con "auto" en gris.

Invariantes preservados:
- 0 lecturas Firestore nuevas
- `_coachBuildBitacora` pura (determinista, sin side effects)
- Sin cambios a schema, colecciones, auth ni algoritmo de progresión

---

### FASE 13 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Coach Monitor: contexto semanal, tendencia de peso, check-in pendiente, adherencia**

Archivos modificados:
- `vdsen-coach.html` — 4 parches quirúrgicos
- `tests/progression-engine.test.js` — P196-P205 (37 assertions nuevas)

Helpers añadidos (antes de `loadMonitorClients`):
- `_coachGetWeeklyCheckins(entries, max)` — espejo de `_getWeeklyCheckins` del cliente
- `_coachCalcWeightTrend(entries, max)` — espejo de `_calcWeightTrend`; retorna `NO_DATA` (no `SIN_DATOS`)
- `_coachHasPendingCheckin(entries, currentWeek)` — true si `currentWeek > 1` y `ci_sem_{W}` ausente
- `_coachCalcAdherence(entries, week, totalDays, planData)` → `{sessionsCompleted, sessionsTotal, sessionPct, setsCompleted, setsTotal, setPct}`. SET_ADHERENCE_APPROXIMATE.

Bugs corregidos en el callback onSnapshot:
- `totalWeeks` estaba undefined → ahora `const totalWeeks = (_activePlanCache?.weeks) ?? 6`
- `planData?.days?.length` era undefined → ahora usa `_activePlanCache?.days?.length`

Comportamiento añadido en Monitor:
- Header de semana: "SEM N / M SEM" (M = totalWeeks del plan, no hardcoded 6)
- Chip tendencia de peso: ⚖ SUBIENDO/BAJANDO/ESTABLE + rate kg/sem (solo si NO_DATA no aplica)
- Chip check-in pendiente: "⚠ Check-in sem N pendiente" cuando aplica
- Badge adherencia: "ADHERENCIA SEM N / Sesiones N/M · X% / Series N/M · X%"

Invariantes preservados:
- 0 lecturas Firestore nuevas en los helpers
- CURRENT_WEEK vs REAL_WEEK: el Monitor usa solo `logs.currentWeek`
- Sin cambios a schema, colecciones, auth ni farmacología
- Clasificación REVIEW/PROGRESSING/STABLE/NO_DATA del attention monitor sin cambios

---

### FASE 12 (rama `claude/client-app-improvements-qayy4n` — pendiente merge)
**Client UX: Check-in History, Weight Trend, Week Performance Summary**

Archivos modificados:
- `vdsen-cliente.html` — 5 parches quirúrgicos
- `tests/progression-engine.test.js` — P186-P195 (36 assertions nuevas)

Funciones añadidas (antes de `_calcSessionStats`):
- `_getWeeklyCheckins(entries, max)` — extrae hasta `max` entradas `ci_sem_{W}` de LOGS, ordenadas newest-first
- `_calcWeightTrend(checkins)` — tasa de cambio de peso usando semanas reales (no asume consecutividad). Umbrales: >+0.5 → SUBIENDO; <-0.5 → BAJANDO; else → ESTABLE; <2 pesos → SIN_DATOS
- `_buildWeekPerfSummary()` — strip de stats semanales (series totales, RIR medio, ICS medio) para CURRENT_WEEK, todas las sesiones, excluye autoFilled. 0 lecturas Firestore. Devuelve `''` si no hay sets.
- `_buildCheckinHistory()` — tabla HTML de los últimos 6 check-ins con chip de tendencia de peso

Comportamiento añadido en Tab Check-in (`renderCheckin`):
- Chip "SEMANA N DE M" bajo el header, atenuado si `CURRENT_WEEK < REAL_WEEK`
- Sección "HISTORIAL DE CHECK-INS" antes del botón GUARDAR: chip tendencia (↑/→/↓) + tabla peso/HRV/sueño/WHO-5 de las 6 últimas semanas. Estado vacío: "Aún no hay check-ins previos."

Comportamiento añadido en Tab Entrenamiento (`renderEntrenamiento`):
- Strip "Resumen sem N" debajo del session dashboard: series totales, RIR medio e ICS medio de la semana completa (todas las sesiones en CURRENT_WEEK)
- Solo visible si hay al menos 1 serie completada en la semana

Invariantes preservados:
- CURRENT_WEEK vs REAL_WEEK: sin mutación
- 0 lecturas/listeners Firestore nuevos
- Sin cambios a schema, colecciones ni auth

---

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
