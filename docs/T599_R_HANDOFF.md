# T599-R — Traspaso

Fecha: 2026-10-24. Sin datos de atletas reales, UIDs ni credenciales. Producción, `main`, Rules, IAM, índices, variables de Vercel, `CLIENT_APP_RELEASE_ENABLED` y Numeric Apply: sin tocar. Toda aplicación numérica ocurrió en emulador (`demo-vdsen-client-e2e`).

## 1. Identidad

| Campo | Valor |
|---|---|
| HEAD canónico inicial | `e65d86039d74a52467feafdf04eb714a6cef6d90` (no avanzó durante la tarea) |
| HEAD canónico final | merge commit de este PR (se anota en la descripción del PR al fusionar) |
| Rama / worktree | `feat/t599r-progression-authority` · `…/Documents/Codex/2026-10-24/vdsen-t599r` (nuevo) |
| Producción (Vercel, solo lectura) | `b5f53af5843f466528a4b95e5a3e52d6c8c77fb1` · `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw` · build `issue-115-brave-rc-20261024-01` · rollback `dpl_GfBVe46gHe3GSwkGx8yufoJLMLeB` |
| Build del candidato | `t599r-progression-authority-20261024-01` (distinto del publicado; cutover desde `b5f53af` 5/5) |

## 2. Estado recuperado de T599 (Codex)

El worktree de Codex (`~/.codex/worktrees/t599-progression/…`, rama `codex/t599-real-progression`, sin commits propios sobre `e65d860`) tenía trabajo **sin commitear**; no se tocó. Se copió como parche (`git diff`) y archivos nuevos a un worktree propio y se continuó desde ahí:
- `assets/progression-effective-prescription.js`: `validOverlayValues`, `describeProgression`, FREEZE aplica su carga, DELOAD completo validado, unidad de carga.
- `assets/progression-application-consumer.js`: validación de valores estructurales.
- `vdsen-cliente.html`: bloque «OBJETIVO DE ESTA SERIE» (carga/reps/RIR/series/descanso), bloque de autoridad `data-progression-state`, «OBJETIVO APLICADO», copiar historial rotulado.
- `tests/t599-real-prescription.test.js`, `scripts/e2e-client-chain/t599-{progression-e2e,browser-gates}.cjs`, `.github/workflows/vdsen-t599-sandbox.yml` (solo emulador `demo-*`, `permissions: contents: read`, acciones fijadas por SHA, sin secretos).
- Su último log (`t599-e2e.log`) terminaba en **44/46**: «DELOAD continuity…». Causa: el arnés avanzaba la semana solo en el documento raíz de la bitácora; el documento del mesociclo (más reciente) seguía mandando y el atleta quedaba en la semana 3. Corregido en el arnés (ambos documentos, como hace el Cliente real) → **68/68**. No era un defecto del producto.
- Lo que **no** resolvía: D-01, D-02, D-07, D-05/D-03 parcial (ver abajo).

## 3. Evidencia T600 utilizada

Auditoría T600 (commit local `fbc21ad`, worktree `vdsen-t600`, **intacto**): `docs/t600-independent/{DEFECTS,PROGRESSION_MATRIX,UX_ACCEPTANCE,HANDOFF}.md`. Sus casos se convirtieron en una compuerta con aserciones (`scripts/e2e-t599r/chain.cjs`, copia adaptada del arnés T600, sin modificar el original) y los defectos se reprodujeron de forma independiente (pruebas unitarias en rojo contra `e65d860` antes de corregir). Nota: la reproducción de D-02 de T600 fechó la edición del plan en el futuro (+60 s); el código antiguo ignoraba las marcas de tiempo, así que el defecto era real, y la prueba nueva usa un orden de eventos realista.

## 4. D-02 — overlay invalidado que recupera autoridad

