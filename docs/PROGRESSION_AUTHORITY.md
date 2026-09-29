# VDSEN — Estado de autoridad de progresión (T480–T495)

Documento de continuidad. Describe qué es canónico, qué sigue siendo legado y qué decisiones de producto/ciencia
siguen abiertas. Las pruebas T475–T495 fijan todo lo marcado como CANÓNICO.

## Flujo canónico (hoy, en modo shadow)

LOGS (ejecución real) → evidencia comparable por PID → política canónica (`assets/progression-magnitude-policy.js`)
→ registro shadow en `logs/{uid}/mesos/{planId}.progressionApplications[*].magnitude`
→ (dry-run) consumidor de overlay (`assets/progression-application-consumer.js`) → auditoría en el Monitor del Coach.

- `NUMERIC_APPLY_ENABLED=false` en los tres módulos; no existe estado APPLIED; nada modifica carga/reps/series/RIR/descanso.
- `vdsen-plan-v2` es prescripción base inmutable. Una aplicación futura es un overlay aditivo de UNA exposición exacta.
- Precedencia futura: SAFETY > override exacto del Coach > overlay canónico elegible > plan base.
- Identidad = `prescriptionExerciseId`; nombre y posición nunca son identidad de mutación.

## Módulos

| Módulo | Rol |
|---|---|
| `progression-auto-apply-shadow.js` | Ciclo de vida shadow (PENDING/REJECTED/STALE), idempotencia, guardas de contexto |
| `progression-magnitude-policy.js` | Reglas A–E (nivel C, heurísticas VDSEN/Ehrenstein-derivadas), ≥2 exposiciones comparables, dirección confirmada, conflicto de seguridad |
| `progression-equipment-resolver.js` | Carga deseada → carga físicamente realizable; sin metadatos de incremento ⇒ `UNRESOLVED_EQUIPMENT_INCREMENT` |
| `progression-application-consumer.js` | Planificador dry-run + transacción idempotente (rechaza mientras el flag esté apagado) |

## Cortafuegos (tests)

- T490: ninguna salida del motor legado (`progrec`, `newLoad`, `newReps`, `newSets`, `substituteExercise`…) puede llegar a un sink operativo
  de LOAD, REPS, SETS, RIR, REST, EXERCISE o FRECUENCIA/SPLIT, en ninguna de las dos apps.
- T482/T487: no existe escritor a `plans/` derivado de recomendaciones; solo autoría/edición explícita del Coach.
- T483/T484/T485/T488: sin prefill, sin reducción de series, sin base de calentamiento y sin arrastre de series desde recomendaciones o historia.

## Matriz de autoridad final (T507)

| Dimensión | Autoridad operativa | Evidencia / candidato canónico | Aplicación futura | Garantía (tests) |
|---|---|---|---|---|
| LOAD | Plan del Coach; el atleta registra la carga ejecutada | registro shadow canónico (Regla A) + resolvedor de equipo | overlay exacto de próxima exposición (inactivo) | t483, t485, t493, t503 |
| REPS | Plan del Coach (rango) | Regla A (reps dentro del rango) | overlay (inactivo) | t483, t493 |
| SETS | Plan del Coach (+ lo ya registrado hoy) | solo revisión del Coach (Regla B) | ninguna (estructural no autorizado) | t484, t488, t497, t499 |
| RIR | RIR del Coach (`rirByWeek`/sets); RIR observado separado | señales legadas solo informativas | ninguna | t496 |
| REST | Plan del Coach | Regla C (+30 s) | overlay (inactivo) | t493, t507 |
| EXERCISE | Coach; la sustitución del atleta es ejecución (sin PID) | ninguna | ninguna | t506 |
| FREQUENCY / SPLIT | Coach | ninguna | ninguna | t482, t490 |

Restos operativos CONTENIDOS (T515): **Temporizador de descanso** (`fatigueCost`) y los valores de visualización (RIR 2 / descanso 90 s cuando el Coach los omitió) son solo respaldo de UI: el conversor los marca (`rirDefaulted`/`restDefaulted`), un `restSeconds` o RIR de 0 escrito por el Coach se preserva (antes un descanso 0 de superserie se mostraba como 90), el RIR prescrito solo se registra en el log si lo escribió el Coach, el historial ya no guarda el RIR prescrito como observado y nada de esto se persiste como prescripción.

## Política de producto cerrada (T523)

