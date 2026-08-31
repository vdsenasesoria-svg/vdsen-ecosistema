# VDSEN — CONTEXTO DEL GENERADOR DE PLANES
## Ecosystem Compatibility Contract

Fecha: 2026-08-30

---

## PROPÓSITO

Documento canónico de compatibilidad entre el Generador de Planes VDSEN
y el Ecosistema Coach/Cliente actual.

Un buen plan VDSEN ya no se evalúa solo por "¿Está bien diseñado?"
También por "¿Puede el ecosistema ejecutarlo y aprender de él?"

El Generador no debe pensar en el plan como un documento aislado.
Debe generar una PRESCRIPCIÓN que pueda ser ejecutada, registrada,
auditada y comparada longitudinalmente.

---

## REGLA DE CARGA DE CONTEXTO

- **Tarea UI / bug / frontend**: leer `VDSEN_DEV_STATE.md` — NO cargar este archivo salvo necesidad
- **Tarea Motor / generación / plan / adaptación longitudinal**: leer `VDSEN_DEV_STATE.md` + este archivo

---

## 1. ARQUITECTURA

```
Generador de Planes
      ↓
Coach App (vdsen-coach.html)
   → importación / edición / templates / catálogo
   → plan activo en Firestore (plans/{id})
      ↓
Client App (vdsen-cliente.html)
   → ejecución set-by-set
   → Progression Engine determinista (congelado v3.1)
   → logs/{uid}
      ↓
Coach Monitor
   → historial rendimiento
   → recomendaciones progrec_{W}_{D}
   → check-ins ci_sem_{W}
      ↓
Siguiente prescripción del Generador
```

Colecciones Firestore:
`clients/{uid}` · `plans/{id}` · `logs/{uid}` · `exercises/{id}` · `coaches/{uid}` · `compendio/{coachId}`

No diseñar nuevas colecciones desde el Generador.

---

## 2. CONTRATOS

| Contrato | Rol |
|----------|-----|
| `vdsen-generation-request-v1` | Input del Motor |
| `vdsen-generation-response-v1` | Output completo (plan + audit + warnings) |
| `vdsen-plan-v2` | Schema del plan puro persistido en Firestore |

`targets`, `decisionTrace`, `audit`, `warnings`, `errors`, `missingInputs`
→ viven en la response, fuera del plan puro.

---

## 3. prescriptionExerciseId — INFRAESTRUCTURA POST-GENERACIÓN

**El Motor NO debe generarlo.**

`prescriptionExerciseId` se añade en Coach App al guardar/importar el plan.
Identifica una instancia estable de un ejercicio dentro de un plan concreto.

- Al aplicar un template: se regenera
- No se hereda entre mesociclos

El plan generado debe usar `exerciseName` canónico y estable.
`prescriptionExerciseId` es conocimiento conceptual del Motor, no output del Motor.

---

## 4. EXERCISENAME — CANÓNICO Y ESTABLE

Regla: preferir el nombre canónico del catálogo cuando esté disponible.

Evitar variaciones innecesarias:
- "Press inclinado" / "Press Inclinado Máquina" / "Press pecho inclinado en máquina"
  → si refieren al mismo ejercicio canónico, usar el nombre del catálogo.

La estabilidad de `exerciseName` afecta:
- historial longitudinal
- matching legacy
- Coach Monitor
- templates
- sustituciones
- auditoría

`POSITION != IDENTITY` — no inferir identidad de `dayIndex`/`exerciseIndex`.

Una sustitución real debe ser tratada como nueva referencia.

---

## 5. LOAD / CARGA / PROGREC — SEPARACIÓN CONCEPTUAL

| Campo | Semántica |
|-------|-----------|
| `plan.sets[].load` | Placeholder prescriptivo. En planes nuevos automáticos: `0` |
| `logs.carga` | Carga REAL ejecutada por el cliente |
| `progrec.newLoad` | Sugerencia del Progression Engine para próxima exposición |

El Generador **no debe inventar cargas absolutas** en planes nuevos automáticos.
La Client App autoregula por `repsTarget + rirTarget + historial real`.

---

## 6. SET CONTRACT

Cada set generado debe incluir todos estos campos:

```json
{
  "setIndex": 0,
  "repsTarget": 10,
  "rirTarget": 2,
  "load": 0,
  "restSeconds": 120
}
```

`restSeconds` es funcional y visible en la UI. **No omitir. Debe ser numérico válido.**

Heurísticos orientativos (no leyes):
- Compound pesado: 150–240 s
- Compound moderado: 120–180 s
- Aislamiento: 60–120 s
- No usar `0` salvo que sea intencional

---

## 7. RIR — SEMÁNTICA CONGELADA

```
rir_error = actualRIR - rirTarget
positivo  → TOO_EASY
negativo  → TOO_HARD
|error| ≤ 1 → PRESCRIPTION_MATCH
```

No invertir este signo.

Principios de prescripción:
- Compounds: mayor margen (RIR 2–3 habitual)
- Aislamientos: toleran menor margen (RIR 1–2)
- Fatiga/readiness pueden subir RIR objetivo
- RIR 0 es contextual, no default universal

