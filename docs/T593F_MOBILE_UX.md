# T593-FINAL · Issue #115 — «Guardar serie» superpuesto en móvil

**Alcance:** solo `vdsen-cliente.html`, pruebas, herramienta E2E local y este documento. Sin cambios de persistencia (el guardado por entrada del PR #114 queda intacto), sin Firestore, Motor, Rules, índices ni IAM.

## 1 · Causa (reproducida)
`.workout-set-current .set-actions` era `position:sticky; bottom:0; z-index:4` con márgenes negativos y un degradado. El botón está al final de la tarjeta, pero un sticky se pega al borde inferior del **contenedor de scroll** (`#tabEntr`): en una tarjeta más alta que la pantalla (360×740: 579 px de tarjeta, RIR/ICS/pump bajo el pliegue) el botón **flotaba sobre CARGA / REPS** mientras RIR, calidad (ICS) y pump seguían debajo. Es exactamente lo que muestra la grabación de Brave Android. Solo en alturas ≤ 560 px (teclado) una regla lo volvía estático.

Capturas 360×740 (mismo scroll; «antes» = regla antigua reinyectada): `docs/issue-115/before-360x740.jpg` · `docs/issue-115/after-360x740.jpg`.

## 2 · Corrección
* El botón y su contenedor van **en el flujo normal de la tarjeta, después de todos los campos** (carga/reps, RIR, ICS, pump): `position:static`, sin márgenes negativos, sin `z-index`, `margin-top:16px`.
* Unidades de viewport: los modales con `max-height` en `vh` (hoja de ejercicio, modales de 85 vh y 72 vh) ganan el equivalente `dvh` (con `vh` como respaldo) para seguir las barras variables del navegador; el contenedor raíz ya usaba `100dvh`.
* Sin cambios de marca, tipografía, tamaño táctil (`min-height` 48–64 px) ni de la semántica de `completeSet` / doble toque / T596.

## 3 · Verificación (navegador real, atleta sintético, Auth + Firestore Emulator)
Auditoría geométrica `scripts/e2e-client-chain/mobile-audit.js` (cajas delimitadoras a 5 posiciones de scroll: el botón no intersecta ningún campo, ni la navegación inferior ni la cabecera, está debajo del último campo, `position:static`, ≥ 44 px; la parte pintada se recorta al contenedor):

| Viewport | Resultado |
|---|---|
| 320×640 | PASS (botón 48 px) |
| 360×740 | PASS |
| 360×780 | PASS |
| 390×844 | PASS |
| 430×932 | PASS |
| 740×360 (horizontal) | PASS |
| 360×320 (altura con teclado abierto) | PASS |
| **Control negativo** (regla antigua reinyectada, 360×740) | **FALLA** (4–5 campos intersectados en 3 de 5 posiciones de scroll) |

Además: las 5 pestañas del Cliente a 320 px sin ningún elemento recortado por la derecha; tarjeta de cardio y modal post-sesión a 320 px sin recortes (el modal ocupa el viewport y se desplaza, botón de 66 px); `documentElement.scrollWidth <= innerWidth` en todos (**no** se usó solo esa condición). Guardar 3 series desde la UI real: persisten `log_1_0_0_s0..s2` con `prescriptionExerciseId` y sin duplicados.

Nota de método: con el panel del navegador oculto, la animación de entrada de la pestaña puede quedarse a medias (traslación de 5 px); la auditoría termina las animaciones antes de medir.

## 4 · Pruebas
* `tests/t593f-mobile-cta-layout.test.js` (5): CSS entregado — contenedor del botón nunca sticky/fixed/absolute, sin márgenes negativos/offsets/z-index, objetivo táctil ≥ 44 px, unidades `dvh`, semántica de guardado y persistencia por entrada intactas. **Falla (3 de 5) sobre el CSS anterior.**
* Actualizadas (contrato cambiado a propósito, mismo objetivo): `T566-8` (el CTA ya no es sticky; sigue siendo alcanzable por el flujo + scroll-into-view de T566) y `T576.5` (el botón es estático a toda altura, la regla de baja altura solo ajusta el padding).
* Suite unitaria completa: 1688 pasan; los 18 fallos heredados de Windows/CRLF son los mismos (17 CRLF + `T571-1e`); `CE.36` (temporización) falla bajo la carga de la corrida paralela y pasa sola.

## 5 · Residuales / no verificado
* Teclado virtual **real** y barras dinámicas de Brave Android: no reproducibles en el panel (se simuló solo la altura con teclado). Prueba breve para el teléfono físico en `docs/T594_PILOT_PLAN.md`.
* No se tocó ninguna otra pantalla; la auditoría de recortes no encontró defectos adicionales a 320 px.

## 6 · Revisión de la grabación real (Brave Android, Preview `9774bd8`, 22/oct/2026, 17 s)
Método: 30 fotogramas equiespaciados del vídeo (extraídos con el Chrome local) revisados uno a uno.

**Hallazgo A (corregido en este PR): la pestaña de entrenamiento se desplazaba de lado.** A partir de la mitad del vídeo todo el contenido aparece desplazado ~20 px a la izquierda (borde de las tarjetas pegado al margen izquierdo, hueco a la derecha). Causa medida: `#tabEntr` no tiene relleno horizontal y la tira de ejercicios (`.xnav`) usaba `margin:14px -14px 0`, así que sobresalía 14 px por cada lado; `#tabEntr` (`overflow-x:auto`) pasaba a tener `scrollWidth 372 > clientWidth 358` a 360 px. Mi auditoría anterior solo medía `document.scrollWidth` y no lo detectó (el desbordamiento estaba **dentro** del contenedor de scroll). Corrección: la tira ya no tiene margen negativo y `#tabEntr` solo hace scroll vertical. La auditoría `__auditScrollers()` comprueba ahora **todos** los contenedores de scroll: PASS en 320, 360, 390 y 430 px en las 5 pestañas; el control negativo (CSS anterior) falla con exactamente `#tabEntr` +14 px y culpable `DIV.xnav`.

**Hallazgo B (NO resuelto, requiere repetir la prueba): el botón «Guardar serie» parece seguir superpuesto en el teléfono.** En los fotogramas a 6,0 s, 7,2 s y 8,3 s el botón verde permanece en la misma posición de pantalla (y≈737–805 px de 1053) mientras el contenido se desplaza por debajo: a 6,0 s tapa las últimas líneas de la ayuda de ICS y a 7,2 s se sitúa justo bajo REPS, encima de «−2,5/+2,5» y RIR. Eso es el comportamiento antiguo (sticky). Sin embargo el HTML que sirve ese Preview es **idéntico byte a byte** al del commit (`position:static`, comprobado) y en Chrome el botón queda estático a 320–430 px. Hipótesis no probadas: una versión anterior servida desde caché del navegador/service worker en ese teléfono, o una URL distinta del Preview. **Siguiente paso:** repetir en una pestaña privada de Brave con la URL del Preview del commit de este PR y anotar la URL exacta; el vídeo mostraba además la cuenta real del atleta, no una de prueba.