Decisiones del director (política de producto VDSEN; **no** reglas científicas ni de Ehrenstein): **D/E → `COACH_REVIEW_REQUIRED`** (sin candidato numérico; no se reduce
carga, reps objetivo, series ni RIR); **C→E**: primera ocurrencia comparable → REST +30 s únicamente, si la misma condición persiste en la siguiente exposición
comparable → revisión del Coach; **serie representativa = última serie de trabajo válida** (sin calentamiento, autofill, express ni series de descenso planificadas; sin
sustituir series faltantes), procedencia `VDSEN_PRODUCT_POLICY_LAST_WORKING_SET`. La guía histórica A.12 de "serie extra" es `LEGACY_REFERENCE_NON_AUTHORITATIVE` (no se
edita ni se restaura). Windows T478 es `NON_BLOCKING_TECHNICAL_PENDING`. Los tres huecos históricos (`RULE_D_E_ALTERNATIVE_NOT_DEFINED`, `RULE_C_E_PRECEDENCE_NOT_DEFINED`,
`REPRESENTATIVE_SET_NOT_DEFINED`) ya no bloquean: se conservan solo como procedencia (`PRODUCT_POLICIES[].resolves`). `SCIENCE_POLICY_UNRESOLVED` sigue disponible para una rama
futura genuinamente desconocida.

## Estado pre-activación (T508–T516)

| Eje | Estado |
|---|---|
| Autoridad operativa legada | 0 |
| Autoridad de mutación por nombre | 0 (los nombres son etiquetas; identidad = PID / ids exactos) |
| Autoridad de prescripción del atleta | 0 |
| Progresión canónica / ruta de aplicación canónica | 1 / 1 (única escritura `tx.set` de overlays, en el consumidor) |
| Aplicación numérica real | APAGADA (`NUMERIC_APPLY_ENABLED=false`, sin estado APPLIED) |
| Identidad de equipo | 39 de 41 grupos con id canónico (69 de 71 ejercicios; T517 asigna cada máquina Impulse/Matrix por `exerciseId` exacto, sin fusionar por marca); sin resolver: "Máquina" genérica y el accesorio de polea (no es implemento de carga) — `docs/EQUIPMENT_INCREMENT_INVENTORY.md` |
| Incrementos de equipo | solo valores escritos por el Coach; ninguno en el repositorio. Modelo: ejercicio > sede+equipo > equipo compartido > sin resolver, en `coaches/{uid}.equipmentIncrements` y `exercises/{id}.loadIncrement` |
| Cola de equipos del Coach | modal "Equipos" + `docs/EQUIPMENT_ACTIVATION_READINESS.md` |
| Candidato listo (sintético) | `READY_BUT_DISABLED`; con la bandera forzada en un sandbox → `EXECUTABLE` (T513) |
| Guardia de activación | 19 verificaciones independientes; `canApply` exige `guard.ok` |
| Reproducción en sombra | `docs/SHADOW_REPLAY_REPORT.md` (15 escenarios sintéticos, motivos de bloqueo) |
| Ciencia sin resolver | solo bloquea ramas D/E (`SCIENCE_POLICY_UNRESOLVED`); Reglas A y C independientes; serie representativa = supuesto global provisional |

Falta antes de activar: (1) el Coach carga incrementos reales de equipo, (2) decisiones de ciencia: D/E, precedencia C/E, serie representativa, (3) validar el runner en Windows.

Estado detallado y verificable: `docs/AUTO_APPLY_READINESS.md`, `docs/AUTO_APPLY_ACTIVATION_CHECKLIST.md` (T522), búsqueda de fuentes `docs/PROGRESSION_SCIENCE_SOURCE_SEARCH.md` y opciones de producto `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md` (T521).

## Guardia de activación (T513)

`verifyActivationPreconditions` re-verifica 18 hechos directamente (cliente exacto, plan activo exacto, PID exacto, exposición origen válida,
exposición destino exacta, destino no iniciado, plan sin cambios, sin override del Coach, sin conflicto de seguridad, evidencia elegible,
dirección consistente, magnitud resuelta, identidad de equipo, incremento resuelto, unidad compatible, carga físicamente realizable,
clave de idempotencia válida, contexto de transacción vigente). `canApply` exige `guard.ok` además de la bandera y de no tener bloqueos;
los tests con la bandera forzada en un sandbox garantizan que ningún hecho faltante puede saltarse la guardia.

## Matriz de preparación de aplicación (T504)

`planApplication(...).readiness` lista 12 compuertas en orden fijo: IDENTITY, FRESHNESS, TARGET_EXPOSURE, COACH_OVERRIDE, SAFETY,
EVIDENCE_COUNT, DIRECTION_CONSISTENCY, MAGNITUDE_BRANCH, EQUIPMENT_IDENTITY, EQUIPMENT_INCREMENT, UNIT, TARGET_STARTED. `readiness.state` = BLOCKED | READY_BUT_DISABLED | EXECUTABLE. La ciencia sin definir se LOCALIZA (T512): `SCIENCE_POLICY_UNRESOLVED` solo bloquea ramas D/E; las Reglas A y C no se bloquean; la serie representativa es un supuesto global provisional (`globalProvisional`). Cada compuerta es PASS / BLOCKED /
NOT_EVALUATED / NOT_APPLICABLE con códigos explícitos (`EVIDENCE_COUNT_INSUFFICIENT`, `DIRECTION_CONFLICTING`, `DIRECTION_UNCONFIRMED`,
`POLICY_BRANCH_REQUIRES_RESOLUTION` + reglas sin resolver, `UNRESOLVED_EQUIPMENT_INCREMENT`, ...). Un candidato es ejecutable solo si todas
pasan Y la bandera está activa (`executable=false` mientras `NUMERIC_APPLY_ENABLED=false`).

