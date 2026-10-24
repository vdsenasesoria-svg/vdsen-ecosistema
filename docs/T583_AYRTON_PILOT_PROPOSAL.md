# T583 · Propuesta de validación controlada — piloto: Ayrton

**Esto es una propuesta. No activa nada.** Preparar el canario no autoriza Numeric Apply, CRON ni a ningún otro cliente. Sustituye el paso 0 ("incrementos reales") de `docs/PILOT_CANARY_RUNBOOK.md`: desde T582 el equipamiento es opcional.

## Qué ya está demostrado (emulador, Cliente real)
Con el Cliente real en el navegador contra emuladores (Auth + Firestore) y el manejador real de `/api/autonomous-progression-trigger`: el atleta registra series, el Cliente guarda y calcula su recomendación, el servidor materializa y aplica, la siguiente exposición muestra `AUTOAJUSTE VDSEN 100 → 105 kg` / `10 → 12 reps`, el atleta registra una carga distinta (102,5) y la siguiente evaluación parte de 102,5. Repetible en CI: `tests/t583-real-client-chain-emulator.cjs`.

## Etapa 0 · Identificar a Ayrton sin inventar nada (solo lectura)
1. El UID **no se inventa ni se deduce**: lo copia el propietario de Firebase Console → Authentication → Users (cuenta Cliente de Ayrton).
2. Comprobar en Firestore `clients/{uid}`: `coachId` (el Coach de Ayrton) y `activePlanId`; abrir ese plan y confirmar que sus ejercicios tienen `prescriptionExerciseId` (todo plan guardado por el Coach lo tiene) y sus `sets`. No se modifica su historial ni su plan.
3. Confirmar que no tiene molestia articular activa (el sistema bloquea aumentos con dolor, y es lo correcto).

## Etapa 1 · Observación sin aplicar (PENDING solamente) — requiere autorización
- Interruptores: `AUTONOMOUS_PROGRESSION_ENABLED=true` y `..._NUMERIC_APPLY_ENABLED=false`; `releaseControl/autonomousProgression = { schema:'vdsen-autonomous-release-v1', enabled:true, clientIds:['<uid Ayrton>'] }` (solo Admin); `coaches/{coachUid}.autoApplyCanary = { enabled:true, clientIds:['<uid Ayrton>'], prescriptionExerciseIds:[] }`. **CRON apagado.**
- Qué ocurre: tras cada sesión de Ayrton el servidor crea registros `PENDING` con la decisión y sus razones; **no cambia ninguna prescripción**.
- Para qué sirve: verificar con su historial real qué *habría* prescrito, sin que lo vea.

## Etapa 2 · Aplicación solo para Ayrton — requiere autorización explícita aparte
- Cambio respecto a la etapa 1: `..._NUMERIC_APPLY_ENABLED=true`. Nada más. Mismos tres cercos (variables + allowlist con un solo uid + canario del Coach).
- Operaciones permitidas: ajustes de **repeticiones dentro del rango del Motor**, **carga orientativa** y **descanso** sobre los ejercicios de Ayrton. No se aplican series, técnica ni estructura (siguen siendo del Coach).
- Criterio de éxito: Ayrton completa una sesión en Cliente y recibe una prescripción individualizada para su siguiente exposición, calculada con su bitácora real.

## Cómo observar
- Ayrton: en la siguiente exposición ve la chip **AUTOAJUSTE VDSEN** (valor anterior → nuevo) y la prescripción efectiva; puede registrar otra carga (la que use de verdad será la evidencia posterior).
- Coach: panel de monitoreo (decisión, razones, reglas) y, en Firestore, `logs/{uid}/mesos/{planId}`: `progressionApplications` (estado/razón), `nextExposureOverlays` (valor y unidad) y `consumptionReceipts`.
- Respuesta del endpoint: `status` + `created` / `applied` / `consumed` (sin datos personales).

## Cómo detectar errores (parar si ocurre cualquiera)
Carga que Ayrton no puede montar de forma sistemática · más de un overlay por exposición · dolor reportado que no bloquea · unidad incorrecta · un cambio que contradice la decisión del Coach · cualquier 5xx repetido del endpoint · escrituras en documentos de otro cliente (no debe existir ninguna).

## Cómo detener y revertir (en este orden)
1. `releaseControl/autonomousProgression`: `enabled:false` (o borrarlo). Se relee dentro de cada transacción: efecto inmediato, sin redeploy.
2. `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED=false` (y `..._ENABLED=false`) y redeploy.
3. `autoApplyCanary.enabled=false` en el documento del Coach.
4. Revertir una aplicación concreta (el contrato lo permite **antes** de que empiece esa exposición): una decisión del Coach sobre ese ejercicio hace que el Cliente muestre la prescripción base (probado: T583-E8), o la acción de revertir del panel (`REVERTED`). Una exposición ya empezada conserva lo que empezó.

## Evidencia para ampliar el alcance
≥ 3 sesiones consecutivas de Ayrton con: cero duplicados · cero escrituras fuera de su cuenta · valores coherentes con las reglas (comparados con la etapa 1) · estados `APPLIED → CONSUMED` completos · la carga que registró siempre usada como base de la siguiente evaluación · Ayrton confirma que las prescripciones fueron razonables.

## Ampliar a los demás clientes (después de validar y autorizar)
Sin cambiar el algoritmo por usuario: añadir sus UIDs a la allowlist y al canario. **Dos límites actuales a decidir por el propietario antes:** (a) la allowlist admite como máximo 10 clientes (`RELEASE_MAX_CLIENTS` en `api/_autonomousProgression.js`); (b) el canario es por Coach y por cliente/ejercicio. "Todos los elegibles" exige decidir cómo reemplazar esa lista cerrada por una regla de elegibilidad, y es un cambio de contrato aparte.
