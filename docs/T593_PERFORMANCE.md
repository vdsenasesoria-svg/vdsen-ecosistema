# T593 · Mediciones de rendimiento del Cliente (reproducibles)

**Herramienta:** `node scripts/e2e-client-chain/perf-e2e.cjs` (solo local; atleta sintético de `seed-cardio.cjs`; Auth + Firestore Emulator; servidor con `E2E_COUNT_FS=1`, que pasa cada lectura / escucha / escritura de Firestore por un contador `window.__fsc`).
**Entorno de la corrida registrada:** Chrome 155.0.8059.82 (headless=new), Windows 11 10.0.26200, AMD Ryzen 7 7730U (16 hilos), Node 24.21, emuladores locales con latencia ≈ 0. **Son cifras de trabajo del cliente en una máquina rápida, no de red ni de un teléfono.**

**Método:** (1) inicio de sesión; (2) arranque con sesión guardada ×5 (recarga + arranque de la app; tiempo medido **dentro de la página** hasta que se ve la pantalla de la app); (3) 60 cambios de pestaña / día / ejercicio repetidos 3 veces, con recolección de basura forzada antes de leer el montón; (4) errores de consola y excepciones durante todo.

| Medida | Resultado |
|---|---|
| Inicio de sesión → pantalla de la app | 0,7–0,9 s |
| Arranque en caliente (mediana, corridas normales) | ≈ 0,5–0,9 s |
| Lecturas Firestore por arranque | 5 `getDoc` + 1 `getDocs` (0 documentos devueltos por `getDocs`), constantes en todas las corridas |
| Escuchas (listeners) activas | **3**, constantes tras arrancar y tras 180 cambios de pantalla |
| Lecturas / escrituras durante 60 cambios de navegación | **0 / 0** |
| Montón JS tras GC (4,62 MB al inicio) | 5,27 → 5,29 → 5,30 MB tras cada ronda de 60 cambios: **se estabiliza (+0,03 MB por ronda)** |
| Errores de consola / excepciones | 0 en la corrida registrada |

**Observación honesta (no resuelta):** en las recargas repetidas del arnés, entre el 5.º y el 6.º arranque aparecen **valores atípicos** (6–40 s hasta ver la pantalla). En los atípicos las lecturas individuales de Firestore tardaron 2,7–3,9 s (frente a 36–55 ms normales) y la pantalla acabó apareciendo con los mismos contadores; no hay errores de consola ni trabajo de CPU del cliente. Es coherente con la saturación de conexiones HTTP/1.1 de larga duración del emulador local entre recargas inmediatas, pero **no está demostrado** que no ocurra en producción (que usa HTTP/2). **NO VERIFICADO en producción / teléfono real**; un usuario real no recarga 5 veces seguidas en un minuto, pero conviene observarlo en el piloto (checklist T594).

**Qué no se midió:** memoria del proceso del navegador en un teléfono, tiempo de carga en red móvil, consumo de batería.