## Decisiones abiertas (no resueltas a propósito)

1. ~~RIR prescrito~~ — **CERRADA (T496)**: el RIR prescrito es el del Coach (`plan.rirByWeek`/sets). `getAdjustedRIR` devuelve el RIR del Coach sin cambios (sin calendario, sin +2 reactivo, sin piso de barra libre); el RIR 0 se preserva. El estado de deload sigue como aviso informativo (`_computeDeloadTriggers`). RIR observado (`rir_real`) permanece separado.
2. ~~`_maybeSuggestExtraSet`~~ — **CERRADA (T497)**: eliminado (junto con `_showAddSetSuggestion`/`addExtraSetNow`). El conteo de series es prescripción estructural (Coach o futura política estructural canónica explícita); ICS/pump/RIR observado quedan solo como evidencia registrada. (`_maybeSuggestExtraSet` ya no existe.)
3. ~~Historial por nombre~~ — **CERRADA (T498)**: con `prescriptionExerciseId`, `_getExerciseHistoryEntry` y `_getPrevWeekData` usan solo historial/logs por PID (sin fallback por nombre ni posicional). El historial por nombre (`_getExerciseHistoryEntry`) se lee solo cuando el PID genuinamente no existe (planes legados). Los rellenos exprés (sets `autoFilled`) ya no escriben en el historial.
4. ~~Motor de progresión del cliente~~ — **DEGRADADO (T500)**: `calculateProgression` sigue generando `progrec_*` solo como evidencia/compatibilidad/diagnóstico. El atleta ya no ve recomendaciones legadas (sin bloque HOY, encabezado, referencia por serie, banner add_sets/deload, historial ni filas de resumen; solo señales de fatiga INFORMATIVAS). El Coach las ve únicamente como evidencia legada colapsada; la recomendación primaria es el registro canónico shadow. `_getProgRecForExercise` queda como adaptador de compatibilidad sin consumidores de UI.
5. **Metadatos de incremento por equipo** — **CAMINO CONECTADO (T501–T503), DATOS PENDIENTES**: el repositorio no contiene ningún incremento explícito (ver `docs/EQUIPMENT_INCREMENT_INVENTORY.md`, 0 de 28 equipos). El Coach puede configurarlo por ejercicio (editor "Incr.", `loadIncrement` en `exercises/{id}`, fuente `COACH_CONFIGURED`); el dry-run resuelve `carga deseada → carga realizable` con `resolveForCandidate` o bloquea con `UNRESOLVED_EQUIPMENT_INCREMENT` / `UNIT_MISMATCH` / `DIRECTION_NOT_REALIZABLE` / `EQUIPMENT_OUT_OF_RANGE`. Sin datos configurados nada es accionable.
6. **Ciencia sin resolver (T505)** — búsqueda en `docs/CONTEXTO_GENERADOR.md`, `docs/CONTEXTO_MAESTRO.md` y `references/*`: la "double progression" (reps primero, luego carga; §8) rige la progresión hacia ARRIBA (Regla A) y no elige entre reps y carga para D/E; nada define la precedencia C/E ni qué serie representa una exposición. Quedan explícitos y NO inventados (`SCIENCE_GAPS` en la política; `readiness.activationPrerequisites`): `RULE_D_E_ALTERNATIVE_NOT_DEFINED`, `RULE_C_E_PRECEDENCE_NOT_DEFINED`, `REPRESENTATIVE_SET_NOT_DEFINED`. Deben cerrarse por decisión del director antes de activar `NUMERIC_APPLY_ENABLED`.
7. ~~`exmod_*`~~ — **CERRADA (T499)**: el atleta ya no puede redefinir series/reps objetivo/RIR prescritos (editor `showExModModal`/`saveExMod`/`clearExMod` eliminado; ningún lector de `exmod_*`). Los `exmod_*` ya guardados en `logs/{uid}` se conservan sin borrar pero no se leen. El atleta sigue registrando ejecución (carga/reps/RIR observado), notas (`exnote_`), omisiones (`exskip_`) y unidad.
8. Validación del runner de emulador en Windows: pendiente.
