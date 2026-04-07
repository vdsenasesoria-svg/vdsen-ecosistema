# VDSEN Ecosistema — Contexto para Claude Code

## Stack

- HTML single-file (sin bundler, sin framework)
- Tailwind CSS vía CDN
- Firebase SDK modular v11.0.2 vía importmap
- Firebase Auth (email/password)
- Firebase Firestore (proyecto: vdsen-ecosistema)
- jsPDF + PDF.js para exportación y lectura de PDFs
- Vercel para deploy estático

## Archivos principales

- `vdsen-coach.html` — app del coach (sidebar desktop, bottom nav mobile)
- `vdsen-cliente.html` — app del cliente (máquina de estados de workout)
- `vercel.json` — routing con rewrites `/coach` → `/vdsen-coach.html` y `/cliente` → `/vdsen-cliente.html`
- `firestore.rules` — reglas de seguridad Firestore

## Colecciones Firestore

- `coaches/{uid}` — documento del coach (displayName, email, role)
- `clients/{uid}` — clientes del coach (coachId, activePlanId, nutritionPlan, supplementPlan)
- `exercises/{id}` — catálogo de ejercicios por coach
- `plans/{id}` — planes de entrenamiento
- `sessions/{clientId_fecha}` — sesiones diarias
- `compendio/{coachId}` — texto extraído del PDF del compendio

## Convención de IDs

- Sessions: `{clientId}_{YYYY-MM-DD}`
- Compendio: document ID = UID del coach

## Coach de prueba

- Email: coach@vdsen.com
- UID existe en Firebase Auth
- Documento en Firestore colección `coaches` con campos: displayName, email, role: "coach"
- Si el doc no existe al login, se crea automáticamente en `onAuthStateChanged`

## Reglas de edición

- NUNCA reescribir archivos completos. Usar str_replace quirúrgico.
- Editar solo el bloque afectado (función, listener, sección HTML).
- Confirmar cada cambio antes de continuar con el siguiente.

## Estado actual (resuelto)

Los siguientes problemas fueron resueltos:

- `currentCoach` null: `onAuthStateChanged` setea `currentCoach = user` y crea el doc `coaches/{uid}` si no existe. Guards con toasts en todas las funciones que lo requieren.
- Botón "+ Nuevo Cliente": funcional, crea doc en `clients/` y muestra toast de confirmación.
- Subida PDF compendio: `uploadCompendioBtn` extrae texto con PDF.js y lo guarda en `compendio/{uid}`.
- Routing Vercel: `vercel.json` con rewrites para `/coach` y `/cliente`.
- Toasts reales: `showToast()` implementado en ambos archivos (no más `alert()`).
- Modo manual de planes: `manualModeBtn` + editor por días + `saveManualPlan()` implementados.

## Mejoras pendientes

- Loaders/spinners mientras cargan datos de Firestore
- Función "Ver" detalle de cliente (actualmente muestra toast "Detalles próximamente")
- Función "Eliminar" ejercicio del catálogo (actualmente muestra toast "Eliminar pendiente")

## API Key Anthropic

- NO está en el código
- El coach la ingresa en Configuración → se guarda en localStorage como `vdsen_apikey`
- Modelo a usar: claude-sonnet-4-20250514

## Deploy

- GitHub repo: vdsen-ecosistema (privado)
- Vercel conectado al repo, auto-deploy en push a main
- URLs: https://vdsen-ecosistema.vercel.app/vdsen-coach.html
- URLs amigables: /coach y /cliente
