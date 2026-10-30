# FASE 4 — Por qué el suite de emulador del export no termina (causa raíz MEDIDA)

Este documento corrige un diagnóstico anterior **incorrecto** que quedó registrado en un commit de
este repositorio. La versión previa atribuía el problema al límite de tuberías del sandbox de
ejecución. **Eso era falso** y la medición lo desmiente.

---

## 1. El diagnóstico anterior era incorrecto

En el commit `1494ff8` se afirmó que `scripts/client-export-emulator.cjs` se bloqueaba porque
`spawnSync(..., { encoding: 'utf8' })` usa stdio por tubería y "este sandbox no puede abrir tuberías
entre procesos".

Dos hechos lo refutan:

1. `tests/release-infrastructure.test.js` tarda ~39 s y **completa correctamente** bajo `node --test`,
   que usa subprocesos con tubería. Las tuberías funcionan.
2. Corriendo `tests/client-export-emulator.cjs` **directamente** (sin el wrapper, sin `spawnSync`), el
   problema aparece igual.

El cuelgue no tenía nada que ver con tuberías.

---

## 2. Lo que realmente ocurre

El suite **PASA**. Corriendo el archivo directamente contra el emulador real + `firestore.rules`:

```
✔ EM.1  coachA exports clientA with the real SDK + rules: complete, valid, correct ids  (5679 ms)
✔ EM.2  coachA -> clientB (owned by coachB) is DENIED by the real rules                  ( 172 ms)
✔ EM.3  coachB -> clientA is DENIED; coachB still exports its own clients                ( 313 ms)
✔ EM.4  missing / incorrect ownership and non-coach identities fail closed               ( 222 ms)
✔ EM.5  same display name: no cross-client leakage in any direction; clientId is
        authoritative                                                                    (1012 ms)
✔ EM.6  real query shapes: only getDoc/getDocs, equality filters on coachId +
        clientId/clientUid, never a name; permitted by the real rules
```

Los tests son **rápidos** (cientos de ms a pocos segundos). El problema es lo que pasa **después**:

```
lineas totales del log: 51.499
lineas 'GrpcConnection ... Listen stream ... error. Code: 2': 51.541
proceso node: CPU 154 s, sigue vivo indefinidamente
```

**El SDK web de Firestore entra en un bucle de reintento de `Listen` que nunca cierra.** Cada
reintento abre un stream nuevo (`stream 0x89ed2f4a`, `0x89ed2f4b`, …) y ninguno se cierra, así que:

- el event loop nunca queda vacío → **el proceso Node nunca sale**;
- se emiten decenas de miles de líneas de log;
- el emulador acaba asfixiado por el volumen.

En CI esto no se ve como un fallo, se ve como un **workflow colgado hasta el timeout**.

---

## 3. Un intento de arreglo que NO funcionó (y por eso se revirtió)

Hipótesis: `deleteApp()` de firebase-js-sdk no termina las conexiones gRPC, así que bastaba con
llamar `terminate(db)` sobre cada instancia antes de borrar las apps.

**Medición del resultado: no sirvió.** Con `terminate()` cableado en el `after()`, el bucle persistió
igual (51.541 líneas de `GrpcConnection`). El cambio se **revirtió** en lugar de dejarlo en el árbol
como si funcionara:

```
terminate en el archivo: False
clientDbs en el archivo: False
```

---

## 3.bis — Aislamiento por operación (medido)

Para no volver a suponer, se ejecutó **una operación por vez** contra el emulador y se contó la tasa
de reintentos de `Listen` durante 6 s después de cada una:

`
A) web SDK: sólo connect, sin operación     listens en 6s = 0
B) web SDK: getDoc                          listens en 6s = 0
C) web SDK: getDocs(query where)            listens en 6s = 0   <- lo que usa el exportador
D) Admin: sólo initialize                   listens en 6s = 0
E) Admin: set                               listens en 6s = 0
F) Admin: get                               listens en 6s = 0
G) Admin: deleteApp                         listens en 6s = 0
H) web SDK: terminate                       listens en 6s = 0
I) web SDK: deleteApp                       listens en 6s = 0
TOTAL de líneas Listen en toda la corrida: 0
`

Conclusión: **ninguna operación básica ni el ciclo de vida de las apps lo provocan por sí solos.**
Se confirmó además que **nadie en el test, los helpers ni los módulos del export usa `onSnapshot`**.
El bucle sólo aparece al correr el archivo completo bajo `node --test` con las diez pruebas, es decir
depende de la **escala** (muchos exports y cientos de documentos) y del runner, no de una API suelta.

## 3.ter — El SEGUNDO intento de arreglo tampoco funcionó (y también se revirtió)

Hipótesis: forzar la salida del proceso desde el `after()`.

`js
test.after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
`

**Medición: tampoco sirvió.** El bucle persistió (52.532 líneas de `GrpcConnection`) y el proceso
siguió vivo. Motivo: `node --test` mantiene sus propios handles, así que la salida programada no
llega a ejecutarse. El cambio se **revirtió** igual que el anterior:

`
terminate     en el archivo: False
clientDbs     en el archivo: False
process.exit  en el archivo: False
git diff HEAD -- tests/client-export-emulator.cjs  ->  sin diferencias
`

**Dos intentos, dos reversiones.** El árbol no contiene ningún arreglo no probado.

## 4. Estado honesto

| Aspecto | Resultado |
|---|---|
| El contrato del export contra reglas reales | **VERIFICADO** — los tests EM.1..EM.6 pasan |
| El proceso termina solo | **NO** — bucle de reintento de `Listen` |
| Arreglo implementado | **NO** — el intento con `terminate()` se revirtió tras medir que no funciona |
| Ejecutable en CI hoy | **NO de forma fiable** — colgaría hasta el timeout |

---

## 5. Qué haría falta (no hecho)

No es un defecto del código del export: es la interacción entre el SDK web de Firestore y el emulador
en este entorno. Opciones reales, ninguna trivial:

1. Fijar `experimentalForceLongPolling` o desactivar el transporte de escucha en el cliente de prueba,
   si el SDK lo permite para este caso.
2. Cerrar explícitamente **todos** los canales gRPC y forzar la salida del proceso con `process.exit()`
   al final del archivo de test (pragmático, pero enmascara fugas futuras).
3. Ejecutar el suite sólo en el entorno de CI Linux, donde el comportamiento del emulador difiere, y
   no en Windows.

Mientras no se elija una, **el resultado correcto que debe reportarse para este suite es NOT RUN**, con
la causa raíz documentada aquí — no un PASS, y no el diagnóstico de tuberías que se registró antes.

---

## 6. Lo que este documento NO afirma

- No afirma que el export tenga un defecto: **no lo tiene**. Sus 6 pruebas contra reglas reales pasan.
- No afirma que el sandbox bloquee el suite: **no lo bloquea**.
- No afirma haber arreglado nada: **el intento se revirtió**.
