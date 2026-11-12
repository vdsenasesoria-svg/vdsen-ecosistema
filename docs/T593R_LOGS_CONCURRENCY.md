# T593-R · Concurrencia de logs entre dispositivos (P1 de integridad)

**Estado:** defecto REPRODUCIDO con la app real y corregido. Solo `vdsen-cliente.html`, pruebas y la herramienta E2E local. Sin Rules, índices, IAM, Motor, Numeric Apply ni producción.

## 1 · El defecto (reproducido)
`_doSaveLogs` escribía `setDoc(..., { mergeFields: ['entries', ...] })`: cada guardado **reemplazaba el mapa completo** `entries` (y `exerciseUnits` / `exerciseHistory`) con la copia de ese dispositivo. Un dispositivo sin conexión o desactualizado borraba al reconectarse lo que otro ya había guardado.

Reproducción (dos orígenes = dos dispositivos del mismo atleta sintético, Auth + Firestore Emulator con las reglas del repo, UI real del Cliente, red de Firestore apagada con `window.__net.off()`):

| Paso | Resultado antes de la corrección |
|---|---|
| D2 sin conexión | — |
| D1 guarda `log_2_0_0_s1` (confirmado por el servidor) | servidor: `…_s0`, `…_s1` |
| D2 guarda `log_2_0_1_s1` sin conexión y se reconecta | servidor: `log_2_0_0_s0`, `log_2_0_1_s0`, `log_2_0_1_s1` — **`log_2_0_0_s1` desaparece** |

## 2 · Política de resolución de conflictos (explícita)
Un guardado escribe **solo lo que ese dispositivo cambió**, como rutas de campo (`entries.<clave>`, `exerciseUnits.<clave>`, `exerciseHistory.<clave>`), y borra **solo** lo que borró a sabiendas. Nunca toca el resto del mapa ni los campos que escribe el servidor (`progressionApplications`, `summary`, overlays, recibos).

* **Línea base** (último estado conocido del servidor) distingue «cambiado/nuevo» de «sin cambios» y «borrado aquí» de «nunca visto aquí». La línea base solo avanza con lo realmente enviado y **cuando el servidor lo confirma** (una escritura retenida sin conexión se reenvía, de forma idempotente, hasta confirmarse).
* **Entradas independientes** (series distintas): se preservan siempre, en cualquier orden y con o sin conexión.
* **La misma entrada editada en dos dispositivos:** gana el `ts` más reciente; la perdedora se guarda en un diario local (`vdsen_log_conflicts`, se borra al cerrar sesión) y, si la perdedora era la local, se avisa al atleta. La misma escritura devuelta por el servidor (mismo `ts`) no es conflicto. Las escrituras que la cola offline reenvía al reconectarse se aplican por orden de llegada (gana la última **solo para esa entrada**, nunca para sus vecinas).
* **Borrados:** se propagan; un dispositivo desactualizado no los resucita al guardar otras entradas; una edición nueva posterior a un borrado remoto gana.
* **Cambio de plan:** la línea base es el estado antiguo ⇒ las entradas del plan anterior se eliminan de `logs/{uid}` (sin evidencia cruzada entre planes) y el mesociclo antiguo conserva su historia.
* **Semana:** un dispositivo desactualizado nunca retrocede `currentWeek`.
* **Primer guardado de una sesión con línea base desconocida** (copia local restaurada) o con los dos documentos (raíz y espejo por plan) divergentes: escribe todas las claves locales como fusión, **sin borrar nada** (también cura un espejo que perdió escrituras).
* El oyente en vivo y el refresco al volver a primer plano **fusionan** la copia remota bajo los cambios locales pendientes (antes la reemplazaban entera cuando no había guardado pendiente).

## 3 · Pruebas
* `tests/t593r-logs-concurrency.test.js` (11): las funciones reales del Cliente en un vm contra un Firestore en memoria con fusión por rutas de campo y cola offline por dispositivo — series distintas, **el defecto reproducido**, misma serie (ts, diario, eco), reconexión con escrituras pendientes, edición/borrado, cambio de plan, doble toque/reintentos, recarga, local vs servidor, unidades/historial, recuperación y ausencia de escrituras de mapa completo.
* Reapuntadas sin debilitar (la garantía que fijaban se conserva o se refuerza): t245, t251, t475, t477, t441, t553.U10, t574, t596, t130 (clave `vdsen_log_conflicts` clasificada y limpiada al cerrar sesión). Ayudante `tests/helpers/client-log-merge.js`.
* Navegador real tras la corrección (atleta sintético B): D1 en línea guarda `…_0_s0/_s1`; D2 sin conexión guarda `…_1_s0/_s1` y se reconecta ⇒ **las cuatro entradas persisten**, sin conflictos, y D1 muestra las series de D2 por el oyente.
* Suite unitaria completa: 1684 pasan / 18 fallan = los mismos 18 nombres heredados.

## 4 · Residuales
* La misma entrada editada sin conexión en dos dispositivos se resuelve por orden de llegada al reconectar (el SDK reenvía la cola sin posibilidad de comparar); en línea se decide por `ts`. No hay reloj común: `ts` es el del dispositivo.
* La interfaz permite volver a editar una serie ya completada solo mediante el flujo existente de «editar»; no se probó el caso de edición simultánea en navegador (cubierto en vm).
* Un dispositivo que se queda mucho tiempo desactualizado no ve los cambios ajenos hasta recibir un snapshot (como antes), pero ya no los destruye.
