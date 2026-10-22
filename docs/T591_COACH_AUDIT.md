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

---

# T591-B · Resolución de los bloqueos del dictamen REQUEST_CHANGES del PR #109

**HEAD base de esta ronda:** `752bee5` (el HEAD final está en el PR). Solo Coach (`vdsen-coach.html`) y pruebas/documentos. Sin Rules, índices, IAM, Motor, Cliente, flags ni producción.

## 1 · Asignación de planes (P1): una sola transacción, idempotente
`saveImportedPlan` ya no hace `addDoc` + `updateDoc`. Dentro de **una transacción** (`runTransaction`): lee el cliente, comprueba la propiedad (`coachId`) y que el plan activo siga siendo el que el Coach confirmó, y escribe en conjunto el plan nuevo, `clients/{id}.activePlanId` y el retiro histórico del plan anterior.
* **Consistencia:** todo o nada. Un fallo antes del commit no deja plan huérfano ni cambia el cliente ni el plan anterior.
* **Idempotencia:** el id del plan es estable por (vista previa, cliente) (`_stablePlanIdFor`). Si el commit se hizo pero se perdió el acuse, el reintento detecta que `activePlanId` ya es ese plan y responde «ya estaba asignado» sin duplicar, sin pedir otra confirmación y sin segundo respaldo. El respaldo del plan saliente usa id determinista (`<planId>__replaced`).
* **Contienda:** si el plan activo cambió mientras el Coach confirmaba (otra pestaña o dispositivo), la transacción aborta con un mensaje explícito y no escribe nada.
* **Doble clic:** `_savingImportedPlan` + id estable ⇒ un solo plan.
* **Fallos:** mensajes explícitos («NO se guardó nada: reintenta, es seguro»); la vista previa se conserva para reintentar.
* **Reglas actuales:** compatible sin cambiarlas (el create de `plans` exige `ownsClient` sobre el cliente existente; el update del plan anterior lo permite su dueño). **Demostrado contra las reglas reales en el emulador.**

Las otras cinco rutas de asignación (manual, plantillas ×2, duplicar ×2) mantienen sus escrituras separadas (siguen fijadas por pruebas propias, T134-H/T135-H/T137-H/T138-H); ahora cierran el plan anterior con el mismo retiro histórico explícito. **Riesgo residual:** esas rutas conservan la ventana entre `addDoc` y `updateDoc`.

### Pruebas de seguridad ajustadas (sin debilitar garantías)
t482 (escritores de `plans/`: ahora se exige la transacción única, sin `addDoc`/`deleteDoc` en el import), t546.M (createdAt/updatedAt de un mismo evento ISO también en la transacción), t263 (exactamente 1 activación transaccional + 3 simples), t115h y qa_r5 (updatedAt en el documento transaccional; activación por `tx.update`), qa_r4/t143h/t134h/t587-A4 (nuevo texto), t265/t266 (respaldo con id determinista).

## 2 · Autoridad del plan activo (P1)
**Autoridad única: `clients/{id}.activePlanId`.** Auditoría de lectores: la app Cliente (`loadPlan`) y el Coach (detalle, monitor, editor) resuelven siempre `plans/{activePlanId}`; el Expediente marca `is_active` con `activePlanId`; **ningún lector filtra planes por `status`** (comprobado en Coach, Cliente, `api/`, `assets/` y `assets/client-export`). Los escritores que ponen `status:'active'` son solo de creación.
Los planes reemplazados quedan **históricos de forma explícita**: `status:'superseded'` + `supersededAt` + `supersededBy` (un borrador aprobado conserva su `status`). El `deleteDoc` silencioso (las reglas nunca permitieron borrar un plan activo) se reemplazó por `_supersedePlan`, que **no borra nada, no toca `updatedAt`** y avisa si falla. Aplicado en las seis rutas de reemplazo. Verificado en el emulador: tras reemplazar queda un plan `active` y el anterior `superseded`.

## 3 · `rirByWeek` del Generador (P1)
* Contrato implementado: el `rirByWeek` **explícito y válido** del Generador (semanas 1..N completas, valores 0–5; claves numéricas o texto) se **preserva** y se guarda `rirByWeekSource:'generator'`. Si falta o es inválido ⇒ esquema del Coach con `rirByWeekSource:'coach-default'`, y un inválido se **avisa** en la vista previa. Si el Coach cambia la duración del plan (acción explícita) el esquema se recalcula y queda registrado `rirByWeekSource:'coach-edit'`.
* Corrección adicional: el importador solo leía `rirByWeek` de la raíz; ahora también de `entrenamiento.rirByWeek` (igual que el normalizador del servidor). La ruta del borrador de IA aplica el mismo contrato.
* **Round-trip completo verificado en navegador real:** Generador (`{1:3,2:2,3:1,4:4}`, distinto del esquema del Coach) → importar → guardar → editor del Coach (guardar) → app Cliente (`PLAN.rirByWeek` idéntico, semana 4 con RIR 4).
* T587-A4 actualizado al nuevo contrato. Decisión de producto pendiente: **si el Coach cambia la duración de un plan del Generador, se reemplaza su esquema** (queda registrado como `coach-edit`).

