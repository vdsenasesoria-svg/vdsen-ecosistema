# T673 — release OFF y ventana de Ayrton por autorizaciones separadas

Preparación para revisión. Ninguna orden productiva de este documento se ha ejecutado en T673. No fusionar ni despachar workflows a partir de este documento sin autorización. El estado productivo y los manifiestos desplegados de T672 siguen intactos.

## 1. Transición de los dos flags a OFF verificable

La lectura acotada `decrypt=false` del 30/10/2026 04:09 UTC confirmó dos variables `sensitive`, exclusivamente Production: `AUTONOMOUS_PROGRESSION_ENABLED` y `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED`. El plan sin valores anteriores está en el artefacto local `release-output/t673-off-transition.json`; no convertirlo en una autorización. El Numeric Guard sigue rechazando valores ilegibles, secretos, ambiguos o activos. También rechaza `visibility:secret` aunque un formato legado indique `type:plain`.

Procedimiento futuro del propietario, con autorización limitada a estas dos claves, sin redeploy asociado:

1. Establecer un ejecutor y una ventana de mantenimiento. Confirmar alias/baseline y barreras caducadas o cerradas. Capturar por GET equipo/proyecto y lista completa de metadatos (`decrypt=false`). No usar `env pull`, endpoints de descifrado ni recuperar los valores antiguos.
2. Ejecutar el planificador puro `offTransition()` de `scripts/pilot/window-protocol.cjs` con la respuesta real. Antes de cada modificación, releer el `id`, ámbito, tipo y `updatedAt` observado. Una diferencia requiere detenerse. Las variables compartidas, integraciones, ámbitos mixtos o duplicados requieren otra revisión: el planificador los rechaza.
3. Escribir un valor nuevo conocido, `false`, con tipo `plain`/Config, solo Production. La API documenta `PATCH /v9/projects/{project}/env/{id}` con `type`, `value` y `target`. No es necesario conocer el contenido anterior. Si la plataforma rechaza el cambio de tipo de Secret, detenerse: la eliminación y recreación mediante `POST /v10/projects/{project}/env` requiere autorización expresa adicional; no hacer un fallback destructivo automático.
4. Tras cada operación leer únicamente esa configuración y luego la lista completa. Exigir que ambas claves sean `plain`, Config cuando exista `visibility`, valor público exacto `false`, sin duplicados ni vínculos opacos. Ejecutar el guard canónico sin overrides. Un resultado incierto exige lectura y conciliación; nunca repetir una escritura a ciegas.
5. No restaurar el contenido desconocido de los antiguos Secret. La recuperación segura mantiene ambas claves OFF (o ausentes, si eso fue autorizado), las barreras cerradas/caducadas y el alias anterior. Esto no apaga retroactivamente el deployment antiguo: su seguridad sigue dependiendo de las barreras caducadas hasta el release OFF.

