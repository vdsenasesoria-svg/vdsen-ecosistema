# E2E del Cliente real contra emuladores (T583) — solo local, fuera del CI

Reproduce la cadena **plan → bitácora → progresión → siguiente exposición** con la UI real del Cliente (`vdsen-cliente.html`) y el manejador real de `/api/autonomous-progression-trigger`, todo contra los emuladores de Firebase (proyecto demo `demo-vdsen-client-e2e`). No contacta ningún proyecto remoto; los datos son sintéticos y las credenciales de prueba van a la carpeta temporal del sistema.

1. Emuladores Auth (9099) + Firestore (8085) con `firestore.rules` del repo.
2. `node scripts/e2e-client-chain/seed.cjs [worktree] [A,B,...]` — un Coach y N atletas sintéticos (A–F; el E con plan heredado), cada uno con una exposición previa.
3. `node scripts/e2e-client-chain/serve.cjs` — sirve el Cliente (puerto 5199) conectado a los emuladores (en memoria; el archivo no se modifica).
4. En el navegador, inyecta `driver.js` (`/__driver.js`) y usa `__boot(who)`, `__session(...)`: son clics reales sobre los controles del Cliente (campos de carga/reps, botones de RIR y bombeo, "GUARDAR SERIE", "COMPLETAR", modal post-sesión).
5. `state.cjs <A..F>` muestra registros / overlays / progrec persistidos; `capture.cjs <out.json>` genera el fixture que reproduce `tests/t583-real-client-chain-emulator.cjs` en el CI.

Variables del servidor (solo para pruebas locales): `E2E_ENABLED=0` deja el ejecutor DESARMADO (202, cero escrituras); `E2E_NUMERIC=0` solo materializa (PENDING), nunca aplica. Por defecto ambos activos (es un emulador, nunca producción).

## T595-B — latencia real de «Guardar serie» y runtime móvil

- `node scripts/e2e-client-chain/t594-mobile-runtime-e2e.cjs` (12 controles: objetivo efectivo antes de los campos, CTA en 320/360/390/430 y horizontal, sin desbordamiento horizontal en cada pestaña **a cada ancho**, control negativo del `position:sticky` histórico, SW versionado, 3 guardados reales sin duplicados).
- `node scripts/e2e-client-chain/save-latency-e2e.cjs [--root <checkout>] [--reps 5] [--out r.json]` — línea de tiempo por toque (botón ocupado, inicio/resolución de la escritura mesociclo y raíz, badge «✓ GUARDADO» / «GUARDADO LOCAL» / pendiente / error) en Chrome real contra emuladores, con inyección de latencia/fallo en `serve.cjs` (`E2E_COUNT_FS=1`, `window.__fsInject`). `--root` mide otro checkout (con `node_modules`) con los MISMOS escenarios. Un Chrome nuevo por arranque (un navegador compartido retrasaba 2–5 s las primeras escrituras del siguiente arranque).
- Los números describen el pipeline del Cliente con acks inyectados contra un emulador de ~0 ms: no son latencia de producción ni de un teléfono.
- Antes de repetir: cierra Chrome/servidores previos en los puertos 5199/9334 (un servidor huérfano produce «no current set card»).
