# T574 — Endpoint hospedado en Vercel staging + Firebase staging (federado, sin claves)

Proyecto Vercel: `vdsen-ecosistema-staging-t573` (`prj_ZefsZK0hyGe7WxNqenR7MO9f2H8O`, equipo `vdsenasesoria-svgs-projects`, Vercel Authentication = all). Firebase: `vdsen-ecosistema-staging` únicamente.

## Auditoría previa (gcloud, sólo lectura)
- Pool WIF `vercel-staging` ACTIVE; proveedor `vercel-t573` ACTIVE: emisor `https://oidc.vercel.com/vdsenasesoria-svgs-projects`, audiencia `https://vercel.com/vdsenasesoria-svgs-projects`, condición `assertion.sub == 'owner:vdsenasesoria-svgs-projects:project:vdsen-ecosistema-staging-t573:environment:production'` (sólo despliegues de entorno *production* de ese proyecto).
- Cuenta de servicio `vdsen-t573-runtime`: binding `roles/iam.workloadIdentityUser` a ese único sujeto; en el proyecto sólo `roles/datastore.user`; **sin claves gestionadas por el usuario** (sólo la clave de sistema). APIs `sts`, `iamcredentials`, `firestore` habilitadas.

## Implementación
`api/_firebaseAdmin.js`: modo federado (token OIDC de la cabecera `x-vercel-oidc-token` → STS → suplantación de la cuenta de servicio; configuración externa con identificadores públicos; el token se escribe en `/tmp` con modo 600). Se activa sólo para el proyecto Vercel staging (reconocido por su id público o por el claim `project_id` del token) o con `FIREBASE_AUTH_MODE=wif`; rechaza ids de proyecto de producción (`vdsen-ecosistema`, `vdsen-planes`), ids no `-staging` y cuentas de servicio ajenas. El modo por claves de producción no cambia. Sonda de sólo lectura `POST ?check=firestore` (usuario Firebase autenticado, sólo en el runtime federado) y `GET ?check=firestore` con `CRON_SECRET`.

## Resultados hospedados (HOSTED_STAGING_PASS, sin escrituras)
Despliegue `dpl_GxY66vL2HJhvkkipbanCvh2Ugcit` (target production del proyecto *staging*, commit `47b6b0e`), `docs/t574-hosted-staging-results.json`:
| Caso | Resultado |
|---|---|
| H01 GET sin credenciales → 401 | PASS |
| H02 POST sin token → 401 | PASS |
| H03 token Firebase inválido → 401 | PASS |
| H04 credencial federada real (STS + suplantación) → lectura Firestore | PASS (`READ_OK`) |
| H05 token válido, interruptores OFF → 202 DISARMED, cero escrituras | PASS |
| H06 cuerpo inválido → 400 | PASS |
| H07 método no admitido → 405 | PASS |
Control negativo: la misma versión como **Preview** (sujeto `environment:preview`) → sonda `502 READ_FAILED`: Google rechaza la identidad; la condición del proveedor funciona.

## Bloqueado (acción administrativa necesaria)
La credencial del operador recibe **403** al escribir/listar variables de entorno del proyecto Vercel (`POST/GET /v10/projects/{id}/env`). Sin ellas no se puede ejecutar la matriz con escrituras. Un propietario debe, en el proyecto staging: `AUTONOMOUS_PROGRESSION_ENABLED=true`, `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=true`, `CRON_SECRET` (sensible, conocido por quien ejecuta la prueba) y redeploy production; además el documento `releaseControl/autonomousProgression` con sólo UIDs sintéticos (lo crea la prueba con IAM de operador en staging). No se activó nada por código para eludir este límite. Pendiente por eso: PENDING/APPLIED/CONSUMED, idempotencia, E06, E08, cron, allowlist/canario hospedados (ya cubiertos en emulador y en staging con ejecutor local).
