# T601 — Preparación de release (Cliente) · dictamen

Fecha: 2026-10-24. Sin escrituras en producción, sin datos reales, sin activar compuertas. Todo lo mutable ocurrió en emuladores (`demo-vdsen-client-e2e`) con atletas sintéticos. Evidencia: `docs/t601-evidence/`.

## 1–2. SHA y build evaluados

| Campo | Valor |
|---|---|
| HEAD inicial (T601) | `1b36318d557e76bb148f1a12f8ac3d625c165c33` (PR #132 fusionado; worktrees T597/T598/T599-R/T600 preservados) |
| **SHA candidato final** | **`25da9f35e168735801963454a89c0ea1b2b06fdc`** (PR #133, ver §12) |
| Build candidato | **`t601-compact-card-20261024-01`** (distinto del publicado `issue-115-brave-rc-20261024-01`) |
| Producción verificada (Vercel solo lectura + GET público) | `b5f53af5843f466528a4b95e5a3e52d6c8c77fb1` · `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw` · target production · sirve `issue-115-brave-rc-20261024-01` |

## 3. Comparación producción vs. candidato (Chrome real, misma sesión guiada)

Misma sesión en ambos (`scripts/t601/compare.cjs`: `b5f53af` y el candidato servidos con el mismo servidor de emulador, atleta sintético, perfiles de navegador aislados). **30 comprobaciones: producción 28/30, candidato 28/30; 0 regresiones, 0 mejoras.** Las dos «FAIL» idénticas en ambos son de visibilidad (nota abajo). La corrida del candidato es de código idéntico al final salvo la cadena del build.

| Área | Comprobación | Producción b5f53af | Candidato | Resultado |
|---|---|---|---|---|
| Identidad | build identificado | PASS | PASS | sin regresión |
| Navegación | Inicio / Entrenamiento / Nutrición / Check-in / Perfil renderizan sin desbordar horizontalmente (5 comprobaciones) | PASS | PASS | sin regresión |
| Entrenamiento | lista los 2 ejercicios del plan | PASS | PASS | sin regresión |
| Entrenamiento | serie actual con carga, reps, RIR 0-5, ICS, pump y botón GUARDAR | PASS | PASS | sin regresión |
| Entrenamiento | contador de series de la sesión | PASS | PASS | sin regresión |
| Historial | bloque «Última semana» con USAR CARGA/REPS | PASS | PASS | sin regresión |
| Guardado | persistencia (documento del plan y raíz) con carga/reps/RIR/ICS/pump | PASS | PASS | sin regresión |
| Progreso | el contador avanza al guardar | PASS | PASS | sin regresión |
| Descanso | se inicia el temporizador (90 s del plan) | PASS | PASS | sin regresión |
| Corrección | reabrir la serie la devuelve a edición; la corrección reemplaza sin duplicar (82.5 × 9) | PASS | PASS | sin regresión |
| Reanudación | una sesión nueva conserva las series guardadas | PASS | PASS | sin regresión |
| Offline | sin red no se anuncia «✓ GUARDADO» y avisa pendiente/local; al reconectar llega a ambos documentos | PASS | PASS | sin regresión |
| Sincronización | un segundo navegador ve las series guardadas | PASS | PASS | sin regresión |
| Móvil | 320×640, 360×740, 390×844, 430×932 y 740×360: sin desbordamiento horizontal, serie actual y GUARDAR (5 comprobaciones) | PASS | PASS | sin regresión |
| Visibilidad 360×740 / 390×844 | GUARDAR visible sin desplazar | FAIL | FAIL | igual en ambos |
| Visibilidad 430×932 | GUARDAR visible sin desplazar | PASS | PASS | sin regresión |
| Finalización | aparece COMPLETAR; el post-sesión se persiste y la semana avanza | PASS | PASS | sin regresión |
| Errores | sin errores de página no capturados | PASS | PASS | sin regresión |

**Hallazgo y corrección (PR #133).** El primer candidato (`1b36318`) hacía la tarjeta de serie 122 px más alta (bloque «Sin autoajuste aplicado» de 4 líneas) y en 430×932 «GUARDAR SERIE» quedaba fuera de la primera pantalla, a diferencia de producción. Corregido solo en presentación: sin ajuste, una línea corta; PENDIENTE/BLOQUEADO/REVISIÓN conservan su explicación sin el bloque «cambio» vacío; la advertencia de «copiar historial» solo aparece cuando difieren las reps. Altura 878→802 px (producción 756): a 430×932 GUARDAR vuelve a verse; en 360×740 y 390×844 ocurre lo mismo que en producción (parcialmente bajo el pliegue). El +46 px restante es la información nueva (referencia y estado): cambio **intencional y medido**, no regresión funcional. Capturas: `docs/t601-evidence/screens/`. La experiencia aprobada por el propietario era la de `b5f53af`; su aceptación sobre el candidato sigue pendiente (§16).

## 4–5. Claridad para el atleta (sin conocer el Motor)

Texto real del Cliente (`chain-numeric-ON-95of95.json`):
- **Carga**: «REFERENCIA DE BITÁCORA · Última carga de trabajo válida: 100 KG»; con ajuste aplicado, «OBJETIVO APLICADO … CARGA 105 KG»; «SIN HISTORIAL» en la primera ejecución. El Coach no prescribe kg/lb («ESTRUCTURA COACH 10 reps RIR 1»).
- **Reps / RIR / series / descanso** juntos en «OBJETIVO DE ESTA SERIE» (p. ej. «10 reps · RIR 1 · 3 series · Descanso 1:30»).
- **Cambio y motivo**: «CAMBIO RESPECTO DE LA EXPOSICIÓN ANTERIOR — Descanso: 1:30 → 2:00 · Motivo: repeticiones incompletas con el RIR previsto: más descanso. Regla C. Origen: aplicación del servidor (no es una sugerencia)».
- **Estado**: PENDIENTE · AUTOAJUSTE APLICADO · AUTOAJUSTE CONSUMIDO · REVISIÓN REQUERIDA · BLOQUEADO · «Sin autoajuste aplicado». La referencia histórica no se confunde con una progresión («la referencia no es una progresión»).
- **Caso del propietario** (10 kg × 10 con objetivo vigente 8 reps RIR 3, descanso 2:30): `t599-progression-e2e` 68/68 lo cubre: la referencia muestra 10 KG, el objetivo sigue siendo 8 reps / RIR 3, no se inventa ningún incremento y copiar historial es un borrador que no sobrescribe el objetivo (advierte «Objetivo vigente: 8 reps · No es una recomendación»).

## 6–7. D-01 y D-02

- **D-01**: con datos ejecutados por el Cliente real: regla C → REST 90→120 (hoja «Descanso 2:00» = temporizador 120 s, CONSUMED); regla E → PENDING con revisión del Coach, sin overlay. Negativos (evidencia insuficiente, `maintain` sin cambio elegible, dolor, decisión del Coach, PID ajeno, Numeric Apply OFF): sin aplicaciones arbitrarias.
- **D-02**: plan editado antes de iniciar → plan base antes y después de la primera serie, sin recibo y el record sigue APPLIED (no CONSUMED). Override del Coach, recibo tardío, edición posterior al inicio y empate de marcas: unitarias `t599r-overlay-invalidation-and-maintain` 20/20 (el servidor re-valida dentro de su transacción).

## 8. Riesgo de relojes desincronizados — NO ACEPTADO · NO-GO para Numeric Apply

El orden «edición del plan / decisión del Coach vs. primera serie» se infiere de dos relojes (`plan.updatedAt`/`decidedAt` del Coach; `ts` del dispositivo del atleta). Pruebas de caracterización nuevas (`tests/t601-clock-skew-risk.test.js`, 3/3): reloj del dispositivo adelantado o sincronizado → seguro; **atrasado más que el intervalo edición→inicio (p. ej. 6 min con 5 min de intervalo) → el overlay invalidado conserva autoridad**; el sesgo opuesto falla seguro (descarta el overlay a mitad de exposición). No puede demostrarse seguridad con esa condición. Antes de activar Numeric Apply, el instante de inicio debe provenir de un reloj del servidor (p. ej. marca de servidor en la primera serie persistida o en el recibo), o el riesgo debe aceptarse explícitamente.

## 9. Pruebas por dimensión (sandbox aislado, `chain.cjs --numeric 1`, 95/95)

CÁLCULO → PENDING → APPLIED → CLIENTE → EJECUCIÓN → CONSUMED, con igualdad exacta entre el valor del servidor y el de la interfaz:

| Dimensión | Casos | Resultado |
|---|---|---|
| LOAD | regla A 100→105 · DP 20→20,5 · ICS<6/<7 → 85/72 · 2× duro → 76 | PASS |
| REPS | 10→11 | PASS |
| SETS | S-ADD 3→4 · S-EIMD3 3→2 · 4/4 series persistidas (t599-progression-e2e) | PASS |
| RIR | solo vía DELOAD con `rirByWeek` (→4) | PASS |
| REST | regla C vía `maintain` real 90→120, hoja = temporizador | PASS |
| DELOAD | 3→2 series, 100→90, RIR del plan | PASS |
| FREEZE | S-FREEZE-ZERO/HARD, carga vigente | PASS |

## 10. Numeric Apply OFF (`--numeric 0`, 20/20)

Solo PENDING / revisión; **cero overlays y ninguna transición a APPLIED** en Firestore; el Cliente muestra estructura y referencia histórica con «PENDIENTE · calculado, aún no aplicado» / «REVISIÓN REQUERIDA» / «BLOQUEADO». `NUMERIC_APPLY_ENABLED=false` en el Cliente y `numeric_apply_enabled:false` en el manifiesto.

## 11. Gates oficiales (PowerShell, sobre el código del PR #133)

| Gate | Resultado |
|---|---|
| `check.cjs` (simulando pull_request) | PASS |
| `baseline.cjs unit` | PASS, 1767, 0 regresiones |
| `baseline.cjs emulator` | PASS, 197/197, 0 regresiones |
| Cadena numeric ON / OFF | 95/95 · 20/20 |
| `t599-progression-e2e` (6 dimensiones, continuidad, caso Brave) | 68/68 |
| Dos navegadores | 27/27 |
| Runtime móvil T594 (320/360/390/430 + horizontal) | 14/14 |
| Guardado / offline | 10/10 |
| Auth E2E | 15/15 |
| Cutover del service worker desde `b5f53af` (datos del atleta conservados) | 5/5 |
| Comparación producción/candidato | 28/30 = 28/30 (0 regresiones) |

Flake `T596-2` (umbral de 25 ms de reloj de pared): en esta cadena de tareas falló **1 de 4** corridas completas del baseline unitario (T599-R, tras ~1 h de E2E), 6/6 aislada; **no reapareció en T601**. Sin causa confirmada; no se declara resuelto.

## 12. CI

PR #133: `check` PASS y `VDSEN T599 sandbox` (navegador real, Windows) PASS. Merge `25da9f35e168735801963454a89c0ea1b2b06fdc`.

## 13–14. Preview e identidad real

- Deployment del SHA exacto: `dpl_EpFKfxk6oErjHJ3ia7Qn83B397v7` (Preview, READY).
- **URL para abrir en Brave Android**: `https://vdsen-ecosistema-lrd1fly8c-vdsenasesoria-svgs-projects.vercel.app/cliente` (protegido por Vercel Authentication: abrir con la sesión de Vercel del propietario; no se desactivó la protección; el contenido se verificó con la herramienta autorizada de la cuenta).
- Verificado en el HTML servido: `vdsen-client-build` y `VDSEN_CLIENT_BUILD` = `t601-compact-card-20261024-01`; **0** apariciones de `issue-115-brave-rc-…`, `t599r-…`, `t598-…`; contiene el bloque compacto y ya no «SUGERIDO PARA HOY»; `sw.js?build=t601-…` responde 200, caché `vdsen-<build>`, `max-age=0, must-revalidate`. Transición desde `b5f53af`: probada en navegador (5/5: worker y caché nuevos, caché anterior eliminada, localStorage/IndexedDB intactos).
- Producción real: `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw` (target production, READY, source cli).

## 15. Controles productivos (preflight de solo lectura)

| Control | Estado |
|---|---|
| `CLIENT_APP_RELEASE_ENABLED` (publicación del Cliente) | NO VERIFICADO en el entorno remoto; el repositorio/manifiesto lo registra en `false` tras T596-R |
| `AUTONOMOUS_PROGRESSION_ENABLED`, `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` | NO VERIFICADO: la API de Vercel devolvió 403 al listar variables; manifiesto: `numeric_apply_enabled:false` |
| `releaseControl/autonomousProgression`, `autoApplyCanary`, autoridad del Coach, Firestore Rules desplegadas, credenciales del ejecutor | NO VERIFICADO (requerirían datos/credenciales reales; no se consultaron). Un GET público sin credencial al endpoint del ejecutor respondió 401 (falla cerrado) |

Son dos activaciones distintas: publicar el Cliente (`CLIENT_APP_RELEASE_ENABLED`) no activa la progresión autónoma. No se cambió ningún valor, no se promovió ni revirtió nada, no se tocó el manifiesto ni el rebaseline #129.

## 16. Aceptación física pendiente

Brave Android: **PENDIENTE** (#115 abierto). Checklist (abrir el Preview con la sesión de Vercel): 1) confirmar el build `t601-compact-card-20261024-01` con `getVdsenRuntimeDiagnostics()`; 2) Entrenamiento: «OBJETIVO DE ESTA SERIE» y la referencia legibles; 3) guardar una serie sintética; 4) la serie siguiente muestra la referencia; 5) abrir el teclado y desplazar la tarjeta; 6) «GUARDAR SERIE» sin solapes; 7) modo avión → guardar → reconectar (pendiente, no «✓ GUARDADO»; luego sincroniza); 8) recargar: la referencia persiste; 9) comparar la sensación con producción. Chrome automatizado no equivale a Brave físico.

## 17. Problemas aún abiertos

#115 y #124 (evidencia sintética); riesgo de relojes (§8); D-06 en la vista de monitoreo del Coach (no auditada); override del Coach y dolor *entre* fuente y objetivo cubiertos por unitarias, no por E2E de navegador; dos navegadores con versiones distintas del código; plan real sin `repsRange`/prioridades musculares; `T596-2`; +46 px de tarjeta respecto a producción (intencional).

## 18–19. SHA recomendado y rollback

- **SHA recomendado para un release app-only controlado: `25da9f35e168735801963454a89c0ea1b2b06fdc`** (el código es idéntico al de esta rama documental, que solo añade este informe y su evidencia).
- Rollback disponible: `dpl_4wyBNxUCNAMYHy5KwuaZ7SnnsoEw` (`b5f53af`, producción actual, `isRollbackCandidate: true`) y `dpl_GfBVe46gHe3GSwkGx8yufoJLMLeB` (`c161fdb`).

## 20. Dictamen

| Decisión | Veredicto | Justificación |
|---|---|---|
| Integración canónica | **GO** (hecha: #132, #133) | Gates PASS, 0 regresiones vs producción, CI verde |
| Aceptación física (Brave Android) | **GO para ejecutarla** | Preview del SHA exacto listo y verificado; el resultado físico es independiente y sigue pendiente |
| Release app-only | **GO condicionado** | Solo con la aceptación física del propietario, autorización explícita, gates de CI de release y rebaseline posterior; `CLIENT_APP_RELEASE_ENABLED` sigue siendo decisión del propietario |
| Numeric Apply | **NO-GO** | Riesgo de relojes sin mitigar (§8); variables/allowlist/canario/credenciales NO VERIFICADOS; plan real sin `repsRange`; #124 abierto |
