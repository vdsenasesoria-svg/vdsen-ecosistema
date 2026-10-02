# Puerta de lanzamiento a producción (T541) — NO DESPLEGADO

Estados: PASS / FAIL / BLOCKED / NON_BLOCKING_PENDING. Producción (`vdsen-ecosistema`) y `vdsen-planes`: sin tocar.

| Área | Estado | Evidencia |
|---|---|---|
| CODE | PASS | suite unitaria 835/835; `git diff --check` limpio |
| RULES | PASS (staging) | reglas desplegadas y probadas en `vdsen-ecosistema-staging`; **no** en producción |
| INDEXES | PASS (staging) | `plans_backup (coachId, clientId, backedUpAt)` en estado READY; consulta de runtime sin error |
| TENANT ISOLATION | PASS | emulador 11/11 + staging real 0 fallos |
| EXECUTION EVIDENCE | PASS | el atleta escribe carga / reps / RIR observado; otros coaches no pueden leer ni envenenar `entries`, `currentWeek`, historial, `progrec` |
| COACH AUTHORITY | PASS con 1 caso BLOCKED | campo `apiAccessEnabled`: crear / añadir / borrar+recrear denegados en staging; voltear o quitar un `true` existente: BLOCKED_BY_STAGING_ADMIN_CREDENTIALS (cubierto por emulador A02/A03) |
| ORPHAN SECURITY | PASS con 1 caso BLOCKED | robo, adopción, asignación por atleta, enumeración: denegados; reclamar un huérfano preexistente: BLOCKED_BY_STAGING_ADMIN_CREDENTIALS (emulador O01) |
| PHONE INDEX | PASS | lectura pública intacta; solo el coach dueño escribe / borra |
| PRIVATE COACH DATA | PASS | plantillas, compendio, respaldos, fichas, prospectos |
| API ENTITLEMENT UNIT | PASS | 401 / 403 sin coach / 403 sin entitlement / 403 false / permitido true; falla cerrado (5 + 18 + 57 + 4 pruebas) |
| API ENTITLEMENT REAL STAGING | BLOCKED | API_STAGING_RUNTIME = NOT_CONFIGURED; API_REAL_200_SMOKE = BLOCKED_BY_STAGING_ADMIN_CREDENTIALS (no hay runtime de la API contra staging ni credencial Admin; no se crearon claves) |
| ATHLETE FLOW | PASS (Firestore) | lectura del propio cliente y plan, guardado de ejecución, sin acceso a datos ajenos. La app web no se ejecutó contra staging |
| COACH FLOW | PASS (Firestore) | alta de cliente, lista, plan, materialización PENDING, equipo, respaldos. La app web no se ejecutó contra staging |
| ROLLBACK READINESS | PASS | `docs/FIRESTORE_DEPLOYMENT_RUNBOOK.md`: versión de reglas previa y orden de reversión |
| NUMERIC_APPLY_ENABLED | PASS | `false` en los 4 módulos; ningún registro APPLIED |
| EQUIPMENT DATA | NON_BLOCKING_PENDING | 0 incrementos reales (necesarios para candidatos de carga, no para la seguridad) |

## Puerta T547 (pre-producción; staging sintético, producción sin tocar)

Nunca es un GO automático: la decisión de producción sigue siendo de Ayrton / el director.

| Área | Estado | Evidencia |
|---|---|---|
| TENANT SECURITY | PASS | emulador 11/11 + `docs/staging-smoke-results.json` (116 checks, 0 fallos; 2 BLOCKED por credencial Admin, sin cambio); otro coach / atleta denegados en la edición de plan activo; adopción cross-tenant y cambio de `coachId` denegados |
| ACTIVE PLAN OWNER EDIT | PASS | regla `plans` update: el coach dueño edita su plan `active` (y un `draft_approved` solo si es el `activePlanId` del cliente); emulador `tests/t547-active-plan-edit.cjs` 7/7; verificado en staging real con el editor del Coach |
| PER-SET PRESCRIPTION FIDELITY | PASS | editor por serie; `scripts/client-staging-coach-editor-fidelity.cjs` 19/19 (plan con forma Ayrton 7d/32 ej/80 series: 0 diffs inesperados, 32 PID, RIR heterogéneo exacto, `createdAt`/`updatedAt` correctos) |
| EXPRESS EVIDENCE INTEGRITY | PASS | `express` y `expressFinal` quedan fuera de la serie representativa y de la exposición comparable (`tests/t547-express-canonical-exclusion.test.js`); sigue siendo historial de ejecución |
| LEGACY MISSING-OBSERVATION INTEGRITY | PASS | `calculateProgression` ya no fabrica RIR=objetivo / ICS=8 / Pump=2; faltante = `null` ("Sin registro"); sigue sin autoridad (sin escrituras de prescripción, overlays ni estado canónico); `tests/t547-legacy-missing-observation.test.js` |
| REAL STANDARD SESSION | PASS (clon sintético) | `scripts/client-staging-standard-session.cjs` 42/42: día 2 "Lower A", 11/11 series por serie (NO Express), recarga + re-login, serie representativa real = seleccionada, materializador PENDING/REJECTED, APPLIED 0, overlays 0. **No** sustituye la sesión humana de Ayrton (puerta final de UX) |
| MOBILE QA | PASS | `scripts/client-staging-mobile-qa.cjs` 48/48 a 320/360/375/390/414/430 px |

