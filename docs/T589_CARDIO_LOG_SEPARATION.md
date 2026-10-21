# T589 · El registro de cardio queda separado del de fuerza

**Qué cambia para cada persona**
* **Atleta:** un ejercicio de cardio pide solo **duración real (min)** y **una** medida de esfuerzo a elegir: **RPE (1–10)** o **Calidad (1–10)**. Distancia, FC, ritmo, notas y datos de reloj son opcionales y están plegados. Nunca pide series, repeticiones, carga, RIR ni descanso. Una sesión de **solo cardio** se completa igual que cualquier otra. Un día **mixto** (fuerza + cardio) funciona con cada tarjeta en su lenguaje.
* **Resumen final / RESUMEN:** el cardio sale como una fila propia («32 min · RPE 7/10» o «45 min · Calidad 8/10»); nunca cuenta como serie.
* **Coach:** cada ejercicio del editor tiene un selector **Tipo (FUERZA / CARDIO)**. Con CARDIO se prescribe solo la duración objetivo y no se guardan series. Al importar un plan, un ejercicio sin tipo declarado cuyo nombre **exacto** está en el catálogo del Coach con patrón motor «Cardio» se guarda como cardio.
* **Expediente TXT:** los registros de cardio van en `cardio_registrado` (duración, medida de esfuerzo y cuál fue, distancia, FC) y las sesiones solo de cardio aparecen; no se mezclan con las series.

**Cómo se identifica el cardio (sin adivinar por palabras del nombre)**
1. `exerciseType` / `tipo` declarado en el plan (gana siempre, incluso `fuerza`).
2. Si no hay tipo declarado: `motorPattern: 'Cardio'` del propio ejercicio, o coincidencia **exacta** (id o nombre completo normalizado, nunca parcial) con una ficha del catálogo del Coach cuyo patrón motor es «Cardio».
Un nombre que solo *parece* cardio («Correr en cinta suave», «Cardio de hombros») sigue siendo fuerza.

**Forma del registro** (`logs/{uid}.entries.log_{W}_{D}_{E}`, una sola clave por ejercicio, sin `_s{S}`): `{ exType:'cardio', duracionMin, metrica:'rpe'|'calidad', rpe | calidad, modo, distanciaKm?, fcMedia?, fcMax?, ritmo?, notas?, wearable?, prescriptionExerciseId, exerciseNameSnapshot, done, ts }`. Solo se guarda la medida elegida. Los registros históricos (con `rpe` y sin `metrica`) se leen igual.

**Motor VDSEN y estadísticas**
* `calculateProgression` omite el cardio: los minutos no son repeticiones y una entrada de cardio no es una serie.
* `_buildWeekPerfSummary` ignora las series cuyo ejercicio está clasificado cardio hoy (los registros guardados **no se tocan**; solo se excluyen).
* `materializeRecords` (sombra de progresión, también en servidor) no crea candidatos para un PID declarado cardio.
* Export: `derive.observed` excluye los registros con forma de serie de un ejercicio declarado cardio.

**Pruebas:** `tests/t589-cardio-log-separation.test.js` (9) + contratos actualizados `t543` (la entrada de cardio ahora sale de `_cardioEntry`; el campo `card_rpe_` pasó a `card_eff_`) y sandbox de `t587-session-recap`. Verificación en navegador real (emuladores): día mixto, día solo cardio, validación, guardado en Firestore y recuperación, resumen, 320 / 390 / 430 px sin desbordes y controles ≥ 44 px.

**Límites conocidos:** no se verificó el editor del Coach en un navegador real (solo contratos de código y pruebas de las funciones puras); el Motor externo debería emitir `exerciseType:'cardio'` para el cardio (hoy el contrato ya lo admite).