---

## 8. DOUBLE PROGRESSION

La Client App progresa reps primero, luego carga.
Prescribir rangos de reps claros: `8–10`, `10–12`, `12–15`.

`repsTarget` puede almacenarse como techo del rango.
La lógica debe conservar también el límite inferior cuando aplique.

---

## 9. PROGRESSION ENGINE — NO DUPLICAR

El Motor prescribe el mesociclo inicial.
El Client Engine (v3.1, congelado) adapta la ejecución set a set.
El Coach/Motor decide cambios estructurales en la siguiente prescripción.

Señales del Client Engine (solo lectura para el Generador):
`KEEP · PROGRESS_REPS · PROGRESS_LOAD · FREEZE_LOAD · ADJUST_LOAD_DOWN · REVIEW`
`ADD_SETS_CANDIDATE · REDUCE_SETS_CANDIDATE · DELOAD_CANDIDATE`

---

## 10. VOLUMEN — NO AUTOESCALAR POR BUEN RENDIMIENTO

Buen rendimiento no implica automáticamente `+1 serie`.

El volumen cambia solo con evidencia longitudinal suficiente.

Regla: el Generador debe usar `prioridad`, `volumeTarget`, `volumeRange`,
`frequencyTarget`, `readiness`, `previousPlan`, `learned_state`.
No aumentar volumen simplemente porque el cliente progresó carga.

---

## 11. VOLUMEN FRACCIONAL

Auditoría de volumen por músculo:

| Tipo | Valor fraccional |
|------|-----------------|
| Directo | 1.0 |
| Indirecto significativo | 0.5 |
| Estabilizador / menor | 0 |

El Coach Monitor depende de una prescripción auditable y consistente.

---

## 12. FRECUENCIA Y TOPOLOGÍA

La frecuencia distribuye volumen y calidad de ejecución.
No tratar 2–3x como obligación universal.

Topologías:
`ONE_ON_ONE_OFF · TWO_ON_ONE_OFF · THREE_ON_ONE_OFF · FOUR_ON_ONE_OFF`
`FIVE_ON_TWO_OFF · SIX_ON_ONE_OFF · CUSTOM`

Evaluar según: targets musculares, recuperación, calendario, adherencia, historial.
`TWO_ON_ONE_OFF` es heurística, no regla universal.

---

## 13. DELOAD — REACTIVO, NO CALENDARIO

No generar: "Semana 6 = deload automático".

La semana final del mesociclo es un **MESOCYCLE_CHECKPOINT**.

El deload real es reactivo y depende de:
- Rendimiento (cargas, reps, RIR real)
- EIMD post-sesión
- Dolor articular
- Sueño
- RPE
- Energía
- Otros datos disponibles

El Generador puede diseñar una semana final de revisión.
El Progression Engine (Client App, congelado v3.1) ya tiene su regla: `currentWeek === totalWeeks`.
El Generador no la duplica ni la contradice.

---

## 14. HISTORIAL DE EJERCICIOS — ESTABILIDAD

La Client App muestra por ejercicio:
- Últimas exposiciones (carga, reps, RIR, ICS)
- Tendencia
- PR simple
- Recomendación HOY

Para mantener historial limpio:
- Estabilidad razonable de ejercicios fundamentales
- Rotaciones con motivo
- Sustituciones reales claramente diferenciadas
- No cambiar nombres sin motivo

---

## 15. VARIACION_VERTICAL

```json
{
  "variacion_vertical": {
    "semana_inicio": 1,
    "semana_variacion": 4,
    "ejercicio_sustituto": "Nombre canónico",
    "nivel_sustituto": "suplementario"
  }
}
```

NO rotar ejercicios solo por calendario.
Rotar cuando: estancamiento repetido, tolerancia peor, adherencia, pérdida de ejecución,
alternativa mejor conocida, objetivo del mesociclo.

---

## 16. TEMPLATES

Al aplicar un template en Coach App:
- `prescriptionExerciseId` se regenera
- No se heredan: logs · progression history · check-ins · cargas reales · pharmacology

Implicación: los planes generados deben ser modularmente reutilizables.
Evitar datos client-specific dentro de la training structure.

---

## 17. TÉCNICAS ESPECIALES

La Client App soporta: `straight · rest-pause · superset · y3t · drop_set`.

No usar por defecto. Contextuales, no universales.
No para compensar mala prescripción.
Preservar compatibilidad con el renderer de la Client App.

---

## 18. CHECK-INS / WEIGHT TREND

Datos disponibles por semana: `peso · hrv · who5 · sleep`

Heurística descriptiva (solo UI):
- `> +0.5 kg/sem` → SUBIENDO
- `< -0.5 kg/sem` → BAJANDO
- `±0.5` → ESTABLE

Esta etiqueta NO es regla nutricional del Motor.
No ajustar calorías automáticamente por el chip de tendencia.
El objetivo del cliente siempre pesa más que la tendencia de corto plazo.

---

## 19. COACH ATTENTION MONITOR

