# T587 · Resumen final de entrenamiento (modo captura)

Solo presentación y lectura: no escribe en Firestore, no guarda nada, no dispara progresión. No se tocó el Motor.

## Qué hace
* Aparece **automáticamente** tras el cierre y guardado **exitoso** de la sesión (`submitPostSession`, tras `_saved !== false`). Si cerrar la sesión adelanta la semana o el día (última sesión de la semana), el resumen sigue perteneciendo a la sesión recién guardada (misma semana y día de inicio, mismo atleta y plan).
* Se **reabre desde el historial**: botón `RESUMEN` en la cabecera de cualquier sesión completa o parcial (también de semanas anteriores).
* Encabezado pequeño con el **logo oficial** (el mismo recorte de la imagen oficial que usa el encabezado; no se redibuja), fecha, nombre de la sesión, ejercicios y series completadas.
* Por ejercicio: nombre, series ejecutadas, repeticiones reales, carga real y unidad, RIR real, ICS (promedio de lo registrado), nota breve, y el **descanso prescrito** rotulado "Descanso prescrito" (el Cliente no mide el descanso real; si algún día se mide, se mostrará como real).
* Cargas o repeticiones distintas por serie se muestran compactas (`10·10·8 reps`, `100·100·95 kg`). Unidades distintas nunca se mezclan en un número (`100 kg · 225 lb`).
* **Nada se inventa:** un dato ausente se omite; no se muestran valores solo sugeridos ni la recomendación del Cliente (el servidor es la autoridad); las series express se etiquetan y conservan solo las observaciones realmente dadas.
* **Modo CAPTURA:** pantalla completa por encima de la navegación, sin botones (solo el contador de página si hay varias); tocar la pantalla avanza de página y, al final, sale del modo captura.
* Sesiones largas o con notas largas: se **paginan** midiendo cada bloque en el ancho real (un ejercicio nunca se parte ni se reduce para forzar una pantalla).
* Un solo resumen a la vez; "INICIO" vuelve a la pestaña de inicio.

## Verificación
* `tests/t587-session-recap.test.js` (8 pruebas): construcción, datos ausentes, unidades, formatos, paginación, recolección desde la bitácora (solo series hechas y no autollenadas, sustituciones, descanso, notas por PID y legado, fecha, sin fugas de otra semana/día), contrato de solo lectura y de captura (estático).
* Pruebas existentes de la cadena posterior a la sesión (T125, T126c, T359, T360, QA-R6) siguen pasando.
* **Navegador con el Cliente real** (emuladores, atleta sintético): sesión registrada por la interfaz → el resumen apareció solo al guardar; reapertura desde el historial en otra semana; sesión sintética extensa (14 ejercicios, nota larga, series con cargas distintas, libras, sin carga) a **320×640** (4 páginas, sin desbordes), **390×844** (3 páginas, legible) y **430×932** (2 páginas); doble apertura = un solo overlay; modo captura sin navegación; cierre limpio.
* Aún no probado: reintentos de guardado y cierre concurrente a nivel de interfaz (la guarda `_postSessionSubmitting` existente no se modificó y el resumen es de solo lectura, por lo que no puede duplicar escrituras); captura de pantalla real en un teléfono físico.
