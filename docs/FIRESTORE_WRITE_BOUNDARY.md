# Frontera de escritura canónica de Firestore (T536–T537)

Estado: **PASS / READY en el repositorio** (`firestore.rules` + tiempo de ejecución), probado con Firestore Emulator real (`tests/t536-rules-security.cjs`, `tests/t532-lifecycle-emulator.cjs`, `tests/t476-auto-apply-emulator.cjs`). **Las reglas NO están desplegadas**: el despliegue no está autorizado y debe ocurrir antes de activar la aplicación numérica.

Las reglas no pueden leer `NUMERIC_APPLY_ENABLED`. La defensa es por capas: bandera de ejecución + alcance de canario + guardia de activación (19) + matriz de transiciones del consumidor + autorización de Firestore.

## 1. Inventario de escritores (antes de T537, con llamadas de producción)

| Dato | Documento | Escritor de producción (antes) | Principal |
|---|---|---|---|
| `progressionApplications` (registro PENDING) | `logs/{uid}/mesos/{planId}` | `_recordShadowProgression` (cliente, tras la sesión y en la cola de recuperación) | **CLIENTE** |
| `progressionApplicationSummary` | meso **y** raíz `logs/{uid}` | mismo escritor cliente; además `_reconcileShadowAuto` y `_onShadowAutoAction` del Coach | **AMBOS** |
| PENDING → REJECTED / PENDING (KEEP_ORIGINAL / REVERT_DECISION) | meso + raíz + `clients/{uid}.coachInterventions` | `_onShadowAutoAction` (Coach) | COACH |
| PENDING → STALE | meso + raíz | `_recordShadowProgression` (cliente) y `_reconcileShadowAuto` (Coach) | **AMBOS** |
| `nextExposureOverlays` + PENDING → APPLIED | meso | `applyOverlayTransaction`: **sin llamada de producción** (bandera apagada, no cableado) | DESCONOCIDO (diseñado: Coach) |
| APPLIED → CONSUMED | meso | `consumeOverlayTransaction` vía `_maybeConsumeOverlays` (cliente) | **CLIENTE** |
| APPLIED → OVERRIDDEN / REVERTED / STALE | meso + raíz | `_reconcileAppliedOverlays`, `_onRevertApplied` (Coach) | COACH |
| campos de revisión / auditoría de ciclo de vida | dentro del registro (`revision`, `events`, `lifecycle.*`) | los mismos escritores anteriores | según transición |
| metadatos de decisión del Coach | `clients/{uid}.coachInterventions` | Coach (reglas: cliente solo `phone*`) | COACH |
| incrementos de equipo | `coaches/{uid}.equipmentIncrements`, `exercises/{id}.loadIncrement` | Coach | COACH |

Las reglas anteriores permitían a **cualquier usuario autenticado escribir todo** su `logs/{uid}` y `logs/{uid}/mesos/*`, y a **cualquier coach** escribir los `logs` de cualquier usuario. RED demostrado: 12 de 19 pruebas de reglas fallaban (los ataques del atleta y del coach ajeno tenían éxito), 7 pasaban (escrituras legítimas).

## 2. Campos canónicos protegidos

`progressionApplications`, `nextExposureOverlays`, `progressionApplicationSummary` (en `logs/{uid}` y `logs/{uid}/mesos/{planId}`). Definidos una vez en `firestore.rules` (`canonicalKeys()`); un test evita la deriva respecto del código (T537.1).

Reglas para `logs/{uid}` y `mesos/{planId}`:
- **Atleta**: crear / actualizar solo si `!createsCanonical()` / `!changesCanonical()`; borrar solo si el documento no contiene campos canónicos. Reemplazos totales que los descartarían se deniegan.
- **Coach**: acceso legado a campos NO canónicos sin cambios; los canónicos solo si `ownsClient(userId)` (`clients/{uid}.coachId == request.auth.uid`).
- **Recibos de consumo** (`consumptionReceipts`, solo en `mesos`): el atleta puede AÑADIR claves; no modificar ni borrar existentes (`changedKeys/removedKeys == 0`), máximo 200.

## 3. Modelo de consumo (CONSUMED)

