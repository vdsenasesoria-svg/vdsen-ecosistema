# Coach — subida directa de fotos de ejercicio (Firebase Storage)

Estado: implementado y validado **solo en local** (emuladores). No se creó bucket, no se desplegaron reglas, no se tocó staging/producción.
Decisión de arquitectura: Opción A (Firebase Storage), ver `docs/COACH_IMAGE_UPLOAD_DISCOVERY.md`.

## Flujo del Coach
Catálogo → ejercicio → **Visual** (Metadata visual) → sección *Foto del ejercicio*:
`Subir foto` / `Cambiar foto` → procesamiento local (“Procesando imagen...”) → vista previa (“Foto lista”) → **Guardar metadata visual**. `Eliminar foto` marca el borrado (se aplica al guardar); `Descartar selección` / `Cerrar` no escriben nada. Se muestra el origen: *Foto subida*, *URL externa* o *Sin foto*. Los campos “Asset local” y “URL HTTPS” siguen disponibles (secundarios; quedan deshabilitados mientras hay una foto subida o una foto pendiente).

## Modelo de propiedad (descubierto en el código, no asumido)
- Coach = usuario Auth con documento `coaches/{uid}`; `exercises/{id}.coachId == uid` (la regla de Firestore lo exige al crear).
- Atleta = usuario Auth con `clients/{uid}` cuyo `coachId` apunta al coach; el cliente lee `exercises where coachId == clientData.coachId` en cada `loadPlan`.
- Por eso las imágenes no pueden ir inline en `exercises` (se leería el catálogo completo en cada carga).

## Ruta en Storage
`exercise-media/{coachId}/{exerciseId}/image-<16 hex>`
- `coachId` = uid autenticado; `exerciseId` = id del documento `exercises/{id}` (nunca nombres visibles; solo `[A-Za-z0-9_-]`, sin traversal).
- Nombre **versionado** (token aleatorio de 64 bits): reemplazar = subir nuevo → guardar Firestore → borrar el anterior. Una ruta fija obligaría a sobrescribir antes de saber si Firestore se guardó (estado inconsistente si falla); la versión nueva nunca destruye la referencia vigente.

## Campos Firestore (`exercises/{id}`)
- `imageUrl`: URL HTTPS de descarga (con token) → la usa el renderer del atleta sin cambios (`_safeClientMediaUrl` acepta `https://`).
- `assetRef`: ruta canónica del objeto (`exercise-media/...`). `buildPatch` la valida con regex estricta; `mediaUrl` sigue aceptando solo `https://` / `assets/...`.
- Nunca base64, data URI ni bytes. Valores legados (`https://…`, `assets/…`) no cambian.

## Ciclo de vida
1. Selección: valida MIME declarado (JPEG/PNG/WebP), tamaño de origen (≤ 15 MB, si no: “La imagen es demasiado grande. Intenta con otra foto.”), firma de bytes (un SVG/HTML renombrado se rechaza) y decodifica con orientación EXIF correcta.
2. Procesado: lado largo ≤ 1600 px, sin ampliar, aspecto preservado, re-codificación (elimina EXIF/GPS), calidad iterativa .85→.45 y reducción 0.8× hasta ≤ 350 KB (tope duro 480 KB). JPEG para fotos; WebP solo si hay transparencia real y el navegador lo soporta. Error genérico: “No se pudo procesar esta imagen.” (sin stack).
3. Estado local: el Blob procesado y la URL de vista previa viven solo en el controlador del editor. **Nada se escribe** hasta Guardar.
4. Guardar: verifica contexto (editor/coach/ejercicio) → `uploadBytes` → `getDownloadURL` → verifica contexto otra vez → `updateDoc` (imageUrl + assetRef) → borra el objeto anterior (solo si es propio: mismo coach y mismo ejercicio).
5. Fallos: si `updateDoc` falla se elimina el objeto nuevo; si cambia el contexto durante la subida se elimina el objeto y no se persiste nada; si falla el borrado del objeto anterior el Firestore ya apunta al nuevo (queda un huérfano, ver abajo).
6. Eliminar foto: `updateDoc` con `imageUrl:''`/`assetRef:''` y luego borrado del objeto (solo si era una foto subida; en URLs/assets legados solo se limpian los campos).
7. Cancelar / cerrar / cambiar de ejercicio / logout / cambio de coach: `_visualEditorClose()` incrementa el token de secuencia, invalida el controlador (descarta Blob, revoca la URL de objeto, limpia vista previa) y elimina el overlay. `_parkCoachShell()` lo invoca antes de estacionar el shell, así que nada de Coach A sobrevive al login de Coach B (ni en DOM oculto).
8. Carreras: cada operación async lleva token; un resultado tardío (decodificación o subida) nunca reemplaza una selección más nueva ni persiste tras cerrar el editor.

