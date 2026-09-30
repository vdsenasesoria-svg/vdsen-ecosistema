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

## Antes de producción todavía falta

1. Provisionar entitlements (`scripts/admin-coach-api-access.cjs`) para los coaches aprobados antes de desplegar el API endurecido.
2. Smoke real de las apps web contra staging (apuntar una copia a `config/firebase-staging.config.json`) y, si se quiere, prueba real del API con un runtime de staging.
3. Autorización explícita para desplegar índices → app/API → reglas en producción (runbook).

Decisión de lanzamiento: **no hay bloqueos de seguridad de Firestore abiertos**; los bloqueos restantes son de credenciales de administrador para pruebas del API y de datos de equipo.
