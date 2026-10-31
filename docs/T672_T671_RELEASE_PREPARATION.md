# T672 — preparación del release T671

Estado: preparado, bloqueado, sin despliegue ni promoción autorizados.

## Identidades y manifiestos

- Runtime candidato exacto: `a8cf462c78c4bd795cc9f485a82f64429c179f00`.
- Baseline productivo observado: `dpl_9w1SAJULqvH2HoDftuXNJmjPbv5K`, runtime `21dc0e2b211facfb0df9f3079c58488c2f86952c`.
- El paquete `.release/t671-app-candidate.json` fija el árbol Git completo y hashes SHA-256 de 47 superficies registradas y cuatro fuentes del servidor. Las únicas superficies de producto modificadas son `vdsen-cliente.html` y `api/autonomous-progression-trigger.js`.
- `.release/deployed-product.json` y `.release/vdsen-client.json` siguen describiendo la producción anterior. No adelantarlos al candidato ni inventar deployment, fecha o run id.
- CI post-merge `40996532624`: 1847 unitarias y 220 emulador PASS, baseline coincidente, cero regresiones, sobre el SHA candidato.
- Preview exacto observado: `dpl_FYaeL8yudZUqkCqmRfzxZx96dFtC`, READY, único resultado para el SHA candidato. Rollback actual READY: 25/25 superficies HTTP con SHA-256 coincidente con el runtime anterior; `vercel.json` se comprueba en Git, no por HTTP. La restauración no se ha ejecutado.
- Preparación local: 64 pruebas específicas PASS y equivalencia de producto PASS (26 rutas). `check.cjs` local se detiene por exigir la rama canónica; no se suplanta esa precondición. El CI del PR debe comprobar el contrato en su contexto admitido.

## Bloqueos y gates antes de autorizar una ejecución

1. `CLIENT_APP_RELEASE_ENABLED=false` y `PRODUCTION_RELEASE_ENABLED=false` en el Environment `Production`. Mantenerlos así durante esta preparación. Una autorización futura debe cubrir expresamente el armado temporal del interruptor app-only y su restitución a `false`; el interruptor de Rules permanece en `false`.
2. Los dos flags `AUTONOMOUS_PROGRESSION_*` están guardados como `sensitive` en Production. El guard devuelve `VALUE_NOT_READABLE`. Un canario caducado no demuestra que esos flags estén apagados. No cambiar el guard: antes de cualquier release, bajo otra autorización, ambos deben estar ausentes o ser `plain` con valor exacto `false`.
3. Revalidar acceso, proyecto/equipo, alias productivo, baseline, main exacto `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c`, candidato Preview READY por SHA y ausencia de candidatos ambiguos. El Preview se usa como identidad del candidato; nunca se promueve.
4. Ejecutar la prueba del paquete y `verify-product-identity` con el SHA candidato. Verificar las superficies HTTP del rollback contra los blobs del runtime anterior; las fuentes/configuración restantes se verifican en Git y en el paquete exportado. La vía existente utiliza el manifiesto desplegado para su smoke; el paquete de preparación amplía la evidencia revisada, sin alterar esa vía.
5. Revalidar Rules FE151/compatibilidad mediante lectura, sin publicación. El hash de Rules empaquetadas no cambia entre baseline y candidato. No ejecutar la vía rules-only.
6. El runtime candidato conserva la definición CRON existente. No añadir `CRON_SECRET` ni habilitar barridos; no afirmar que la programación está deshabilitada. Rechazar cualquier ejecución que altere el alcance autorizado de CRON.

## Procedimiento futuro de una sola ejecución

Esto es un procedimiento condicionado, no una autorización ni una ejecución T672. El workflow acopla creación de un deployment staged de Production y su promoción; no ofrece un modo stage-only. La aprobación futura debe cubrir ambas operaciones y la recuperación automática.

1. Revisar y fusionar este PR solo con aprobación. Confirmar CI sobre su SHA final y equivalencia de producto con el candidato exacto. Una diferencia de código exige detenerse y revisar otro SHA.
2. Designar un ejecutor. Consultar los runs de `vdsen-app-release-prod.yml`; no continuar si hay uno activo/pendiente o un estado incierto. Anotar el instante y los runs existentes. Resolver los bloqueos anteriores con autorizaciones separadas; obtener el preflight de solo lectura del mismo código, sin usarlo para publicar.
3. Capturar antes de mutar el deployment actual, SHA, hashes verificados, Rules compatibles, main y el artefacto de rollback. La vía captura `app-rollback-<run_id>.json`; el destino de recuperación es el baseline actual capturado, no el rollback genérico antiguo de `.release/vdsen-client.json`.
4. Solo después de la autorización completa, despachar exactamente una vez:

   ```powershell
   gh workflow run vdsen-app-release-prod.yml --repo vdsenasesoria-svg/vdsen-ecosistema --ref codex/client-app-next -f runtime_sha=a8cf462c78c4bd795cc9f485a82f64429c179f00 -f reason="Approved T672 T671 observability app-only release"
   ```

