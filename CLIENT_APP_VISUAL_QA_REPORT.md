# VDSEN Client App — QA visual autenticado

Fecha: 2026-09-26

Baseline solicitado: `588bbea8eb39b1cba4d703aa7b7c05758f1d7509`

Alcance: Client App únicamente. Coach App fuera de alcance y sin cambios.

## Resultado ejecutivo

**FAIL de cierre / NO congelar todavía.** No se detectó un BLOCKER funcional nuevo en el código local y todas las pruebas automatizadas pasan, pero la versión publicada disponible para la sesión autenticada no corresponde al baseline solicitado. La publicación observada identifica la UI como `v3.2` y no contiene todavía “Cómo realizarlo” ni los módulos avanzados agregados en `588bbea`. Por tanto, los escenarios B–M no pudieron validarse visualmente con autenticación real y no corresponde declarar el QA completo como PASS.

Sí se completó una auditoría autenticada read-only del cliente legacy publicado, una revisión visual responsive, una revisión de contratos/fallbacks del baseline local y dos correcciones de accesibilidad vinculadas a hallazgos reproducibles.

## Entorno

- Windows, Chrome, sesión real de cliente ya autenticada.
- URL: `https://vdsen-ecosistema.vercel.app/cliente`.
- Rama local: `codex/client-app-next`.
- Baseline local verificado antes de los cambios: `588bbea8eb39b1cba4d703aa7b7c05758f1d7509`.
- No se encontraron credenciales de prueba ni un harness visual autenticado autorizado en el repositorio.
- No se creó ninguna cuenta, no se alteró autenticación y no se desplegó el baseline a producción.
- No se enviaron check-ins ni se modificaron datos reales.

## Perfiles y cobertura

| Perfil | Cobertura | Resultado |
| --- | --- | --- |
| A. Cliente legacy normal | Sesión real autenticada, plan válido, sin módulos competitivos visibles | PASS parcial visual |
| B. Cliente normal con técnica | Fixtures/contratos T446; no visible en la publicación autenticada | PASS automatizado / visual pendiente |
| C. Instrucciones parciales | Fixture T446 para ejecución parcial y headings vacíos | PASS automatizado / visual pendiente |
| D. Sin instrucciones | Fixture T446; no se genera sección vacía | PASS automatizado / visual pendiente |
| E. Competitive Physique | Contratos T447 de visibilidad explícita | PASS automatizado / visual pendiente |
| F. Posing | Adapter y check-in opcional verificados por T447/suite | PASS automatizado / visual pendiente |
| G. Cardio + NEAT | Separación explícita verificada por T447 | PASS automatizado / visual pendiente |
| H. Stage Readiness | Estados cualitativos verificados por T447 | PASS automatizado / visual pendiente |
| I. Health | Visibilidad independiente y explícita verificada por T447 | PASS automatizado / visual pendiente |
| J. Pharmacology Context | Lista permitida; sin dosis, ciclos, stacks ni PCT, verificada por T447 | PASS automatizado / visual pendiente |
| K. Trial Peak / Peak Week | Gate `approved` + `clientVisible` verificado por T447 | PASS automatizado / visual pendiente |
| L. Post-Contest | Render condicional/fallback cubierto por la suite | PASS automatizado / visual pendiente |
| M. Datos incompletos | Fallbacks de técnica y módulos sin contenido cubiertos por T446/T447 | PASS automatizado / visual pendiente |

## Viewports auditados

- 375 × 812 px: Entreno y Check-in.
- 390 × 844 px: Inicio, Entreno, Nutrición, Check-in y Perfil.
- 768 × 900 px: Inicio y comportamiento responsive intermedio.
- 1440 × 900 px: Inicio desktop.
- El override temporal de viewport se restableció al terminar; Chrome volvió a 1536 px de ancho.

En todos los viewports auditados el `scrollWidth` coincidió con el ancho disponible: no se observó overflow horizontal. La navegación inferior, scroll vertical, encabezado y elementos sticky permanecieron operables.

## Hallazgos por severidad

### BLOCKER

