# T597 — Traspaso de Claude a Codex

Fecha: 2026-10-23. Sin datos de atletas reales, UIDs ni credenciales. Producción, `main`, Rules, IAM, índices, `CLIENT_APP_RELEASE_ENABLED` y Numeric Apply: sin tocar.

## 1. Identidad

| Campo | Valor |
|---|---|
| HEAD canónico inicial | `83aee8a00e2ed37eca51c1c2834b1a9b2fcab7cc` (`codex/client-app-next`, no avanzó durante la tarea) |
| HEAD canónico final | merge commit del PR de T597 (ver el PR; anotado en la descripción al fusionar) |
| Rama | `fix/t597-logbook-load-reference` (la creó Codex) |
| Worktree | `…/Documents/Codex/2026-10-24/t597-logbook-load` — **el de Codex sobrevivió** y se continuó desde él. Worktree de contraste (descartable): `%TEMP%/t597-base83` en `83aee8a` |
| PR previo de Codex | ninguno (se verificó con `gh pr list`); rama sin commit parcial |

## 2. Qué sobrevivió de Codex (todo sin commitear, verificado en disco)

`vdsen-cliente.html` (+127/−52), `tests/t597-logbook-load-reference.test.js` (nuevo), pines actualizados en `t485`, `t507`, `t553`, `t594-client-effective-targets`, y `docs/PRODUCTION_RELEASE_GATE.md`, `docs/PROGRESSION_AUTHORITY.md`. Logs de Codex conservados en `docs/t597-evidence/codex-*.log` (t583 10/10 y t584/t586 9/9 PASS, 19 escenarios) y copiados en `%TEMP%/codex-t597-evidence/` (incluye su baseline unitario **FAIL con 7 regresiones**, ver §4). No se perdió ni se sobrescribió nada de Codex.

## 3. Cambios nuevos de Claude

- Pines desactualizados de 7 pruebas (eran pruebas del código reemplazado, no regresiones de comportamiento; en cada caso se verificó el equivalente semántico): `t251`, `t417` (forma `{…, last, personalBest}`), `t483.4/5` (la carga del plan ya no es base de calentamiento), `t495.2` y `t516.2` (`if (!pidKey) return {};` — sigue sin fallback por nombre), `t498.1/.3` (el harness extraía funciones sueltas; ahora incluye los helpers `_history*`).
- `docs/PROGRESSION_AUTHORITY.md`: la sección T597 quedó insertada *dentro* de T582 (entre su título y su cuerpo); se movió antes de T582.
- `tests/t597-logbook-load-reference.test.js`: +1 prueba (T597-K) — el cambio KG/LB convierte `last` y `personalBest` por separado y mantiene la vista plana igual a `last`.
- `scripts/e2e-client-chain/t594-mobile-runtime-e2e.cjs`: el control de objetivo ahora espera «ESTRUCTURA COACH» sin «CARGA»; dos controles nuevos en navegador real: la referencia de bitácora (o «SIN HISTORIAL») aparece **antes** de los campos y nunca como «CARGA no prescrita», y tras el primer guardado de 80 kg la **serie siguiente** muestra «80 KG» de bitácora.
- Evidencia en `docs/t597-evidence/`.

## 4. Causa raíz de «CARGA no prescrita»