### Escenarios que pueden dejar objetos huérfanos
- Falla el borrado del objeto anterior tras guardar Firestore (red/permiso): la foto activa es correcta; el objeto viejo queda sin referencia (≤ 480 KB).
- Se cierra la pestaña entre `uploadBytes` y `updateDoc`.
- Falla el borrado de rollback tras un `updateDoc` fallido.
Mitigación futura (fuera de alcance): barrido administrativo de objetos de `exercise-media/` no referenciados por `assetRef`.

## Reglas (`storage.rules`)
- Escritura (`create`/`update`): solo el coach dueño (`request.auth.uid == coachId`, existe `coaches/{coachId}`), el ejercicio existe y `exercises/{exerciseId}.coachId == coachId`, nombre `image-<16 hex>`, `contentType` ∈ {`image/jpeg`,`image/png`,`image/webp`}, tamaño 1 B–512 KB. SVG/HTML/otros tipos quedan rechazados.
- Borrado: solo el coach dueño y solo nombres del esquema.
- Lectura: el coach dueño o un atleta cuyo `clients/{uid}.coachId == coachId`. Sin lectura pública y sin `request.auth != null` genérico. Sin `list`.
- Las reglas usan lecturas cruzadas a Firestore (`firestore.exists/get`).
- Modelo de lectura del atleta: la URL con token es un enlace tipo *bearer* (quien la tenga puede abrirla); las reglas controlan la lectura por SDK. Es el mismo modelo que usa `<img src>` en el renderer actual (sin cabeceras de autenticación).

## Pruebas locales
```
NODE_PATH=$(npm root -g) node scripts/coach-image-storage-rules.cjs   # 35 pruebas de seguridad (Auth+Firestore+Storage emulators)
NODE_PATH=$(npm root -g) node scripts/coach-image-upload-e2e.cjs      # 42 pruebas de navegador (UI real del Coach)
node --test tests/coach-image-upload.test.js                          # 21 pruebas unitarias
```
`scripts/storage-emulator-lib.cjs` levanta los tres emuladores con **copias** de `firestore.rules` y `storage.rules`, usa el proyecto `demo-vdsen-e2e`, sustituye la apiKey y reescribe en memoria `getDownloadURL` (las URLs del emulador son `http://127.0.0.1`, que la validación HTTPS rechaza correctamente) hacia un host https ficticio que Playwright enruta al emulador. El código de producción no se modifica. Los scripts E2E existentes también sirven ahora `firebase-storage.js` local.

## Compatibilidad hacia atrás
Ejercicios con `imageUrl` externa o `assetRef` `assets/...` se muestran como *URL externa*, se pueden editar y guardar sin cambios sin tocar Storage; subir una foto los reemplaza (no se borra nada fuera de `exercise-media/{coachId}/{exerciseId}/`). El cliente atleta no cambió.

## Pasos externos pendientes (NO realizados; requieren Work futuro)
1. Crear/verificar el bucket de Storage del proyecto `vdsen-ecosistema` (hoy `firebaseConfig.storageBucket = vdsen-ecosistema.firebasestorage.app`) y confirmar región.
2. Añadir el bloque `"storage": { "rules": "storage.rules" }` a `firebase.json` y **desplegar** `storage.rules` (este PR no toca `firebase.json` ni despliega).
3. Verificar CORS del bucket para el origen de producción/staging (subida desde navegador y `<img>` desde la app cliente).
4. Verificar lectura/escritura autenticada reales (Coach: subir/cambiar/eliminar; atleta: ver imagen) y que la API de Storage esté habilitada para el proyecto.
5. Prueba en staging con un coach y un atleta reales antes de producción.
6. Opcional: política de limpieza de objetos huérfanos.