- **Antes** (`e65d860`): `evaluateOverlay` devolvía «usable» en cuanto el PID tenía una serie guardada, *antes* de mirar `COACH_OVERRIDE` y `TARGET_INVALIDATED`. Plan editado tras APPLIED → el Cliente mostraba el plan base y, al guardar la primera serie, el ajuste reaparecía (105 kg) y el record pasaba a CONSUMED.
- **Ahora**: `exposureStart()` obtiene el momento de inicio de evidencia persistida (menor `ts` de las series de trabajo del PID). Una revisión del plan o decisión exacta del Coach **anterior o simultánea** a la primera serie invalida el overlay aunque luego se ejecute; una **posterior** no es retroactiva; sin marca de tiempo o con empate → falla cerrado. CONSUMED conserva su exposición. `consumeOverlayTransaction` re-evalúa dentro de su transacción (plan, cliente y bitácora re-leídos; el plan se juzga como el del record, por lo que una exposición iniciada de un plan reemplazado sigue consumiéndose, t532 #7): un recibo —también reintentado tarde— nunca convierte en CONSUMED un overlay invalidado. Seguridad (dolor) sigue por delante de todo.
- **Pruebas**: `tests/t599r-overlay-invalidation-and-maintain.test.js` (D-02.1–D-02.11: edición antes/después/simultánea/sin `ts`, override antes/después, dolor, CONSUMED, consumo servidor con recibo tardío, edición posterior). E2E real (T9): antes y después de la primera serie sigue el plan base, sin recibo, record APPLIED (no CONSUMED).
- **Límite conocido**: el orden se infiere de relojes (plan/Coach vs. dispositivo del atleta); con un reloj del dispositivo muy atrasado una edición previa podría verse como posterior. No cubierto: dos navegadores con versiones distintas del código.

## 5. D-01 — `maintain` oculta las reglas C/E

- **Antes**: `maintain` sin delta → `REJECTED/NO_NUMERIC_DELTA` antes de la política: REST +30 s nunca llegaba y E no llegaba al Coach (T583-E4 lo fijaba como «el servidor no aplica nada»).
- **Ahora**: `buildRecord` evalúa la política para ese caso; el record sale de REJECTED **solo** si produce REST +30 s (regla C) o una revisión del Coach (D, E, C+E…). Alcance deliberadamente estrecho: un `maintain` nunca crea un aumento de LOAD/REPS/SETS (el Cliente conserva su veto sobre aumentos); sin nada que ajustar, el rechazo original se mantiene (sin incrementos inventados).
- **Desde datos del Cliente real** (E2E T1/T12): REST y REST2 → APPLIED 90→120, hoja «Descanso 2:00» y temporizador 120 s, CONSUMED; regla E → PENDING con `coachReviewRequired:E`, sin overlay, el atleta ve «REVISIÓN REQUERIDA». Controles negativos: sin evidencia suficiente, `maintain` sin cambio elegible, dolor, decisión del Coach, PID ajeno, numeric OFF (solo PENDING).
- **Prueba actualizada**: `T583-E4` (pinaba el defecto): ahora exige REST +30 s y ningún LOAD/REPS/SETS.

## 6. Coherencia Motor ↔ Firestore ↔ Cliente

`LOGS → progrec (solo disparador) → política → magnitud → record → overlay → prescripción efectiva → Cliente`.
- **D-07**: `record.dimension` = dimensión de la decisión canónica (antes salía de la acción del Cliente: REPS/FREEZE aparecían como LOAD); la derivada de la acción heredada queda en `record.legacyDimension`, la acción en `record.action`. Verificado en cada dimensión aplicada.
- **D-06 (101,5 vs 105)**: el overlay APPLIED manda siempre en el Cliente y se rotula «Origen: aplicación del servidor (no es una sugerencia)»; `progrec` sigue guardándose como evidencia legada. **Abierto**: la pantalla de monitoreo del Coach no se auditó; si muestra `progrec.newLoad` seguirá habiendo dos números en esa vista.

## 7. Interfaz (qué intentar en la siguiente serie)

«OBJETIVO DE ESTA SERIE»: carga (referencia de bitácora u objetivo aplicado), reps, RIR, **series** y **descanso** juntos. Vocabulario único por estado real: `ESTRUCTURA COACH` · `REFERENCIA DE BITÁCORA` · `PENDIENTE` · `AUTOAJUSTE APLICADO` · `AUTOAJUSTE CONSUMIDO` · `REVISIÓN REQUERIDA` · `BLOQUEADO` · «Sin autoajuste aplicado». Con cambio: «Carga: 100 → 105 KG · Reps… · Descanso: 1:30 → 2:00» + **motivo en lenguaje claro** (p. ej. «repeticiones incompletas con el RIR previsto: más descanso», regla C) + «Origen: aplicación del servidor (no es una sugerencia)». Ya no existe «SUGERIDO PARA HOY» para un ajuste APPLIED («OBJETIVO APLICADO»); la hoja del ejercicio dice «ESTRUCTURA VIGENTE · AUTOAJUSTE» cuando los valores vienen del Motor (nunca «PRESCRIPCIÓN COACH»); un PENDIENTE, una revisión o un bloqueo explican por qué no hay ajuste; «REFERENCIA DE BITÁCORA» ya no sale pegada a su texto (D-05). El Coach no prescribe kg/lb. Capturas: `docs/t599r-evidence/screens/`.
D-08 (consumo tardío, T600): el recibo se escribía *después* del aviso del guardado y un aviso con otro en vuelo se descartaba, así que CONSUMED esperaba a un guardado posterior. Ahora el Cliente vuelve a avisar tras escribir el recibo y recuerda (no descarta) una solicitud en vuelo: 95/95 sin consumos tardíos.

## 8. E2E por dimensión (Chrome real + Auth/Firestore Emulator, atletas sintéticos; semana 2 ejecutada por la UI real)

`chain.cjs --numeric 1` (95/95) — por ejercicio: APPLIED con el valor esperado, `record.dimension`, texto real del Cliente, motivo, CONSUMED tras la primera serie real con carga distinta de la sugerida, y para REST hoja = temporizador:

| Dimensión | Caso | Resultado |
|---|---|---|
| LOAD | regla A 100→105 · DP 20→20,5 · ICS<6/<7 → 85/72 · 2× duro → 76 | PASS |
| REPS | 10→11 (RIR 1, rango 8–12) | PASS |
| SETS | `S-ADD` 3→4 · `S-EIMD3` 3→2 (contador/bloques coherentes) | PASS (la serie añadida no se ejecutó en esta compuerta; sí en `t599-progression-e2e`: 4/4 persistidas y progreso 4/4) |
| RIR | solo `rirByWeek` vía DELOAD (4) | PASS |
| REST | regla C vía `maintain` real, 90→120, sheet 2:00 = timer 120 s | PASS |
| DELOAD | 3→2 series, 100→90, RIR del plan | PASS |
| FREEZE | `S-FREEZE-ZERO/HARD`, carga vigente | PASS |
| Reglas D/E | revisión del Coach, sin overlay | PASS |
| Seguridad | dolor, sin evidencia, PID ajeno, plan editado (D-02) | PASS |
| Dos navegadores | misma prescripción efectiva antes y después del consumo | PASS |

Además `t599-progression-e2e` **68/68** (6 dimensiones × PENDING→APPLIED→UI→timer→CONSUMED→nueva sesión→continuidad semana 4 + caso Brave 10 kg vs 8 reps), `t598 sync` **27/27**, runtime móvil **14/14**, guardado/offline **10/10**, Auth E2E **15/15**, cutover SW desde `b5f53af` **5/5** (datos del atleta conservados).

## 9. Aplicación y consumo efectivos en sandbox

Servidor real (`/api/autonomous-progression-trigger` servido por `serve.cjs`, `E2E_NUMERIC=1`, emulador): materialización → PENDING → APPLIED → overlay en el Cliente → ejecución → recibo → CONSUMED → continuidad (LOAD/REPS/SETS/REST llevan; DELOAD/FREEZE no).

## 10. Numeric Apply OFF

`chain.cjs --numeric 0` (20/20): solo PENDING/revisión, **cero** overlays y cero APPLIED en Firestore, el atleta ve el plan base con «PENDIENTE · calculado, aún no aplicado» / «REVISIÓN REQUERIDA» / «BLOQUEADO». `NUMERIC_APPLY_ENABLED=false` en el Cliente y `numeric_apply_enabled:false` en el manifiesto.

## 11. Gates (PowerShell)

| Gate | Resultado |
|---|---|
| `check.cjs` (simulando `pull_request`; sin eso exige estar en la rama canónica) | PASS |
| `baseline.cjs unit` | PASS, **1760** PASS, 0 regresiones (la primera corrida, justo tras ~1 h de E2E, marcó 1 regresión: `T596-2` con umbral de 25 ms de reloj de pared; 6/6 aislada y PASS en la repetición → **flake de temporización, no resuelto**; ambas salidas en `docs/t599r-evidence/`) |
| `baseline.cjs emulator` | PASS, **197/197**, 0 regresiones (una primera corrida con 6 «regresiones» eran pruebas que fijaban D-01/continuidad antes de la restricción de alcance; ver §5; `t581 INT-04`, `t532 #7`, `t586 AUTH-01/02` pasan sin cambios) |
| Los números 1726 (T596) y 1733 (T598) no son objetivos: el total creció legítimamente. |

## 12–13. CI y PR

Ver el PR de T599-R (CI `check` y, si está habilitado por ruta, `VDSEN T599 sandbox`); PR, merge SHA y resultado de CI se anotan en la descripción del PR.

## 14. Estado real de producción

Sin cambios: `b5f53af` (`dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw`). Variables `AUTONOMOUS_PROGRESSION_*` de Vercel: **NO VERIFICADO** (la API devolvió 403). `releaseControl/autonomousProgression` y el canario del Coach: no consultados (sin datos reales). Estos controles son distintos de `CLIENT_APP_RELEASE_ENABLED` (compuerta del release de la app).

## 15. T596 intento 1 vs T596-R intento 2

- **T596, workflow `40055779147` intento 1**: NO-GO seguro — `CLIENT_APP_RELEASE_ENABLED=false`, se detuvo antes de staging; sin publicación, promoción ni rollback; Rules, IAM, `main`, Numeric Apply y datos reales intactos. Gates locales: contrato 0 fallos, app-only 23/23, focales 40/40, unit 1726, emulador 197, Numeric Apply OFF; `app-candidate-check` local bloqueado por ausencia intencional del secreto de Vercel.
- **T596-R, mismo workflow, intento 2**: SUCCESS. Runtime `b5f53af`, deployment `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw`, build `issue-115-brave-rc-20261024-01`, kill switch `false → true → false`, rebaseline PR #129 fusionado, rollback `dpl_GfBVe46gHe3GSwkGx8yufoJLMLeB`.
- El NO-GO pertenece solo al primer intento: `b5f53af` **está publicado**. No se reintentó T596 ni se tocó el rebaseline #129. Producción es la referencia contra la que se mide este candidato (diferencias: T597, T598, T599, este PR).

## 16. Bloqueos pendientes

- **#115**: solo Chrome emulado; Brave Android físico PENDIENTE (checklist en `docs/T595B_CLAUDE_HANDOFF.md` §10).
- **#124**: evidencia sintética; no se cierra. Abiertos: D-06 en la vista del Coach; override del Coach tras APPLIED y dolor *entre* fuente y objetivo cubiertos por unitarias/código, no por E2E de navegador; dos navegadores con versiones distintas; reloj del dispositivo vs. servidor (§4); un `maintain` aún bloquea aumentos numéricos por diseño.
- `T596-2` flake de temporización (§11).

## 17. Requisitos para un futuro piloto productivo

1. Autorización del propietario y SHA aprobado; gates oficiales en CI de release; release app-only y rebaseline posteriores (no se ejecutaron).
2. Verificación (no asumida) de `AUTONOMOUS_PROGRESSION_ENABLED` / `…_NUMERIC_APPLY_ENABLED`, `releaseControl/autonomousProgression` (≤10 clientes), `autoApplyCanary` del Coach y credenciales Admin/WIF del ejecutor.
3. Plan real con `repsRange`, `muscleGroup`/prioridades (sin `repsRange` no hay REPS; sin volumen `S-ADD` usa el máximo por defecto).
4. Validación física (Brave Android) y prueba humana de una sesión real del piloto.
5. Decidir qué ve el Coach en su monitor (D-06).

## 18. Recomendación

- **Fusión a la canónica: GO** (no es un release; todos los gates PASS; producción intacta).
- **Activación de progresión numérica en producción: NO-GO** hasta cumplir §17 y la aceptación física de #115.
