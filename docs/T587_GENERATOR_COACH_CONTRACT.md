# T587 · Contrato Generador → Coach → Firestore → Cliente (estado verificado)

**Método:** `tests/t587-plan-roundtrip-matrix.test.js` (7 pruebas) pasa un plan realista del Generador (`vdsen-plan-v2`) por cada ruta del Coach y comprueba cada campo del que depende el motor. Nada se asumió de fases anteriores.
Rutas ejecutadas funcionalmente: **(1) pegar / PDF / aplicar IA** (`_normalizeTrainingPlan`) y **(2) pestaña JSON** (`parsePlanFromJSON`), más el sellado del guardado. Rutas verificadas por contrato estático (el código es inline en un modal): importar-y-reemplazar en el plan activo, exportar → reimportar, editor (metadatos de fila), duplicar plan / duplicar a cliente (`...planData`), borrador IA (`vdsen-ai`), plantillas.

## Resultado por campo (ambas rutas funcionales)
| Campo | ¿Sobrevive? | Nota |
| --- | --- | --- |
| `prescriptionExerciseId` | Sí | un PID existente se conserva byte a byte; los faltantes los acuña el guardado explícito (único por ejercicio) |
| `updatedAt` (ISO string) | Sí, por el guardado | todas las rutas que CREAN un plan lo fechan (`saveImportedPlan`, manual, plantilla, duplicar, borrador IA); la edición lo actualiza solo si cambia la prescripción |
| `repsRange` | Sí, cuando el Motor la declara | repeticiones fijas no reciben rango inventado; un rango que contradice las series se descarta |
| `muscleGroup` | Sí | solo claves del vocabulario VDSEN (19, tabla MEV/MRV); fuera de vocabulario se descarta; nunca se deduce del nombre |
| `musclePriorities` (plan) | Sí | `{PRIORITARIO:[…], NO_PRIORITARIO:[…]}`; un músculo en ambas clases se descarta |
| `exerciseId` | Solo si es un id conocido del catálogo o coincide por nombre exacto | un id desconocido se descarta; **nunca bloquea LOAD** (T582) |
| series, `repsTarget` por serie, `rirTarget`, `restSeconds` (incl. 0), `load`, `technique`, `supersetGroup`, campos de rendimiento | Sí | sin cambios |
| `grupos_objetivo` (por día) | **No (pérdida intencional)** | no existe en ningún contrato ni consumidor del repo; lo útil para el motor es `muscleGroup` por ejercicio |

**Pérdidas verificadas que requirieron corrección en T587:** ninguna en las rutas del Coach (lo corregido en T582–T586 sigue vigente en ambas rutas). La brecha real no está en el Coach sino en los **33 planes heredados** (ver `docs/T587_LEGACY_PLAN_NORMALIZATION.md`) y en lo que **emita el Generador** (abajo).

## Qué debe emitir el Generador (contrato exacto)
```
entrenamiento.musclePriorities   OPCIONAL  {"PRIORITARIO":[claves],"NO_PRIORITARIO":[claves]}   declarado por el Coach; no inferir; un músculo no va en ambas listas
entrenamiento.days[].exercises[].muscleGroup   OPCIONAL  UNA clave del músculo principal motor     solo si hay prioridades declaradas; nunca por el nombre del ejercicio
entrenamiento.days[].exercises[].repsRange     OPCIONAL  {"min":int,"max":int}                      solo con rango real (min < max); max = techo; cada repsTarget dentro del rango
entrenamiento.days[].exercises[].prescriptionExerciseId  NUNCA generarlo (solo copiar del request si es el mismo ejercicio/día)
entrenamiento.days[].exercises[].exerciseId    OPCIONAL  solo si el request trae lista de catálogo con ids
Claves permitidas de músculo: pectoral, dorsal_ancho, trapecio_medio, delt_anterior, delt_lateral, delt_posterior, biceps, braquial, triceps, cuadriceps, isquios, gluteo_mayor, gluteo_medio, gastrocnemio, soleo, erectores, recto_abdominal, oblicuos, serrato
```
Campos que NO deben emitirse esperando efecto: `grupos_objetivo` por día (se ignora). El servidor del repo (`api/vdsen-generate.js`, regla 23) y `references/motor-bloque-salida-entrenamiento.md` ya llevan este contrato.

## Bloque para actualizar la PARTE D del Proyecto Generador Maestro VDSEN
Texto para pegar. **NO se aplicó ni se comprobó en el Proyecto de ChatGPT.**

> **PARTE D — Salida de entrenamiento (adición T587).**
> 1. Por ejercicio de fuerza con rango real de repeticiones: `"repsRange":{"min":<int>,"max":<int>}` (min < max). `max` es el techo y cada `repsTarget` queda dentro. Repeticiones fijas ⇒ omite `repsRange`. Nunca inventes el mínimo.
> 2. Solo si el Coach declaró prioridades musculares: `entrenamiento.musclePriorities` = `{"PRIORITARIO":[…],"NO_PRIORITARIO":[…]}` y, en cada ejercicio, `muscleGroup` = una clave del músculo principal (lista exacta: pectoral, dorsal_ancho, trapecio_medio, delt_anterior, delt_lateral, delt_posterior, biceps, braquial, triceps, cuadriceps, isquios, gluteo_mayor, gluteo_medio, gastrocnemio, soleo, erectores, recto_abdominal, oblicuos, serrato). Un músculo no puede estar en ambas listas. NO_PRIORITARIO no significa mantenimiento. Si no hay prioridades declaradas, omite ambos campos; nunca los deduzcas del nombre del ejercicio.
> 3. No emitas `grupos_objetivo` por día ni otros campos fuera de este contrato: se descartan.
> 4. `prescriptionExerciseId`: nunca lo generes; copia el del request solo si es el mismo ejercicio en el mismo día. `exerciseId`: solo si el request trae un catálogo con ids.
> 5. Ningún otro campo de la prescripción cambia (series, `repsTarget`, `rirTarget`, `restSeconds`, `load`, técnica).
