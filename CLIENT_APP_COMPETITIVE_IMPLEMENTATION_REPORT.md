# VDSEN Client App — Competitive Physique implementation report

Fecha: 2026-09-26  
Baseline: `30146d0b42bdf4f70438c24eb8c3f64869d2492e`

## Alcance implementado

La implementación está contenida en `vdsen-cliente.html`. No modifica la UI, los flujos ni los contratos de escritura de `vdsen-coach.html`.

Se añadieron dos adapters de lectura:

1. técnica por ejercicio, resuelta primero por `exerciseId` contra el catálogo canónico y después por nombre para datos legacy;
2. módulos avanzados de cliente, filtrados por visibilidad explícita antes de llegar al renderer.

Los campos nuevos son opcionales. La ausencia de instrucciones, módulos competitivos o datos sensibles devuelve una cadena vacía y conserva la experiencia legacy.

## Técnica por ejercicio

El loader preserva `exerciseId` y `prescriptionExerciseId` y ahora acepta de forma opcional:

- `exerciseInstructions`;
- `athleteSpecificTechniqueNote`;
- `clientSelectionRationale`;
- `videoUrl` / `imageUrl` con `mediaClientVisible: true`.

El catálogo de `exercises` admite sin hacerlos obligatorios:

- `instructionVersion`;
- `exerciseInstructions`;
- `setupInstructions`;
- `executionInstructions`;
- `romInstructions`;
- `technicalCues`;
- `commonErrors`;
- `equipmentSettingsSchema`.

La UI muestra un bloque colapsable **CÓMO REALIZARLO** con las secciones disponibles: Setup, Ejecución, ROM, Claves técnicas y Evita. La nota específica del atleta se mantiene separada y tiene prominencia visual como **AJUSTE PARA TI**. No se fabrican posiciones de asiento, medidas ni configuraciones de máquina.

Cuando existe un rationale expresamente destinado al cliente, aparece en **¿POR QUÉ ESTE EJERCICIO?**. No se expone decision trace, scoring, confidence, IDs ni heurísticas del motor.

## Competitive Physique y dominios relacionados

La pantalla Inicio puede presentar, solo si hay datos autorizados:

- evento, fecha, división, semanas restantes, foco y prioridades;
- Stage Gap cualitativo;
- Contest Prep / Prep Status;
- Posing;
- Cardio separado de Pasos / NEAT;
- Stage Readiness traducido a lenguaje de cliente;
- Trial Peak y Peak Week;
- Post-Contest Recovery;
- Salud / Monitoreo;
- Medicación / Contexto Farmacológico.

Los módulos aparecen como secciones editoriales colapsables y no como un dashboard adicional. No se generan recomendaciones de entrenamiento, nutrición, cardio, peak week ni farmacología.

## Privacidad y contratos read-only

Que un campo exista en Firestore no lo vuelve visible. El adapter exige uno de estos mecanismos:

- `clientVisible: true` en el módulo;
- `visibility: "client"`;
- `audience` que incluya `client`;
- `clientVisibility.<module>: true` en plan o cliente.

Un contenedor `competitivePhysique` explícitamente visible puede autorizar sus submódulos competitivos. `healthSurveillance` y `pharmacologyContext` nunca heredan esa autorización: requieren visibilidad propia.

Farmacología usa una lista permitida de presentación: agentes reportados, estado, fuente, controles y avisos de vigilancia. No consume ni muestra dosis, ciclos, stacks, PCT, correctores o recomendaciones.

Líquidos/sodio de Peak Week solo aparecen cuando el módulo tiene simultáneamente `approved: true` y `clientVisible: true`.

No se añadieron escrituras Firestore para estos módulos. No se modificaron `firestore.rules`, colecciones, índices ni paths.

## Check-in

Se añadieron campos opcionales para:

- pasos;
- minutos de cardio;
- minutos de posing;
- hambre;
- digestión;
- dolor;
- rendimiento percibido;
- cumplimiento de entrenamiento;
- cumplimiento de nutrición;
- molestias / limitaciones;
- síntomas reportados.

Reutilizan el documento de logs y el guardado existente. Ninguno es obligatorio y los check-ins previos continúan siendo válidos.

## Fallbacks

- Sin `exerciseInstructions`: no se renderiza el bloque y el workout legacy continúa.
- Instrucciones parciales: solo aparecen las secciones presentes.
- Sin catálogo remoto: se conserva el catálogo integrado existente.
- Sin módulos avanzados autorizados: no aparece ninguna sección competitiva o sensible.
- Datos competitivos incompletos: se omiten filas vacías; no se calcula precisión ficticia.
- Cliente no competitivo: conserva la pantalla básica.
- Cambio de usuario o sesión: catálogo, módulos avanzados y mapas por ID se limpian antes de cargar el siguiente cliente.

## Archivos modificados y nuevos

Modificados:

- `vdsen-cliente.html`

Nuevos:

- `tests/t446-client-exercise-instructions.test.js`
- `tests/t447-client-competitive-privacy.test.js`
- `CLIENT_APP_COMPETITIVE_IMPLEMENTATION_REPORT.md`
- `CLIENT_TO_COACH_FUTURE_INTEGRATION.md`

## Validación

Baseline antes del cambio: 276 archivos de prueba ejecutados; 275 PASS y 1 FAIL en `api/_firebaseAdmin.test.js` porque las dependencias declaradas aún no estaban instaladas (`firebase-admin` devolvía `MODULE_NOT_FOUND`). Después de `npm ci`, ese test pasa sin modificar su código.

Pruebas nuevas:

- T446: catálogo canónico, precedencia de nota individual, instrucciones completas/parciales/ausentes, escape HTML, identidad estable, schema y visibilidad de medios.
- T447: autorización explícita, aislamiento de Salud/Farmacología, Stage Readiness cualitativo, separación Cardio/NEAT, lista permitida farmacológica, gate de Peak Week y ausencia de cambios en Coach App.

Validación final:

- suite completa disponible: 278/278 archivos PASS;
- sintaxis del script principal de `vdsen-cliente.html`: PASS;
- `git diff --check`: PASS;
- Coach App con diff vacío: PASS;
- lint, typecheck, build e integration scripts: no definidos en `package.json`; no existe un pipeline adicional que ejecutar.

## Screenshots

No se generaron screenshots. La implementación se verificó mediante contratos, sintaxis y pruebas automatizadas; no se levantó una sesión Firebase de cliente con fixtures productivos.

## Riesgos residuales

- Aún no existe un editor Coach App para producir los nuevos campos.
- Los nombres definitivos del contrato canónico deben cerrarse antes de habilitar escrituras en Coach App.
- El marcado de sesiones de posing permanece read-only; no se inventó un write contract.
- Hace falta QA visual autenticado con fixtures autorizados para revisar contenido real, deep links y dispositivos físicos.
- El fallo preexistente de `_firebaseAdmin.test.js` debe resolverse o aislarse de las variables del entorno para obtener suite completa verde.
