# Entorno de staging de Firebase (T540)

| Elemento | Valor |
|---|---|
| Proyecto de staging | `vdsen-ecosistema-staging` (número 436059785391) — NUEVO |
| Producción | `vdsen-ecosistema` — sin cambios |
| Fuera de alcance | `vdsen-planes` — sin cambios |
| Firestore | `(default)`, nativo, STANDARD, `nam5` (ubicación leída en modo solo metadatos de producción) |
| Auth | solo Email/Password (`firebase.json` → `auth.providers.emailPassword`); sin anónimo, Google ni teléfono |
| App web | «VDSEN Staging» (`1:436059785391:web:3dcbe6ae6cf80abc092c5a`); config en `config/firebase-staging.config.json` (la clave web de Firebase no es un secreto, pero el archivo es solo de staging y ninguna app lo carga) |
| Datos | vacío: 0 usuarios, 0 documentos; nada copiado de producción |
| Reglas / índices | NO desplegados todavía |

Se habilitó la API de Firestore únicamente en el proyecto de staging (necesario para crear la base).

Uso: siempre con proyecto explícito, p. ej. `npx firebase-tools@latest deploy --only firestore:rules --project staging`. `.firebaserc` no define proyecto por defecto.
