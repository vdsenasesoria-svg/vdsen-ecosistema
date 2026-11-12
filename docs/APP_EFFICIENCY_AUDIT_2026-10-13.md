# VDSEN — Auditoría focal de eficiencia Coach + Cliente

Fecha: 2026-10-13 · Origen: `codex/client-app-next@cbd056f`
Rama de cambios: `perf/coach-client-efficiency-20261013`
Alcance: lectura estática + ajustes acotados; **sin despliegue, sin migración, sin modificación de reglas**.

## Evidencia base

* Coach: `vdsen-coach.html` (1,570,690 bytes en Git tree).
* Cliente: `vdsen-cliente.html` (1,092,946 bytes en Git tree).
* Arquitectura intencional: HTML individual, Firebase SDK CDN; preservarla. **Los tamaños son archivos fuente sin comprimir**, no tiempos de descarga medidos.
* Coach Next congelado como `CORE COMPLETE` el 2026-10-09; pruebas de aceptación documentadas en `docs/COACH_NEXT_FROZEN_BASELINE.md`.
* La lista Coach realiza un `getDocs(clients where coachId)` y luego obtiene un log y, cuando corresponde, un plan por cliente; esos reads se ejecutan **en paralelo** con `Promise.all`. Ya reutiliza esos datos para su priorización y dashboard. No convertirlo en un falso P1.
* En arranque se llama tanto `loadClientList()` como `loadClientsSelect()`, que vuelven a solicitar el mismo conjunto de clientes.
* En Cliente, `_liveUnsubClient` actualiza la nutrición y suplementos y repinta Nutrición con cada snapshot con plan nutricional presente, incluso cuando esa pestaña está oculta; `goTab(2)` ya la repinta al abrirse.
* El sistema ya administra listeners y temporizadores: no crear otro sistema de suscripciones ni tocar la evidencia `LOGS`.

## Cambios de esta rama

1. **Coach**: reutilizar el Promise de la consulta `clients` únicamente mientras está pendiente. Por UID; descartar al resolver o rechazar; posteriores recargas siempre consultan de nuevo. El selector ausente deja de iniciar lecturas innecesarias. No se modifica la lectura paralela de logs/planes, priorización ni dashboard.
2. **Cliente**: si Nutrición está oculta, actualizar el modelo recibido sin reconstruir su DOM. Si es visible, repintar inmediatamente tras actualizar tanto nutrición como suplementos. Navegar a Nutrición ejecuta el render normal. No se modifican logs ni escrituras.

**Ahorro esperado (no medido):** una consulta redundante de clientes menos cuando las solicitudes de arranque se solapan y evitar repintados de Nutrición oculta. El ahorro exacto en Firestore, latencia y CPU es pendiente de medición en entorno reproducible. No prometer porcentajes.

## Gates mínimos para merge

* `node --test tests/app-efficiency-20261013.test.js` con PASS.
* `node tests/t149c-nutrition-supplement-render-order.test.js` PASS.
* `node tests/t294-firestore-listener-lifecycle-audit.test.js` PASS.
* `node tests/t332-performance-listener-read-audit.test.js` PASS.
* `node --test tests/coach-runtime-hardening.test.js` PASS.
* `node scripts/release/baseline.cjs unit` y `node scripts/release/check.cjs` (branch-specific guard puede rechazar rama de feature; **no modificar ni omitir el guard**).
* Prueba navegador/emulador: Coach lista+selector+refresco+logout/login; Cliente cambio nutrición durante pestaña Entrenamiento y mientras Nutrición visible, reentrada, conservación de información; 320/390/430 px.
* Sin cambios de `firestore.rules`, contratos `vdsen-plan-v2`, IDs, firmas de progresión, `NUMERIC_APPLY_ENABLED=false`, producción o rama `main`.

## Próxima auditoría de producto, aún NO implementada

Priorizar por uso real, sin recrear el ecosistema:

1. **Coach**: medir p50/p95 desde login a lista interactiva; número efectivo de document reads (no sólo sitios fuente); latencia al abrir detalle y cargar monitor. Ver si el coste `2N` de logs/planes justifica proyección **sin degradar priorización**. Los cambios de caché deben invalidarse tras altas, cambios de plan y logout.
2. **Cliente**: medir tiempo hasta primera prescripción útil, fluidez al guardar series y después de `onSnapshot`; evaluar catálogo de ejercicios y coste de render con plan grande. No eliminar el re-render de Resumen sin revisar que fija `CURRENT_WEEK = REAL_WEEK` (autoridad actual de semana).
3. **UX**: Coach de operador único: acceso directo a cliente, alertas accionables, generación→revisión→publicación sin pantallas redundantes; Cliente: sesión de hoy, series, descansos, registros y claridad sobre prescrito vs ejecutado. Sin dashboards o badges decorativos.
4. **Assets**: cuantificar transferencia y procesamiento de ambos HTML; diferir sólo recursos secundarios probados, sin romper el formato single-file ni el PR #45 (carga de imágenes Coach, abierto).

**Fuera de alcance:** producción, permisos IAM, reglas nuevas, migraciones, unificación de usuarios, refactor general, farmacia/PEDs, autoaplicación numérica. La seguridad existente sigue obligatoria como integridad y aislamiento de datos del atleta; no se inicia un proyecto de hardening multi-coach.
