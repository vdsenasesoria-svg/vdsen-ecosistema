# T602 — Autoridad temporal de la progresión (handoff)

Rama: `fix/t602-temporal-authority` (base `25da9f3`, T601). Alcance: Client + consumidor + evaluador. Sin producción, sin `main`, sin Rules, sin IAM, sin datos reales, Numeric Apply sin activar, kill switch intacto, sin rebaseline.

## 1. Causa raíz

El orden «revisión del plan / decisión del Coach **vs.** primera serie de trabajo» se decidía con relojes que no son del servidor:

| Instante | Quién lo escribía | Reloj |
|---|---|---|
| Inicio de la exposición (`entries.log_*.ts`) | el atleta | **reloj del dispositivo** |
| Instante de referencia (`record.source.calculatedAt`) | el `progrec` del atleta | **reloj del dispositivo** |
| Revisión del plan (`plan.updatedAt`) | app del Coach | reloj del dispositivo del Coach |
| Decisión del Coach (`decidedAt`) | app del Coach | reloj del dispositivo del Coach |

Con el dispositivo del atleta atrasado más que el hueco entre la edición y la primera serie, un overlay **invalidado antes de empezar** se juzgaba «ya iniciado» y conservaba autoridad: la UI lo mostraba como `AUTOAJUSTE APLICADO` y el servidor lo pasaba a `CONSUMED`. Reproducido en navegador real contra el build previo (`25da9f3`, reloj −30 min): D-02 FALLA (`authorityState: APPLIED`, registro `CONSUMED / TARGET_STARTED`, 1 recibo).

## 2. Modelo temporal anterior y nuevo

Regla: **el orden lo decide un instante que asigna la base de datos, nunca el reloj del atleta.**

| Qué | Antes | Ahora |
|---|---|---|
| Inicio de la exposición | `ts` (dispositivo) | `entries.<log>.sts` = `serverTimestamp()` que el Client añade a **toda** serie de trabajo persistida (`done === true`). Se asigna al confirmar el commit: una escritura offline queda sellada **al sincronizar** |
| Instante de referencia | `source.calculatedAt` (dispositivo) | `record.createdAt` (lo escribe el ejecutor de servidor); `calculatedAt` solo como respaldo |
| Revisión del plan (rutas de servidor) | `plan.updatedAt` (texto del Coach) | `updateTime` del documento del plan (snapshot Admin), pasado como `serverPlanUpdatedAt` |
| Revisión del plan (UI, sin `updateTime`) | `plan.updatedAt` | igual (la UI solo *muestra*; la autoridad de consumo es del servidor) |
| `ts` | autoridad | **solo visualización** |

Implementación:
- `assets/progression-effective-prescription.js`: `exposureStart` usa `sts`; nuevo normalizador `_ms` (Timestamp SDK web, Admin, `{seconds,nanoseconds}`, `{_seconds,_nanoseconds}`, número); `evaluateOverlay` usa `createdAt` y `serverPlanUpdatedAt`; exporta `serverMillis`.
- `assets/progression-application-consumer.js` + `api/_autonomousProgression.js`: la transacción de consumo relee el plan, toma su `updateTime` y reevalúa en servidor.
- `vdsen-cliente.html`: `serverTimestamp` importado; `_buildMergeWrite` añade `sts`; `_mapDiff` ignora `sts` (ver §10, defecto hallado por la puerta T599).
- Fail-closed: serie calificante **sin `sts`** + invalidación presente ⇒ sin autoridad. Sin invalidación, los datos históricos siguen funcionando. **Ningún registro de entrenamiento se pierde ni se altera.**

## 3. Pruebas de reloj (navegador real, Chrome, emulador, atleta sintético)

Harness: `scripts/e2e-t599r/chain.cjs` con `--skew <min>` (desplaza `Date` del dispositivo en **todas** las sesiones, vía `Page.addScriptToEvaluateOnNewDocument`) y `--root <worktree>` (sirve otro build con el mismo harness).

| Caso | Reloj dispositivo | Build previo `25da9f3` | T602 |
|---|---|---|---|
| T9 edición **antes** de empezar | −30 min | **FALLA** (overlay vivo, `CONSUMED`) | PASA |
| T9 | 0 / −5 / −30 / +30 | — | PASA ×4 |
| T15 edición **después** de empezar (no retroactiva) | 0 / −5 / −30 / +30 | — | PASA ×4 (8/8) |
| `sts` presente y aceptado por las Rules del repo | −30 / +30 | no existe | PASA |

Unitarios (`tests/t602-temporal-authority.test.js`, `tests/t601-clock-skew-risk.test.js` reescrito): offsets [0, −5, −6, −30, +30 min, −1 día] ⇒ la edición previa **siempre** invalida y la posterior **siempre** se conserva.

