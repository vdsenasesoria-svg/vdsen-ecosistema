# T573 — Bitácora nocturna (sin secretos ni datos de clientes)

Base canónica: `b782f70268e4f18633f542e3abdc12d8733e9d1d` · `main`: `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c`.

## Checkpoint 1 — ~05:50 UTC (2026-10-17)
- Rama `feat/t573-client-visual-premium`.
- Capturas ANTES (390 px) y DESPUÉS (320/390/430) con navegador real contra Firebase staging y cuentas sintéticas: `docs/t573-shots/`.
- Hallazgo visual principal: Inicio mostraba 15 tarjetas idénticas de contexto SRA (una por ejercicio) por encima de la sesión de hoy. Ahora es **un** resumen informativo plegable, debajo de sesión/estadísticas/progreso; las trazas por ejercicio siguen intactas en un `<details>`.
- Capa "UI 3.0" (tokens de marca Lima #B7F400 / Gris / Acero / Detalle, Inter + IBM Plex Mono, superficies redondeadas, navegación inferior con estado activo claro, entradas de serie más grandes, retroalimentación táctil con `prefers-reduced-motion`).
- Auditoría automática por ancho: sin desbordamiento horizontal ni objetivos táctiles < 40 px en las 7 pantallas capturadas.
- AGENTS.md prohíbe claves de cuenta de servicio ⇒ el despliegue hospedado del motor sólo puede usar identidad federada (WIF/OIDC).