El Monitor clasifica por ejercicio: `REVIEW · PROGRESSING · STABLE · NO_DATA`

Señales: `TOO_HARD_REPEATED · PERFORMANCE_REGRESSION · DELOAD_CANDIDATE`

El Generador debe producir planes auditables contra estas señales.
No crear una semántica paralela distinta.

---

## 20. ADHERENCIA

Coach Monitor puede mostrar: sesiones completadas · sets completados.

No convertir adherencia en juicio automático.
Usar adherencia longitudinal como contexto para futuras prescripciones.

Ejemplo: baja adherencia persistente → considerar simplificar el plan.
NO: subir complejidad/volumen automáticamente.

---

## 21. SESSION DASHBOARD

La Client App muestra: sets · ejercicios · RIR · ICS · tiempo sesión.

El Generador debe evitar sesiones impracticables.
Respetar: `duration target`, número de sets, descansos, supersets, transiciones.
La duración prescrita debe ser realista.

---

## 22. COACH PLAN EDITOR

Coach puede: autocompletar desde catálogo, reordenar ejercicios, editar `restSeconds` inline.

El output generado no debe depender de `order-index` como identidad.
Un reorder no debe cambiar el significado fisiológico del plan.

---

## 23. EXERCISE CATALOG

Cuando haya catálogo disponible, usar metadata:
`name · motorPattern · equipment · muscleType · fatigueCost · resistanceCurve`

El catálogo pesa más que nombres inventados por LLM.

---

## 24. LEARNED STATE vs PRIORS

Jerarquía cuando hay historial suficiente:
```
learned_state > ehrenstein_prior > population_prior
```

No reconstruir todo desde `population_prior` si ya existe historial fiable individual.

---

## 25. OBSERVATIONSCOUNT

Solo datos reales/comparables aumentan evidencia.

NO contar como observaciones: `reload · render · autoFilled · navegación · reintentos`

Los sets `autoFilled` no cuentan para Progression Engine, `observationsCount`, historial ni tendencia.
Interpretar `confidence` con cautela.

---

## 26. UPDATE_PLAN — MENOR CAMBIO SUFICIENTE

En `update_plan`: aplicar el menor cambio suficiente.

Preferir:
- Mantener ejercicios que funcionan
- Progresar targets
- Redistribuir pequeñas cantidades de volumen
- Ajustar frecuencia cuando mejora distribución
- Sustituir solo donde hay razón

Evitar: reescribir todo el plan sin necesidad.

---

## 27. PRIORITY CHAIN

Orden de decisión:

1. Seguridad / dolor / datos inválidos
2. Restricciones y avoids explícitos
3. Historial individual fiable
4. `learned_state`
5. RULE
6. RANGE
7. HEURISTIC
8. Population default

---

## 28. AUDITORÍA PRE-ENTREGA

Antes de emitir plan, validar:

**ENTRENAMIENTO**
- Días correctos y no vacíos
- Sets con reps válidas, RIR válidos, `restSeconds` válido
- Load compatible (`0` o numérico)
- `exercisesAvoid` respetado
- Volumen fraccional auditable
- Frecuencia coherente
- Session duration razonable
- Nombres de ejercicios consistentes

**NUTRICIÓN**
- Macros coherentes (±3%)
- Meals válidas
- Sustituciones razonables

**SUPLEMENTACIÓN**
- Tiers válidos

**SEGURIDAD**
- Restricciones respetadas
- Flags clínicos no ignorados

**LONGITUDINAL**
- `previousPlan` considerado
- Logs relevantes considerados
- No reacción exagerada a una sola sesión
- `learned_state` usado cuando corresponde

---

## 29. DO NOT — LISTA EXPLÍCITA

El Generador NUNCA debe:

- Generar `prescriptionExerciseId`
- Generar log keys (`log_{W}_{D}_{E}_s{S}`, etc.)
- Cambiar colecciones Firestore
- Crear `progression history` manual
- Inventar cargas absolutas en planes nuevos
- Escalar volumen automáticamente por buen rendimiento
- Imponer deload por calendario
- Invertir el signo de RIR
- Duplicar lógica del Client Progression Engine v3.1
- Diseñar multicoach / workspaces / transfers
- Introducir IA en progresión set-to-set
- Incluir secretos, UIDs o datos de clientes en el plan

---

## 30. NUEVA EXPECTATIVA

Checklist de plan compatible con el ecosistema:

- [ ] Ejercicio con nombre consistente y canónico
- [ ] Reps claras (rango definido)
- [ ] RIR claro y coherente con objetivo
- [ ] `restSeconds` válido y razonable
- [ ] `load` compatible (`0` para planes nuevos)
- [ ] Volumen auditable por músculo
- [ ] Frecuencia auditable
- [ ] Identidad post-save compatible (no depende de posición)
- [ ] Progresión posible en el siguiente mesociclo
- [ ] Sesión ejecutable en tiempo real
- [ ] Historial interpretable (nombres estables)
- [ ] Rotaciones justificadas
- [ ] Deload no rígido por calendario

---

*FIN DEL CONTEXTO DEL GENERADOR*