Las reglas **no pueden** expresar «el cliente solo pasa APPLIED → CONSUMED sin tocar el payload»: los registros son claves dinámicas dentro de un mapa y las reglas no iteran claves ni pueden aislar la clave modificada. Por tanto no se debilitó la regla; se aplicó la alternativa A (recibo append-only):

1. El atleta, tras persistir la primera serie de trabajo del PID exacto, añade `consumptionReceipts.<recordKey> = { recordKey, overlayKey, dimension, appliedValue, provenance, ackAt }` (`recordConsumptionReceiptTransaction`). El recibo solo reconoce lo mostrado; no crea ni cambia prescripción.
2. El Coach dueño, al abrir el Monitor (`_reconcileAppliedOverlays`), convierte un recibo válido en APPLIED → CONSUMED (`consumeOverlayTransaction`): exige recibo coincidente con el overlay, ejecución persistida y estado consistente. Un recibo forjado no coincide → `RECEIPT_MISMATCH`.
3. Hasta que el Coach registre CONSUMED, la exposición iniciada ya conserva su prescripción efectiva (el resolvedor usa la ejecución persistida), y override/revert/stale se rechazan (destino iniciado).

Migración: cero. Nunca hubo APPLIED en producción.

## 4. Creación de registros PENDING

El atleta ya no crea registros: se eliminaron `_recordShadowProgression`, la cola y el drenaje. Los registros PENDING los materializa el **Coach dueño** (`_materializeShadowRecords` → `shadow.materializeRecords`) a partir de la evidencia `progrec_*` PERSISTIDA; la magnitud se recalcula desde los LOGS, no se confía en ningún payload del atleta. El Coach nunca reescribe LOGS (sin reparación de espejo).

## 5. Propiedad del Coach

Contrato: un Coach solo muta el estado canónico de sus clientes (`clients/{uid}.coachId`). Un pseudo-coach (cualquier usuario que cree `coaches/{su uid}`) no obtiene autoridad canónica: no es el `coachId` de ningún cliente ajeno.

**Legado reportado por separado (fuera de esta frontera):** (a) cualquier usuario autenticado puede autoregistrarse como coach (`coaches/{uid}` es escribible por su uid) y leer `logs`/`clients` de cualquiera; (b) los coaches siguen pudiendo escribir campos NO canónicos (`entries`, `currentWeek`…) de logs de clientes ajenos. Recomendado: revisar el registro de coaches (allowlist / custom claims) antes de abrir la app a más coaches.

## 6. Matriz de autorización de transiciones (reglas + tiempo de ejecución)

| Transición | Principal autorizado | Enforcement |
|---|---|---|
| (creación) PENDING | Coach dueño | reglas (campo canónico) + `materializeRecords` |
| PENDING → REJECTED / STALE / PENDING (KEEP / REVERT_DECISION) | Coach dueño | reglas + `shadow.transition` / `markStale` |
| PENDING → APPLIED (+ overlay) | Coach dueño | reglas + bandera + canario + guardia + `lifecycleTransition` |
| APPLIED → CONSUMED | Coach dueño, con recibo del atleta | reglas + recibo coincidente + ejecución persistida |
| APPLIED → OVERRIDDEN | Coach dueño | reglas + decisión exacta posterior al cálculo |
| APPLIED → REVERTED | Coach dueño | reglas + `expectedRevision` + destino no iniciado |
| APPLIED → STALE | Coach dueño | reglas + plan/PID/destino invalidados |
| CONSUMED / OVERRIDDEN / REVERTED / STALE → cualquiera | nadie | `ALLOWED_TRANSITIONS` (terminales) |
| recibo de consumo (append) | Atleta | reglas (append-only) |

## 7. Metadatos de equipo

`coaches/{uid}`: solo su dueño escribe (`equipmentIncrements` no es forjable por atletas ni por otros coaches). `exercises/{id}`: T537 restringe crear/editar/borrar al coach dueño (`coachId`) o a reclamar un ejercicio legado sin `coachId`; ya no es escribible por cualquier coach. Un atleta o un coach ajeno no puede alterar `loadIncrement` (no puede convertirse en una vía de evasión de la seguridad de progresión).

## 8. Service worker

`CACHE = vdsen-v12`; cada `<script src="assets/*.js">` del atleta debe estar en `PRECACHE` (test T537.7), incluidos `progression-auto-apply-shadow`, `progression-magnitude-policy`, `progression-effective-prescription` y `progression-application-consumer`. Sin trabajo offline adicional.

