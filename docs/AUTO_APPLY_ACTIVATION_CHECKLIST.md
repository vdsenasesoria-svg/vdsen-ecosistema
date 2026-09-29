# Lista de verificación de activación de la auto-aplicación

Generado por `node scripts/generate-activation-docs.cjs` a partir de hechos vivos del repositorio; verificado por `tests/t522-activation-docs.test.js`. `[x]` = cumplido; `[ ]` = pendiente.
Los ítems por candidato se cumplen en tiempo de ejecución para cada candidato (guardia de activación); aquí se marcan como verificados por sus tests.

**Estado: 8 de 15 cumplidos. La bandera NO se activa con esta lista; requiere decisión explícita del director.**

- [ ] **Identidades de equipo resueltas para los ejercicios objetivo** — 69 de 71 ejercicios del catálogo (39 de 41 equipos). Sin resolver por evidencia del repositorio: Accesorio de polea (ATTACHMENT_NOT_LOAD_IMPLEMENT), Máquina (GENERIC_LABEL). Mecanismo verificado: t508, t517.
- [ ] **Incrementos de equipo escritos por el Coach** — 0 de 39 equipos con identidad tienen incremento. Mecanismo verificado: t509, t518, t519. **Datos pendientes del Coach.**
- [ ] **Unidades compatibles** — No evaluable sin incrementos escritos; la incompatibilidad se detecta como `UNIT_MISMATCH` (t503, t512, t518).
- [x] **Elegibilidad de evidencia (≥2 exposiciones comparables)** — Por candidato; verificado por el canario y los tests t492/t504/t512.
- [x] **Dirección consistente** — Por candidato; `DIRECTION_CONFLICTING` / `DIRECTION_UNCONFIRMED` (t492, t512).
- [ ] **Rama de ciencia resuelta (D/E; precedencia C/E)** — Sin resolver: `RULE_D_E_ALTERNATIVE_NOT_DEFINED`, `RULE_C_E_PRECEDENCE_NOT_DEFINED`. Ver `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md`.
- [ ] **Política de serie representativa resuelta** — Sin resolver: `REPRESENTATIVE_SET_NOT_DEFINED` (hoy última serie, supuesto provisional). Ver `docs/REPRESENTATIVE_SET_SIMULATION.md`.
- [x] **Exposición destino exacta y no iniciada** — Por candidato: `TARGET_EXPOSURE_CHANGED`, `TARGET_ALREADY_STARTED` y la guardia de 18 verificaciones (t513).
- [x] **Sin override del Coach** — Por candidato: `COACH_OVERRIDE` / `COACH_KEEP_ORIGINAL` (t493, t512, t513).
- [x] **Seguridad despejada** — Por candidato: `SAFETY_CONFLICT` / `READINESS_VETO` (t492, t512).
- [x] **Canario sintético `READY_BUT_DISABLED`** — Estado del canario en esta generación: READY_BUT_DISABLED (t513, `docs/SHADOW_REPLAY_REPORT.md`).
- [ ] **Runner T478 validado en Windows (o exención explícita)** — Estado registrado: **PENDING**. Se valida con `node scripts/record-windows-validation.cjs` en Windows; Linux no lo emula.
- [ ] **`NUMERIC_APPLY_ENABLED` cambiado intencionalmente** — Actualmente `false` en los tres módulos. **No se cambia en esta ejecución.**
- [x] **Reversión verificada** — `planReversal` revierte antes de que empiece la exposición destino y se bloquea después (t493, verificado al generar).
- [x] **Auditoría visible para el Coach** — Línea dry-run con clase de vista rápida, cola de equipos y matriz de preparación en el Monitor (t494, t510, t520).

## Bloqueos para activar (resumen)

1. Datos del Coach: incrementos reales de equipo (ver `docs/EQUIPMENT_ACTIVATION_READINESS.md`).
2. Decisiones del director: D/E, C/E y serie representativa (ver `docs/PROGRESSION_PRODUCT_DECISIONS_PENDING.md`).
3. Validación del runner en Windows (o exención explícita).
