# T576 — Bitácora de ingeniería autónoma (sin secretos ni datos de clientes)

## Checkpoint 1 — 2026-10-17 ~16:45 UTC
Canónica al iniciar: `17216aaab205f8d56c496bc9991ff31a01157688` · `main` `f6596ba5207dc158b8a9b01483cd0fe0ebeb274c` (sin cambios).

### T575 (cerrado, PR #66 fusionada)
| Ítem | Estado |
|---|---|
| OIDC_CONCURRENCY (tokens ausentes/inválidos/expirados/concurrentes) | PASS (17/17, 400 peticiones intercaladas, sin fugas en logs) |
| SHARED_TOKEN_RISK (archivo compartido envenenable) | corregido: verificación RS256+claims, escritura atómica |
| HOSTED_WRITES_IMPLEMENTED | script implementado; fase `on` hospedada **NOT_TESTED** (bloqueo: 403 al escribir variables de Vercel) |
| ZERO_WRITE_NEGATIVE_TESTS (hospedado, interruptores OFF) | PASS 10 / 1 NOT_TESTED (Preview tras el muro de Vercel Authentication) |
| PENDING/APPLIED/CONSUMED/E06/E08/CRON | EMULATOR_PASS · LOCAL_SHIM_PASS (20) · HOSTED NOT_TESTED |
| CLEANUP_VERIFIED | PASS (documentos y usuarios sintéticos verificados ausentes) |
| CI | PASS (Ubuntu) antes y después de la fusión de #66 |

### Hallazgos del Cliente (auditoría con navegador real, staging sintético)
1. **Pérdida de borrador**: carga/reps escritos y no guardados se perdían al cambiar de pestaña y volver (reproducido: `""` tras el cambio). Corregido con un borrador en memoria (identidad exacta por id de input; se descarta al guardar, al vaciar el campo y al cerrar sesión). `scripts/t576-draft-e2e.cjs`: 6/6 en staging real.
2. **Barra "GUARDAR SERIE" fija cubría el campo con el teclado abierto**: medido a 420 px de alto: 23 % del input cubierto → 0 % tras la corrección (`scripts/t576-keyboard-overlap.cjs`, antes/después).
3. **Tráfico Firestore**: navegar entre pestañas = **0** peticiones; 3 listeners en vivo (cliente, plan, logs) + 2 de la fase de espera, todos liberados en `_clearLiveListeners`/logout. Sin lecturas redundantes por navegación (`docs/t576-perf/`).
4. Estados verificados con capturas (`docs/t576-shots/`): sin plan (pantalla "FICHA ENVIADA"), sin conexión (banner), descanso activo, teclado corto. Sin overflow horizontal a 320/390/430.
