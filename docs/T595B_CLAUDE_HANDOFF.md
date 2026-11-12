# T595-B — Traspaso de Claude a Codex

Fecha: 2026-10-23. Sin UIDs privados, tokens ni secretos. Producción no se tocó.

## 1. Identidad

| Campo | Valor |
|---|---|
| HEAD canónico inicial | `ed98a2cf36d43f3b0a1864bb9727d0bc573e94e5` (`codex/client-app-next`, incluye PR #125 y #126) |
| HEAD canónico final | el merge commit de este PR (ver el PR; el HEAD se anota abajo al fusionar) |
| Rama de trabajo | `chore/t595b-harness-and-latency` |
| Worktree | `…/Documents/Codex/2026-09-21/vdsen-t595b` (nuevo, desde `origin/codex/client-app-next`) |
| Worktree de medición «antes» | `%TEMP%/t595b-before` (detached en `4e7b8a5`, `node_modules` por junction; descartable) |
| Producción (Vercel, solo lectura) | `dpl_GfBVe46gHe3GSwkGx8yufoJLMLeB`, SHA `c161fdb`, 2026-10-22. **No** incluye #123, #125, #126 ni este PR |

## 2. Qué se recuperó de Codex

**Nada de Codex sobrevivió en disco.** El worktree temporal de T595-B ya no existe (no figura en `git worktree list`), no hay `.qa-runtime`, y `release-output/` del checkout `vdsen-client-next` solo contiene la línea base unitaria (`unit-baseline-*`). Solo quedaron los logs de emuladores en `%TEMP%` (`vdsen-t595-emulators*.log`). Lo reportado por Codex (15/15 del Cliente autenticado) **se reprodujo desde cero** (§4); no se afirma recuperar ningún cambio. El diff local no confirmado que había en la rama `fix/client-save-set-latency` era CSS visual ajeno: está respaldado en la rama local `wip/visual-refinement-css-backup` (no se subió).

## 3. Cambios nuevos (este PR)

Producto (`vdsen-cliente.html`), ambos hallados por la medición en navegador real:

1. **`completeSet` dejaba el botón bloqueado/mal rotulado.** Desde T568 el botón se deshabilita y pasa a «GUARDANDO…» *antes* de validar. (a) Con carga vacía (o RIR/ICS fuera de rango) el botón quedaba **deshabilitado en «GUARDANDO…»** hasta un re-render. (b) Cuando la escritura fallaba, el restablecimiento referenciaba `_techLower`, variable local del render que no existe ahí → `ReferenceError` tras el rollback (botón habilitado pero con el texto «GUARDANDO…»). Corrección: se captura la etiqueta original y un único `_restoreSaveBtn()` se llama en todas las salidas sin re-render. Sin cambios en datos ni en la lógica de guardado.
2. **`.sp-target` (objetivo efectivo, PR #125) recortaba el RIR en ≤430 px.** Era un `flex` sin `wrap` dentro de un scroller con `overflow-x:hidden`: la auditoría marcó 140/100/70/30 px de contenido recortado a 320/360/390/430. Corrección: `flex-wrap:wrap; gap:4px 12px`. Sin cambio de texto ni de datos; los valores prescritos y ejecutados siguen separados.

Harness / pruebas:

- `scripts/client-auth-e2e.cjs`: `--out` ahora crea el directorio destino (reproducido: ENOENT al escribir en `release-output/` inexistente tras pasar los 15 controles).
- `scripts/e2e-client-chain/t594-mobile-runtime-e2e.cjs`: (a) el selector de «objetivo antes de los campos» estaba obsoleto tras #125 (buscaba `.sp-fields` en el padre del objetivo) → ahora usa el `.workout-set` contenedor; (b) la auditoría de desbordamiento horizontal solo corría al último tamaño → ahora recorre **cada pestaña a cada ancho** (320/360/390/430/horizontal). Se verificó que sin el fix CSS el control falla y con él pasa.
- `scripts/e2e-client-chain/serve.cjs`: con `E2E_COUNT_FS=1` registra la línea de tiempo de cada `setDoc` y admite inyección opt-in (`window.__fsInject`). Inerte si no se activa.
- Nuevo `scripts/e2e-client-chain/save-latency-e2e.cjs` (§5) y README.
- Pruebas: `tests/t595b-complete-set-button-restore.test.js` (3), una nueva en `client-auth-e2e-runner.test.js`; se actualizaron los pines de texto de `t568`, `t158h`, `t305` al nuevo contrato (`_restoreSaveBtn()`).

## 4. Estado de emuladores y E2E

| Prueba | Resultado |
|---|---|
| Auth + Firestore Emulator, Cliente autenticado (`client-auth-e2e.cjs`, instalación limpia en temporal) | 15/15 PASS, repetido (incluida corrida con `--out` a un directorio inexistente) |
| Firestore Emulator `t476` (reglas reales) | 7/7 PASS (corrido con el PR #126) |
| Runtime móvil T594 (Chrome headless, emulación móvil, atleta sintético) | 12/12 PASS (dos corridas consecutivas); 320/360/390/430 y horizontal; control negativo `sticky` conservado |
| Suite unitaria completa | ver §8 |

Problema de entorno conocido: un servidor/Chrome huérfano en los puertos 5199/9334 hace fallar T594 con «no current set card»; cerrar procesos y repetir.
El fallo `deep-extend` de Codex **no se reprodujo** (instalación limpia en temporal sin error). `T571-1e` falla también en `4e7b8a5` por una ruta de `tar` en Git Bash/Windows (preexistente, ajeno).

## 5. Latencia de «Guardar serie» en navegador (Chrome real + emuladores)

Método: toque real sobre el botón real; línea de tiempo en el navegador (botón ocupado, inicio/resolución de escritura mesociclo y raíz, badge de confirmación/pendiente/error). El emulador tiene ~0 ms propios; el retraso de red se **inyecta** tras el ack real (`delay`) y los fallos se inyectan sin enviar nada. Un Chrome nuevo por arranque, 5 repeticiones (×2 arranques para los escenarios repetidos). **No es latencia de producción ni de teléfono.**
«Antes» = `4e7b8a5` (pre-#126, escrituras en serie); «Después» = este PR (paralelas + fix de botón). Tiempo hasta «✓ GUARDADO», mediana (p95, desviación):

| Escenario | Antes | Después |
|---|---|---|
| Red normal (n=10) | 92 ms (148, sd 19) | 72 ms (89, sd 12) |
| Ack 600 ms en ambas (n=10) | 1293 ms (1307, sd 9) | 663 ms (674, sd 5) |
| Mesos lento 1500 / raíz 100 (n=5) | 1693 ms (1701) | 1545 ms (1576) |
| Raíz lenta 1500 / mesos 100 (n=10) | 1693 ms (1726) | 1572 ms (1615) |
| Doble toque, ack 400 (n=5) | 885 ms (890) | 466 ms (548) |
| Mesos falla (no fatal por diseño, n=5) | 273 ms | 235 ms |
| Latencia CDP 300 ms (n=5) | 375 ms | 374 ms |

Respuesta visual (botón «GUARDANDO…»): 1–4 ms en todos los escenarios en línea; el doble toque genera exactamente 1 escritura mesos + 1 raíz y 1 clave persistida.
Integridad (todas PASS en «Después»): fallo de la escritura raíz → nunca «✓ GUARDADO», error visible a ~215 ms, botón usable con su etiqueta original, clave **no** persistida; offline → nunca «✓ GUARDADO», estado pendiente en ~7 ms, tras reconectar queda persistida **una vez** en ambos documentos; carga vacía → 0 escrituras y botón restaurado. «Antes» falla 3 de esos 10 controles (los dos defectos de botón y el `ReferenceError`).
Hallazgo metodológico: con un Chrome compartido entre arranques, la primera escritura del siguiente arranque se retrasaba 2–5 s (artefacto del harness, no del Cliente); por eso hay un Chrome por arranque.
Observación para decidir (no se cambió): si una escritura no se confirma en 5 s (`_WRITE_GRACE_MS`) el Cliente la trata como «pendiente» y deja continuar; con un ack realmente lento el atleta espera hasta 5 s antes de poder seguir.

Evidencia: `docs/t595b-evidence/` — `t595b-save-latency-before.json`, `t595b-save-latency-after.json`, `t595b-mobile-runtime-result.json`, `t595b-client-auth-15of15.json`.

## 6. Progresión VDSEN (Issue #124)

Sin cambios en el Motor, `NUMERIC_APPLY_ENABLED=false`, objetivos del PR #125 intactos (el único cambio ahí es de maquetación del contenedor). No se repitieron las pruebas ya aprobadas. **#124 no se cierra**: solo hay evidencia sintética.

## 7. Diagnóstico de Ayrton — BLOQUEADO

No hay UID autorizado explícitamente; no se enumeraron usuarios, no se leyó ninguna bitácora real. Procedimiento GET-only para cuando exista autorización (Ayrton entrega el UID o autoriza el medio):

1. Obtener el UID por un canal explícito (dato del propietario), nunca deducirlo.
2. Con credencial de solo lectura del propietario, GET únicamente de `clients/{uid}`, `logs/{uid}` y `logs/{uid}/mesos/{planId activo}` (REST `documents.get`, sin `list`, sin `runQuery`, sin escritura).
3. Registrar solo: `planId`, claves `log_*`/`done_*` de la semana en curso, `updatedAt`, presencia de `progressionApplications`/`nextExposureOverlays`; no copiar valores personales.
4. Resultado a un archivo local fuera del repo; el informe no incluye el UID.

## 8. Pruebas y CI

Ver el PR (CI `check`) — resultado final anotado en la descripción del PR. Suite unitaria local en el worktree limpio: 1 solo fallo (`T571-1e`, preexistente/ambiental).

## 9. Preparación del release (NO ejecutado)

- Producción: `c161fdb`. Canónico: `ed98a2c` + este PR. Archivos de runtime distintos: `vdsen-cliente.html`, `.release/vdsen-client.json`, `.release/deployed-product.json`, `.gitattributes`, `docs/T594_PILOT_PLAN.md` (+ scripts/tests).
- Cambios de producto a liberar: #125 (objetivos efectivos), #126 (escrituras en paralelo), este PR (botón + `.sp-target`). Sin cambios de Reglas, índices, API ni variables.
- `VDSEN_CLIENT_BUILD` sigue siendo `issue-115-cache-cutover-20261022-01` (no cambió desde `c161fdb`), así que el service worker versionado (`sw.js?build=…`) **no** cambia con este release; el HTML es network-first. Decidir si se quiere bump de build para forzar el ciclo del SW.
- Pendiente antes de liberar: SHA aprobado por Ayrton; gates oficiales (`scripts/release/check.cjs`, `baseline.cjs unit`, `app-candidate-check.cjs`); rollback = deployment de producción actual (`dpl_GfBVe46…`, candidato de rollback); rebaseline posterior (`chore/rebaseline-<sha>` como en #121); `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` no definida/`false`.

## 10. Issues

- **#115 (Brave Android): ABIERTO.** Solo hubo Chrome headless con emulación móvil; ninguna validación en el teléfono. Procedimiento mínimo físico: abrir `/cliente` en Brave Android del propietario, ir a Entrenamiento, comprobar (1) objetivo visible antes de los campos con RIR completo, (2) «GUARDAR SERIE» fluye con su tarjeta sin tapar campos ni la barra inferior al desplazar, (3) sin desplazamiento horizontal, (4) guardar con carga vacía devuelve el botón, (5) modo avión → guardar → reconectar. Registrar `getVdsenRuntimeDiagnostics()` (build y SW).
- **#124:** abierto (ver §6).
- **T594:** sin GO; requisitos no cumplidos (producción y Ayrton).

## 11. Próxima acción exacta para Codex

1. `git fetch` y partir de `codex/client-app-next` (con este PR fusionado).
2. Decidir sobre `_WRITE_GRACE_MS` (5 s) con datos de teléfono, si se considera defecto.
3. Obtener autorización/UID de Ayrton y ejecutar §7; pedir la validación física §10.
4. Con SHA aprobado: gates oficiales + release + rebaseline (§9). No activar Numeric Apply.
