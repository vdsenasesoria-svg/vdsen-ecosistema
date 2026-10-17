# T570-R — Motor autónomo de progresión (desarmado)

## Circuito
Bitácora persistida (atleta, reglas Firestore) → `POST /api/autonomous-progression-trigger` (Bearer Firebase; uid sólo del token) → ejecutor confiable (relee cliente/plan/logs en transacción) → decisión canónica + traza SRA (`mutation=NONE`) → overlay `APPLIED` → el Cliente lo lee (datos de servidor, no caché) → siguiente exposición.

## Frontera del canario (sistema de lanzamiento, no tarea del Coach)
`coaches/{coachId}.autoApplyCanary = { enabled, clientIds[], prescriptionExerciseIds[] }`, releído **dentro de cada transacción** (materializar y aplicar). Ausente / desactivado / cliente fuera / PID fuera ⇒ cero escrituras.
Interruptores de entorno (Vercel): `AUTONOMOUS_PROGRESSION_ENABLED`, `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED`, `CRON_SECRET`. Sin ellos el endpoint responde 202 DISARMED.

## Recuperación por cron
`GET` en la misma función (límite de 12 funciones de Vercel Hobby) con `Authorization: Bearer $CRON_SECRET`; `vercel.json` la programa `0 9 * * *`. En Hobby los crons son **a lo sumo diarios** y se ejecutan en cualquier momento de la hora programada: latencia máxima de recuperación ≈ 24 h + 59 min. Es un respaldo; el procesamiento normal es reactivo (notificación tras guardado confirmado + al cargar la app). Un plan Pro permitiría una frecuencia mayor.

## Estados por dimensión
| Dimensión | Estado |
|---|---|
| REPS (Regla A con RIR objetivo < 2) | funcional |
| REST (Regla C) | funcional |
| LOAD (Regla A con RIR objetivo ≥ 2) | `BLOCKED_EQUIPMENT_DATA` hasta que existan incrementos verificados (`coaches/*.equipmentIncrements` + identidad canónica de equipo). Con datos verificados el ejecutor ya los usa. No bloquea REPS/REST. |
| D/E | sin cambios numéricos |
| SRA | traza informativa, `mutation=NONE`, sin veto operativo |

## Reglas Firestore
Producción (`vdsen-ecosistema`), staging y `firestore.rules` del repositorio son **idénticas** (sha256 `a98507012c418ec14c0510265b6c88ec612760d39ca031ca81c70a75e36a77e9`). Copias de respaldo: `docs/t570r-evidence/`. No hace falta publicar reglas.

## Evidencia
- Emulador: `tests/t570r-autonomous-emulator.cjs` (20 pruebas) dentro de `scripts/test-auto-apply-emulator.cjs`.
- Staging real (`vdsen-ecosistema-staging`, cuentas sintéticas, reglas desplegadas): `scripts/t570r-staging-e2e.cjs` → `docs/t570r-staging-e2e-results.json`.
- Limitación declarada: en staging el ejecutor corrió localmente con identidad IAM del operador (controlador REST de transacciones); la función de Vercel no se desplegó contra staging.
