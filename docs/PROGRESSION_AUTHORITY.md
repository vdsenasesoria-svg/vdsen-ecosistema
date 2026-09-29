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

Restos operativos documentados (no son autoridad de prescripción): **Temporizador de descanso** — si el set del plan no trae
`restSeconds`, el temporizador usa una ayuda por `fatigueCost` (solo cronómetro, no persiste); al cargar el plan se muestran valores por
defecto de visualización cuando el Coach omitió RIR (2) o descanso (90 s).

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
