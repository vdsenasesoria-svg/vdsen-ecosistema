# T592 · Auditoría y optimización de la aplicación Cliente

**HEAD inicial (verificado):** `6a9c866` (`codex/client-app-next`, incluye T587, T589 y el PR #103 «T590: validador del plan alineado con cardio», fusionado por otra vía).
**Alcance:** solo `vdsen-cliente.html` y sus pruebas. Sin cambios en Coach, Motor, Generador, Rules, Indexes, IAM, datos reales, flags ni Numeric Apply. Producción no se tocó.

## Método
Reconocimiento (HEAD, historial T587/T589/T590, línea base de 1624 pruebas: 1606 pasan y 18 fallan por causas heredadas de Windows/documentos generados/recuperación de release) → auditoría de código de guardado, listeners, contadores y cardio → **reproducción en la app real** (emuladores Auth + Firestore, atleta sintético con día mixto y día solo cardio) → corrección → pruebas → verificación a 320 / 390 / 430 px.

## Hallazgos y estado
| Id | Sev. | Hallazgo (reproducido) | Estado |
|---|---|---|---|
| H1 | **P1** | **Toque doble en «CONFIRMAR CARDIO» lo confirmaba y lo desmarcaba al instante** (`done` quedaba en `false`). Mismo patrón en calistenia, estación y circuito. | **Corregido** (`_perfBlocked`, ventana de 700 ms por entrada) |
| H2 | **P1** | **Cardio / calistenia / estación / circuito se podían registrar en semanas futuras (vista previa) y pasadas**; fuerza ya lo rechazaba. Se escribía `log_{semana futura}_…` en Firestore. | **Corregido** (mismo guard: «Vista previa» / «Semana pasada») |
| H3 | **P1** | **T589 incumplido en los contadores:** el cardio contaba como «serie» (tablero «series», estado de la sesión en Inicio, texto del cierre parcial). | **Corregido:** `strengthSets` / `cardioDone` / `_dayTotals` / `_progressText`; el cardio se informa aparte («1/3 series · 1/1 cardio»; día solo cardio «0/1 cardio»); la barra de progreso sigue contando toda la sesión. `completedSets` conserva su significado histórico (los flujos de sesión dependen de él). |
| H4 | P2 | Regresión de rendimiento introducida por T589: `_getExType` escaneaba el catálogo completo en cada llamada (se invoca por cada serie en las estadísticas semanales). | **Corregido:** índice normalizado nombre→patrón (se reconstruye si cambia el catálogo o tras 2 s); 30 000 clasificaciones con catálogo de 600 fichas en <1,5 s (prueba) |
| H5 | P2 | Áreas táctiles < 44 px: botones «Reabrir» (20 px) y «Ver Resumen» (22 px) de la franja de sesión terminada, «CERRAR SESIÓN» (38 px) y los 3 interruptores del Perfil (30 px). | **Corregido** (44 px; interruptores con área de toque ampliada sin cambiar su aspecto, comprobado con `elementFromPoint`) |

## Verificado sin hallazgo (en la app real)
Recuperación tras cerrar sesión y volver a entrar (series, cardio y marcador `done_` íntegros; sin claves duplicadas en Firestore); resumen final y botón RESUMEN con valores ejecutados (fuerza por serie, cardio con duración + RPE/calidad); sesión incompleta = «EN CURSO / PARCIAL», nunca «completada»; sesión solo cardio se completa; día mixto; `inputmode` numérico en los campos de fuerza y cardio; sin desbordes horizontales en las 5 pestañas a 320 / 390 / 430 px; progresión: el cardio no genera recomendación en `progrec` (T589 sigue operativo). Revisión de código: guardado con `mergeFields`, listeners con baja explícita al cerrar sesión, honestidad offline al cerrar sesión (`navigator.onLine`).

## Pruebas
* Nueva `tests/t592-client-audit.test.js` (6): guard de semana y toque doble, 4 confirmaciones protegidas, contadores, pantallas, rendimiento del índice, áreas táctiles.
* Ajustes de sandbox en `t306/t308/t309/t314/t323/t333` (nuevas funciones auxiliares; `t309` ahora fija `strengthDone/strengthTotal`) y `t589` (índice del catálogo). El texto del cierre parcial para días de fuerza es idéntico al anterior (los tests lo fijan literalmente).
* Suite completa local: **1606 pasan / 18 fallan = exactamente los 18 heredados** (diferencia de nombres contra la línea base: ninguna). Sin regresiones nuevas.
* Navegador real: ver arriba; datos sintéticos de emulador, ningún dato real.

## Riesgos residuales / no resuelto (no es éxito total)
1. **Pérdida/recuperación sin conexión no ejercitada en el navegador** (solo revisión de código): no se pudo simular una caída de red sin invalidar el emulador.
2. **Edición simultánea desde dos dispositivos:** `_doSaveLogs` reemplaza el mapa `entries` completo; el último en escribir gana, y una actualización remota re-renderiza la pantalla (puede descartar lo escrito y no guardado en un campo). Diseño existente; arreglarlo requiere cambiar el modelo de escritura (fuera de alcance).
3. Lecturas de Firestore al iniciar y consumo de memoria **no medidos** con instrumentos; solo revisión de listeners (3 `onSnapshot` con baja).
4. Campos del Check-in miden 42–43 px (1–2 px bajo el objetivo de 44): no se tocó para no alterar formularios que funcionan.
5. El editor del Coach con cardio (T589) sigue sin verificación en navegador real.
6. T590/PR #103 llegó a la rama canónica sin pasar por esta sesión; se auditó solo en lo que toca al Cliente.