- **QA-BLOCKER-001 — baseline no desplegado en el entorno autenticado.** La versión publicada es anterior al baseline y no permite observar los módulos recién implementados. Es un bloqueo de validación, no un defecto demostrado del código local. Impide cerrar B–M y congelar Client App.

### HIGH

- Ninguno demostrado.

### MEDIUM

- **VQA-001 — objetivos táctiles inferiores a 44 px.** En producción se midieron acciones de 22–35 px en Entreno. El código local conservaba controles compactos equivalentes en cierre semanal, unidad, opciones, calentamiento y nota. Corregido con un mínimo común de 44 × 44 px y controles de unidad operables por teclado.
- **VQA-002 — inputs legacy de Check-in sin etiqueta accesible.** Peso, HRV, sueño, medidas corporales, ICS y notas no tenían `label` asociado ni nombre ARIA. Corregido con `label for` y nombres contextuales para ICS.

### LOW

- **VQA-003 — texto `NaN` al inicio del Check-in publicado.** Reproducido en la versión publicada después de navegar y después de refresh. El baseline local no contiene esa concatenación defectuosa: `renderCheckin()` inicia con una cadena HTML válida. Se registra como desfase de despliegue; no se añadió un parche artificial al código actual.

### COSMETIC

- Ninguno que justifique cambios.

## Correcciones aplicadas

Archivo de producto modificado: `vdsen-cliente.html`.

- Clase reusable `tap-target` con mínimo 44 × 44 px.
- Aplicación a cierre semanal, unidad, opciones, calentamiento y nota de ejercicio.
- Selector de unidad convertido de `div` con click a `button` enfocable.
- Nombres accesibles para controles compactos.
- `label for` en campos numéricos legacy del Check-in y notas para coach.
- Nombres contextuales para inputs ICS y para el nombre de ejercicio libre.

No se cambió ningún contrato de escritura, ruta Firestore, schema, ID estable ni lógica clínica/de programación.

## Evidencia visual y funcional

Pantallas auditadas en la sesión autenticada:

- Inicio;
- Entreno;
- Nutrición;
- Check-in;
- Perfil.

Comprobaciones realizadas:

- entrada autenticada y persistencia de sesión tras refresh;
- navegación entre las cinco áreas principales;
- expansión y cierre del acordeón “Qué es RIR y qué es ICS”;
- ausencia de overflow horizontal en los cuatro tamaños;
- medición de targets táctiles e inventario de labels de inputs;
- consola sin warnings ni errores durante el recorrido;
- ausencia de módulos Competitive/Health/Pharmacology en el cliente normal publicado.

Se capturaron vistas durante la auditoría en la herramienta de navegador, pero no se guardaron archivos de screenshot porque contenían nombre y métricas reales del cliente. Esto evita persistir datos sensibles. No existe evidencia before/after autenticada de las correcciones porque el baseline corregido no está desplegado y no hay harness de autenticación local autorizado.

No se probaron logout/login ni submit de Check-in: cerrar la única sesión habría impedido continuar sin credenciales de prueba, y guardar habría transmitido datos reales de salud. La persistencia de sesión sí se validó con refresh. Los estados de guardado, error, rollback y aislamiento semanal quedan cubiertos por la suite automatizada existente.

## Pruebas

- T446 — técnica por ejercicio: 12 aserciones PASS.
- T447 — privacidad y módulos avanzados: 11 aserciones PASS.
- T448 — accesibilidad derivada del QA visual: 9 aserciones PASS.
- Suite completa disponible: **272/272 archivos PASS**.
- Sintaxis del script principal de `vdsen-cliente.html`: PASS.
- `git diff --check`: PASS.
- Diff de `vdsen-coach.html` contra el baseline: vacío.
- No hay scripts de lint, typecheck, build ni harness visual/e2e definidos en `package.json`.

## Riesgos residuales y criterio de freeze

1. Desplegar el commit final en un preview o entorno autenticado seguro.
2. Repetir visualmente B–M con fixtures representativos y autorizados.
3. Confirmar que `NaN` desaparece al quedar alineado el despliegue.
4. Revalidar submit/loading/success/error del Check-in con una cuenta de prueba, no con datos reales.
5. Solo después de esos cuatro puntos puede declararse PASS y congelarse Client App.
