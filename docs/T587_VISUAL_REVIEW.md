# T587 · Revisión visual del Cliente (propuesta pendiente de aprobación del propietario)

**Estado:** propuesta en PR en borrador. **No se fusiona ni se despliega sin aprobación.**

## Qué se revisó (y qué no existe)
| Fuente | Estado |
| --- | --- |
| Cliente en producción hoy (`9654ecb`, diseño del PR #87 / T585) | Revisado en navegador (390 px). |
| Diseño anterior funcional (`1b63208`, T584, antes de T585) | Revisado en navegador (390 px), mismos datos. |
| PR #87 (capa "élite", logo oficial recortado, tipografía Saira) | Revisado: es lo que está en producción. |
| Rama `codex/client-visual-editorial-20261019` | **No existe en el remoto** (solo se conoce por una nota de estado de otra sesión); su contenido no se inventa ni se revisó. Si está en otra máquina, hay que publicarla para compararla. |
| Otras ramas visuales del remoto (`feat/t573-client-visual-premium`, `feat/client-visual-polish`, `design/client-elite-visual`, …) | Anteriores a T585 o ya incorporadas; no hay una propuesta reciente distinta. |

Capturas comparativas (390 px, Inicio y registro de series): carpeta `T587_visual_comparison/` (1 anterior · 2 producción hoy · 3 propuesta).

## Hallazgos sobre el diseño en producción
1. **Introduje una tipografía nueva (Saira, con cursivas en los títulos) sin aprobación.** Contradice la regla de no añadir tipografías ni cambios de marca; la propuesta la retira por completo y vuelve a Inter (texto y títulos) + IBM Plex Mono (datos) + el logo oficial.
2. **Decoración innecesaria:** degradados en tarjetas, sombras de profundidad, botón con relieve, barra lima animada en la navegación, animación de entrada de pestañas.
3. **Encabezado más alto y ruidoso:** logo grande + dos líneas de texto + datos del atleta.
4. Jerarquía del registro de series correcta (se conserva); el espacio vertical del panel de series era generoso.

## La propuesta (solo CSS, sin tocar marcado, datos ni lógica; claro y oscuro)
* Sin Saira ni cursivas; títulos en Inter 800; el logo oficial se conserva (recorte de la imagen oficial, 26 px de alto; 22 px bajo 390 px).
* Encabezado de una fila: logo + "COACH AYRTON" + datos del atleta; se oculta el subtítulo decorativo "PERFORMANCE SYSTEM".
* Superficies planas (un solo color de placa, una línea fina, sin degradado ni sombra); CTA lima plano; barra de progreso sólida; el valor de progreso conserva el acento.
* Navegación inferior plana: el elemento activo se marca con icono lima y etiqueta en hueso (sin barra ni tinte).
* Panel de series con un poco menos de relleno vertical para ver más del formulario sin desplazarse.
* Se mantiene el resumen final (PR #94) y todo el contenido; no se agregaron elementos.

## Pendiente (requiere decisión del propietario)
Aprobar, pedir ajustes concretos (indicando qué no te gustó) o descartar. Con aprobación: fusionar, release protegido y rebaseline. Áreas aún sin pasar por revisión autenticada con datos reales: calendario/historial, nutrición, check-in, perfil y tema claro completo.
