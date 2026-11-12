# T594 · Plan del piloto controlado (preparación; NO activado)

Objetivo: validar con uso real la experiencia móvil y la integridad de datos del Cliente ya publicado. **No es una reconstrucción.** No se inicia con atletas reales hasta que los criterios GO de la sección 6 estén cumplidos y el propietario lo autorice.

Entorno de ensayo previo (sintético): `scripts/e2e-client-chain` (Auth + Firestore Emulator, `serve.cjs`, `driver.js`, `mobile-audit.js`, `window.__net.off()/on()` para simular offline, `E2E_NUMERIC=0` = el trigger real solo materializa). Atletas sintéticos con plan de fuerza, de cardio y mixto.

## 1 · Matriz de aceptación
| ID | Escenario | Dispositivo | Evidencia | Estado previo (sintético) |
|---|---|---|---|---|
| F1 | Registrar 3 series de fuerza (carga, reps, RIR, ICS, pump) con el botón dentro de la tarjeta | Brave Android 1 | captura + claves `log_*` con PID en Firestore | PASS (emulador) |
| F2 | «Guardar serie» nunca tapa RIR/ICS/pump/carga/reps al desplazarse | teléfono físico | grabación corta | **PASS (grabación Brave Android aportada para T593)**; PASS 7 viewports (panel) |
| F3 | Editar / corregir una serie y volver a guardar | 1 | misma clave, sin duplicado | PASS (vm) |
| C1 | Sesión solo cardio: duración + RPE o calidad; sin series/reps/carga | 1 | `log_*` cardio, resumen, Expediente TXT | PASS (emulador) |
| C2 | Día mixto fuerza + cardio | 1 | cardio fuera del volumen de fuerza | PASS (unit + emulador) |
| N1 | Registrar una serie sin conexión, cerrar y reabrir la app, reconectar | 1 | `__net`/modo avión; 1 documento, 0 duplicados | PASS (emulador, sin SW) — **SW real NO VERIFICADO** |
| N2 | Cola offline con varias series y reconexión | 1 | todas las claves, orden | PASS (vm + emulador) |
| D1 | Dos dispositivos, ejercicios distintos, en línea | 1 + 2 | ambos conjuntos; convergencia | PASS (emulador, PR #114) |
| D2 | Dos dispositivos, uno sin conexión mientras el otro guarda | 1 + 2 | unión sin pérdidas | PASS (emulador, PR #114) |
| D3 | Misma serie editada en ambos | 1 + 2 | gana `ts` más reciente; diario local | PASS (vm) |
| M1 | Cierre de sesión → post-sesión → decisión del Motor (Numeric Apply apagado) | 1 | registro `MATERIALIZED`, sin overlay | PASS (emulador) |
| M2 | La decisión se ve en el monitor del Coach | Coach | captura | NO VERIFICADO hoy |
| P1 | Cambio de plan por el Coach durante la sesión | 1 | semana 1 limpia; plan anterior en su mesociclo | PASS (vm) |
| U1 | 320/360/390/430 px, vertical y horizontal, teclado abierto | físico | sin solapes ni recortes | PASS (panel); teclado real NO VERIFICADO |

## 2 · Escenarios de fuerza y cardio
Plan sintético de 2 días: D1 «Empuje + cardio» (press 3×10 RIR2 + cinta zona 2 30 min), D2 «Solo cardio» (bicicleta intervalos 25 min). Registrar D1 completo, D2 solo cardio, y repetir una semana siguiente.

## 3 · Conectividad
Con el panel de red del teléfono (modo avión): abrir conectado → registrar serie → avión → registrar otra → cerrar/reabrir → reconectar. Esperado: ambas series en Firestore tras reconectar, una sola vez, con el mismo PID; insignia de «pendiente» mientras no hay confirmación.

## 4 · Dos dispositivos
Mismo atleta de prueba en dos teléfonos (o teléfono + navegador): D1/D2/D3 de la matriz. Comparar el documento `logs/{uid}/mesos/{planId}` con la intención de cada dispositivo.

## 5 · Prueba breve para Brave Android físico (≈ 10 min)
1. Abrir `/cliente` con una cuenta de prueba autorizada (conectado) y entrar en Entrenamiento.
2. Desplazar lentamente la tarjeta de SERIE 1 de arriba abajo: **el botón verde debe quedar siempre debajo de PUMP/ICS y nunca encima de otros campos**. Grabar pantalla.
3. Completar 3 series; cambiar a cardio y registrar duración + RPE.
4. Activar modo avión → registrar una serie → cerrar la app (deslizar) → reabrir (debe cargar) → desactivar avión → comprobar que la serie aparece en el Coach / Firestore una sola vez.
5. Girar a horizontal y abrir el teclado en CARGA: el campo no queda tapado por cabecera ni navegación.
6. Anotar: modelo, versión de Brave/Android, resultado de cada paso y capturas.

## 6 · Checklist y criterios GO / NO-GO
**GO** solo si todo se cumple: (a) el release del Issue #115 está publicado y rebaseado; (b) pasos 2–6 de la sección 5 OK en un teléfono físico; (c) service worker registrado, caché presente y apertura offline correcta en dispositivo real; (d) D1–D3 sin pérdidas ni duplicados; (e) login real de prueba en producción correcto; (f) Numeric Apply apagado y rollback comprobado; (g) autorización expresa del propietario y lista cerrada de atletas del piloto.
**NO-GO** ante: pérdida o duplicación de registros, botón superpuesto, apertura offline fallida, error de consola relevante, decisión numérica aplicada, o cualquier incumplimiento de (a)–(g).
