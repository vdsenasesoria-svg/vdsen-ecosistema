# T598 — Traspaso de Claude a Codex

Fecha: 2026-10-24 (hora del servidor de Vercel). Sin datos reales, UIDs ni credenciales. Producción, `main`, Rules, IAM, índices, Motor, `CLIENT_APP_RELEASE_ENABLED` y Numeric Apply: sin tocar.

## 1. Identidad

| Campo | Valor |
|---|---|
| HEAD canónico inicial | `8ad797b690ed12bdd1c061a5affcbc7ea51f6c9e` (verificado; PR #130 fusionado, sin avance previo) |
| HEAD canónico final | merge commit del PR #131 (ver el PR) |
| Rama / worktree | `chore/t598-build-id-and-sync-e2e` · `…/Documents/Codex/2026-10-24/vdsen-t598` (nuevo). El worktree de Codex `t597-logbook-load` no se tocó |
| Producción (Vercel, solo lectura) | `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw`, SHA `b5f53af5843f466528a4b95e5a3e52d6c8c77fb1`, build `issue-115-brave-rc-20261024-01` |
| Build del candidato | **`t598-logbook-reference-20261024-01`** (distinto del publicado) |

## 2. Cambios

1. **Identidad de build**: `<meta name="vdsen-client-build">` y `window.VDSEN_CLIENT_BUILD` (único lugar donde vive; el service worker toma la identidad del query `sw.js?build=…` y su caché es `vdsen-<build>`, así que URL del worker, caché, diagnóstico de runtime y HTML cambian juntos). `.release/vdsen-client.json` no se tocó (solo lo actualiza el rebaseline posterior a un release verificado).
2. **Defecto hallado en T597 por el E2E de navegador real** — `editSet()` (reabrir un registro) lo invalida (`done=false`) pero la referencia de bitácora seguía mostrando el valor invalidado hasta el siguiente guardado o recarga (UI y `exerciseHistory` guardado). Corrección mínima: `_rebuildExerciseHistoryFromLogs('', pid)` entre la invalidación y `saveLogs()`. Evidencia del fallo previo: `docs/t598-evidence/sync-run1-before-editSet-fix-FAILS-S6a.json`. Prueba unitaria añadida en `tests/t597-logbook-load-reference.test.js`.
3. **E2E nuevo `scripts/e2e-client-chain/t598-logbook-sync-e2e.cjs`** (Chrome real + Auth/Firestore Emulator, atletas sintéticos, proyecto `demo-*`).
4. `scripts/e2e-client-chain/sw-cutover-e2e.cjs`: nuevo control — localStorage (respaldo de bitácora offline) e IndexedDB (Auth/Firestore) sobreviven al cambio de worker/caché.

## 3. Resultados

| Prueba | Resultado |
|---|---|
| Escenarios T597 1–8 en navegador | PASS: SIN HISTORIAL sin carga inventada; 10×10 persistido una vez en doc del plan y raíz; serie siguiente «REFERENCIA DE BITÁCORA 10 KG» con input de carga separado, editable y vacío; nueva sesión recupera 10 KG; exposición previa (15 KG) es la referencia de la nueva; récord 15 / última 10 → referencia 10; invalidar → 15 (UI y almacenado), corregir a 12 → 12 con récord 15; solo 2 claves `__pid__`, sin herencia por nombre; KG→LB→KG: 22.5 LB (10 KG = 22.05; redondeo de placas de la app, ±1.25) → 10 KG, sin referencias duplicadas |
| **Dos navegadores independientes** (2 perfiles Chrome, mismo atleta) | **27/27 PASS, dos corridas** (`sync-two-browsers-27of27.json`): B recupera la referencia de A (listener en vivo y resincronización al volver a primer plano), A modifica y B la reemplaza (10→12), guardado simultáneo de la MISMA serie → un solo ganador coherente en ambos documentos, series distintas simultáneas → ninguna borra a la otra (persistencia por entrada), orden por `ts`, B offline: la entrada **no** se anuncia «✓ GUARDADO», **no** está en remoto y A no la ve; al reconectar llega **una sola vez** a ambos documentos y A recupera la referencia; otro atleta sintético intacto; sin errores de página |
| Cutover desde `b5f53af` | 5/5 (worker y caché nuevos, caché vieja eliminada, datos del atleta intactos, controlado por el nuevo worker) |
| Runtime móvil T594 | 14/14 ×2 (320/360/390/430 + horizontal, ESTRUCTURA COACH y referencia antes de campos, sin desborde horizontal, CTA sin solape, control negativo `sticky` conservado) |
| Guardado / offline (`save-latency-e2e`) | 10/10 |
| Auth E2E | 15/15 |
| `check.cjs` (con `GITHUB_EVENT_NAME=pull_request`; sin eso exige estar en la rama canónica) | PASS |
| `baseline.cjs unit` (PowerShell) | gate PASS, 1733 PASS, 0 regresiones |
| `baseline.cjs emulator` (PowerShell) | gate PASS, 197/197, 0 regresiones |
| CI oficial del PR #131 | `check` PASS |

`t586 AUTH-08` (flake de T597) **no reapareció** en esta ronda (1 corrida completa); eso no demuestra que esté resuelto: causa sin investigar, reaparición posible.

## 4. Autoridad del Motor (auditoría por diff)

T597 (`83aee8a..8ad797b`) tocó únicamente `vdsen-cliente.html`, docs, tests y un script E2E; ningún archivo de `api/`, Rules, `.release/` ni de los módulos del Motor. Dentro del HTML solo cambió presentación/historial/calentamiento (`toggleExUnit`, `loadPlan`, refresco de logs, `_effectiveSetTargetHtml`, `_buildExCard`, `_warmupReferenceLoad`, helpers `_history*`, `_logbookReferenceHtml`); no se tocó `calculateProgression`, deload, dolor/fatiga, política de magnitud, overlays ni incrementos. Con Numeric Apply OFF: la referencia de bitácora es visible; una carga numérica solo aparece como «OBJETIVO AUTOAJUSTE VDSEN» si es el valor efectivo de un overlay canónico APPLIED (probado en sandbox por la suite de emulador: t583/t584/t586, PENDING no aplicado, SAFETY_CONFLICT). No se creó ningún segundo Motor ni se activó la progresión numérica.

## 5. Preview verificable

- Deployment del SHA exacto del candidato (`8c675d74b1b94a18447ae28fc63b74c2befe4136`): `dpl_5Dj43rktkzVZGBinc6Mktpg1qg7W`, **READY**, target Preview.
- URL exacta: `https://vdsen-ecosistema-fzblb73od-vdsenasesoria-svgs-projects.vercel.app/cliente` (alias de rama: `vdsen-ecosistema-git-chore-t-7eb3b1-vdsenasesoria-svgs-projects.vercel.app`). Protegido por Vercel Authentication: se conservó; se verificó con la herramienta autorizada de la cuenta (enlace temporal de 23 h) y el propietario puede abrirlo con su sesión de Vercel.
- Verificado sobre el contenido servido: `meta vdsen-client-build` y `VDSEN_CLIENT_BUILD` = `t598-logbook-reference-20261024-01`; ninguna aparición del id publicado; contiene la corrección de `editSet`; `sw.js` servido (HTTP 200, `cache-control: max-age=0, must-revalidate`), cuya caché se deriva del query de build.
- El commit posterior de este documento es solo docs (mismo código); el release debe nombrarse por el merge commit de la canónica (§8).

## 6. Estados

Producción: sin cambios (`b5f53af`). Numeric Apply: `false`. **#115 abierto** (Brave Android físico PENDIENTE: solo Chrome emulado). **#124 abierto** (solo evidencia sintética).

### Checklist de aceptación física en Brave Android (PENDIENTE — no hay dispositivo autorizado)

1. Abrir la URL del Preview (con la sesión de Vercel del propietario). 2. Ejecutar `getVdsenRuntimeDiagnostics()` y confirmar build `t598-logbook-reference-20261024-01` y worker `sw.js?build=t598-…`. 3. Entrenamiento: ver «REFERENCIA DE BITÁCORA» (o «SIN HISTORIAL») antes de los campos. 4. Guardar una primera serie sintética. 5. Comprobar que la segunda serie muestra esa carga como referencia. 6. Abrir el teclado. 7. Desplazar la tarjeta. 8. Comprobar que «GUARDAR SERIE» no tapa campos ni la barra inferior. 9. Modo avión → guardar → reconectar (debe decir pendiente, no «✓ GUARDADO», y sincronizar). 10. Recargar y confirmar que la referencia persistió.

## 7. Limitaciones

- La sincronización validada es navegador↔navegador por el emulador, no dos teléfonos físicos.
- La referencia usa la última ejecución por `ts` de cualquier semana del plan (decisión de producto abierta, ver T597).
- `_WRITE_GRACE_MS` (5 s) sigue como en T595-B.
- Los baselines deben correr desde PowerShell (Git Bash falla `T571-1e`).
- `check.cjs` fuera de CI exige estar en `codex/client-app-next` o simular `pull_request`.

## 8. SHA recomendado para un futuro release controlado

El merge commit del PR #131 en `codex/client-app-next` (contiene T597 + T598; app-only). Antes: validar la checklist física, autorización de Ayrton, gates oficiales en CI de release, release, y rebaseline (`chore/rebaseline-<sha>`). Rollback: `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw` (b5f53af).
