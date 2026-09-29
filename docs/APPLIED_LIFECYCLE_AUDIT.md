# Auditoría del ciclo de vida PENDING → APPLIED → CONSUMED (T527)

Estado: **no implementado a propósito**. La bandera `NUMERIC_APPLY_ENABLED=false` mantiene todo el ciclo inalcanzable. Verificado por `tests/t527-lifecycle-final-audit.test.js`.

## Qué existe hoy

| Pieza | Estado |
|---|---|
| Estados de registro shadow | `PENDING`, `REJECTED`, `STALE` (sin `APPLIED`) |
| Overlay de próxima exposición | Solo se planifica (`status: 'PLANNED'`, `reversibleUntil: 'TARGET_EXPOSURE_START'`); se escribe en un único `tx.set` que rechaza con la bandera apagada |
| Reversión | `planReversal` (dry-run): revierte solo antes de que empiece la exposición destino |
| Alcance de canario | `autoApplyCanary` (T526), solo dry-run, deshabilitado por defecto |
| Cliente | **No lee** `nextExposureOverlays`; la prescripción del atleta nunca cambia por un overlay |

## Delta exacto para activar (no implementado)

1. **APPLIED**: transición de registro `PENDING → APPLIED` dentro de la MISMA transacción que escribe el overlay (hoy el registro queda `PENDING`); requiere ampliar `STATES` y la máquina de transiciones del shadow.
2. **Lectura en el cliente**: `vdsen-cliente.html` debe resolver el overlay por `(PID, semana, día)` y mostrar la prescripción efectiva con procedencia; hoy no existe ese lector.
3. **CONSUMED**: marcar el overlay `CONSUMED` al iniciar la exposición destino (primer set registrado), guardando el valor realmente mostrado; sin esto el overlay puede reaplicarse.
4. **OVERRIDDEN**: cuando el Coach decide sobre el PID después del cálculo, el overlay pasa a `OVERRIDDEN` (hoy solo se bloquea la planificación con `COACH_OVERRIDE`).
5. **REVERTED**: escritura de reversión transaccional antes del inicio del destino (hoy solo `planReversal` dry-run).
6. **STALE**: cambio de plan/exposición destino tras aplicar → overlay `STALE` y el cliente vuelve a la prescripción original.
7. Reglas de seguridad ya presentes y reutilizables: guardia de 19 verificaciones, `expectedRevision`, `isCurrent`, snapshot de equipo en el overlay.

Nada de lo anterior se implementa mientras existan bloqueos de datos: hoy 0 incrementos reales de equipo configurados.
