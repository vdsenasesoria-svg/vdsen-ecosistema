# VDSEN ECOSISTEMA — CONTEXTO MAESTRO PARA CLAUDE CODE

## PROYECTO
VDSEN Ecosistema — app de coaching de fitness.

## STACK
- HTML single-file
- Tailwind CDN
- Firebase SDK v10.12.0 modular
- Firebase Auth
- Firestore
- Vercel deploy estático

## ARCHIVOS PRINCIPALES
- vdsen-coach.html → app del coach
- vdsen-cliente.html → app del cliente

## FIREBASE
Proyecto:
vdsen-ecosistema

## REPO
vdsenasesoria-svg/vdsen-ecosistema
Privado.

---

## ESTADO ACTUAL

main HEAD producción:
2b6e927

Rama de trabajo:
claude/client-app-improvements-qayy4n

NO trabajar directamente sobre main.

FASES 7–14:
implementadas en la rama de trabajo y pendientes de merge a main.

### TESTS BASELINE
Archivo:
tests/progression-engine.test.js

Resultado baseline:
542/542 PASS

Rango actual:
P01–P215

INVARIANTE:
No aceptar cambios que reduzcan el baseline.

Después de CADA cambio:
node tests/progression-engine.test.js

Resultado esperado:
542/542 PASS o más.

---

## INVARIANTES DUROS

NUNCA:

- cambiar schema vdsen-plan-v2
- cambiar colecciones Firestore
- migrar datos
- tocar Auth
- tocar farmacología
- reescribir archivos completos
- hacer cambios masivos innecesarios
- mergear a main sin autorización explícita del usuario
- diseñar multicoach
- introducir breaking changes en claves de logs
- modificar algoritmos congelados sin autorización explícita

SINGLE-COACH es permanente.

EDICIÓN:
usar cambios quirúrgicos / str_replace sobre bloques concretos.

---

## COLECCIONES FIRESTORE

coaches/{uid}

clients/{uid}

Campos relevantes de clients:
```
{
  coachId,
  activePlanId,
  nutritionPlan,
  nutritionRaw,
  supplementPlan,
  supplementsRaw,
  pharmacoPlan
}
```

plans/{id}

Shape relevante:
```
{
  weeks,
  daysPerWeek,
  days: [
    {
      dayIndex,
      label,
      exercises: [
        {
          exerciseName,
          sets: [
            {
              setIndex,
              repsTarget,
              rirTarget,
              load,
              restSeconds
            }
          ]
        }
      ]
    }
  ],
  coachId,
  clientId
}
```

logs/{uid}

Shape:
```
{
  entries: {
    key: value
  },
  currentWeek
}
```

exercises/{id}

compendio/{coachId}

NO cambiar nombres ni jerarquía de estas colecciones.

---

## LOG ENTRIES — CONTRATO

### SET LOG
Clave:
`log_{W}_{D}_{E}_s{S}`

Valor:
```
{
  carga,
  reps,
  unit,
  done,
  rir_real,
  ics,
  pump,
  ts,
  autoFilled
}
```

### DAY DONE
Clave:
`done_{W}_{D}`

Valor:
boolean

### POST SESSION
Clave:
`postsession_{W}_{D}`

Valor:
```
{
  eimd,
  articular,
  patron,
  sleep,
  rpe
}
```

### PROGRESSION RECOMMENDATIONS
Clave:
`progrec_{W}_{D}`

Valor:
```
{
  recommendations: [],
  deloadTriggers: []
}
```

### WEEKLY CHECK-IN
Clave:
`ci_sem_{W}`

Valor:
```
{
  peso,
  hrv,
  who5,
  sleep
}
```

Estas claves son contratos existentes.
No renombrarlas.
No cambiar su semántica.
No crear variantes duplicadas si no es estrictamente necesario.

---

## FASES YA IMPLEMENTADAS

### FASE 7
Dashboard cliente:
- resumen semanal
- sesión activa

### FASE 8
Entrenamiento en vivo del cliente visible en Monitor del coach.

### FASE 9
Catálogo de ejercicios con MEV/MRV.

IMPORTANTE:
MEV/MRV en esta app forman parte de lógica existente/legacy.
No reinterpretar automáticamente la arquitectura sin autorización.

### FASE 10
Compendio PDF + exportación IA.

### FASE 11
Ficha unificada vdsen-ficha-v2:
- import
- export

### FASE 12 — CLIENTE
Helpers en vdsen-cliente.html:

`_getWeeklyCheckins(entries, max)`
→ `[{week, data}]` newest-first

`_calcWeightTrend(checkins)`
→ `{ status: 'SUBIENDO'|'BAJANDO'|'ESTABLE'|'SIN_DATOS', rate }`

`_buildWeekPerfSummary(...)`

`_buildCheckinHistory(...)`

### FASE 13 — COACH
Helpers en vdsen-coach.html:

`_coachGetWeeklyCheckins(entries, max)`

`_coachCalcWeightTrend(entries, max)`

`_coachHasPendingCheckin(entries, currentWeek)`
→ boolean

`_coachCalcAdherence(entries, week, totalDays, planData)`
→ `{ sessionsCompleted, sessionsTotal, sessionPct, setsCompleted, setsTotal, setPct }`

NOTA:
setPct usa semántica:
SET_ADHERENCE_APPROXIMATE

Fixes ya aplicados:
- totalWeeks undefined
- planData undefined
en Monitor.

Monitor actualmente muestra:
- SEM N/M
- chip tendencia peso
- chip check-in pendiente
- badge adherencia sesiones
- badge adherencia series

### FASE 14 — COACH
Helper:

`_coachBuildBitacora(logs, week, planData)`