Fuentes primarias: [edición de variables](https://vercel.com/docs/rest-api/projects/edit-an-environment-variable), [Secret/Config](https://vercel.com/docs/environment-variables/sensitive-environment-variables), [deploy y overrides por deployment](https://vercel.com/docs/cli/deploy).

## 2. Una ejecución para publicar exactamente T671, OFF

Se conserva el procedimiento de `T672_T671_RELEASE_PREPARATION.md` y su paquete de 51 hashes: SHA `a8cf462c78c4bd795cc9f485a82f64429c179f00`. Las modificaciones de T673 no se incluyen silenciosamente en ese runtime.

Después de aprobar/fusionar el paquete de preparación y de otra autorización de release:

1. Resolver OFF verificable, revalidar gates/CI/equivalencia/baseline/rollback y ausencia de ejecución activa o incierta. Autorizar el armado temporal de `CLIENT_APP_RELEASE_ENABLED`; Rules sigue apagado.
2. Despachar una sola vez `vdsen-app-release-prod.yml` con `runtime_sha=a8cf462c78c4bd795cc9f485a82f64429c179f00`, en `codex/client-app-next`. No cambiar el Numeric Guard para admitir ON.
3. Verificar el mismo ID staged/promovido, resultado `SUCCESS`, alias, bytes, SHA y evidencia numérica DISARMED. Restituir el interruptor app-only. Registrar el deployment y run oficiales reales mediante el PR de rebaseline habitual.
4. La vía del piloto exige ese rebaseline canónico de T671, con `app_release.source_release_run` oficial distinto de cero. No admite el runtime T663 actual como sustituto.

Antes de una nueva apertura Firestore hay otro gate concreto: retirar el antiguo deployment armado T663 `dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K`. Su código no tiene restricción inmutable; dejar su URL operativa podría rearmarlo al renovar Firestore. Solo después del T671 OFF verificado, su rollback OFF probado y autorización expresa de retiro del ID exacto, el propietario puede efectuar ese retiro. T673 no elimina ni modifica deployments. La vía nueva exige lectura autenticada 404 del ID legado; 401/403, timeout o cambiar únicamente el alias no prueban retiro. No usar el legado armado como rollback de la ventana nueva. La restauración del OFF T671 sigue disponible aunque exista el legado: es una acción de recuperación que no abre barreras.

## 3. Autorización independiente de piloto

La nueva vía `.github/workflows/vdsen-ayrton-runtime.yml` es distinta de app-only. No modifica variables guardadas, Firestore, Rules o IAM. Está cerrada por defecto: necesita `AYRTON_RUNTIME_RELEASE_ENABLED=true`, Environment `Production`, repositorio/ref/workflow exactos y primer intento del run. App-only y piloto reutilizan el lock canónico `vdsen-production` de los flujos de release/rollback existentes, sin cancelar ejecuciones activas. No se modifica la vía de Rules.

Antes de armar o restaurar, descarga por GitHub autenticado los artefactos del run app-only oficial del baseline OFF. Deben coincidir repositorio, workflow, ref, run, deployment, SHA, resultado VERIFIED/SUCCESS y las pruebas Numeric Guard de antes/después del build. Los metadatos de un deployment y los valores actuales del proyecto no prueban por sí solos sus flags inmutables. La prueba histórica del build se distingue de la prueba fresca de configuración del proyecto: no se cambia el reloj de ningún guard. Un artefacto ausente, caducado o discordante bloquea ambas operaciones.

La autorización debe nombrar: único UID real de Ayrton (se verifica contra su hash fijo), Coach/plan, SHA piloto revisado, expiración UTC absoluta con TTL positivo de hasta 168 horas, operación única, deployment OFF de recuperación y permiso para verificar/revocar. El tiempo de build consume el TTL; nunca se vuelve a calcular al confirmar.

El SHA del piloto debe incluir la nueva consulta GET autenticada y la restricción `VDSEN_PILOT_WINDOW`. Será un SHA revisado posterior a T671; nunca inventar ese SHA ni desplegar HEAD implícitamente. No se alteran prescripciones, decisiones o datos históricos.

### Runtime del piloto: un deployment, todavía sin canario activo

1. Con otra autorización, deshabilitar las dos barreras mediante el instrumento canónico y verificarlo. El TTL antiguo vencido no sustituye esta condición: la vía exige `enabled:false` en ambas.
2. Verificar que el principal WIF existente puede leer los tres documentos requeridos (Cliente, Coach, release). Una denegación es un bloqueo; no cambiar IAM. Verificar el permiso de deploy/rollback del principal Vercel existente. Ningún permiso nuevo se presume concedido.
3. Preparar inputs de `vdsen-ayrton-runtime.yml`: `runtime_sha`, `pilot_uid`, `coach_id`, `plan_id`, `expires_at`, `operation_id`; `restore_run` vacío. La única mutación autorizada de ese run será crear un staged y promocionar ese ID, con recuperación al OFF capturado si falla.
4. Despachar exactamente una vez desde la rama canónica. El workflow ejecuta contrato y suites completas, verifica fuente exacta, alias OFF, ambas barreras deshabilitadas y configuración guardada DISARMED antes/después del build. Una barrera cambiada bloquea la promoción.
5. El staged recibe solo overrides de deployment para los dos flags `true` y una restricción inmutable: hashes del UID y plan, expiración y operación. No cambia valores del proyecto. CRON no se habilita: se rechaza `CRON_SECRET` y el runtime acotado rechaza el sweep incluso si aparece una credencial por error.
6. No se permiten reruns de jobs ni otro intento de armado sobre el mismo baseline sin revisión. Se comprueban el historial de runs y los deployments por operación/baseline. Un timeout de deploy queda incierto y no crea otro deployment automáticamente.
7. Revisar `ayrton-runtime-<run_id>/ayrton-runtime.json`. El éxito es `RUNTIME_READY_FENCES_CLOSED_NOT_ACTIVATED`, no una aplicación real. Su campo `window` contiene el ID nuevo, SHA y TTL definitivos para el paso siguiente. Restituir el interruptor del piloto según la autorización.

### Apertura de las dos barreras, después de verificar flags efectivos

El propietario ejecuta `scripts/pilot/ayrton-window.cjs` con el archivo `window` extraído del artefacto aprobado. Por defecto es simulación; `--confirm` es una escritura productiva que exige otra autorización expresa, o estar incluida expresamente en la autorización de ventana. Los agentes no ejecutan estas mutaciones locales durante T673.

La verificación usa la API Vercel autenticada y un Firebase ID token vigente del propietario en memoria (`VDSEN_PILOT_ID_TOKEN`), sin imprimirlo, guardarlo, pasarlo por argumentos ni introducirlo como input/secret nuevo de GitHub. Gcloud utiliza la identidad ya autorizada para las barreras; no generar claves ni suplantar usuarios.

```text
node scripts/pilot/ayrton-window.cjs --window <archivo_aprobado> --mode enable
node scripts/pilot/ayrton-window.cjs --window <archivo_aprobado> --mode enable --confirm
```

El wrapper obtiene por GET el deployment exacto de la API, verifica equipo/proyecto/READY/SHA/alias y consulta su URL directa con `?check=runtime`. El token debe pertenecer al UID de Ayrton: otro usuario autenticado recibe 403 sin flags ni metadatos de la ventana. No ejecuta un trigger: la consulta no lee Firestore ni llama al motor. Exige ambos flags efectivos ON, CRON ausente y hash/TTL/operación exactamente iguales al archivo. Repite la prueba antes del commit y después del readback.

Solo entonces usa el writer canónico: dos barreras en un único commit con precondiciones de versión, sin `--replace`. Registra versiones antes y después, estados, SHA y expiry en `<archivo_aprobado>.evidence.json`, sin credenciales. Una repetición de la misma ventana ya coincidente escribe cero documentos y nunca extiende el TTL. Conflictos, cambios de plan/Coach, scopes ajenos o caducidad bloquean la activación. Un commit con respuesta incierta provoca lectura de las dos barreras y queda incierto aunque parezca aplicado: no se reintenta ni se declara éxito. Un fallo de verificación posterior al commit no se presenta como éxito: revocar y conciliar, sin repetir enable.

El runtime añade una restricción; no reemplaza los dos flags ni las dos barreras transaccionales. Incluso si otra operación ampliase una allowlist, otro UID queda rechazado antes de leer su entrenamiento. Un deployment antiguo no vuelve a aplicar tras su expiración aunque Firestore abra otra ventana.

### Revocación, expiración y rollback

```text
node scripts/pilot/ayrton-window.cjs --window <mismo_archivo> --mode stop --confirm
```

La revocación no depende de que funcione la consulta de runtime, del ID token de Firebase ni del plan activo: deshabilita ambas barreras atómicamente y verifica su lectura. Rechaza scopes ajenos y cambios de Coach. Ante una identidad/documento desaparecido o un conflicto, no sobrescribir: usar el rollback OFF autorizado y mantener bloqueado; el límite inmutable del runtime también caduca.

Para volver al OFF capturado, autorizar una ejecución del mismo workflow con solo `restore_run=<run_oficial_piloto>` y su interruptor temporal. Descarga el artefacto de un run oficial completado del workflow/ref esperado. Solo restaura si el alias actual es el ID piloto capturado; si ya está en OFF, no promueve otra vez. Un alias ajeno requiere revisión. No crea deployments ni toca Rules o datos. Exige alias y bytes OFF verificados. Un rollback fallido queda `ROLLBACK_FAILED_UNVERIFIED` y prohíbe nuevas ejecuciones.

La caducidad es automática en las barreras del motor y en la restricción del runtime, sin CRON y sin renovación. No se programa una nueva build ni una renovación al vencer. La restauración del alias requiere la autorización de rollback indicada.

## Evidencia y límites de la preparación

Pruebas de preparación: transición sin lectura de Secret, guard fail-closed, protocolo de un solo deploy, concurrencia, fallos/rollback, GET sin acceso a datos, aislamiento de otro UID, expiry, idempotencia y revocación, todas aisladas. No hay sesiones ficticias ni escrituras productivas. La ejecución protegida/WIF, el build con overrides y la restauración se validan por simulación y contrato; su prueba real queda para la ejecución expresamente autorizada. No declarar REAL_APPLY_VERIFIED por estas pruebas: exige una sesión auténtica posterior, aplicación canónica, overlay y siguiente prescripción comprobados.

## Revisión pre-merge del HEAD 8552b05

La revisión reprodujo y corrigió: rollback pese a conservar el alias baseline; UID distinto aceptado por la restricción del runtime si se configuraba otro hash; diagnóstico accesible a otros usuarios autenticados; fechas UTC inexistentes normalizadas por Date.parse; ausencia de evidencia oficial OFF para el destino de rollback; y separación accidental del lock respecto a los flujos de release/rollback legados. El runtime y el instrumento comparten ahora una única constante del UID permitido. La recuperación automática solo actúa después de un intento propio de promoción y si el alias sigue en ese staged. El historial de la primera ejecución debe incluir exactamente el run actual: una lista vacía o incompleta no autoriza otro deploy. Las regresiones se comprueban en pruebas aisladas; no se infiere de ellas ninguna aplicación productiva.