Pendiente humano: la sesión real de Ayrton en su cuenta de staging (cuenta y plan conservados sin tocar). NUMERIC_APPLY_ENABLED sigue `false`.

## Puerta T552 (cierre técnico pre-producción; staging sintético, producción sin tocar)

Estados factuales; **no** es un GO automático. La puerta humana (UX) es independiente y sigue en PARTIAL hasta el re-chequeo de Ayrton.

| Hallazgo | Estado | Evidencia |
|---|---|---|
| PLANS CREATE OWNERSHIP | PASS | regla `plans` create exige `coachId == auth.uid` **y** `clientId` string no vacío con `ownsClient(clientId)` (cliente existente del mismo coach). Emulador `tests/t552-plans-create-ownership.cjs` 8/8 (4 en rojo antes del parche); staging real (reglas desplegadas en `vdsen-ecosistema-staging`): propio PASS, cliente de otro coach / inexistente / otro coach / coachId forjado / atleta / sin sesión DENEGADOS |
| REST = 0 IMPORT FIDELITY | PASS | `restSeconds: 0` se conserva en import -> normalización -> guardado -> export -> re-import -> modal de actualizar plan (antes: `parseInt(x ?? 90) || 90` lo convertía en 90). 60 / 90 / 150 sin cambios; ausente / inválido siguen en 90. `tests/t552-coach-import-export-fidelity.test.js` + staging |
| PID EXPORT FIDELITY | PASS | `exportActivePlanJSON` omitía `prescriptionExerciseId`; además `_normalizeTrainingPlan` y el modal de actualizar plan lo descartaban. Ahora los 32 PID del plan con forma Ayrton (con nombres duplicados y PID distintos) sobreviven export -> import -> guardado -> actualizar, byte a byte y en orden; nunca se deriva de `exerciseId` |
| T551 CROSS-PLAN SAME-PID ISOLATION | PASS | plan B reimportado desde el export de A comparte TODOS los PID; en Semana 2 de B no aparece ÚLTIMA SEMANA ni USAR CARGA/REPS; control mismo plan + mismo PID + semana-1 exacta sí; la evidencia de A queda intacta. `tests/t552-cross-plan-same-pid.test.js` (la decisión `_logsPlanChanged` se extrajo sin cambio de lógica) + staging |
| USAR CARGA/REPS CONTRACT | UNCHANGED | explícito, solo carga + reps, borrador, nunca RIR / ICS / Pump / notas / prescripción, sin autoguardado |
| LEGACY (fuera de alcance, abierto) | OPEN | `_getPrevWeekData` conserva el fallback por nombre / posición para planes sin PID (alimenta calentamiento y recomendaciones advisory); `buildBoostcampExercise` (código muerto) |
| EXPORT (fuera de alcance, abierto) | OPEN | el export JSON sigue sin llevar `supersetGroup`, `nivel_medio` ni `variacion_vertical` |

**TECHNICAL_PREPRODUCTION_BLOCKERS_CLOSED**: los tres hallazgos conocidos y el hueco cross-plan de T551 pasan (emulador, unidad y staging). Pendiente humano: re-chequeo corto de Ayrton (ICS, descanso, notas, ÚLTIMA SEMANA / USAR). NUMERIC_APPLY_ENABLED sigue `false`; producción sin tocar y sin desplegar.

## Antes de producción todavía falta

1. Provisionar entitlements (`scripts/admin-coach-api-access.cjs`) para los coaches aprobados antes de desplegar el API endurecido.
2. Smoke real de las apps web contra staging (apuntar una copia a `config/firebase-staging.config.json`) y, si se quiere, prueba real del API con un runtime de staging.
3. Autorización explícita para desplegar índices → app/API → reglas en producción (runbook).

Decisión de lanzamiento: **no hay bloqueos de seguridad de Firestore abiertos**; los bloqueos restantes son de credenciales de administrador para pruebas del API y de datos de equipo.
