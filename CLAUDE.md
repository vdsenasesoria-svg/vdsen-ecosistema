# VDSEN Ecosistema — Contexto para Claude Code

## Stack

- HTML single-file (sin bundler, sin framework)
- Tailwind CSS vía CDN
- Firebase SDK modular v10.12.0 vía CDN (gstatic)
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

- `coaches/{uid}` — doc del coach (displayName, email, role)
- `clients/{uid}` — clientes (coachId, activePlanId, nutritionPlan, supplementPlan)
  - `nutritionPlan`: `{ calorias, proteina, carbos, grasas, texto }`
  - `supplementPlan`: `{ texto }`
- `exercises/{id}` — catálogo de ejercicios por coach (name, motorPattern, equipment, muscleType, fatigueCost, resistanceCurve, coachId)
- `plans/{id}` — planes de entrenamiento `{ weeks, daysPerWeek, days:[{dayIndex, label, exercises:[{exerciseName, sets:[{setIndex, repsTarget, rirTarget, load, restSeconds}]}]}], coachId, clientId, status, generatedBy, createdAt }`
- `logs/{uid}` — registros de entrenamiento del cliente (ID = UID del cliente) `{ entries: {key: value}, currentWeek }`
- `compendio/{coachId}` — texto extraído del PDF del compendio

## Estructura LOGS (cliente)

Claves en `entries`:
- `log_{W}_{D}_{E}_s{S}` — set registrado `{ carga, reps, unit, done, rir, rir_real, ics, pump, ts }`
- `done_{W}_{D}` — sesión completada (boolean)
- `postsession_{W}_{D}` — check-in post-sesión `{ eimd, articular, patron, sleep, rpe }`
- `progrec_{W}_{D}` — recomendaciones de progresión generadas `{ recommendations:[], deloadTriggers:[] }`
- `ci_sem_{W}` — check-in semanal `{ peso, hrv, who5 }`

## Algoritmo de progresión VDSEN v3.1

- ICS (1-10): calidad de serie por set. <7 = técnica mala → bajar carga
- Pump (1-3): 1=bueno, 2=ok, 3=bajo
- EIMD post-sesión (1-3): dolor muscular
- Articular: si/no + patrón afectado
- Sleep: horas
- RPE sesión: 1-10
- Semana 6 = deload automático
- Recomendaciones guardadas en `progrec_{W}_{D}` → coach las ve en panel de monitoreo

## Reglas de edición

- NUNCA reescribir archivos completos. Usar str_replace quirúrgico.
- Editar solo el bloque afectado.
- Push directo a main sin PR (flujo acordado con el usuario).

## Estado actual — funcionalidades implementadas

### App Coach (`vdsen-coach.html`)
- Login con Firebase Auth, crea doc `coaches/{uid}` si no existe
- Lista de clientes con auto-vinculación de clientes huérfanos
- Crear cliente: modal con nombre/email/contraseña, crea Auth + Firestore
- Si email ya existe en Auth → recupera UID e intenta vincular
- Ver cliente: modal con plan, nutrición y suplementación
- Editar plan: editor por día/ejercicio (nombre, series, reps, RIR) + guardar en Firestore
- Eliminar plan: quita `activePlanId` del cliente y borra el doc de `plans/`
- Nutrición: editor con campos Kcal, Proteína, Carbohidratos, Grasas + texto libre
- Suplementación: textarea libre
- Importar plan desde texto (copiar/pegar) con parser flexible
- Importar plan desde PDF con PDF.js + mismo parser
- Catálogo de ejercicios: crear con muscleType/fatigueCost/resistanceCurve, eliminar
- Panel de monitoreo: selecciona cliente → muestra semana, RIR objetivo, alertas de deload, recomendaciones de `progrec`
- Extracción inteligente de compendio PDF (filtra farmacología/nutrición/bibliografía)

### App Cliente (`vdsen-cliente.html`)
- Login con Firebase Auth (proyecto vdsen-ecosistema)
- `loadPlan`: lee `clients/{uid}` → `activePlanId` → `plans/{activePlanId}`, convierte al formato del renderer
- Si sin plan → pantalla de espera
- Registro de series: carga, reps, RIR real, ICS (1-10), Pump (1-3)
- Botón `=` en serie 2+: copia carga/reps/RIR/ICS/Pump de la serie anterior
- Unidad KG/LB por ejercicio (toggle independiente por ejercicio)
- Completar sesión → modal post-sesión (EIMD, dolor articular, sueño, RPE)
- Algoritmo progresión: calcula recomendaciones por ejercicio y las guarda en logs
- Semana 6 = deload automático
- Tabs: Resumen, Entrenamiento, Nutrición, Check-in, Perfil
- Logs guardados en `logs/{uid}` (por UID, no por email)

## Deploy

- GitHub repo: vdsenasesoria-svg/vdsen-ecosistema (privado)
- Vercel conectado al repo, auto-deploy en push a main
- URLs: https://vdsen-ecosistema.vercel.app/vdsen-coach.html
- URLs amigables: /coach y /cliente
- Push directo a main (sin PRs)
