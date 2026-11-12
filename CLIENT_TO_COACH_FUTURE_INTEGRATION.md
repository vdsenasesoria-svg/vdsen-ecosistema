# VDSEN — integración futura Client App → Coach App

Estado: pendiente. Este documento no autoriza ni implementa cambios en Coach App.

## Objetivo de la fase futura

Permitir que `vdsen-coach.html` produzca, revise y publique los datos opcionales que la Client App ya puede leer, sin cambiar `vdsen-plan-v2`, `days[]`, `exercises[]`, `sets[]`, `prescriptionExerciseId` ni los datos legacy.

## Contrato canónico por cerrar

Antes de implementar writes debe elegirse una única ubicación canónica. Recomendación para revisión:

- prescripción vinculada al plan: `plans/{planId}`;
- técnica general reutilizable: `exercises/{exerciseId}`;
- nota biomecánica individual: ejercicio prescrito dentro de `plans/{planId}.days[].exercises[]`;
- datos longitudinales no prescriptivos: documento del cliente o subdocumento dedicado, sujeto a reglas específicas.

La Client App admite temporalmente lectura desde plan o cliente para facilitar migración, pero Coach App no debe escribir en ambas ubicaciones como contrato permanente.

## Campos de catálogo que Coach App deberá editar

Todos opcionales:

```json
{
  "instructionVersion": "string",
  "exerciseInstructions": {
    "setup": "string",
    "equipmentSetup": "string",
    "bodyPosition": "string",
    "execution": "string",
    "rangeOfMotion": "string",
    "breathingBracing": "string",
    "tempoNotes": "string",
    "cues": ["string"],
    "avoid": ["string"]
  },
  "equipmentSettingsSchema": "object opcional"
}
```

El editor debe conservar `exerciseId`, nombre canónico, aliases, músculo, región, patrón y categoría. No debe crear IDs nuevos al actualizar técnica.

## Campos por ejercicio prescrito

Todos opcionales:

```json
{
  "exerciseId": "ID canónico existente",
  "prescriptionExerciseId": "ID estable de prescripción",
  "athleteSpecificTechniqueNote": "string",
  "clientSelectionRationale": "string exclusivamente orientado al cliente",
  "videoUrl": "string",
  "imageUrl": "string",
  "mediaClientVisible": true
}
```

La nota individual no debe sobrescribir ni convertir en universal la técnica del catálogo. El rationale no debe copiar decision trace, scores internos ni confidence.

## Módulos avanzados que requieren editor

- `competitivePhysique`;
- `competitivePriorities`;
- `stageGap`;
- `contestPrep`;
- `posing`;
- `cardio`;
- `neat`;
- `stageReadiness`;
- `trialPeak`;
- `peakWeek`;
- `postContestRecovery`;
- `healthSurveillance`;
- `pharmacologyContext`.

Cada editor debe permitir estado incompleto/null, preview de cliente y autorización explícita de visibilidad.

## Visibilidad

La Coach App deberá ofrecer un control deliberado por módulo. El contrato compatible ya leído por Client App admite:

```json
{
  "clientVisible": true
}
```

También admite un mapa `clientVisibility.<module>`, pero la fase Coach debe escoger un solo mecanismo canónico.

Reglas obligatorias:

- Salud requiere autorización propia.
- Farmacología requiere autorización propia.
- Imágenes y video requieren `mediaClientVisible: true`.
- Un módulo oculto no debe quedar visible por herencia accidental.
- El preview Coach debe mostrar exactamente la vista filtrada del cliente.

## Farmacología

El editor futuro puede registrar contexto reportado y procedencia, pero la vista cliente solo debe publicar:

- agentes reportados;
- activo/inactivo;
- procedencia;
- controles o laboratorios relacionados;
- avisos de vigilancia.

Debe mantener separados `REPORTED_PROTOCOL`, `CLINICIAN_AUTHORED_PLAN` y `VDSEN_RECOMMENDATION`. No debe generar dosis, ciclos, stacks, PCT, correctores ni prescripción autónoma.

## Peak Week

Para exponer líquidos o sodio deben coexistir:

- aprobación explícita del plan (`approved: true`);
- autorización de cliente (`clientVisible: true`);
- contenido prescrito por una fuente autorizada.

La Coach App no debe permitir que la Client App genere o modifique el protocolo.

## Posing completion

La Client App actual solo presenta prescripción y cumplimiento recibido. Si se desea marcar una sesión como completada deberá diseñarse antes:

- path Firestore;
- identidad estable de la sesión;
- idempotencia;
- aislamiento por usuario y plan;
- reglas de lectura/escritura;
- comportamiento offline y reconciliación;
- consumo posterior por Coach App.

No debe reutilizarse un índice visual como ID persistente.

## Reglas y migración

La fase Coach deberá:

1. definir el esquema definitivo y versionarlo;
2. revisar `firestore.rules` con aislamiento por coach/cliente y campos permitidos;
3. agregar validadores null-safe;
4. conservar planes sin módulos avanzados;
5. migrar solo si es necesario y con rollback verificable;
6. probar cliente legacy, cliente normal y atleta competitivo;
7. validar preview, activación, refresh, deep link y cambio de sesión;
8. confirmar que el generador no vuelve obligatorios estos dominios.

## Criterios de aceptación futuros

- Coach App puede crear, editar, ocultar y publicar cada módulo.
- Preview Coach coincide con Client App.
- Ningún módulo sensible aparece sin autorización explícita.
- Técnica canónica e individual permanecen separadas.
- `vdsen-plan-v2` y `prescriptionExerciseId` se conservan.
- Posing completion, si se implementa, tiene contrato estable y pruebas de concurrencia.
- No hay recomendaciones farmacológicas autónomas.
