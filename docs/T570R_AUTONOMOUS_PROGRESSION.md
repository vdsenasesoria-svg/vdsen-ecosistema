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

## T571 — segunda frontera, consumo y runtime
- **Allowlist de lanzamiento** `releaseControl/autonomousProgression` = `{ schema:'vdsen-autonomous-release-v1', enabled:true, clientIds:[≤10 uids] }`. Sólo Admin la escribe (ninguna regla la expone). Se relee dentro de cada transacción canónica (materializar, aplicar, consumir). Ausente/vacía/inválida/comodín ⇒ cero escrituras. El cron sólo intenta a los uids de la allowlist.
- **APPLIED → CONSUMED**: el atleta añade un recibo (append-only, reglas ya existentes) tras persistir la primera serie de la exposición objetivo; el servidor lo valida (registro, overlay, PID, plan, exposición, ejecución persistida) y hace la transición. El overlay sigue mostrándose en la exposición iniciada.
- **Runtime Vercel (Hobby)**: la lectura de variables de entorno del proyecto está denegada a este operador (403) y no hay Vercel CLI; no se verificaron FIREBASE_*/CRON_SECRET/AUTONOMOUS_* en producción. Preview no tiene credenciales de Firebase Admin (la función ahora responde 503 `RUNTIME_NOT_CONFIGURED`). Sin credenciales de staging seguras en Preview no se hizo la prueba hospedada.
- Orden de activación sugerido (cuando se pueda verificar el entorno): 1) variables en Vercel con `AUTONOMOUS_PROGRESSION_ENABLED=false`; 2) desplegar; 3) crear `releaseControl/autonomousProgression` con el uid sintético; 4) canario en el Coach sintético; 5) habilitar `ENABLED` y `NUMERIC_APPLY_ENABLED`.
