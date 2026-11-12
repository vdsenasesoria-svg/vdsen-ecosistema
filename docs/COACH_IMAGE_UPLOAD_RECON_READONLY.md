# FASE 11 — Reconocimiento read-only: `claude/coach-image-upload-v1`

**Estado: RECONOCIMIENTO ÚNICAMENTE. No se portó ni se mergeó nada. No se creó infraestructura de Storage.**

Fecha del reconocimiento: ver el commit de este documento. Rama inspeccionada:
`origin/claude/coach-image-upload-v1` @ `019412ac2230`.

---

## 1. Posición de la rama

| Dato | Valor |
|---|---|
| HEAD | `019412ac2230` |
| merge-base con canónica | `794929c71752bd3945ded7503158cb37b5bd495a` |
| commits propios | 22 |
| canónica por delante | 79 |

De esos 22 commits, **18 son el trabajo de Coach Next / client export que YA fue portado** por
intención (los tres de runtime hardening y los quince del export). Los **3 commits nuevos** que esta
rama aporta por encima son:

| Commit | Contenido |
|---|---|
| `4214b62` | `docs(coach): image upload discovery - storage architecture required` |
| `cba6948` | `feat(coach): add storage-backed exercise image upload` |
| `672c8f9` | `test(coach): cover exercise image storage lifecycle` |
| `019412a` | `docs(coach): document exercise image storage architecture` |

---

## 2. Superficie nueva que introduce

```
A  assets/exercise-image-upload.js          (cliente de subida)
A  storage.rules                            (NUEVO — no existe en canónica)
A  scripts/storage-emulator-lib.cjs         (emulador de Storage)
A  scripts/coach-image-storage-rules.cjs    (runner de reglas de Storage)
A  scripts/coach-image-upload-e2e.cjs       (E2E de subida)
A  tests/coach-image-upload.test.js
A  docs/COACH_IMAGE_UPLOAD_DISCOVERY.md
A  docs/COACH_IMAGE_UPLOAD_STORAGE.md
```

---

## 3. Arquitectura que propone

**Opción A: Firebase Storage.** El descubrimiento documenta que la subida de imágenes **exige
infraestructura de Storage**, que hoy no existe en la canónica.

`storage.rules` es un archivo **enteramente nuevo**. Su modelo:

- **Topología de ownership derivada de `firestore.rules`**: un Coach es un usuario de Auth con
  documento `coaches/{uid}`; `request.auth.uid == exercises/{id}.coachId`.
- **Ruta**: `exercise-media/{coachId}/{exerciseId}/image-<16 hex>`.
- **Reemplazo bajo nombre NUEVO**: subir sobre el mismo nombre rotaría el download token y mataría la
  URL antigua todavía referenciada. El archivo viejo se borra después.
- **Todo lo demás denegado por defecto.**
- **Sólo imágenes, sin SVG/HTML**: `contentType in ['image/jpeg','image/png','image/webp']` y
  `size > 0 && size <= 512 KB` como techo duro del servidor (el navegador re-codifica a ~350 KB).
- `allow read: isCoachOwner || athleteOfCoach` · `allow create/update: isImageName && ownsExercise &&
  validImage` · `allow delete: isImageName && isCoachOwner` (sólo su propio namespace).

---

## 4. Por qué NO se puede empezar sin decisión del owner

1. **`storage.rules` no existe en la canónica.** Introducirlo es una **superficie de seguridad nueva**,
   no una extensión de lo existente. Requiere su propio review y su propio carril de release: el
   runbook actual es `release_mode ∈ {rules_only, app_only}` para **Firestore**; Storage no está
   contemplado.
2. **Hace falta un emulador de Storage** (`storage-emulator-lib.cjs`) que tampoco existe.
3. **Toca exactamente las áreas excluidas de este mandato**: Storage y el proyecto Firebase. El
   mandato vigente dice explícitamente **SIN Nutrition/Supplements/Storage**.
4. **La rama está 79 commits por detrás.** Portarla sería portar por intención, como con el export —
   su `vdsen-coach.html` divergió y su glue no aplica.
5. **Riesgo de fuga por URL firmada**: el propio diseño reconoce que reemplazar un objeto rota su
   download token. Cualquier implementación necesita revisar con cuidado qué URLs quedan vivas y si
   imágenes de un cliente pueden alcanzar a otro.

---

## 5. Recomendación

**Es la fase siguiente correcta** (coincide con la recomendación previa: *Coach image upload /
Storage*, no Nutrition ni Supplements), pero **no debe empezar dentro de este mandato**. Antes hace
falta:

1. Decisión explícita del owner de abrir el frente **Storage**.
2. Definir cómo se liberan las **reglas de Storage** (equivalente al runbook de Firestore, pero para
   Storage): capturar las reglas vivas, hash, referencia inmutable, rollback.
3. Aceptar que `storage.rules` entra en la **superficie servida / de seguridad** y por tanto en el
   manifiesto desplegado una vez desplegado.

---

## 6. Lo que este reconocimiento NO hizo

- No se escribió ni un byte de código de producto para image upload.
- No se creó `storage.rules` en la canónica.
- No se habilitó Firebase Storage.
- No se hizo merge ni cherry-pick de la rama.
- No se tocó la canónica (`e3828bdd`) ni `main` (`f6596ba`).
