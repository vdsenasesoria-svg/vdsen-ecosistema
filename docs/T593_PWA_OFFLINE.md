# T593 · PWA / service worker y apertura offline (Chromium real)

**Herramienta:** `scripts/e2e-client-chain/sw-offline-e2e.cjs` (solo local, datos sintéticos, Auth + Firestore Emulator). Lanza **Google Chrome real** (headless=new) y lo maneja por el protocolo DevTools con el WebSocket integrado de Node. El servidor de la app es un proceso hijo: al matarlo, los recursos estáticos quedan **realmente inalcanzables** (solo el service worker puede responder); la emulación de red de la página bloquea además la conexión a Firestore (la escritura queda retenida en la cola del dispositivo).

| # | Comprobación | Resultado |
|---|---|---|
| 1 | El service worker se registra y queda `activated` (`scope /`) | PASS |
| 2 | La página queda controlada por el SW | PASS |
| 3 | Caché `vdsen-v13` con 14 entradas (cáscara de la app: HTML, manifest, assets, módulos) | PASS |
| 4 | Inicio de sesión del atleta sintético en línea | PASS |
| 5 | En línea: serie 1 guardada (`log_1_0_0_s0`) | PASS |
| 6 | **Sin red**: reabrir la app desde la caché del SW (título VDSEN) | PASS |
| 7 | **Sin red**: la app arranca con la sesión guardada (persistencia de Auth y de Firestore) | PASS |
| 8 | **Sin red**: los scripts cacheados responden (servidos por el SW) | PASS |
| 9 | **Sin red**: el plan se dibuja desde la caché del dispositivo | PASS |
| 10 | **Sin red**: se registra una serie (queda retenida: `log_1_0_0_s1`) | PASS |
| 11 | Tras reconectar: las dos series están en Firestore **una vez cada una** con el mismo PID | PASS |
| 12 | Sin escrituras pendientes ni insignia de sincronización tras reconectar | PASS |

**Hallazgo de la propia prueba:** el arnés local no servía `/cliente` (la reescritura de producción), y el `addAll` de precarga del SW fallaba ⇒ el SW no se instalaba. Producción sí responde 200 en todas las URLs precacheadas (comprobado); el arnés ya sirve `/cliente`.

**Limitación honesta:** es Chromium de escritorio con red emulada, no Brave en un teléfono físico. El panel de navegador integrado de Claude no puede registrar service workers. **NO VERIFICADO** en dispositivo real: tienda de caché con poco espacio, barras dinámicas, ciclo de vida del SW en Android. Prueba breve para el teléfono: `docs/T594_PILOT_PLAN.md`, sección 5.