Retorna:
```
[
  {
    dayIndex,
    label,
    done,
    postsession,
    exercises: [
      {
        exIndex,
        name,
        repsTarget,
        rirTarget,
        sets: [
          {
            setIndex,
            carga,
            reps,
            rirReal,
            ics,
            pump,
            unit,
            done,
            autoFilled
          }
        ]
      }
    ]
  }
]
```

UI:
sección colapsable
"Bitácora completa"

Jerarquía:
día → ejercicio → set

---

## HELPERS PUROS

Todos estos helpers actuales son puros y NO consultan Firestore directamente.

**CLIENTE:**
- `_getWeeklyCheckins`
- `_calcWeightTrend`
- `_buildWeekPerfSummary`
- `_buildCheckinHistory`

**COACH:**
- `_coachGetWeeklyCheckins`
- `_coachCalcWeightTrend`
- `_coachHasPendingCheckin`
- `_coachCalcAdherence`
- `_coachBuildBitacora`

REGLA:
Antes de escribir lógica nueva, revisar si uno de estos helpers ya resuelve el problema.

Evitar duplicación de semántica entre coach y cliente.

---

## ALGORITMO PROGRESIÓN VDSEN v3.1 — CONGELADO EN LA APP

**ESTE BLOQUE NO SE TOCA SIN AUTORIZACIÓN EXPLÍCITA.**

Reglas:

- ICS < 7 → bajar carga
- Semana 6 → deload automático
- También deload automático en la última semana del plan

Thresholds de peso:

```
rate > 0.5  → SUBIENDO
rate < -0.5 → BAJANDO
else        → ESTABLE
```

Recomendaciones se guardan en `progrec_{W}_{D}`

IMPORTANTE:
Aunque el Generador Maestro VDSEN actual use deload reactivo y multimodal, el Progression Engine v3.1 de ESTA APP está congelado.

No intentar "corregirlo" durante otras fases.

Separar:

- PRESCRIPCIÓN NUEVA → puede usar reglas metodológicas actuales.
- ENGINE v3.1 EXISTENTE → preservar tal como está.

---

## VDSEN PLAN — INTEROPERABILIDAD

Schema:
vdsen-plan-v2

NO cambiarlo.

En Firestore `plans/{id}`, la estructura persistida relevante es:

```
{
  weeks,
  daysPerWeek,
  days: [...]
}
```

El importador/exportador puede normalizar estructuras externas, pero NO modificar silenciosamente la estructura persistida ni migrar datos.

No crear dos fuentes de verdad persistidas.

---

## IMPORTACIÓN DE PLANES

Existe contexto previo de bugs de importación.

Se implementó en rama:

`api/vdsen-plan-normalizer.js`

Funciones:
- `normalizeVdsenPlan`
- `validateVdsenPlan`

Tests:
T-N01..T-N09

IMPORTANTE:
Este módulo corre en Node.

NO asumir que vdsen-coach.html lo utiliza automáticamente.

El browser todavía tiene lógica inline como:
- `_classifyBlocks`
- `_normalizeTrainingPlan`
- `parsePlanFromJSON`
- `_submitModalImport`

Cuando se trabaje en importación:

TRAZAR SIEMPRE:
```
raw → parsed → classified → normalized → validated → persisted
```

No modificar JSONs a ciegas para adaptarlos a bugs del parser.

Buscar primero causa raíz.

---

## REGLA DE DEPLOY

Vercel despliega desde main.

La rama de trabajo:
`claude/client-app-improvements-qayy4n`

NO está en producción hasta merge explícito.

Si un fix funciona en rama pero no en producción:
antes de asumir bug nuevo, verificar:

1. branch
2. commit
3. deploy
4. hash en producción

NO mergear a main sin autorización explícita.

---

## REGLAS DE TRABAJO

Antes de editar:

1. git status
2. confirmar rama actual
3. localizar bloque exacto
4. entender flujo afectado
5. revisar helpers existentes
6. identificar invariantes relevantes

Al editar:

- str_replace quirúrgico
- mínimo cambio suficiente
- no refactor global
- no reformat completo
- no mover lógica sin necesidad

Después:

1. node tests/progression-engine.test.js
2. confirmar 542/542 PASS o más
3. revisar git diff
4. confirmar que no hay cambios colaterales
5. commit en: `claude/client-app-improvements-qayy4n`
6. push SOLO a esa rama
7. NO mergear a main

---

## FORMATO DE RESPUESTA DESPUÉS DE CADA TAREA

Reportar:

**A. CAUSA RAÍZ**

**B. CAMBIO REALIZADO**

**C. ARCHIVOS MODIFICADOS**

**D. FUNCIONES/BLOQUES TOCADOS**

**E. INVARIANTES VERIFICADOS**

**F. TESTS**
Ejemplo: 542/542 PASS

**G. GIT**
- branch
- commit hash

**H. RIESGOS / DEUDA TÉCNICA**
solo si existe

**I. MERGE A MAIN**
Debe decir: NO realizado
salvo autorización explícita del usuario.

---

## PRINCIPIO GENERAL

VDSEN no debe convertirse en una colección de parches aislados.

Toda nueva fase debe respetar:

```
datos existentes → helpers puros → engine congelado → UI → Firestore existente
```

sin romper interoperabilidad.

El objetivo es evolucionar:

```
Coach App → Client App → logs → Progression Engine → historial longitudinal
→ Coach Monitor → siguiente prescripción
```

manteniendo separación entre:

- PRESCRIPCIÓN
- EJECUCIÓN
- PROGRESIÓN
- HISTORIAL

No confundir posición con identidad.
No inferir identidad estable de un ejercicio solo por dayIndex/exIndex.

---

*FIN DEL CONTEXTO MAESTRO*
