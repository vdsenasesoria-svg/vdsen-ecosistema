# T573 — Validación hospedada del motor autónomo (estado y runbook)

Estado: **BLOCKED** para el despliegue hospedado aislado; el motor sigue desarmado en producción.

## Por qué está bloqueado (evidencia, sin secretos)
- `create_project` en Vercel (POST /v11/projects, equipo `vdsenasesoria-svgs-projects`) → **403 forbidden**: la credencial disponible para el operador sólo lee/inspecciona; tampoco puede listar variables de entorno ni hay Vercel CLI autenticado.
- `AGENTS.md` prohíbe claves de cuenta de servicio. La única identidad aceptable en Vercel es federada (Vercel OIDC → Workload Identity Federation de GCP). Eso exige crear un proyecto Vercel con OIDC activo y variables propias: imposible sin permiso de escritura.
- No se creó ninguna credencial, pool, cuenta de servicio ni proyecto: no se dejó ningún recurso huérfano.

## Evidencia hospedada obtenida igualmente
- Preview del proyecto existente (sin credenciales de Firebase Admin, sin interruptores): `GET /api/autonomous-progression-trigger` → **503 `RUNTIME_NOT_CONFIGURED`** (antes de PR #62 caía con 500; corregido). Sin credenciales no puede haber ninguna mutación. Fila 1 de la matriz = HOSTED_PREVIEW_PASS.

## Matriz de aceptación (20 filas)
Leyenda: EMU = emulador (`tests/t570r-autonomous-emulator.cjs`), STG_LOCAL = staging real con ejecutor local e identidad IAM del operador (`scripts/t570r-staging-e2e.cjs`), HOSTED = función desplegada.

| # | Caso | Estado |
|---|---|---|
| 1 | Sin Firebase Admin → 503 | HOSTED_PREVIEW_PASS + unit |
| 2 | Sin token → 401 | EMU_PASS · STG_LOCAL_PASS (STG03) · HOSTED NOT_TESTED |
| 3 | Token inválido → 401 | EMU_PASS (endpoint, identidades inválidas) · HOSTED NOT_TESTED |
| 4 | Motor desactivado → 0 escrituras | EMU_PASS (E12) |
| 5 | Allowlist ausente → 0 escrituras | EMU_PASS · STG_LOCAL_PASS (STG00b) |
| 6 | Canario desactivado → 0 escrituras | EMU_PASS · STG_LOCAL_PASS (STG14) |
| 7 | Cliente fuera → 0 escrituras | EMU_PASS |
| 8 | PID fuera → 0 aplicaciones | EMU_PASS |
| 9 | Ejecución autorizada (sintética) | STG_LOCAL_PASS (STG02) |
| 10 | Materialización PENDING | STG_LOCAL_PASS |
| 11 | APPLIED | STG_LOCAL_PASS (STG05) |
| 12 | Lectura efectiva del Cliente | STG_LOCAL_PASS (STG06) |
| 13 | APPLIED → CONSUMED | STG_LOCAL_PASS (STG09c) |
| 14 | Idempotencia bajo reintentos | EMU_PASS · STG_LOCAL_PASS (STG10) |
| 15 | E06 escritura denegada | EMU_PASS · staging NOT_TESTED |
| 16 | E08 SAFETY_CONFLICT | EMU_PASS |
| 17 | LOAD bloqueado sin incrementos | EMU_PASS |
| 18 | REPS y REST independientes | EMU_PASS (REPS también STG_LOCAL) |
| 19 | Cron autenticado | STG_LOCAL_PASS (STG13) · HOSTED NOT_TESTED |
| 20 | Sin mutaciones productivas | Verificado por construcción: toda operación Admin/REST de escritura apuntó a `vdsen-ecosistema-staging`; en producción sólo hubo lecturas (reglas, lista de despliegues) |

HOSTED_STAGING_PASS: **ninguna fila** (bloqueado).

## Runbook para completar la prueba hospedada (cuando exista permiso de escritura en Vercel)
1. Proyecto Vercel nuevo `vdsen-ecosistema-staging-t573`: repo conectado, OIDC activo (modo `team`), Vercel Authentication = all, `commandForIgnoringBuildStep` que sólo construye la rama de validación, sin dominios productivos.
2. GCP (proyecto `vdsen-ecosistema-staging` únicamente): cuenta de servicio `vdsen-t573-runtime` con `roles/datastore.user`; pool WIF `vercel-staging` + proveedor OIDC (emisor `https://oidc.vercel.com/vdsenasesoria-svgs-projects`, audiencia `https://vercel.com/vdsenasesoria-svgs-projects`, condición `assertion.project_id == '<id del proyecto staging>'`); binding `roles/iam.workloadIdentityUser` limitado a ese `project_id`. Sin claves.
3. Código (rama separada): `api/_firebaseAdmin.js` con modo federado (config WIF no secreta; token OIDC de la cabecera `x-vercel-oidc-token` → credencial externa → ADC) manteniendo el modo actual por variables.
4. Variables del proyecto staging: `FIREBASE_PROJECT_ID=vdsen-ecosistema-staging`, interruptores `AUTONOMOUS_PROGRESSION_*` inicialmente `false`, `CRON_SECRET` aleatorio, doc `releaseControl/autonomousProgression` sólo con UIDs sintéticos.
5. Ejecutar la matriz contra la URL protegida (bypass temporal firmado), registrar commit exacto y limpiar (proyecto, WIF, SA, datos sintéticos).
