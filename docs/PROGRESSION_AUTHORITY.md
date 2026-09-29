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

1. **RIR prescrito**: conviven `plan.rirByWeek` (Coach), `getAdjustedRIR` (ajuste calendario −1 en semanas pico/intensif. y +2 por
   señales de deload reactivo en el cliente) y el piso RIR≥1 en compuestos de barra libre (seguridad). Requiere decidir cuál es la
   autoridad; el ajuste por calendario contradice "sin progresión por calendario".
2. **`_maybeSuggestExtraSet`** (cliente): sugiere una serie extra en sesión con umbrales fijos (ICS, pump, RIR, MRV). No es automático
   (requiere toque del atleta) pero es un recomendador de volumen paralelo al Coach.
3. **Historial por nombre** (`_getExerciseHistoryEntry`): PID primero, pero cae a la clave por nombre si no hay historial por PID
   (continuidad de datos legados). Alimenta referencias y la base del calentamiento.
4. **Motor de progresión del cliente** (`calculateProgression`): sigue generando `progrec` como evidencia/señal legada; puede discrepar del
   candidato canónico (se muestran separados y etiquetados "no aplicada").
5. **Metadatos de incremento por equipo**: no existen; sin ellos ninguna carga puede ser accionable.
6. **Magnitud D/E (reps vs carga)**, precedencia C/E y representatividad de la serie: siguen sin resolver por la fuente.
7. `exmod_*` (modificación de series/reps/RIR por el atleta para su semana): función existente de autoría del atleta; decisión de producto pendiente.
8. Validación del runner de emulador en Windows: pendiente.
