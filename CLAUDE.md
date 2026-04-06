\# VDSEN Ecosistema — Contexto para Claude Code



\## Stack

\- HTML single-file (sin bundler, sin framework)

\- Tailwind CSS vía CDN

\- Firebase SDK modular v11.0.2 vía importmap

\- Firebase Auth (email/password)

\- Firebase Firestore (proyecto: vdsen-ecosistema)

\- jsPDF + PDF.js para exportación y lectura de PDFs

\- Vercel para deploy estático



\## Archivos principales

\- `vdsen-coach.html` — app del coach (sidebar desktop, bottom nav mobile)

\- `vdsen-cliente.html` — app del cliente (máquina de estados de workout)

\- `vercel.json` — routing y cleanUrls

\- `firestore.rules` — reglas de seguridad Firestore



\## Colecciones Firestore

\- `coaches/{uid}` — documento del coach (displayName, email, role)

\- `clients/{uid}` — clientes del coach (coachId, activePlanId, nutritionPlan, supplementPlan)

\- `exercises/{id}` — catálogo de ejercicios por coach

\- `plans/{id}` — planes de entrenamiento

\- `sessions/{clientId\_fecha}` — sesiones diarias

\- `compendio/{coachId}` — texto extraído del PDF del compendio



\## Convención de IDs

\- Sessions: `{clientId}\_{YYYY-MM-DD}`

\- Compendio: document ID = UID del coach



\## Coach de prueba

\- Email: coach@vdsen.com

\- UID existe en Firebase Auth

\- Documento en Firestore colección `coaches` con campos: displayName, email, role: "coach"



\## Reglas de edición

\- NUNCA reescribir archivos completos. Usar str\_replace quirúrgico.

\- Editar solo el bloque afectado (función, listener, sección HTML).

\- Confirmar cada cambio antes de continuar con el siguiente.



\## Problemas activos a resolver (en orden de prioridad)

1\. `currentCoach` es null al intentar crear cliente, subir compendio o generar plan con IA.

&#x20;  - Causa probable: el documento `coaches/{uid}` no existe en Firestore, o race condition en onAuthStateChanged.

2\. Botón "+ Nuevo Cliente" no funciona (mismo origen).

3\. Subida de PDF del compendio no hace nada.

4\. Routing amigable /coach y /cliente no funciona en Vercel (vercel.json configurado pero falla).



\## Mejoras pendientes

\- Feedback visual con toasts reales (no alert())

\- Loaders mientras cargan datos de Firestore

\- Modo manual de creación de planes (actualmente solo modo IA)



\## API Key Anthropic

\- NO está en el código

\- El coach la ingresa en Configuración → se guarda en localStorage como `vdsen\_apikey`

\- Modelo a usar: claude-sonnet-4-20250514



\## Deploy

\- GitHub repo: vdsen-ecosistema (privado)

\- Vercel conectado al repo, auto-deploy en push a main

\- URLs: https://vdsen-ecosistema.vercel.app/vdsen-coach.html