## 4. Offline y concurrencia

- **Escritura offline tardía** (T16, navegador real, `Network.emulateNetworkConditions`): el atleta ejecuta la serie sin red, el Coach revisa el plan, el dispositivo reconecta. `sts` del servidor > `updateTime` del plan ⇒ sin autoridad; registro sigue `APPLIED`; la serie queda guardada. PASA.
- **Dos navegadores concurrentes** (T1, T598 sync): misma prescripción efectiva antes y después del consumo; la serie más temprana confirmada por el servidor define el inicio (unit T602.5).
- **Recibo tardío** (unit T602.3/T602.6): recibo con `ackAt` muy posterior no rescata un overlay invalidado.

## 5. Coach override

`coachInterventions[].decidedAt` anterior a la primera serie confirmada por el servidor bloquea (`COACH_OVERRIDE`); posterior, no (T602.6; emulador t581/t583/t584/t586 INT-06 / E8 / E7 / AUTH-06). Residual: `decidedAt` lo escribe el Coach (ver §8).

## 6. Estado de overlays invalidados

Un overlay invalidado queda `APPLIED` en el registro (no pasa a `CONSUMED`), la UI muestra el plan base antes y después de la primera serie, sin recibo consumido. Los datos de entrenamiento se conservan íntegros.

## 7. Numeric Apply OFF

`chain.cjs --numeric 0 --only T1,T4,T9`: 11/11. Solo `PENDING`, ningún overlay, nunca `APPLIED`.

## 8. Riesgos residuales y bloqueo de infraestructura

1. **`sts` es falsificable por el atleta.** `firestore.rules` deja `entries` como mapa libre. Sin cambio de Rules el atleta puede escribir `sts` arbitrario con el SDK. Cambio mínimo requerido (**NO desplegado, prohibido en esta tarea**): en `match /logs/{userId}` y `/mesos/{planId}`, para claves `log_*` nuevas o modificadas, `request.resource.data.entries[k].sts == request.time`. Hasta entonces la protección cubre el **error de reloj** (el caso real), no un atleta adversarial. Esto es el bloqueo de infraestructura; no se simuló con otros relojes locales.
2. **Reloj del Coach** (`decidedAt`, y `plan.updatedAt` en rutas de UI). Las rutas de servidor usan `updateTime` del plan; `decidedAt` queda como texto del Coach. Cambio mínimo: Cloud Function / endpoint que escriba `coachInterventions[].decidedAt` con `FieldValue.serverTimestamp()`.
3. `updateTime` del plan cambia con **cualquier** escritura del documento; una escritura no prescriptiva posterior a la materialización invalida (fail-closed, conservador).
4. Volver a completar una serie editada re-sella `sts` (el inicio parece más tarde; fail-closed).
5. Datos de Clients previos a T602 (sin `sts`): fail-closed solo si hay invalidación; entrenamiento intacto.

## 9. Puertas

- Unitarios: 1778/1778 (incluye `t602-temporal-authority` 10 casos).
- Emulador (Rules reales): gate PASS, 0 regresiones nuevas. Los fixtures de 6 suites usaban un `clock` fijo en el pasado frente a un `updateTime` real del emulador; ahora usan reloj real (el servidor real materializa «ahora»). Sin cambio de lógica en los tests.
- Navegador (Chrome real, emulador): T599 progresión 68/68; T598 sync 27/27; chain ON (T1,T9,T12) 39/39; chain OFF (T1,T4) 9/9; T594 móvil 14/14; chain T1,T16 37/37; T15 8/8 ×4 relojes; save-latency 10/10 (latencia y restauración del botón intactas); SW cutover 5/5 (contra `25da9f3`).
- Baseline unitario (PowerShell): PASS, 0 regresiones; baseline emulador: PASS, 0 regresiones; `release/check.cjs`: PASS (kill switch y flag numérico sin tocar).
- Build id: `t602-temporal-authority-20261024-01`.

## 10. Defecto hallado por las puertas (corregido)

La primera versión del cambio hacía que el eco del propio write (con `sts` añadido por el servidor) se tomara como «novedad remota» (`_remoteHasNews`), y un snapshot de semana antigua disparaba «Tu coach ha ajustado tu semana… Recargando» a mitad de sesión (T599 e2e: contexto destruido). Corrección: `_mapDiff` ignora `sts` (`_noSts`). Cubierto por unit T602.10 y `t593r` actualizado.

## 11. PR y SHA

(se completa al fusionar)

## 12. Dictamen para un piloto futuro

**GO condicional para el error de reloj del dispositivo; NO-GO para Numeric Apply real hasta (a) desplegar la regla `sts == request.time` y (b) `decidedAt` de servidor.** Nada se desplegó ni se activó en esta tarea.