`_effectiveSetTargetHtml()` (PR #125) mostraba la carga del plan o el texto «CARGA no prescrita» sin consultar nunca la bitácora; y `EXERCISE_HISTORY` guardaba el **máximo histórico** (solo se sobrescribía si `nuevaCarga ≥ guardada`), de modo que tras 15 kg → 10 kg la «referencia» seguía siendo 15 kg. Además el calentamiento caía a la carga del plan (`COACH_PLAN`) cuando no había ejecución previa.

## 5. Contrato resultante

- **Récord vs última ejecución:** `EXERCISE_HISTORY.__pid__<PID> = { load, reps, rir, unit, updatedAt, last, personalBest }`. `last` = ejecución válida más reciente por `ts` (la referencia operativa); `personalBest` = récord, separado; los campos planos reflejan `last` (compatibilidad). Caso 15 kg → 10 kg: récord 15, última 10, referencia **10**; los 15 no se recuperan por ser el máximo.
- **Válida:** `done`, no `autoFilled`, no calentamiento, no Express/expressFinal, carga > 0, mismo `prescriptionExerciseId`. Sin PID no se escribe ni lee historial (falla cerrado, T553); sustituciones del atleta no contaminan.
- **Primera serie / siguientes:** sin historial → «SIN HISTORIAL — Primera ejecución: registra la carga utilizada». Tras guardar 10 kg × 10, la serie siguiente muestra «REFERENCIA DE BITÁCORA — Última carga de trabajo válida: 10 KG».
- **Entre sesiones:** al cargar bitácora (Firestore, caché local o refresco/adopción de otro dispositivo) `_rebuildLoadedHistoryReferences()` recalcula desde los registros reales de los PID presentes; una corrección/eliminación recalcula sin conservar valores obsoletos.
- **Unidades:** la referencia se convierte a la unidad del ejercicio; el toggle KG/LB convierte `last` y `personalBest`.
- **Coach:** el objetivo del plan muestra «ESTRUCTURA COACH» (reps/RIR) sin kg/lb; una carga numérica solo se muestra como «OBJETIVO AUTOAJUSTE VDSEN» cuando es el valor efectivo de un overlay canónico APPLIED. La referencia de bitácora nunca se etiqueta «prescrita por Coach», no modifica inputs, plan, overlays ni PENDING.
- **Calentamiento:** base = ejecución previa > historial; sin base, cualitativo (nunca carga del plan).

## 6. Resultados

| Prueba | Resultado |
|---|---|
| Focal (t597 + t485/t507/t553/t594) | 42/42 PASS reproducido; t597 ahora 6 pruebas; 7 pines actualizados PASS |
| E2E Cliente/Motor (t583 10 + t584 9 + t586 en el baseline de emulador) | PASS (incluidos en emulador 197/197); logs de Codex conservados |
| **Baseline unitario** (`baseline.cjs unit`, PowerShell) | **gate PASS**, TEST_BASELINE_MATCH YES, 1732 eventos PASS, 0 regresiones nuevas, 13 «fixed baseline failures» (pruebas que figuraban como fallos conocidos y hoy pasan: sin acción) |
| **Baseline emulador** (`baseline.cjs emulator`) | **gate PASS**, 197/197 PASS, 0 regresiones, 37 «fixed». **Primera corrida: 1 fallo `t586 AUTH-08`** (evidencia en `emulator-baseline-run1-AUTH-08-flake.json`); no se reprodujo: 3/3 PASS aislado y PASS en la repetición completa → **flake no atribuible a T597** (diferencia en `t586` no existe; el archivo no se tocó) |
| Runtime móvil T594 (Chrome + emuladores) | 14/14 PASS ×2 (320/360/390/430/horizontal, referencia antes de campos, siguiente serie 80 KG) |
| Guardado/offline (`save-latency-e2e`) | 10/10 PASS: sin regresión de guardado, doble toque, fallo, offline |
| Auth + Firestore Emulator, Cliente autenticado | 15/15 PASS |
| Verificación funcional A–N | A,B,C,D,E,F,G,H,K,N cubiertas por t597/t485/t498/t594 + navegador (B/C/D en T594); I (offline/reconexión) por `save-latency-e2e`; J (dos dispositivos) por reconstrucción desde LOGS fusionados (T597-E2 + hook en `_refreshLogsFromFirestore`; la fusión por entrada es de #114) — **no hay E2E de dos navegadores con la referencia de bitácora**; L (overlay APPLIED en sandbox) y M (dolor/fatiga) por t583/t584/t586 (SAFETY_CONFLICT, CONSUMED, PENDING con Numeric Apply OFF) |

Aviso de entorno: bajo Git Bash el único fallo del baseline unitario fue `T571-1e` (ruta de `tar`); en PowerShell y en CI pasa (22/22 también en `83aee8a`). Ejecutar los baselines desde PowerShell.

## 7. Numeric Apply

`NUMERIC_APPLY_ENABLED=false` en el Cliente; `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` no se tocó. APPLIED solo en el sandbox de emulador (t583/t584/t586). Ningún PENDING pasó a APPLIED por T597.

## 8. PR y CI

Ver el PR de T597 (CI oficial `check`); resultado anotado en su descripción.

## 9. Bloqueos / pendientes

- Sin E2E de dos dispositivos reales con la referencia de bitácora (§6, J).
- La referencia usa la última ejecución *por `ts`* de cualquier semana del plan; si se quisiera restringir a «exposición comparable» (misma semana-1), es decisión de producto.
- #115 (Brave Android físico) y #124 siguen abiertos; no se cierran con pruebas sintéticas.
- Producción sigue en el release anterior; T597 NO incluye autorización de despliegue.

## 10. Próxima acción exacta antes de publicar producción

1. `git fetch`; partir de `codex/client-app-next` con el PR de T597 fusionado.
2. Validar en un teléfono real (Brave Android) la nueva fila «REFERENCIA DE BITÁCORA» sin solapes (checklist en `docs/T595B_CLAUDE_HANDOFF.md` §10) y, si es posible, dos dispositivos del mismo atleta.
3. SHA aprobado por Ayrton → gates oficiales (`check.cjs`, `baseline.cjs unit/emulator` desde PowerShell) → release → rebaseline (`chore/rebaseline-<sha>`). No activar Numeric Apply.
