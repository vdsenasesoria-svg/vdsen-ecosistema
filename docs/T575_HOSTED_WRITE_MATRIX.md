# T575 — Endurecimiento OIDC y matriz hospedada con escrituras (estado)

## 1. Auditoría de concurrencia OIDC (`api/_firebaseAdmin.js`)
| Riesgo hallado | Impacto | Corrección |
|---|---|---|
| `x-vercel-oidc-token` es una cabecera alcanzable por el cliente y se escribía **sin verificar** en un archivo compartido | un cliente podía **envenenar** el token del que depende todo refresco de credenciales de la instancia (DoS) | verificación RS256 contra el JWKS publicado por Vercel + claims fijados (`iss`, `aud`, `project_id` del proyecto staging, `exp`/`nbf`) antes de aceptar |
| `setRequestOidcToken(undefined)` ponía `_oidcToken = null` | una petición sin cabecera borraba el token de otra petición concurrente en la misma instancia (401/503 espurios) | cabecera ausente/ inválida/ expirada **nunca** borra ni degrada un token válido; gana el que expira más tarde |
| `fs.writeFileSync` sobre la ruta compartida | lectura parcial/vacía durante un refresco | escritura en archivo temporal único + `rename` atómico, sólo si el token cambió |
| token expirado retenido | credenciales caducadas reutilizadas | error determinista `FIREBASE_WIF_OIDC_EXPIRED` (cierra en falso) |
| instancia Admin en caché / `GOOGLE_APPLICATION_CREDENTIALS` global | el token es de **despliegue** (no de usuario): no hay mezcla de identidades de usuario; la identidad de usuario sigue siendo el ID token de Firebase, verificado aparte | sin cambio necesario; documentado |
| registros | los JWT/archivos no deben aparecer en logs | prueba que captura `console.*` y mensajes de error |
Pruebas (`api/_firebaseAdmin.test.js`, 17/17): token válido; falsificado/ajeno/claims erróneos/expirado/malformado rechazados; no hay degradación; fail-closed sin token; **400 peticiones intercaladas** sin archivo parcial, falsificado ni vacío; sin fugas en logs.
Verificado hospedado tras el cambio: `t574` 7/7 incluida la lectura Firestore federada (`READ_OK`) — la verificación JWKS funciona en el runtime real.

## 2. Matriz con escrituras — `scripts/t575-hosted-matrix.cjs`
Veredictos calculados con **instantáneas de Firestore** (identidad IAM del operador) antes/después, independientes de lo que responde el servidor; refusa cualquier proyecto que no sea staging; verifica limpieza y que ninguna llamada tocó producción.
- Fase `off` (interruptores apagados; estado actual de staging): preparación (allowlist con el UID sintético exacto, canario con PID explícitos, comprobación de que no hay clientes reales) + negativos de cero escrituras + procedimiento de desactivación.
- Fase `on` (requiere los interruptores): H10–H13, H15–H24, H08/H09, H26/H28 y limpieza.

| Fase | Entorno | Resultado | Evidencia |
|---|---|---|---|
| off | **HOSTED** (despliegue production del proyecto staging, commit `f4ec326`) | 10 PASS, 0 FAIL, 1 NOT_TESTED (rechazo Preview: muro de Vercel Authentication sin cookie válida; el rechazo ya se demostró en T574) | `docs/t575-matrix-hosted-off.json` |
| off | LOCAL_SHIM | 10 PASS, 1 NOT_TESTED | `docs/t575-matrix-local-shim-off.json` |
| on | **LOCAL_SHIM** (mismo handler/ejecutor, datos de staging, NO la función hospedada) | 20 PASS, 0 FAIL, 1 NOT_TESTED | `docs/t575-matrix-local-shim-on.json` |
| on | **HOSTED** | **NOT_TESTED — BLOQUEADO** (ver §3) | — |
El shim sólo valida que el script y las aserciones son correctas; **no cuenta como evidencia hospedada**.

## 3. Bloqueo y acción exacta para el propietario
La credencial del operador recibe 403 al escribir variables del proyecto Vercel `vdsen-ecosistema-staging-t573`. Para ejecutar la fase `on` hospedada:
1. Vercel → proyecto `vdsen-ecosistema-staging-t573` → Settings → Environment Variables, **sólo entorno Production**: `AUTONOMOUS_PROGRESSION_ENABLED=true`, `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=true`, y `CRON_SECRET` como *Sensitive* (≥32 bytes aleatorios; guardar el valor en un archivo local fuera del repositorio, p. ej. `%TEMP%\cron-secret.txt`).
2. Redeploy production del mismo commit; obtener acceso (enlace compartible/cookie) a la URL.
3. `node scripts/t575-hosted-matrix.cjs --phase on --base <host> --cookie-file <f> --cron-secret-file <f>` (crea y borra sus propios datos sintéticos; la allowlist sólo contiene UID sintéticos).
4. Desactivación inmediata: poner ambos interruptores en `false` (o borrarlos), borrar `CRON_SECRET`, redeploy; verificar con `--phase off` (debe dar DISARMED/cero escrituras) y `node scripts/t575-hosted-matrix.cjs --teardown`.
Permiso exacto que falta: escritura de variables de entorno del proyecto (rol con *Environment Variables: write* en ese proyecto).
