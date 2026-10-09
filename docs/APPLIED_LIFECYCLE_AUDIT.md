# Ciclo de vida de la aplicación: PENDING → APPLIED → CONSUMED / OVERRIDDEN / REVERTED / STALE

Estado (T529–T535): **implementado y verificado detrás de `NUMERIC_APPLY_ENABLED=false`** (bandera apagada en los 4 módulos: política, sombra, consumidor y prescripción efectiva). Con la bandera apagada `APPLIED` no puede crearse ni consumirse. Verificado por `tests/t529…t535`, más `tests/t532-lifecycle-emulator.cjs` con Firestore Emulator real.

| Componente | Estado |
|---|---|
| APPLIED LIFECYCLE | READY_BEHIND_DISABLED_FLAG |
| CLIENT OVERLAY CONSUMER | READY_BEHIND_DISABLED_FLAG |
| ROLLBACK | READY |
| CONSUMPTION | READY |
| OVERRIDE | READY |
| STALE | READY |

## Registro canónico y transiciones

El registro de aplicación de progresión (`logs/{uid}/mesos/{planId}.progressionApplications[key]`) es el **único** registro de ciclo de vida (sin segunda máquina de estados). El overlay (`nextExposureOverlays['ovl_'+key]`) refleja su estado en el mismo documento.

| Desde | Hacia (permitido) |
|---|---|
| PENDING | APPLIED · REJECTED · STALE |
| APPLIED | CONSUMED · OVERRIDDEN · REVERTED · STALE |
| REJECTED | PENDING (solo acción Coach `REVERT_DECISION`) · STALE (barrido por cambio de plan) |
| CONSUMED · OVERRIDDEN · REVERTED · STALE | — (terminales) |

No hay resurrección: un nuevo candidato válido necesita una nueva identidad de idempotencia (nuevo registro), nunca reabrir uno terminal. Además, un candidato para la MISMA exposición destino no puede apilar un segundo overlay mientras exista uno (cualquier estado).

## Transacciones (un único escritor: `_commitLifecycle`)

Registro + overlay + resumen del Monitor (meso y raíz) se escriben **siempre juntos**, en una sola transacción. No existe "overlay escrito con registro PENDING" ni "registro APPLIED sin overlay" (probado con escrituras denegadas en el emulador).

| Transición | Función | Compuertas |
|---|---|---|
| PENDING → APPLIED | `applyOverlayTransaction` | bandera, `expectedRevision`, cliente/plan activo/PID/exposición exactos, destino no iniciado (a nivel sesión, conservador), guardia de activación (19), alcance de canario re-leído del documento del Coach dentro de la transacción (ausente/deshabilitado = fuera), sin override del Coach, sin dolor reportado entre origen y destino, `operationKey = apply:<key>` |
| APPLIED → CONSUMED | `consumeOverlayTransaction` (Coach dueño) tras `recordConsumptionReceiptTransaction` (atleta, recibo append-only) | bandera; primera serie de trabajo **persistida** del PID exacto (LOGS releídos en la transacción); el recibo debe describir exactamente el overlay; `consume:<key>`; registra `consumedAt` y la prescripción efectiva mostrada |
| APPLIED → OVERRIDDEN | `overrideOverlayTransaction` | decisión exacta del Coach (EXERCISE + PID + plan, acción ≠ NO_CHANGE) posterior al cálculo de origen; destino no iniciado; registra `overriddenAt` e intervención |
| APPLIED → REVERTED | `revertOverlayTransaction` | Coach; `expectedRevision` obligatorio; identidad de overlay exacta; destino no iniciado; conserva el historial |
| APPLIED → STALE | `staleOverlayTransaction` | plan reemplazado / PID o exposición destino invalidados / plan editado tras el cálculo; destino no iniciado; sin limpieza destructiva |

Override / revert / stale funcionan con la bandera apagada (válvulas de seguridad: solo pueden QUITAR efecto). Aplicar y consumir exigen la bandera.

**Inicio de la exposición destino** (definición única, `pidExposureStarted`): primera serie de trabajo persistida del PID exacto en la semana/día exactos: `done`, sin autofill, sin express, sin etiqueta explícita de calentamiento / drop / intensificación. Renderizar o abrir la pantalla no cuenta.

## Prescripción efectiva (cliente)

`efectiva = plan base + overlay elegible`. Precedencia: **SEGURIDAD > override exacto del Coach > overlay elegible > plan base**. `vdsen-plan-v2` nunca se muta. Procedencia: `BASE_PLAN`, `CANONICAL_OVERLAY`, `COACH_OVERRIDE`, `SAFETY_FALLBACK`. Cualquier duda (identidad, plan, estado, unidad distinta, overlay ambiguo, registro/overlay inconsistentes) → plan base.
Presentación mínima: «AUTOAJUSTE VDSEN · 100 → 102.5 kg». El valor de carga efectivo solo es un prefill editable; el valor **ejecutado** (LOGS), el **prescrito base** y el **efectivo del overlay** son tres valores separados y nunca se sobrescriben entre sí.

## Concurrencia (Firestore Emulator real, `tests/t532-lifecycle-emulator.cjs`)

Dos dispositivos aplicando · carrera override↔apply · carrera primera serie↔revert (sin pérdida de LOGS) · carrera cambio de plan↔apply · consumo duplicado · callbacks tardíos de otro cliente / otro plan · reintento tras ambigüedad de red · escritura de overlay denegada · escritura de estado denegada (rollback total) · ciclo completo y sin resurrección. Resultado: un único estado final coherente, sin overlay duplicado, sin evento duplicado, sin aplicación parcial, sin pérdida de LOGS.

## Aristas conocidas (documentadas, no bloqueantes)

- Si la primera serie de trabajo se ejecuta mientras el cliente muestra un fallback (p. ej. seguridad), el overlay queda `APPLIED` (no se consume porque no se mostró) y, como la exposición ya empezó, deja de poder revertirse; se mostrará desde entonces. Es una situación rara y auditable.
- El resumen del Monitor muestra las 8 entradas más recientes; el detalle completo vive en el registro.

## Modelo de confianza y frontera de escritura (T537)

Resuelto en el repositorio: `firestore.rules` reserva todo campo canónico al Coach dueño del cliente; el atleta solo escribe ejecución y recibos de consumo append-only. Ver `docs/FIRESTORE_WRITE_BOUNDARY.md` (inventario de escritores, matriz de autorización por transición, modelo de consumo por recibo, propiedad del Coach). **FIRESTORE_CANONICAL_WRITE_BOUNDARY: PASS / READY** (probado con reglas reales en el emulador). Las reglas **no están desplegadas**.

Quién realiza cada transición: PENDING (creación), APPLIED, OVERRIDDEN, REVERTED, STALE → Coach dueño; CONSUMED → Coach dueño con el recibo del atleta; recibo → atleta.

## Qué falta para activar de verdad

1. Datos reales de incrementos de equipo del Coach (bloqueo operativo principal): `docs/EQUIPMENT_DATA_REQUIRED_NEXT.md`.
2. **Despliegue de `firestore.rules`** (no autorizado en esta ejecución) antes de activar.
3. Decisión explícita del director de cambiar `NUMERIC_APPLY_ENABLED` (y activar el canario `autoApplyCanary` para clientes/PIDs concretos).