## 9. Bandera apagada: defensa en profundidad

Un cliente malicioso con el SDK no puede crear un overlay APPLIED: reglas (campo canónico), `lifecycleTransition` rechaza APPLIED con la bandera apagada, canario ausente = fuera de alcance, guardia de 19 verificaciones y matriz de transiciones.

## 10. Modelo de identidad y aislamiento por inquilino (T538)

**Modelo de identidad real (auditado, no se inventó una arquitectura de roles):**
1. `coaches/{uid}` lo crean: (a) el botón «Crear cuenta» de la app Coach (registro abierto: `createUserWithEmailAndPassword` + `setDoc`), (b) `onAuthStateChanged` de la app Coach, que crea el documento para CUALQUIER usuario autenticado que abra esa app, (c) `ensureCoachDoc` (merge).
2. Antes, una cuenta de atleta podía crear su propio `coaches/{uid}` (la regla solo exigía `auth.uid == coachId`). Ahora se deniega si existe `clients/{uid}`.
3. No hay custom claims ni provisión desde el servidor; no existe primitiva de rol de confianza.
4. Sí: las reglas (`exists(coaches/{uid})`) y `api/_firebaseAdmin.isAuthorizedCoach` usan la existencia del documento como única comprobación de rol.
5. Las cuentas Coach son autocreadas (registro abierto).

**Regla de inquilino:** `isCoachUser()` (autocreable) ya no concede acceso a datos privados de otro coach. El acceso a un cliente exige `clients/{clientId}.coachId == request.auth.uid` (`ownsClient`) o ser el propio atleta (`isSelfOrOwnerCoach`).

| Recurso | Lectura | Escritura |
|---|---|---|
| `clients/{id}` | atleta o coach dueño | (sin cambios) crear con su coachId; actualizar propios; reclamar huérfano por uid |
| `logs/{uid}`, `mesos/*` (entries, semana, historial, canónico) | atleta o coach dueño | atleta: ejecución + recibos; coach dueño: todo; nadie más |
| `fichas_onboarding`, `fichas_renovacion` | atleta o coach dueño | ídem |
| `phone_index` | pública (login por celular, sin cambios) | solo coach dueño del cliente al que apunta (antes y después) |
| `compendio/{uid}` | solo ese coach | solo ese coach |
| `templates`, `plans_backup`, `fichas_publicas` (lectura) | solo su `coachId` | crear/editar solo con su `coachId` |
| `sessions` | cerrada (sin lectores ni escritores en ninguna app) | cerrada |
| `exercises` | catálogo global de lectura | solo coach dueño (T537) |

Cambios en la app Coach: las consultas sobre `clients`, `fichas_publicas` y `plans_backup` filtran por `coachId`; las herramientas de reparación/recuperación de clientes ya no enumeran clientes ajenos ni sin coach (se reclama por uid con «Reparar UID»). `firestore.indexes.json` añade el índice `plans_backup (coachId, clientId, backedUpAt)`: **debe desplegarse junto con las reglas**.

**FIRESTORE_TENANT_ISOLATION: PASS / READY** en el repositorio (`tests/t538-tenant-isolation.cjs`; RED antes: 10 de 11 fallaban).

**Actualización T539:** el registro de coach sigue abierto, pero ya NO concede acceso a la API de pago: eso requiere `apiAccessEnabled === true`, gestionado solo por el Admin SDK y protegido por las reglas (`docs/COACH_API_ENTITLEMENT.md`). La regla que permitía a cualquier coach reclamar un cliente sin `coachId` fue eliminada: `coachId` solo se asigna al crear y es inmutable; la recuperación de clientes legacy es solo administrativa (`scripts/admin-recover-client.cjs`).

**Riesgos residuales (reportados):**
- **Creación de cliente (flujo previsto):** un coach puede crear un documento `clients/{uid}` NUEVO con su `coachId`. No puede sobrescribir ni adoptar un cliente existente de otro coach. Un UID de Auth SIN documento de cliente podría ser «pre-reclamado» por un coach: la arquitectura actual no distingue esa intención de un alta legítima (haría falta una invitación firmada; no se inventó aquí).
- Índices y reglas deben desplegarse juntos; nada se desplegó.
