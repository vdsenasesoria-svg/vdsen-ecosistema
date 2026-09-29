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

## Decisiones abiertas (no resueltas a propósito)

1. ~~RIR prescrito~~ — **CERRADA (T496)**: el RIR prescrito es el del Coach (`plan.rirByWeek`/sets). `getAdjustedRIR` devuelve el RIR del Coach sin cambios (sin calendario, sin +2 reactivo, sin piso de barra libre); el RIR 0 se preserva. El estado de deload sigue como aviso informativo (`_computeDeloadTriggers`). RIR observado (`rir_real`) permanece separado.
2. ~~`_maybeSuggestExtraSet`~~ — **CERRADA (T497)**: eliminado (junto con `_showAddSetSuggestion`/`addExtraSetNow`). El conteo de series es prescripción estructural (Coach o futura política estructural canónica explícita); ICS/pump/RIR observado quedan solo como evidencia registrada. (`_maybeSuggestExtraSet` ya no existe.)
3. ~~Historial por nombre~~ — **CERRADA (T498)**: con `prescriptionExerciseId`, `_getExerciseHistoryEntry` y `_getPrevWeekData` usan solo historial/logs por PID (sin fallback por nombre ni posicional). El historial por nombre (`_getExerciseHistoryEntry`) se lee solo cuando el PID genuinamente no existe (planes legados). Los rellenos exprés (sets `autoFilled`) ya no escriben en el historial.
4. **Motor de progresión del cliente** (`calculateProgression`): sigue generando `progrec` como evidencia/señal legada; puede discrepar del
   candidato canónico (se muestran separados y etiquetados "no aplicada").
5. **Metadatos de incremento por equipo**: no existen; sin ellos ninguna carga puede ser accionable.
6. **Magnitud D/E (reps vs carga)**, precedencia C/E y representatividad de la serie: siguen sin resolver por la fuente.
7. ~~`exmod_*`~~ — **CERRADA (T499)**: el atleta ya no puede redefinir series/reps objetivo/RIR prescritos (editor `showExModModal`/`saveExMod`/`clearExMod` eliminado; ningún lector de `exmod_*`). Los `exmod_*` ya guardados en `logs/{uid}` se conservan sin borrar pero no se leen. El atleta sigue registrando ejecución (carga/reps/RIR observado), notas (`exnote_`), omisiones (`exskip_`) y unidad.
8. Validación del runner de emulador en Windows: pendiente.
