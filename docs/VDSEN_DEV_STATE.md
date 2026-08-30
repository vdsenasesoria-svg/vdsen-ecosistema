# VDSEN Dev State — Handoff Document
> Actualizado: 2026-08-30 · Rama activa: `claude/client-app-improvements-qayy4n`

---

## Estado actual

| Item | Valor |
|------|-------|
| Último commit en rama | ver `git log --oneline -5` |
| Baseline FASE 5 | `4a87e42` (en main) |
| FASE 6 baseline | `0d8863c` |
| Suite tests | **255/255 PASS** (P01–P109) |
| Estado merge | **NO MERGEADO** — requiere autorización explícita |

---

## FASES completadas

### FASE 5 (mergeada a main — `4a87e42`)
- Máquina de estados de workout en `vdsen-cliente.html`
- Algoritmo progresión v3.1 completo
- Check-in post-sesión + semanal
- Deload automático semana 6

### FASE 6 (en rama, self-review completado)
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
- NO `add_sets` automático (solo el coach lo ordena)
- NO recalcular progrec en path de historial (consume el ya existente)

### Colecciones Firestore (NO cambiar)
- Sin nuevas colecciones
- Sin migración destructiva
- `activePlanId` intocable
- `logs/{uid}` — doc único por cliente

---

## Backlog ordenado (NO implementar sin autorización)

```
A. Deload semana 5 opcional (coach-configurable threshold)
B. Check-in semanal mejorado (HRV integración manual)
C. Sustitución de ejercicio en sesión activa (sin perder historial)
D. Exportar logs como CSV desde panel coach
E. Notificaciones push (Firestore → FCM) para nuevo plan disponible
F. Editor de plan drag-and-drop (reordenar días/ejercicios)
G. Foto-progreso del cliente (Storage bucket separado)
```

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
- P01–P60: motor de progresión (algoritmo core, RIR, ICS, pump, deload)
- P61–P87: casos edge (Y3T, FST7, autoFilled, prevWeekData, volumen)
- P88–P105: FASE 6 baseline (historia, identidad, navegación semana, coach)
- P106–P109: self-review bug fixes (orden sets, unidad, stale progrec, XSS)

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
