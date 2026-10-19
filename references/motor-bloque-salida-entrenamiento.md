# BLOQUE DE SALIDA — ENTRENAMIENTO (contrato T584)

> **Estado:** texto listo para pegar en las instrucciones del Motor VDSEN externo. **Este archivo NO actualiza el Motor externo**: hasta que el propietario lo integre en sus instrucciones, el Motor seguirá emitiendo solo el techo de repeticiones (`repsTarget`). No cambia ningún criterio científico del Motor; solo qué campos transmite la salida.

Pega el bloque siguiente (entre las líneas `=====`) dentro del apartado de formato JSON de entrenamiento del Motor, reemplazando la descripción de los campos por ejercicio y por serie.

=====
## Salida de entrenamiento — campos por ejercicio y por serie

Cada elemento de `entrenamiento.days[].exercises[]` lleva:

| Campo | Regla |
|---|---|
| `exerciseName` | Obligatorio. EXACTO del catálogo VDSEN. |
| `prescriptionExerciseId` | **Opcional. NUNCA lo inventes ni lo generes.** Identifica la instancia prescrita (un ejercicio, en un día, dentro de un plan) y es lo que une su historial. Solo si el request trae el `prescriptionExerciseId` de ese MISMO ejercicio en ese MISMO día y lo mantienes sin cambios, cópialo literalmente. Ejercicio nuevo, sustituido o movido de día ⇒ OMÍTELO (la app lo asigna al guardar, y un plan regenerado empieza sin heredar historial). |
| `exerciseId` | **Opcional.** Solo si el request incluye una lista de catálogo con ids y el ejercicio está en ella: copia el id exacto. Si no hay lista o no estás seguro ⇒ OMÍTELO. Nunca lo construyas a partir del nombre. Su ausencia no impide la progresión. |
| `repsRange` | **Opcional.** `{"min":int,"max":int}` con el rango de repeticiones aplicable por fibra (Compendio A.4) **cuando prescribes un RANGO** (`min` < `max`). `max` es el techo. Todo `repsTarget` de serie queda dentro de `[min,max]`. **Repeticiones fijas ⇒ OMÍTELO.** Nunca inventes el mínimo: sale de A.4. |
| `technique`, `techniqueNote`, `supersetGroup`, `alternatives`, `nivel_medio`, `variacion_vertical` | Sin cambios. |
| `sets[]` | Un objeto por serie (ver abajo). |

Cada serie de `sets[]` lleva:

| Campo | Regla |
|---|---|
| `setIndex` | Entero consecutivo desde 0. |
| `repsTarget` | Obligatorio. Es el objetivo ESPECÍFICO de esa serie: el techo del rango por defecto, o un valor distinto dentro de `[min,max]` si esa serie lo requiere. En repeticiones fijas, el número fijo. |
| `rirTarget` | Obligatorio, por serie. Sin cambios. |
| `load` | `0` (el atleta registra la carga real). |
| `restSeconds` | Obligatorio, por serie. Sin cambios. |

Reglas de coherencia: no emitas `repsRange` si todas las series tienen el mismo objetivo y la prescripción es fija; no emitas un `repsTarget` fuera de `repsRange`; no cambies RIR, descansos, series ni técnica por haber añadido `repsRange`.

Ejemplos (fragmentos de `exercises[]`):

```json
{ "exerciseName": "Press convergente de pecho", "repsRange": {"min": 6, "max": 10},
  "sets": [ {"setIndex":0,"repsTarget":10,"rirTarget":2,"load":0,"restSeconds":120},
            {"setIndex":1,"repsTarget":8,"rirTarget":1,"load":0,"restSeconds":150} ] }
```
```json
{ "exerciseName": "Elevaciones laterales en polea", "sets": [ {"setIndex":0,"repsTarget":15,"rirTarget":2,"load":0,"restSeconds":60},
                                                            {"setIndex":1,"repsTarget":15,"rirTarget":2,"load":0,"restSeconds":60} ] }
```
```json
{ "exerciseName": "Remo en polea baja", "prescriptionExerciseId": "<copiado literalmente del request>", "repsRange": {"min": 8, "max": 12},
  "sets": [ {"setIndex":0,"repsTarget":12,"rirTarget":2,"load":0,"restSeconds":90} ] }
```
=====

## Qué comprobar tras integrarlo (el propietario)
1. Genera un plan de prueba: los ejercicios con rango traen `repsRange` y todos los `repsTarget` caen dentro; los de repeticiones fijas no lo traen.
2. Impórtalo en la app del Coach: el plan guardado conserva `repsRange` (el Coach descarta un rango incoherente en silencio, así que si falta, revisa que el Motor lo haya emitido).
3. Ningún `prescriptionExerciseId` ni `exerciseId` inventado: en planes nuevos deben estar ausentes salvo que el request los haya aportado.
