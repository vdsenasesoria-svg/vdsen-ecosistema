# T596 · Registrar entrenamientos sin internet

**Problema (reproducido en la app real, emuladores):** sin conexión, «GUARDAR SERIE» se quedaba en «GUARDANDO…» para siempre. Firestore (con `persistentLocalCache`) guarda la escritura en una cola del dispositivo y la envía al volver internet, pero la promesa de `setDoc()` solo se cumple cuando el **servidor** confirma. La app esperaba esa confirmación para avanzar → sin internet no se podía pasar de la primera serie ni cerrar la sesión. Además, las series se guardaban por una ruta que no dejaba copia en el almacenamiento local del dispositivo.

**Corrección (solo `vdsen-cliente.html`):**
* `_fbWriteOrQueue`: una escritura sin confirmar se considera **aceptada en el dispositivo** (al instante si el aparato indica que no hay conexión; tras 5 s si hay señal pero el servidor no responde). El atleta continúa; el resultado real se sigue atendiendo cuando la promesa se resuelve.
* Insignia fija «⏳ Sin conexión: tu registro está guardado en este dispositivo y se enviará solo al volver internet» mientras haya registros pendientes; no se muestra «✓ GUARDADO» si solo está en el dispositivo.
* Si la escritura pendiente es rechazada después (p. ej. permisos), se avisa con un mensaje visible y el registro se conserva (en `LOGS` y en la copia local) para reintentar.
* Un error inmediato (antes del plazo) sigue cancelando el guardado y revirtiendo la serie, como antes.
* `_doSaveLogs` escribe siempre la copia local (`vdsen_logs_backup`) antes de tocar la red (también cuando se llama directamente desde `completeSet` / cerrar sesión).
* Los avisos al servidor (ejecutor de progresión, consumo de ajustes) esperan la confirmación real.

**Verificación en el navegador real (Firebase cortado y restablecido):** 3 series de fuerza + cardio + cierre de sesión + resumen funcionaron sin conexión; tras volver la conexión, en ≤ 5 s el servidor tenía `done_1_0`, las 3 series y el cardio, la cola quedó en 0 y la insignia se ocultó sin errores; recargar la app sin conexión restauró la sesión, el plan y la bitácora (7 s).

**Pruebas:** `tests/t596-offline-writes.test.js` (5) + sandboxes de t441/t475/t553/t574 y pins de t245/t251 ajustados al nuevo helper. Suite completa: 1612 pasan / 18 fallan = los 18 heredados, sin fallos nuevos.

**No verificado / no cambiado (honesto):**
* El **service worker** (que permite abrir la app sin internet en el celular) no pudo ejercitarse: el panel de navegador de pruebas no permite registrarlo. Revisión de código: precachea el HTML del cliente y todos sus scripts, y cachea en ejecución fuentes y SDK. **Riesgo conocido, no corregido:** el HTML es «red primero» sin tiempo máximo, de modo que con señal muy mala (no cero) la app puede tardar en caer a la copia local; cambiarlo toca el service worker de todos los dispositivos y su manifiesto de release, por lo que requiere decisión propia y prueba en un teléfono real.
* En dispositivos reales `navigator.onLine` puede decir «hay conexión» sin tenerla: en ese caso aplica el plazo de 5 s.
* Edición simultánea desde dos dispositivos (último gana): sin cambio.
