# T604 — cierre de CI y hardening temporal pre-piloto

## Alcance y custodia

- HEAD canónico de inicio: `c1421c07a45594d01aa72f27e8e99ef70dc1d279`.
- Rama de trabajo: `fix/t604-temporal-marker-hardening`.
- Sin despliegues, cambios de IAM, secretos, datos reales, `main` ni reglas productivas.
- `firestore.rules` conserva el blob `7cd6458ab26b34fbfb3dcd7a4d37389737db1ea3` de `c1421c0`. `firestore.t603.rules` sigue siendo solamente la candidata usada por el emulador.
- Numeric Apply sigue apagado en las fuentes distribuidas.

## Diagnóstico de CI #137

El run `40159842341` falló únicamente en la aplicación del resultado del gate:

- El gate unitario del artefacto informó PASS.
- El paso de emulador terminó como paso de Actions exitoso, pero su JSON dice `Structured test events missing; fail closed`.
- El SHA evaluado por ese run fue `af4590f0681e05a723099affa836a46b7fd14100`; su diff contra `c1421c0` contiene solamente `docs/T603_TEMPORAL_SECURITY_HANDOFF.md`.

La reproducción local del gate canónico en `c1421c0` emitió eventos `VDSEN_TEST_EVENT` y terminó PASS con 211 PASS / 0 FAIL / 0 regresiones. Por ello no hay evidencia de regresión funcional en #137; el fallo queda clasificado como recolección transitoria del arnés/runner, no como PASS histórico. La repetición del mismo run terminó `SUCCESS` el 24-oct-2026.

## Defectos confirmados y corrección

1. `_writeStartMarkers` fijaba el estado local antes de conocer el resultado de `setDoc`. Una caída transitoria bloqueaba el reintento durante la sesión.
   - Ahora distingue `PENDING`, `CONFIRMED`, `EXISTS` y `PERMANENT`.
   - Un error transitorio libera el estado para un reintento posterior acotado (máximo dos), sin cola nueva ni espera en Guardar serie.
   - Un `permission-denied` verifica por lectura si otro dispositivo creó el documento: se vuelve `EXISTS`; si no existe, queda `PERMANENT`.
   - El marcador sigue siendo create-only y se emite después de iniciar la escritura del log; el registro no depende del marcador.

2. `_reconcileAppliedOverlays` de Coach llamaba a consumo sin `refs.start` ni `refs.decision`.
   - Esa ruta podía evaluar el inicio/decisión con valores de dispositivo en vez de los documentos sellados por Firestore.
   - Ahora pasa las referencias inmutables de marcador y decisión. El consumidor activa `trustedStarts` y reemplaza decisiones únicamente cuando existe su registro sellado.

## Validación realizada

- Focal temporal: 42 PASS / 0 FAIL (`T599-R`, `T602`, `T603`, `T604`).
- Rules temporal real: ejecutado mediante el emulador candidato local y usuarios sintéticos; sin tocar Firebase remoto.
- Gate unitario completo posterior al parche: PASS, 1,790 PASS / 0 FAIL / 0 regresiones.
- Gate emulador completo posterior al parche: PASS, 211 PASS / 0 FAIL / 0 regresiones.

## Riesgos residuales y condiciones de piloto

- La repetición de CI de #137 debe finalizar verde antes de considerar ese PR fusionable.
- El marcador depende de la sincronización normal de Firestore; offline queda `PENDING` hasta que el SDK sincronice, sin perder el log.
- La inferencia temporal usa sellos de servidor solamente en rutas autoritativas; clientes de visualización mantienen compatibilidad con `sts` sin poder consumir/aplicar por esa vía.
- Sigue faltando autorización explícita y verificaciones de entorno para habilitar Numeric Apply, canario, allowlist o cualquier despliegue de Rules.

## Autonomía post-activación

El flujo ordinario no requiere una aprobación manual del Coach por serie ni por progresión:

- Tras una escritura confirmada, Cliente llama de fondo a `_scheduleTrustedProgression`; el endpoint autenticado relee documentos canónicos y materializa la evaluación sin usar evidencia del request.
- El ejecutor conserva la autonomía de evaluación y seguimiento; `coachInterventions` son únicamente una prioridad explícita/excepcional cuando existen.
- Las rutas de seguridad devuelven estados de revisión, bloqueo o diferimiento sin convertir al Coach en un aprobador rutinario.

El bloqueo real actual no es una dependencia funcional del Coach: `AUTONOMOUS_PROGRESSION_NUMERIC_APPLY_ENABLED` permanece OFF y la aplicación requiere, además, la valla de release y el canario autorizados. Con el flag apagado el Motor puede conservar PENDING/observación, pero no aplica cambios numéricos a la próxima exposición. Activar esas vallas es una decisión de release fuera de T604.

## Dictamen

**NO-GO para piloto productivo.** El código endurece la recuperación y la autoridad temporal en el entorno de prueba, pero no autoriza ni ejecuta activación numérica, despliegue o cambios de Rules.
