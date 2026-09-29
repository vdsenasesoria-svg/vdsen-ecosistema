# Lista de verificación de activación de la auto-aplicación

Generado por `node scripts/generate-activation-docs.cjs` a partir de hechos vivos del repositorio; verificado por `tests/t522-activation-docs.test.js`. `[x]` = cumplido; `[ ]` = pendiente.
Los ítems por candidato se cumplen en tiempo de ejecución para cada candidato (guardia de activación); aquí se marcan como verificados por sus tests.

**Estado: 10 de 15 cumplidos; pendientes bloqueantes: 4. La bandera NO se activa con esta lista; requiere decisión explícita del director.**

- [ ] **Identidades de equipo resueltas para los ejercicios objetivo** — 69 de 71 ejercicios del catálogo (39 de 41 equipos). Sin resolver por evidencia del repositorio: Accesorio de polea (ATTACHMENT_NOT_LOAD_IMPLEMENT), Máquina (GENERIC_LABEL). Mecanismo verificado: t508, t517.
- [ ] **Incrementos de equipo escritos por el Coach** — 0 de 39 equipos con identidad tienen incremento. Mecanismo verificado: t509, t518, t519. **Datos pendientes del Coach.**
- [ ] **Unidades compatibles** — No evaluable sin incrementos escritos; la incompatibilidad se detecta como `UNIT_MISMATCH` (t503, t512, t518).
- [x] **Elegibilidad de evidencia (≥2 exposiciones comparables)** — Por candidato; verificado por el canario y los tests t492/t504/t512.
- [x] **Dirección consistente** — Por candidato; `DIRECTION_CONFLICTING` / `DIRECTION_UNCONFIRMED` (t492, t512).
- [x] **Rama D/E y precedencia C→E resueltas** — **PRODUCT POLICY RESOLVED** (fuente `VDSEN_PRODUCT_POLICY`, no ciencia): D/E → `COACH_REVIEW_REQUIRED` (1A, sin candidato numérico); C primero → REST +30 s y, si persiste en la siguiente exposición comparable, revisión del Coach (2B). Verificado por t523.
- [x] **Política de serie representativa resuelta** — **LAST_WORKING_SET** — fuente `VDSEN_PRODUCT_POLICY` (procedencia `VDSEN_PRODUCT_POLICY_LAST_WORKING_SET`); heurística de producto, no consenso científico. El simulador `docs/REPRESENTATIVE_SET_SIMULATION.md` es solo análisis.
- [x] **Exposición destino exacta y no iniciada** — Por candidato: `TARGET_EXPOSURE_CHANGED`, `TARGET_ALREADY_STARTED` y la guardia de 19 verificaciones (t513).
- [x] **Sin override del Coach** — Por candidato: `COACH_OVERRIDE` / `COACH_KEEP_ORIGINAL` (t493, t512, t513).
- [x] **Seguridad despejada** — Por candidato: `SAFETY_CONFLICT` / `READINESS_VETO` (t492, t512).
- [x] **Canario sintético `READY_BUT_DISABLED`** — Estado del canario en esta generación: READY_BUT_DISABLED (t513, `docs/SHADOW_REPLAY_REPORT.md`).
- [ ] **Validación del runner T478 en Windows (WINDOWS_HARNESS_VALIDATION)** — **NON_BLOCKING_TECHNICAL_PENDING** (registro: PENDING). No bloquea la activación de producto; la validación en Linux sigue siendo obligatoria y pasa. Se valida con `node scripts/record-windows-validation.cjs` en Windows; Linux no lo emula y no se marca PASS.
- [ ] **`NUMERIC_APPLY_ENABLED` cambiado intencionalmente** — Actualmente `false` en los tres módulos. **No se cambia en esta ejecución.**
- [x] **Reversión verificada** — `planReversal` revierte antes de que empiece la exposición destino y se bloquea después (t493, verificado al generar).
- [x] **Auditoría visible para el Coach** — Línea dry-run con clase de vista rápida, cola de equipos y matriz de preparación en el Monitor (t494, t510, t520).

## Bloqueos para activar (resumen)

1. **Datos del Coach:** incrementos reales de equipo (ver `docs/EQUIPMENT_DATA_REQUIRED_NEXT.md` y `docs/EQUIPMENT_ACTIVATION_READINESS.md`). Es el bloqueo operativo principal.
2. **Decisión intencional** de cambiar `NUMERIC_APPLY_ENABLED` (no se cambia en esta ejecución).
3. No bloqueante: validación del runner en Windows (`NON_BLOCKING_TECHNICAL_PENDING`).

Las decisiones D/E, C→E y serie representativa ya NO son bloqueos: están cerradas como política de producto VDSEN (ver `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md`).
