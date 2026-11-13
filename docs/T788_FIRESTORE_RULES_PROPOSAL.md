# T788 — Propuesta de Reglas Firestore y Ruta de Despliegue Independiente

## 1. Contexto y restricción de release

El estado actual revisado en `.release/vdsen-client.json` opera en modo `release_mode: "app_only"`, con las reglas vivas fijadas en `FE151` (`sha256: fe1517306bebd4bd529adfc51a406c5e97cac6b2dfd7fcae61c87318dd2e21e0`, commit `ef91ac9072f40b2e2a1e73d77c424f9e21ccb27b`).

Siguiendo el patrón establecido en `firestore.t603.rules`, `firestore.t689.rules` y `docs/RUNBOOK_FUTURE_RULES_RELEASE.md`:
- `firestore.rules` en el árbol principal permanece byte-idéntico al ruleset vivo `FE151` hasta que se ejecute un paquete `rules_only` autorizado.
- La propuesta completa de reglas para T788 queda versionada y auditada en **`firestore.t788.rules`**.
- **No se publican reglas automáticamente** desde PR ni desde sesiones de agente.

---

## 2. Diagnóstico de causa raíz (`Error: Missing or insufficient permissions.`)

Al abrir la vista de fichas en App Coach (`loadFichasRecibidas()` / expediente del cliente), el error `Error: Missing or insufficient permissions.` provenía de la combinación de cuatro factores:

1. **Planificador de consultas en `match /fichas_publicas/{docId}` (`firestore.rules`)**:
   - La regla actual usa `allow read, update, delete: if isCoachUser() && resource.data.get('coachId', '') == request.auth.uid;`.
   - En consultas de colección (`where('coachId', '==', currentCoach.uid)`), el evaluador estático de Cloud Firestore requiere igualdad directa sobre el campo (`resource.data.coachId == request.auth.uid`) y que el documento `coaches/{request.auth.uid}` exista previamente (`isCoachUser()`).
   - Además, cuando `fichas_publicas` fallaba con `permission-denied`, `loadFichasRecibidas()` en `vdsen-coach.html` abortaba toda la función sin cargar las fichas de clientes registrados en `fichas_onboarding/{clientId}`.
2. **Inicialización asíncrona de `coaches/{coachId}`**:
   - En `onAuthStateChanged`, `setDoc(doc(db, 'coaches', user.uid), ...)` podía ejecutarse después de que el Coach abriera la pestaña de fichas, haciendo que `isCoachUser()` (`exists(/databases/$(database)/documents/coaches/$(request.auth.uid))`) devolviera `false`.
3. **Ruta de lectura en `loadFichasRecibidas()`**:
   - Consultaba únicamente `fichas_publicas` (prospectos públicos) y omitía `fichas_onboarding/{clientId}` de los clientes propios del Coach (`where('coachId', '==', currentCoach.uid)` en `clients`).
4. **Incompatibilidad estructural entre formatos de ficha**:
   - `guardarFicha()` en `vdsen-cliente.html` guardaba campos planos (`peso`, `altura`, `dias`, `equipo`, `objetivo`, `experiencia`, `comidas`) sin objeto `.data`, mientras que `_renderClientTabFicha()` y `loadIntakeForClient()` en `vdsen-coach.html` exigían `raw.data`, mostrando «Sin ficha registrada» incluso cuando la ficha existía y había sido enviada.

---

## 3. Cambios propuestos en `firestore.t788.rules`

### 3.1. `match /fichas_publicas/{docId}`
```javascript
match /fichas_publicas/{docId} {
  allow create: if request.resource.data.coachId is string
                && request.resource.data.coachId.size() > 0
                && request.resource.data.nombre is string
                && request.resource.data.nombre.size() > 0;
  // T538 / T788: a prospect form is readable / manageable only by the coach it was sent to.
  // Direct field equality (resource.data.coachId == request.auth.uid) is required for Firestore list queries.
  allow read, update, delete: if isCoachUser() && resource.data.coachId == request.auth.uid;
}
```

### 3.2. `match /clients/{clientId}/checkins/{checkinId}`
```javascript
match /checkins/{checkinId} {
  allow read: if isSelfOrOwnerCoach(clientId);
  allow create: if request.auth != null && request.auth.uid == clientId
    && request.resource.data.id == checkinId
    && request.resource.data.clientId == clientId
    && request.resource.data.status == 'sent'
    && request.resource.data.submittedAt == request.time;
  allow update: if ownsClient(clientId)
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'reviewedAt', 'reviewedByCoachId', 'coachNote'])
    && request.resource.data.status in ['received', 'reviewed']
    && request.resource.data.reviewedByCoachId == request.auth.uid;
}
```

### 3.3. `match /clients/{clientId}/checkin_requests/{requestId}`
```javascript
match /checkin_requests/{requestId} {
  allow read: if isSelfOrOwnerCoach(clientId);
  allow create: if ownsClient(clientId)
    && request.resource.data.id == requestId
    && request.resource.data.clientId == clientId
    && request.resource.data.coachId == request.auth.uid
    && request.resource.data.status == 'pending'
    && request.resource.data.requestedAt == request.time;
  allow update: if (request.auth != null && request.auth.uid == clientId
      && resource.data.status == 'pending'
      && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'checkinId', 'fulfilledAt'])
      && request.resource.data.status == 'sent'
      && request.resource.data.fulfilledAt == request.time)
    || (ownsClient(clientId)
      && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'reviewedAt'])
      && request.resource.data.status in ['received', 'reviewed']);
}
```

---

## 4. Compatibilidad dual en App Coach y App Cliente antes del despliegue de reglas

Mientras `FE151` permanece activo en producción:
- App Coach y App Cliente persisten y sincronizan el seguimiento periódico y las solicitudes del Coach a través de `logs/{clientId}` (`seguimientoItems`, `seguimientoRequests`, `seguimientoSummary`), ruta ya autorizada bajo `FE151` exclusivamente para `isSelfOrOwnerCoach(clientId)` sin tocar claves canónicas (`canonicalKeys()`).
- En paralelo, cuando `firestore.t788.rules` esté desplegado, las escrituras y lecturas utilizan también las subcolecciones dedicadas `clients/{clientId}/checkins/{checkinId}` y `clients/{clientId}/checkin_requests/{requestId}`.

---

## 5. Ruta de despliegue independiente (Runbook)

Para publicar `firestore.t788.rules` en un futuro corte `rules_only`:
1. Validar en `vdsen-ecosistema-staging` con las pruebas de emulador (`tests/t788-fichas-seguimiento.test.js`).
2. Seguir los pasos 1 a 8 de `docs/RUNBOOK_FUTURE_RULES_RELEASE.md`:
   - Capturar el ruleset vivo actual en `.release/rollback/firestore.rules.<sha256>.rules`.
   - Promover `firestore.t788.rules` a `firestore.rules` en el commit candidato de reglas.
   - Configurar `release_mode: "rules_only"`, `rules_sha` y `rules_transition.target_sha256` en `.release/vdsen-client.json`.
   - Verificar `node scripts/release/check.cjs`, `node scripts/release/baseline.cjs unit` y `node scripts/release/baseline.cjs emulator`.
3. Ejecutar exclusivamente mediante `.github/workflows/vdsen-release-prod.yml` bajo el Environment protegido `Production`.