## 4 · Vista previa importada (P2)
Cambiar de cliente con una importación sin guardar **pide confirmación**: Cancelar conserva el cliente y la vista previa; Confirmar descarta el contexto (vista previa, constructor, estado). El selector se bloquea mientras se pregunta y durante un guardado; cambios repetidos o programáticos no abren una segunda pregunta. Los botones del diálogo compartido miden 44 px.

## 5 · Validación (navegador real, Firebase Auth + Firestore Emulator con las reglas del repo, solo datos sintéticos)
| Caso | Resultado |
|---|---|
| Ficha 360 completa (cliente D: respuestas + renovación + antropometría + fotometría + campo compatible desconocido + plan mixto con registros) | **PASS** — TXT con las 4 secciones, campo desconocido conservado, cardio como duración + RPE, series solo de fuerza |
| Ficha 360 incompleta (cliente E) | **PASS** — solo lo respondido, ausencias explícitas, sin mesociclo ⇒ «sin datos» |
| Plan heredado (cliente C: sin PID, sin createdAt/updatedAt) | **PASS** — el editor lo abre, guardar estampa PID y `updatedAt`; el TXT lo exporta con sus registros |
| Plan mixto fuerza/cardio | **PASS** |
| Importación, edición, asignación y recuperación | **PASS** (cardio 30→35, `rirByWeek` intacto) |
| Fallo intermedio durante la asignación (inyectado tras armar las escrituras, antes del commit) | **PASS** — 0 planes, activo sin cambio, vista previa conservada, aviso explícito |
| Reintento | **PASS** — un solo plan |
| Acuse perdido (commit hecho, error al llamante) + reintento | **PASS** — sin segundo plan, sin segunda confirmación, un respaldo, aviso «ya estaba asignado» |
| Concurrencia (el plan activo cambia mientras se confirma) | **PASS** — aborta, no escribe, respeta el cambio ajeno |
| Doble clic / guardados repetidos | **PASS** (unidad + navegador) |
| Expediente TXT y aislamiento | **PASS** — un archivo, 4 secciones, sin otros clientes ni secretos |
| Compatibilidad T589 / T590 / T592 / T596 | **PASS** — el Cliente real lee el plan asignado por el Coach (cardio con su formulario, fuerza con series), registra y cierra sesión (resumen con cardio) y el Coach lo exporta; el cardio se importa sin series (T590); doble toque protegido (T592); T596 es solo Cliente, sin cambios (sus pruebas pasan) |
| Móvil 320 / 390 / 430 | **PASS** — vista previa con avisos, diálogo y editor sin desbordes; áreas táctiles del editor y del diálogo en 44 px |

**Lecturas y listeners (contadores en el arnés):** iniciar sesión en Coach = 10 `getDoc` + 3 `getDocs` (5 documentos) y **0 listeners**; abrir un cliente = 4–5 `getDoc`, 0 `getDocs`, **0 listeners**, sin fugas al cerrar el modal. No se midió memoria.

## Suite y CI
Suite unitaria completa: **1627 pasan / 18 fallan**; los 18 son **los mismos nombres** que fallan en la base sin cambios (`6a9c866` y `2d2e715`, ejecutadas aparte; documentos generados, CRLF y recuperación de release). Diferencia contra la línea base: **ninguna**. Pruebas nuevas: `t591b-plan-assignment` (9, con un Firestore en memoria con transacciones y fallos inyectables). Los checks de CI se informan en el PR.

## Riesgos pendientes
1. Las cinco rutas de asignación no convertidas (manual, plantillas ×2, duplicar ×2) siguen con dos escrituras (ventana de plan huérfano).
2. Cambiar la duración de un plan del Generador reemplaza su esquema RIR (registrado como `coach-edit`): confirmar si el producto quiere otra autoridad.
3. No se midió memoria; los controles del Coach fuera del editor, el diálogo y la vista previa siguen siendo densos en móvil.
4. El Generador externo no es accesible: solo se validó su contrato disponible; los campos sueltos desconocidos no se conservan (lista blanca).