5. Identificar y guardar el único run nuevo con ese ref/input e instante. Si no se puede determinar si se creó, investigar su estado; nunca repetir el dispatch a ciegas. No reejecutar jobs ni desplegar por CLI local.
6. El workflow debe pasar repo contract, pruebas app-only, unitarios/emulador con baseline exacto, equivalencia de producto, preflight y Numeric Guard fresco. Luego crea un único staged desde `git archive` del SHA aprobado, verifica sus bytes y flags, y promueve ese mismo ID. No crear otro deployment para subsanar un resultado incierto.
7. Descargar y revisar preflight, rollback, staged y resultado. Exigir `app_release_status=SUCCESS`, alias convergente al ID staged, runtime exacto, bytes públicos coincidentes y Numeric Guard OFF. No invocar manualmente el trigger de progresión para probarlo.
8. Si hubo mutación y falla la verificación, usar únicamente la recuperación del mismo run/artefacto; verificar deployment, SHA y bytes restaurados. Si no hubo mutación, no efectuar un rollback innecesario. Una recuperación fallida bloquea nuevas acciones: no despachar otro release.
9. Restituir `CLIENT_APP_RELEASE_ENABLED=false` bajo la autorización futura correspondiente y verificarlo. Guardar evidencias redacted. Solo entonces preparar el rebaseline documental con el deployment/run/fecha reales; no hacerlo anticipadamente.

## Actualización posterior de manifiestos

Después del release realmente verificado, el generador canónico actualiza `.release/deployed-product.json` para el runtime desplegado. En `.release/vdsen-client.json` se actualizan `runtime_sha`, `production_deployment`, `target_deployment`, el baseline de app rollback capturado y el bloque `app_release` (SHA, deployment, anterior, run oficial, fecha y superficies realmente verificadas). Los campos `published_rules`, Rules e índices quedan sin cambios. Mantener `numeric_apply_enabled=false`. Estas actualizaciones requieren evidencia real y PR revisado.

## Nueva ventana de Ayrton — procedimiento separado y bloqueado

El permiso anterior venció en `2026-10-29T21:20:03Z`. Las barreras siguen limitadas al mismo atleta; no renovarlas durante T672.

1. Obtener otra aprobación expresa con UID único de Ayrton, Coach/plan confirmados, TTL supervisado, runtime exacto y mecanismo de revocación. No ampliar allowlist ni cambiar prescripción, cardio o bitácora.
2. Hay un bloqueo distinto del TTL: el release app-only exige flags global/numeric OFF. Cambiar variables guardadas después no demuestra activación del runtime servido; una nueva build con flags ON chocaría con el guard actual. El repositorio no ofrece aquí un mecanismo autorizado compatible para ese armado. Se requiere una propuesta separada, revisada y autorizada; no eliminar el guard ni recurrir al despliegue manual de T663.
3. Solo tras resolver y verificar ese mecanismo, preparar la simulación del instrumento canónico `scripts/pilot/ayrton-canary.cjs` para el UID/TTL aprobados. El `--confirm` es una mutación productiva y necesita autorización separada; ninguna orden enable/confirm se ejecuta en T672. El instrumento aplica ambas barreras atómicamente, con precondiciones y expiración del servidor.
4. Verificar ambas barreras, UID/PID, caducidad, aislamiento y revocación. Mantener CRON sin autorización de barrido. No reprocesar Classic/Brazo 2 ni sesiones anteriores.
5. Observar únicamente un evento auténtico posterior: guardado confirmado, diagnóstico `getVdsenProgressionDiagnostics()`, request ID, log correlacionado, flags efectivos, decisión, APPLIED, overlay y sincronización. CONSUMED exige ejecución real de la exposición objetivo. No crear entrenamientos para completar el circuito.
6. Al vencer, detener la ventana sin renovarla automáticamente. Ante incidente, solicitar/usar el mecanismo oficial de revocación dentro de la autorización vigente; conservar evidencia y revisar rollback compatible.
