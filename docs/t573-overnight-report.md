# T573 — Bitácora nocturna (sin secretos ni datos de clientes)

Base canónica: `b782f70268e4f18633f542e3abdc12d8733e9d1d` · `main`: `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c`.

## Checkpoint 1 — ~05:50 UTC (2026-10-17)
- Rama `feat/t573-client-visual-premium`.
- Capturas ANTES (390 px) y DESPUÉS (320/390/430) con navegador real contra Firebase staging y cuentas sintéticas: `docs/t573-shots/`.
- Hallazgo visual principal: Inicio mostraba 15 tarjetas idénticas de contexto SRA (una por ejercicio) por encima de la sesión de hoy. Ahora es **un** resumen informativo plegable, debajo de sesión/estadísticas/progreso; las trazas por ejercicio siguen intactas en un `<details>`.
- Capa "UI 3.0" (tokens de marca Lima #B7F400 / Gris / Acero / Detalle, Inter + IBM Plex Mono, superficies redondeadas, navegación inferior con estado activo claro, entradas de serie más grandes, retroalimentación táctil con `prefers-reduced-motion`).
- Auditoría automática por ancho: sin desbordamiento horizontal ni objetivos táctiles < 40 px en las 7 pantallas capturadas.
- AGENTS.md prohíbe claves de cuenta de servicio ⇒ el despliegue hospedado del motor sólo puede usar identidad federada (WIF/OIDC).

## Checkpoint 2 — ~06:45 UTC
- PR #63 (visual) abierta; PR #64 (docs hospedado) abierta.
- Rendimiento medido (Playwright, mismo equipo/sesión, mediana de 7, `scripts/t573-perf-measure.cjs`, datos en `docs/t573-perf/`): cambio de pestaña a Inicio **46,7 ms → 15,7 ms** (los dos widgets más pesados bajo el pliegue, ~27 ms, se construyen tras el primer pintado en idle; mismo HTML y datos). Resto de pestañas sin diferencias fuera del ruido (±1 ms). Es una medición de laboratorio, no un porcentaje de campo.
- Hospedado en Vercel: BLOQUEADO (403 al crear proyecto; ver `docs/T573_HOSTED_STAGING.md`). Evidencia hospedada: Preview sin credenciales → 503 `RUNTIME_NOT_CONFIGURED`.
- Modo claro revisado (barra de progreso corregida).
