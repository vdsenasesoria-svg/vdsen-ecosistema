# E2E del Cliente real contra emuladores (T583) — solo local, fuera del CI

Reproduce la cadena **plan → bitácora → progresión → siguiente exposición** con la UI real del Cliente (`vdsen-cliente.html`) y el manejador real de `/api/autonomous-progression-trigger`, todo contra los emuladores de Firebase (proyecto demo `demo-vdsen-client-e2e`). No contacta ningún proyecto remoto; los datos son sintéticos y las credenciales de prueba van a la carpeta temporal del sistema.

1. Emuladores Auth (9099) + Firestore (8085) con `firestore.rules` del repo.
2. `node scripts/e2e-client-chain/seed.cjs` — un Coach y seis atletas sintéticos (A–F; el E con plan heredado), cada uno con una exposición previa.
3. `node scripts/e2e-client-chain/serve.cjs` — sirve el Cliente (puerto 5199) conectado a los emuladores (en memoria; el archivo no se modifica).
4. En el navegador, inyecta `driver.js` (`/__driver.js`) y usa `__boot(who)`, `__session(...)`: son clics reales sobre los controles del Cliente (campos de carga/reps, botones de RIR y bombeo, "GUARDAR SERIE", "COMPLETAR", modal post-sesión).
5. `state.cjs <A..F>` muestra registros / overlays / progrec persistidos; `capture.cjs <out.json>` genera el fixture que reproduce `tests/t583-real-client-chain-emulator.cjs` en el CI.
