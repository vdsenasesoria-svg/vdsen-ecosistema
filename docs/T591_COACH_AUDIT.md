# T591 · Auditoría de Coach (estado: **PARCIAL**, ver «Lo que falta»)

**HEAD inicial verificado:** `2d2e715` (`codex/client-app-next`, incluye T589, T590/#103, T592, T593/#105, T596 y el rebaseline #108). **Rama:** `fix/t591-coach-audit`.
**Restricciones respetadas:** `main`, producción, Firebase Rules, Indexes, IAM, datos reales, credenciales, Numeric Apply, Motor, Generador externo y la app Cliente no se tocaron. Todo se probó con emuladores y clientes sintéticos.

## Método
Reconocimiento → línea base (1636 pruebas: 1618 pasan, 18 fallan por causas heredadas de Windows/documentos generados/recuperación de release) → pruebas del importador real de Coach en vm (importación de fuerza, cardio y mixta, estructuras inválidas) → **navegador real contra emuladores** (Auth + Firestore con las reglas del repo, Coach real, coach y clientes sintéticos): importar JSON mixto, asignar, abrir el editor, editar, guardar, recuperar, duplicar clics, Expediente TXT, 320/390/430 px → corrección → pruebas → regresión.

## Hallazgos
| Id | Sev. | Hallazgo (reproducido) | Estado |
|---|---|---|---|
| H1 | **P1** | **Importar JSON descartaba ejercicios en silencio.** Un ejercicio de fuerza sin `sets`, uno con forma no canónica (`series`/`reps`) y uno con `exerciseType` no reconocido (p. ej. `"aerobic"`) desaparecían del plan y el estado decía «✅ JSON válido» sin avisar. | **Corregido:** aviso por cada ejercicio no importado (con el motivo) en la vista previa; si todo se pierde, el motivo sale en el error. |
| H2 | **P1** | **Cardio con series de fuerza:** un cardio declarado que traía `sets` los conservaba (series de fuerza para un cardio; el Expediente contaba esas series como planificadas). | **Corregido:** se ignoran y se avisa («es cardio; sus N serie(s) de fuerza se ignoraron»); el cardio queda sin series, sin carga, RIR ni descanso inventados. |
| H3 | **P1** | **La copia de seguridad del plan saliente no se creaba** cuando el cliente no tenía nutrición/suplementos (Firestore rechaza `undefined`; el error se tragaba). Reproducido: cliente A reemplazó su plan y `plans_backup` quedó en 0. | **Corregido** (campos ausentes se omiten); verificado en navegador: backup creado. |
| H4 | P2 | La vista previa mostraba el cardio como «0 serie(s) × reps». | **Corregido:** «CARDIO · 30 min». |
| H5 | P2 | Un cardio declarado en un plan entraba al catálogo con patrón vacío, así que la regla de catálogo de T589 nunca lo reconocía después. | **Corregido:** se cataloga con patrón «Cardio» (solo si el plan lo declaró). |
| H6 | P2 | Un clic repetido en «Guardar» del editor, una vez cerrado el editor, leía un editor vacío y mostraba «Plan inválido [STRUCT] days[] ausente» tras un guardado exitoso (no escribía nada, pero confundía). | **Corregido** (retorno silencioso). Verificado: 3 clics ⇒ un solo «Plan actualizado», un solo plan. |
| H7 | P2 | En el editor a 320 px, reordenar / sustituir / eliminar medían 16–20 px (mis-toques). | **Corregido:** 44 px; la fila se envuelve y el nombre conserva todo el ancho (193 px a 320). |

## Verificado sin hallazgo
Mixto → editar → guardar → recuperar: ningún ejercicio cambió de significado (cardio sigue cardio con su duración editada 30→35→40, fuerza explícita `fuerza` se mantiene aunque el nombre diga «cardio», una fuerza sin tipo con nombre «Cinta de correr suave» sigue fuerza: **sin inferencia por nombre**), PIDs preservados, un solo plan por cliente tras guardados repetidos. Asignación: selección del cliente correcto, comprobación de propiedad (`coachId`), confirmación al reemplazar plan activo, protección de doble clic en importar. **Expediente TXT** (navegador real): un solo `.txt`, exactamente 4 secciones, secciones vacías como «SIN DATOS REGISTRADOS», sin credenciales ni datos de otro cliente; con registros: cardio como duración + calidad/RPE en `cardio_registrado`, `planned_sets` del cardio = 0, la razón de series completadas solo cuenta fuerza (1/3).

## Resultados por caso (PASS/FAIL)
| # | Caso | Resultado | Cómo |
|---|---|---|---|
| 1 | Cliente con ficha completa | **PASS (solo pruebas automáticas)** | `t588`, `client-export` (fixtures completos); no hay ficha completa sintética en el navegador |
| 2 | Cliente con ficha incompleta | **PASS** | navegador (cliente sin ficha ⇒ «SIN DATOS») |
| 3 | Importación de fuerza | **PASS** | vm + navegador |
| 4 | Importación de cardio | **PASS** | vm + navegador (día solo cardio incluido) |
| 5 | Importación mixta | **PASS** | vm + navegador |
| 6 | Edición y recuperación | **PASS** | navegador (Firestore leído después de guardar) |
| 7 | Asignación al cliente correcto | **PASS** | navegador (A con plan, B sin plan) |
| 8 | Guardado repetido | **PASS** | navegador (importar ×2, editor ×3) |
| 9 | Exportación TXT y aislamiento | **PASS** | navegador + `t588` / `client-export` |
| 10 | Compatibilidad con el Motor | **PASS parcial** | el plan guardado conserva PID, `exerciseType`, `muscleGroup`, `repsRange`; el cardio no genera candidatos (pruebas T589); el Motor externo no se ejecutó |
| 11 | Datos heredados | **PASS (solo pruebas automáticas)** | `t587` / `t553`; no se probó un plan heredado en el navegador |
| 12 | Móvil 320/390/430 | **PASS en desbordes; parcial en táctil** | sin desbordes horizontales en lista, ficha, plan y editor; áreas táctiles corregidas solo en el editor |

## Pruebas
`tests/t591-coach-audit.test.js` (6) + ajuste de `tests/helpers/coach-plan-import.js` (devuelve los avisos). Suite completa: **1618 pasan / 18 fallan = exactamente los 18 heredados**; ninguna regresión nueva.

## Estado de contratos
* **Generador Maestro → Coach:** el Project externo **no es accesible** desde aquí; no se afirma nada sobre él. Se validó el contrato disponible (`docs/T587_GENERATOR_COACH_CONTRACT.md`) con el importador real. Límite: los campos desconocidos del Generador **no se conservan** (el importador usa una lista blanca explícita; ahora se avisa de lo que se pierde de ejercicios completos, no de campos sueltos).
* **Cardio/fuerza:** operativo de extremo a extremo (importar → editar → guardar → Cliente → Expediente).
* **Expediente TXT:** operativo (un archivo, 4 secciones).

## Riesgos residuales y recomendaciones separadas (fuera de este PR)
1. **Asignación en dos escrituras** (`addDoc` del plan y luego `updateDoc` de `activePlanId`): un corte entre ambas deja un plan huérfano `status:'active'`, y un reintento crea otro. Convertirlo en transacción es correcto, pero obliga a reescribir 5 pruebas-red de seguridad que enumeran los escritores de `plans/` (t482, t546, t263, t115h, qa_r5): lo intenté y lo **revertí** para no tocar esas redes sin una decisión propia.
2. Al reemplazar un plan, las reglas impiden borrar el anterior (`status:'active'`): queda con `status:'active'` aunque no sea el activo del cliente (el Coach usa `activePlanId`, así que es cosmético; el Expediente lo lista como mesociclo histórico). El `deleteDoc` falla en silencio.
3. **Densidad táctil del Coach en general:** ~30–90 controles por pantalla miden 28–37 px (herramienta de escritorio usada en móvil). Solo se corrigió el editor; un rediseño táctil completo es otra tarea.
4. `rirByWeek` del Generador se **sobrescribe** al guardar (esquema propio del Coach; así está fijado en `t587`). Decidir si el Generador debe mandar.
5. Cambiar de cliente en el selector de la pestaña Plan **borra la vista previa importada** sin avisar (hay que elegir el cliente antes de pegar el JSON).
6. No medido: lecturas de Firestore al iniciar, listeners y memoria del Coach (sin instrumentos).

## Lo que falta para cerrar T591 como COMPLETO
Ficha 360 completa en navegador con un cliente sintético con todas las secciones; plan heredado en navegador; revisión de rendimiento con instrumentos; decisión sobre los riesgos 1–5.
