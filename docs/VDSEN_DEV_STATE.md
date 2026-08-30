# VDSEN Dev State — Handoff Document
> Actualizado: 2026-08-30 · main HEAD: `2b6e927`

---

## Estado actual

| Item | Valor |
|------|-------|
| main HEAD | `2b6e927` — FASE 6 mergeada |
| FASE 5 commit | `4a87e42` |
| FASE 6 commit | `2b6e927` (merge --no-ff) |
| Suite tests | **255/255 PASS** (P01–P109) |
| Vercel | auto-deploy en curso (push a main `2b6e927`) |
| Siguiente fase | **FASE 7 — Coach Attention Monitor** |

---

## FASES completadas

### FASE 5 (mergeada a main — `4a87e42`)
- Máquina de estados de workout en `vdsen-cliente.html`
- Algoritmo progresión v3.1 completo
- Check-in post-sesión + semanal
- Semana final = MESOCYCLE_CHECKPOINT únicamente.
  Deload es reactivo y requiere ≥2 deloadTriggers.
  La semana final sola nunca dispara deload.

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

---

## Comandos de referencia

```bash
# Ver rama actual y último commit
git log --oneline -5

# Correr tests
node tests/progression-engine.test.js

# Diff vs main
git diff main...HEAD --stat

# Push rama
git push -u origin claude/client-app-improvements-qayy4n
```
