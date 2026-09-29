(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VDSEN_EXERCISE_VISUAL_CATALOG = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  var PENDING_ASSET = 'assets/exercises/pending-license.svg';
  var GYM = 'Smart Fit San Diego';
  var GYM_ID = 'smart-fit-san-diego';

  function equipmentType(equipment) {
    var key = String(equipment || '').toLowerCase();
    if (key.indexOf('mancuer') !== -1) return 'free_weight';
    if (key.indexOf('barra hex') !== -1) return 'trap_bar';
    if (key.indexOf('barra') !== -1) return 'barbell';
    if (key.indexOf('polea') !== -1 || key.indexOf('cable') !== -1) return 'cable';
    if (key.indexOf('banco') !== -1 || key.indexOf('bench') !== -1) return 'bench';
    if (key.indexOf('accesorio') !== -1) return 'other_functional_equipment';
    return 'machine';
  }

  function entry(exerciseId, exerciseName, equipment, objective, setup, execution, commonErrors, variants, aliases) {
    return {
      exerciseId: exerciseId,
      exerciseName: exerciseName,
      name: exerciseName,
      gym: GYM,
      gymId: GYM_ID,
      equipment: equipment,
      equipmentType: equipmentType(equipment),
      imageUrl: null,
      assetRef: PENDING_ASSET,
      imageStatus: 'pending_license',
      instructions: objective,
      technicalObjective: objective,
      setup: setup,
      execution: execution,
      commonErrors: commonErrors || [],
      variants: variants || [],
      aliases: aliases || []
    };
  }

  var smartFitSanDiego = [
    entry('sf-sd-belt-squat', 'Belt Squat', 'Belt Squat',
      'Entrenar el patrón de sentadilla con alta demanda de cuádriceps y glúteo, reduciendo la carga axial sobre el tronco.',
      'Coloca el cinturón sobre la pelvis, engancha el mosquetón centrado y apoya ambos pies completos a una anchura estable. Ajusta la altura para poder liberar el seguro sin encogerte.',
      'Libera el seguro, desciende con pelvis y rodillas coordinadas hasta el rango tolerado y asciende empujando la plataforma con todo el pie. Mantén abdomen activo y rodillas siguiendo la dirección de los dedos.',
      ['Enganchar el cinturón sobre el abdomen en vez de la pelvis.', 'Despegar talones o colapsar las rodillas hacia dentro.', 'Rebotar en el fondo o perder control pélvico.'],
      [{ name:'Belt Squat — postura media', objective:'Equilibrio entre cuádriceps y glúteo.' }],
      ['sentadilla belt squat']),

    entry('sf-sd-pendulum-squat', 'Sentadilla Pendular / Sentadilla Perfecta', 'Sentadilla Pendular',
      'Realizar una sentadilla guiada estable; la posición de pies modifica el énfasis sin cambiar la identidad del equipo.',
      'Ajusta la plataforma y el tope de profundidad antes de cargar. Coloca hombros y espalda firmes en los apoyos y ubica los pies según la variante prescrita.',
      'Desbloquea el seguro, desciende controlando rodillas y pelvis, conserva apoyo completo del pie y sube sin bloquear agresivamente las rodillas.',
      ['Cambiar la posición de pies respecto a la variante prescrita.', 'Perder contacto con respaldo o talones.', 'Forzar profundidad cuando la pelvis pierde control.'],
      [
        { name:'Sentadilla Pendular — plataforma alta / pies bajos', objective:'Mayor flexión de rodilla y énfasis relativo en cuádriceps.', setup:'Plataforma alta; pies en la zona baja, simétricos.' },
        { name:'Sentadilla Pendular — plataforma baja / pies medios', objective:'Distribución más equilibrada entre cuádriceps y cadera.', setup:'Plataforma baja; pies a media altura.' },
        { name:'Good Morning en Sentadilla Pendular', objective:'Bisagra guiada con énfasis en glúteo e isquios.', setup:'Pies estables y rodillas con flexión leve fija.', execution:'Lleva la cadera atrás manteniendo el tronco rígido; vuelve extendiendo la cadera.' }
      ],
      ['Sentadilla Perfecta', 'Sentadilla Pendular']),

    entry('sf-sd-impulse-chest-press-plate-loaded', 'Press de Pecho discos Impulse', 'Impulse · discos',
      'Empuje horizontal estable con el pectoral como limitante principal.',
      'Ajusta el asiento para que las manijas queden a la altura media del pecho. Apoya pies, glúteos y espalda; retrae suavemente las escápulas.',
      'Empuja hacia delante sin elevar los hombros. Regresa con control hasta un estiramiento cómodo y repite sin perder la posición del torso.',
      ['Asiento demasiado alto o bajo.', 'Hombros hacia las orejas.', 'Rebotar en el final del recorrido.'], [], ['Press Pecho discos Impulse']),

    entry('sf-sd-impulse-incline-press-plate-loaded', 'Press Inclinado discos Impulse', 'Impulse · discos',
      'Empuje inclinado con énfasis en pectoral clavicular y deltoide anterior.',
      'Ajusta el asiento para alinear las manijas con la zona superior del pecho. Mantén pies firmes y espalda apoyada.',
      'Empuja en la trayectoria guiada hacia delante y arriba. Controla la vuelta hasta un estiramiento tolerable sin adelantar los hombros.',
      ['Convertirlo en press vertical por un asiento demasiado bajo.', 'Despegar glúteos o arquear en exceso.', 'Acortar la fase excéntrica.'], [], ['Press Inclinado Impulse']),

    entry('sf-sd-impulse-shoulder-press-plate-loaded', 'Press de Hombro discos Impulse', 'Impulse · discos',
      'Empuje vertical estable para deltoides y tríceps.',
      'Regula el asiento para iniciar con las manijas cerca de la altura de hombros. Apoya tronco y pies; activa el abdomen.',
      'Empuja arriba siguiendo la guía de la máquina y baja controlado hasta el rango cómodo del hombro.',
      ['Hiperextender la zona lumbar.', 'Bajar más allá del rango tolerado.', 'Elevar los hombros hacia las orejas.'], [], ['Press Hombro discos Impulse']),

    entry('sf-sd-impulse-seated-chest-press', 'Press de Pecho Sentado Impulse', 'Impulse · peso integrado',
      'Empuje horizontal de pecho con estabilidad y ajuste rápido de carga.',
      'Selecciona la carga y ajusta el asiento para alinear agarres y pecho medio. Apoya completamente la espalda.',
      'Empuja sin perder la posición escapular y vuelve de forma controlada hasta el rango útil.',
      ['Separar la espalda del respaldo.', 'Bloquear los codos con impacto.', 'Usar impulso del torso.'], [], ['Press Pecho Sentado Impulse']),

    entry('sf-sd-impulse-vertical-chest-adduction', 'Aducción Vertical (cross over vertical) de Pecho Impulse', 'Impulse · peso integrado',
      'Aducción del hombro para trabajar el pectoral con el torso estabilizado.',
      'Ajusta asiento y apoyos para que el hombro quede alineado con el eje. Mantén pecho estable y codos en el apoyo indicado.',
      'Acerca los brazos con una trayectoria simétrica, pausa brevemente y regresa controlando el estiramiento.',
      ['Encoger hombros.', 'Cerrar con impulso.', 'Llevar los codos fuera de los apoyos.'], [], ['Cross over vertical de Pecho Impulse', 'Aducción Vertical de Pecho Impulse']),

    entry('sf-sd-impulse-seated-row-plate-loaded', 'Remo Sentado discos Impulse', 'Impulse · discos',
      'Tracción horizontal estable con dorsal y musculatura escapular como objetivo.',
      'Ajusta el asiento y, si existe, el apoyo torácico. Toma el agarre prescrito con columna neutral.',
      'Inicia con el hombro controlado, lleva los codos atrás y regresa hasta permitir protracción tolerada sin redondear la zona lumbar.',
      ['Impulsarse con el torso.', 'Elevar hombros.', 'Acortar la fase de estiramiento.'], [], ['Remo discos Impulse']),

    entry('sf-sd-impulse-chest-supported-incline-row', 'Remo Inclinado con Apoyo de Pecho discos Impulse', 'Impulse · discos',
      'Remo con soporte torácico para reducir compensación lumbar y concentrar la tracción.',
      'Ajusta asiento y pecho contra el pad; pies firmes. Elige el agarre prescrito antes de despegar los discos.',
      'Tira llevando codos hacia atrás sin separar el pecho del apoyo. Baja controlado hasta estirar la espalda.',
      ['Despegar el pecho del pad.', 'Tirar con impulso cervical.', 'Perder alineación de muñeca.'],
      [{ name:'Remo Inclinado Impulse — agarre neutro', objective:'Tracción con muñeca neutra y codos próximos al torso.', setup:'Usa las manijas neutras y ajusta el pecho al pad.' }],
      ['Remo Inclinado Impulse']),

    Object.assign(entry('sf-sd-converging-lat-pulldown-plate-loaded', 'Jalón Dorsal Convergente discos', 'Máquina plate-loaded · discos',
      'Tracción vertical convergente con brazos independientes para trabajar el dorsal con el torso y los muslos estabilizados.',
      'Carga ambos lados por igual. Ajusta el asiento y el soporte de muslos para quedar firme, con los brazos extendidos hacia las manijas altas sin elevar los hombros.',
      'Inicia deprimiendo las escápulas y lleva ambos codos hacia abajo y hacia los costados del torso. Permite que los brazos independientes converjan de forma natural y regresa con control hasta el estiramiento overhead.',
      ['Cargar los brazos de forma desigual.', 'Perder el apoyo de muslos o despegarse del asiento.', 'Convertir el jalón en un remo inclinando demasiado el torso.', 'Acortar el regreso overhead.'],
      [],
      ['Jalón dorsal plate-loaded']), { equipmentId:'sf-sd-converging-lat-pulldown-plate-loaded' }),

    entry('sf-sd-preacher-curl-bench', 'Curl de Bíceps Predicador en banco', 'Banco predicador',
      'Flexión de codo estable con el brazo apoyado y el bíceps como limitante.',
      'Ajusta el banco para apoyar toda la parte posterior del brazo sin elevar los hombros. Usa la carga o implemento prescrito.',
      'Flexiona los codos sin despegar los brazos del apoyo y extiende de forma controlada sin forzar el bloqueo.',
      ['Despegar los codos del banco.', 'Acortar el recorrido inferior.', 'Balancear el tronco.'], [], ['Curl Predicador en banco']),

    entry('sf-sd-matrix-chest-press-selectorized', 'Press de Pecho placas Matrix', 'Matrix · placas',
      'Empuje horizontal convergente y estable para pectoral.',
      'Ajusta el asiento para que las manijas queden a la altura media del pecho y selecciona la carga. Apoya espalda y pies.',
      'Empuja siguiendo la convergencia de la máquina; regresa despacio hasta un estiramiento cómodo.',
      ['Adelantar la cabeza y hombros.', 'Despegar la espalda.', 'Golpear la torre de placas.'],
      [{ name:'Press de Pecho Convergente Matrix — agarre neutro', objective:'Empuje horizontal con muñeca neutra y trayectoria convergente.', setup:'Selecciona el agarre neutro y alinea las manijas con el pecho.' }],
      ['Press de Pecho Convergente Matrix', 'Press Pecho Matrix']),

    entry('sf-sd-matrix-pec-fly-reverse-deck', 'Pec Fly / Reverse Pec Deck placas Matrix', 'Matrix · placas',
      'Realizar aducción para pectoral o apertura inversa para deltoide posterior según la variante prescrita.',
      'Selecciona el modo y ajusta asiento/brazos de la máquina antes de cargar. Alinea hombros con el eje y apoya el torso.',
      'En Pec Fly acerca los brazos sin perder el apoyo; en Reverse Pec Deck abre los brazos guiando con los codos y sin extender la zona lumbar.',
      ['Usar una configuración distinta a la variante.', 'Encoger hombros.', 'Rebotar contra los topes.'],
      [{ name:'Pec Fly Matrix', objective:'Aducción horizontal para pectoral.' }, { name:'Reverse Pec Deck Matrix', objective:'Abducción horizontal para deltoide posterior.' }],
      ['Pec Fly Matrix', 'Reverse Pec Deck Matrix']),

    entry('sf-sd-matrix-converging-shoulder-press', 'Press de Hombro Convergente Matrix', 'Matrix · placas',
      'Empuje vertical convergente para deltoides con soporte de tronco.',
      'Ajusta el asiento para iniciar con agarres a la altura de hombros. Apoya espalda y pies.',
      'Empuja arriba siguiendo la convergencia y baja con control hasta el rango cómodo.',
      ['Arquear la espalda.', 'Bloquear con impacto.', 'Perder contacto con el respaldo.'], [], ['Press Hombro Matrix']),

    entry('sf-sd-matrix-diverging-seated-row', 'Remo Sentado Divergente placas Matrix', 'Matrix · placas',
      'Tracción horizontal divergente que permite recorrido escapular controlado.',
      'Ajusta asiento y apoyo torácico para alcanzar las manijas sin perder el torso estable.',
      'Lleva los codos atrás siguiendo la divergencia; vuelve permitiendo un estiramiento controlado.',
      ['Despegar el pecho.', 'Extender la zona lumbar para terminar la repetición.', 'Tirar solo con las manos.'], [], ['Remo Divergente Matrix']),

    entry('sf-sd-matrix-biceps-curl', 'Curl de Bíceps placas Matrix', 'Matrix · placas',
      'Flexión de codo guiada con el brazo estabilizado.',
      'Ajusta el asiento para alinear el codo con el pivote y selecciona la carga.',
      'Flexiona sin despegar los brazos del apoyo y extiende controlando la torre de placas.',
      ['Codo fuera del eje.', 'Elevar hombros.', 'Dejar caer la carga.'], [], ['Curl Bíceps Matrix']),

    entry('sf-sd-matrix-seated-dip', 'Fondos sentado Matrix', 'Matrix · placas',
      'Extensión de codo en máquina con participación de tríceps y cintura escapular.',
      'Ajusta asiento y cinturón/apoyo si existe. Toma las manijas con hombros deprimidos y pies firmes.',
      'Empuja las manijas abajo hasta la extensión controlada y vuelve sin elevar los hombros.',
      ['Encoger hombros.', 'Inclinarse o rebotar para mover la carga.', 'Forzar el bloqueo del codo.'], [], ['Fondos Matrix', 'Fondos sentado']),

    entry('sf-sd-matrix-leg-press-selectorized', 'Prensa de Pierna Matrix peso integrado', 'Matrix · peso integrado',
      'Extensión de rodilla y cadera con el tronco apoyado.',
      'Ajusta asiento, respaldo y posición de pies según la prescripción. Verifica el selector de carga y libera seguros.',
      'Desciende hasta el rango donde pelvis y espalda permanecen apoyadas; empuja con todo el pie sin bloquear las rodillas.',
      ['Despegar la pelvis.', 'Colapsar rodillas hacia dentro.', 'Bloquear con impacto o despegar talones.'], [], ['Prensa Matrix peso integrado']),

    entry('sf-sd-matrix-knee-extension', 'Extensión de Rodilla Matrix', 'Matrix · placas',
      'Extensión de rodilla para cuádriceps con control del eje articular.',
      'Alinea la rodilla con el pivote, ajusta respaldo y coloca el rodillo sobre la parte distal de la tibia.',
      'Extiende hasta el rango prescrito, pausa sin golpear el tope y baja de forma controlada.',
      ['Rodilla desalineada con el eje.', 'Levantar la cadera.', 'Dejar caer la carga.'], [], ['Extensión Rodilla Matrix']),

    entry('sf-sd-matrix-seated-leg-curl', 'Curl Femoral Sentado Matrix', 'Matrix · placas',
      'Flexión de rodilla con isquios trabajando desde una posición elongada.',
      'Alinea rodilla y pivote, fija el apoyo sobre muslos y coloca el rodillo detrás de los tobillos.',
      'Lleva los talones atrás y abajo sin levantar la pelvis; vuelve controlando la extensión.',
      ['Pelvis levantada.', 'Rodilla fuera del eje.', 'Recorrido parcial por exceso de carga.'], [], ['Curl Femoral Matrix']),

    entry('sf-sd-matrix-abductor-adductor', 'Abductor / Adductor Matrix', 'Matrix · placas',
      'Entrenar abducción o aducción de cadera según la variante prescrita.',
      'Selecciona la posición de pads, apertura inicial y variante antes de cargar. Apoya pelvis y pies como indica la máquina.',
      'Abre o cierra las piernas de forma simétrica, pausa brevemente y regresa sin que la torre golpee.',
      ['Usar el modo contrario al prescrito.', 'Rebotar en el final.', 'Mover la pelvis para ampliar el recorrido.'],
      [{ name:'Abductor Matrix', objective:'Abducción de cadera con énfasis en glúteo medio.' }, { name:'Adductor Matrix', objective:'Aducción de cadera con énfasis en aductores.' }],
      ['Abductor Matrix', 'Adductor Matrix']),

    entry('sf-sd-matrix-glute-machine', 'Glute Machine Matrix', 'Matrix · placas',
      'Extensión de cadera unilateral con el glúteo como objetivo principal.',
      'Ajusta el apoyo del pie y el torso; estabiliza pelvis y abdomen antes de iniciar.',
      'Empuja la plataforma hacia atrás mediante extensión de cadera y vuelve sin perder la posición pélvica.',
      ['Hiperextender la zona lumbar.', 'Rotar la pelvis.', 'Impulsarse con la pierna de apoyo.'], [], ['Glute Matrix']),

    entry('sf-sd-matrix-abdominal-machine', 'Abdominal Machine Matrix', 'Matrix · placas',
      'Flexión controlada del tronco con énfasis en recto abdominal.',
      'Ajusta asiento y apoyos para que el eje permita flexionar el tronco sin deslizar la pelvis.',
      'Acerca esternón y pelvis mediante flexión del tronco; vuelve controlando sin tirar con brazos o cadera.',
      ['Mover solo la cadera.', 'Tirar con brazos.', 'Regresar de golpe.'], [], ['Abdominal Matrix']),

    entry('sf-sd-hip-thrust-machine', 'Hip Thrust Machine', 'Hip Thrust Machine',
      'Extensión de cadera estable con énfasis en glúteo mayor.',
      'Ajusta el cinturón o pad sobre la pelvis y coloca los pies simétricos para terminar con tibias próximas a verticales.',
      'Desciende la cadera con control y sube hasta extensión completa sin hiperextender la zona lumbar; pausa contrayendo glúteos.',
      ['Pad sobre el abdomen.', 'Empujar solo con puntas.', 'Terminar con hiperextensión lumbar.'],
      [{ name:'Hip Thrust Machine — bilateral', objective:'Extensión de cadera simultánea con ambos pies.', setup:'Pies simétricos y cinturón centrado sobre la pelvis.' }],
      ['Hip Thrust en máquina']),

    entry('sf-sd-smith', 'Smith', 'Smith',
      'Usar una barra guiada manteniendo la colocación prescrita para el ejercicio concreto.',
      'Centra el cuerpo bajo la barra, ajusta topes de seguridad y verifica la trayectoria antes de cargar. Coloca banco o pies según la variante.',
      'Gira la barra para liberar, ejecuta el patrón prescrito sin luchar contra la guía y vuelve a enganchar ambos lados al terminar.',
      ['No colocar topes.', 'Posicionarse fuera de la trayectoria compatible.', 'Reenganchar solo un lado.'],
      [{ name:'Sentadilla en Smith', objective:'Sentadilla guiada.' }, { name:'Press en Smith', objective:'Empuje guiado con banco.' }, { name:'RDL en Smith', objective:'Bisagra guiada.' }], []),

    entry('sf-sd-adjustable-cable', 'Polea Ajustable', 'Polea ajustable',
      'Aplicar resistencia por cable desde la altura y el accesorio prescritos.',
      'Coloca el carro a la altura indicada, inserta el pasador completamente, selecciona carga y conecta el accesorio con el mosquetón cerrado.',
      'Toma tensión antes de iniciar, conserva la trayectoria prescrita y devuelve la carga sin soltar el cable.',
      ['Altura distinta a la prescrita.', 'Mosquetón sin cerrar.', 'Dejar golpear las placas.'], [], ['Polea regulable']),

    entry('sf-sd-high-pulley', 'Polea Alta', 'Polea alta',
      'Ejecutar tracciones o extensiones desde un vector alto.',
      'Selecciona carga, conecta el accesorio correcto y comprueba que el cable corre libre. Estabiliza el cuerpo antes de tomar tensión.',
      'Mueve el accesorio en la trayectoria prescrita manteniendo control de tronco y hombros; regresa sin soltar.',
      ['Accesorio mal fijado.', 'Balancear el torso.', 'Perder tensión al inicio.'], [], []),

    entry('sf-sd-low-pulley', 'Polea Baja', 'Polea baja',
      'Ejecutar tracciones, curls o elevaciones desde un vector bajo.',
      'Selecciona carga y accesorio; aléjate lo suficiente para tener tensión inicial sin desalinear el cable.',
      'Ejecuta el patrón prescrito con el segmento objetivo estable y controla el regreso.',
      ['Pararse demasiado cerca y perder tensión.', 'Usar impulso corporal.', 'Rozar el cable contra el cuerpo.'], [], []),

    entry('sf-sd-dumbbells', 'Mancuernas', 'Mancuernas',
      'Proporcionar carga libre unilateral o bilateral respetando el patrón prescrito.',
      'Selecciona un par igual, despeja el área y adopta la posición específica antes de levantar las mancuernas.',
      'Mantén muñecas y trayectoria bajo control; termina la serie dejando las mancuernas en el suelo o soporte sin soltarlas desde altura.',
      ['Usar mancuernas distintas.', 'Perder control de muñeca.', 'Arrojarlas al terminar.'], [], []),

    entry('sf-sd-hex-bar', 'Barra Hexagonal', 'Barra hexagonal',
      'Realizar una tracción desde el suelo con la carga centrada alrededor del cuerpo.',
      'Carga ambos lados por igual, coloca seguros y entra centrado en la barra. Pies firmes, agarres simétricos y columna neutral.',
      'Genera tensión, empuja el suelo y extiende rodillas y cadera juntas. Baja guiando la cadera y conserva la barra nivelada.',
      ['Carga desigual.', 'Redondear la espalda.', 'Elevar primero la cadera o inclinar la barra.'], [], ['Trap Bar']),

    entry('sf-sd-cable-ankle-straps', 'Grilletes para Polea', 'Accesorio de polea',
      'Fijar el cable al tobillo de forma segura para movimientos de cadera o rodilla.',
      'Ajusta el grillete por encima del tobillo sin comprimir en exceso. Cierra velcro y mosquetón y prueba con carga mínima.',
      'Mantén el cable alineado con el movimiento prescrito, estabiliza la pelvis y controla ida y vuelta.',
      ['Velcro flojo.', 'Mosquetón abierto.', 'Girar la pelvis para completar el recorrido.'], [], ['Tobilleras para Polea', 'Grilletes de Polea'])
  ];

  // San Diego y Bugambilias comparten una única fuente de equipo base.
  // Los overrides Firestore siguen comparándose contra ACTIVE_GYM_ID antes
  // de llegar aquí, por lo que permanecen específicos de cada sede.
  var sharedGymCatalog = {
    gymId: GYM_ID,
    gym: GYM,
    aliases: ['San Diego', 'Smart Fit San Diego', 'Bugambilias'],
    entries: smartFitSanDiego
  };
  var functionalEquipment = [
    { equipmentId:'functional-dumbbells', name:'Mancuernas', equipmentType:'free_weight', aliases:['Mancuerna'] },
    { equipmentId:'functional-cable-station', name:'Estación de Poleas', equipmentType:'cable', aliases:['Poleas', 'Estación de cable', 'Cable station'] },
    { equipmentId:'functional-olympic-barbell', name:'Barra olímpica', equipmentType:'barbell', aliases:['Barra olimpica', 'Barra'] },
    { equipmentId:'functional-trap-bar', name:'Barra hexagonal', equipmentType:'trap_bar', aliases:['Trap Bar'] },
    { equipmentId:'functional-adjustable-bench', name:'Banco multiposición', equipmentType:'bench', aliases:['Banco ajustable'] },
    { equipmentId:'functional-hyperextension-bench', name:'Banco ajustable para hiperextensión de espalda baja', equipmentType:'bench', aliases:['Banco de hiperextensión', 'Banco 45°'] }
  ];
  function legacyEntry(exerciseId, exerciseName, equipment, setup, execution, objective, errors, aliases) {
    return { exerciseId: exerciseId, exerciseName: exerciseName, name: exerciseName,
      gym: GYM, gymId: GYM_ID, equipment: equipment, equipmentType: equipmentType(equipment),
      imageUrl: null, assetRef: PENDING_ASSET, imageStatus: 'pending_license',
      instructions: objective, technicalObjective: objective, setup: setup, execution: execution,
      commonErrors: errors, variants: [], aliases: aliases || [] };
  }
  // Explicit legacy mappings: exact Coach names only, never fuzzy authority.
  var legacyVisualEntries = [
    legacyEntry('legacy-press-banca-plano-barra', 'Press banca plano barra', 'Barra olímpica', 'Ajusta el banco plano y coloca la barra en soportes seguros.', 'Desciende la barra al pecho con control y empuja manteniendo el torso estable.', 'Press horizontal con barra y pectoral como limitante principal.', ['Perder estabilidad escapular.', 'Rebotar la barra.']),
    legacyEntry('legacy-press-banca-inclinado-barra', 'Press banca inclinado barra', 'Barra olímpica', 'Ajusta el banco a una inclinación moderada y verifica los seguros.', 'Baja la barra hacia la parte alta del pecho y empuja sin despegar los glúteos.', 'Press inclinado con barra para pectoral clavicular y deltoides anterior.', ['Exceso de inclinación.', 'Despegar la pelvis.']),
    legacyEntry('legacy-press-banca-plano-mancuernas', 'Press banca plano mancuernas', 'Mancuernas', 'Coloca el banco plano y selecciona un par igual de mancuernas.', 'Desciende con control hasta un estiramiento cómodo y empuja sin perder la posición del hombro.', 'Press horizontal unilateral/bilateral con mancuernas.', ['Usar mancuernas desiguales.', 'Perder control al iniciar.']),
    legacyEntry('legacy-press-militar-barra', 'Press militar barra', 'Barra olímpica', 'Coloca la barra a la altura de las clavículas y activa el tronco.', 'Empuja verticalmente sin hiperextender la zona lumbar y baja con control.', 'Empuje vertical con barra para hombros y tríceps.', ['Compensar con la espalda.', 'Empujar fuera de la trayectoria.']),
    legacyEntry('legacy-press-militar-mancuernas', 'Press militar mancuernas', 'Mancuernas', 'Usa un banco con respaldo estable y lleva las mancuernas a los hombros.', 'Empuja arriba siguiendo una trayectoria controlada y regresa sin encoger hombros.', 'Empuje vertical con mancuernas.', ['Balancear el torso.', 'Bajar fuera del rango tolerado.']),
    legacyEntry('legacy-remo-barra-prono', 'Remo con barra prono', 'Barra olímpica', 'Carga la barra de forma simétrica y adopta una bisagra con columna neutral.', 'Lleva la barra hacia el abdomen manteniendo el torso estable y desciende controlando.', 'Tracción horizontal con barra y control de la bisagra.', ['Redondear la espalda.', 'Impulsarse con el torso.']),
    legacyEntry('legacy-sentadilla-trasera-barra', 'Sentadilla trasera barra', 'Barra olímpica', 'Coloca la barra de forma estable sobre la espalda y ajusta los seguros.', 'Desciende con apoyo completo del pie y sube coordinando rodillas y cadera.', 'Sentadilla libre con barra para tren inferior.', ['Perder apoyo del pie.', 'Colapsar las rodillas.']),
    legacyEntry('legacy-peso-muerto-convencional-barra', 'Peso muerto convencional barra', 'Barra olímpica', 'Centra la barra sobre el mediopié y toma un agarre simétrico con columna neutral.', 'Empuja el suelo y extiende rodillas y cadera juntas; baja guiando la barra cerca del cuerpo.', 'Tracción desde el suelo con barra olímpica.', ['Redondear la espalda.', 'Elevar primero la cadera.'])
  ];
  legacyVisualEntries.push(
    legacyEntry('legacy-press-banca-inclinado-mancuernas', 'Press banca inclinado mancuernas', 'Mancuernas', 'Ajusta el banco a una inclinación moderada y coloca un par igual de mancuernas.', 'Baja hacia la zona alta del pecho y empuja manteniendo muñecas y hombros estables.', 'Press inclinado con mancuernas para pectoral superior.', ['Perder simetría.', 'Rebotar en el fondo.']),
    legacyEntry('legacy-crossover-polea-alta', 'Crossover polea alta', 'Estación de Poleas', 'Coloca ambas poleas altas y adopta una base estable con tensión inicial.', 'Aduce los brazos hacia delante y abajo sin convertir el movimiento en un balanceo.', 'Aducción de hombro con vector alto para pectoral.', ['Flexionar demasiado los codos.', 'Usar impulso del torso.']),
    legacyEntry('legacy-crossover-polea-baja', 'Crossover polea baja', 'Estación de Poleas', 'Coloca ambas poleas bajas y toma los agarres con postura estable.', 'Eleva y acerca los brazos siguiendo un arco controlado hasta la contracción.', 'Aducción de hombro con vector bajo para pectoral superior.', ['Elevar los hombros.', 'Perder tensión inicial.']),
    legacyEntry('legacy-press-frances-barra-ez', 'Press francés barra EZ', 'Barra olímpica', 'Túmbate en banco estable y fija los codos apuntando arriba.', 'Flexiona y extiende los codos manteniendo los brazos estables y controlando el descenso.', 'Extensión de codo en posición elongada para tríceps.', ['Abrir los codos.', 'Mover los hombros.']),
    legacyEntry('legacy-extension-triceps-polea-alta', 'Extensión tríceps polea alta', 'Estación de Poleas', 'Coloca la polea alta y fija los codos junto al torso.', 'Extiende los codos hacia abajo y regresa sin perder tensión.', 'Extensión de codo con cable desde vector alto.', ['Separar los codos.', 'Impulsarse con el torso.']),
    legacyEntry('legacy-jalon-prono', 'Jalón al pecho agarre prono', 'Polea Alta', 'Asegura los muslos bajo el apoyo y toma la barra con agarre prono.', 'Lleva los codos abajo y atrás hacia el torso; sube controlando el estiramiento.', 'Tracción vertical con agarre prono.', ['Tirar detrás del cuello.', 'Balancearse.']),
    legacyEntry('legacy-jalon-neutro', 'Jalón al pecho agarre neutro', 'Polea Alta', 'Ajusta el apoyo de muslos y usa manijas paralelas.', 'Lleva los codos hacia las caderas y regresa con control.', 'Tracción vertical con agarre neutro.', ['Encoger hombros.', 'Acortar el recorrido.']),
    legacyEntry('legacy-dominadas-prono', 'Dominadas agarre prono', 'Barra fija', 'Cuelga con agarre prono y estabiliza las escápulas.', 'Eleva el pecho hacia la barra sin balanceo y desciende controlando.', 'Tracción vertical con peso corporal y agarre prono.', ['Usar kipping.', 'No completar el descenso.']),
    legacyEntry('legacy-remo-barra-supino', 'Remo con barra supino', 'Barra olímpica', 'Adopta una bisagra estable y toma la barra con agarre supino.', 'Lleva la barra al abdomen manteniendo el torso fijo y baja de forma controlada.', 'Tracción horizontal supina con barra.', ['Redondear la espalda.', 'Elevar el torso para compensar.']),
    legacyEntry('legacy-remo-mancuerna-unilateral', 'Remo mancuerna unilateral', 'Mancuernas', 'Apoya mano y rodilla en un banco y deja la mancuerna bajo el hombro.', 'Lleva el codo hacia la cadera y vuelve permitiendo un estiramiento controlado.', 'Tracción unilateral con mancuerna.', ['Rotar el torso.', 'Encoger el hombro.']),
    legacyEntry('legacy-curl-mancuerna-alterno', 'Curl mancuerna alterno', 'Mancuernas', 'Adopta una postura estable con una mancuerna en cada mano.', 'Flexiona un codo a la vez sin balancear el torso y baja controlando.', 'Flexión de codo alternada con mancuernas.', ['Balancear el cuerpo.', 'Adelantar el hombro.']),
    legacyEntry('legacy-curl-martillo-mancuerna', 'Curl martillo mancuerna', 'Mancuernas', 'Sujeta las mancuernas con agarre neutro y codos junto al torso.', 'Flexiona los codos manteniendo las muñecas neutras y desciende controlando.', 'Flexión de codo con agarre neutro.', ['Girar las muñecas.', 'Separar los codos.']),
    legacyEntry('legacy-sentadilla-frontal-barra', 'Sentadilla frontal barra', 'Barra olímpica', 'Coloca la barra sobre los hombros y estabiliza el tronco.', 'Desciende con el torso erguido y sube manteniendo rodillas y pies alineados.', 'Sentadilla con barra frontal y énfasis en control del tronco.', ['Perder la posición de la barra.', 'Colapsar las rodillas.']),
    legacyEntry('legacy-sentadilla-bulgara-mancuernas', 'Sentadilla búlgara mancuernas', 'Mancuernas', 'Apoya el empeine trasero y coloca las mancuernas a los lados.', 'Desciende sobre la pierna delantera y sube manteniendo pelvis estable.', 'Sentadilla unilateral con mancuernas.', ['Impulsarse con la pierna trasera.', 'Perder equilibrio.']),
    legacyEntry('legacy-zancada-mancuernas', 'Zancada mancuernas', 'Mancuernas', 'Sujeta mancuernas y despeja el espacio de desplazamiento.', 'Da el paso prescrito, desciende con control y vuelve empujando el suelo.', 'Patrón unilateral de zancada con carga libre.', ['Colapsar la rodilla.', 'Acortar el paso sin control.']),
    legacyEntry('legacy-goblet-squat', 'Goblet squat', 'Mancuernas', 'Sujeta una mancuerna frente al pecho y adopta una base estable.', 'Desciende manteniendo el torso controlado y sube con apoyo completo del pie.', 'Sentadilla con carga anterior libre.', ['Dejar caer el pecho.', 'Levantar los talones.']),
    legacyEntry('legacy-peso-muerto-sumo-barra', 'Peso muerto sumo barra', 'Barra olímpica', 'Coloca los pies abiertos y la barra centrada sobre el mediopié.', 'Empuja el suelo y extiende cadera y rodillas juntas; baja manteniendo la barra cerca.', 'Tracción desde el suelo con base sumo.', ['Cerrar las rodillas.', 'Perder la columna neutral.']),
    legacyEntry('legacy-rdl-mancuernas', 'RDL mancuernas', 'Mancuernas', 'Sujeta las mancuernas frente a los muslos y fija una ligera flexión de rodilla.', 'Lleva la cadera atrás hasta el estiramiento tolerado y vuelve extendiendo la cadera.', 'Bisagra de cadera con mancuernas.', ['Flexionar demasiado las rodillas.', 'Redondear la espalda.']),
    legacyEntry('legacy-hip-thrust-barra', 'Hip thrust barra', 'Barra olímpica', 'Apoya la espalda alta en un banco y centra la barra sobre la pelvis.', 'Eleva la cadera hasta extensión completa sin hiperextender la zona lumbar.', 'Extensión de cadera con barra.', ['Empujar con la zona lumbar.', 'Perder simetría de pies.']),
    legacyEntry('legacy-hiperextension-45', 'Hiperextensión 45°', 'Banco ajustable para hiperextensión de espalda baja', 'Ajusta el banco y apoya la pelvis dejando libres las caderas.', 'Realiza una bisagra de cadera y vuelve extendiendo sin redondear ni hiperextender la espalda.', 'Extensión de cadera y tronco en banco específico de hiperextensión.', ['Flexionar la columna en vez de bisagra.', 'Subir más allá de la alineación.'])
  );
  legacyVisualEntries.push(
    legacyEntry('legacy-press-banca-declinado-mancuernas', 'Press banca declinado mancuernas', 'Mancuernas', 'Ajusta un banco con declinación segura y coloca las mancuernas de forma simétrica.', 'Desciende hacia el pecho bajo y empuja sin perder el contacto con el banco.', 'Press declinado con mancuernas.', ['Deslizarse en el banco.', 'Perder control de las mancuernas.']),
    legacyEntry('legacy-crossover-polea-media', 'Crossover polea media', 'Estación de Poleas', 'Coloca ambas poleas a la altura del pecho y toma tensión inicial.', 'Aduce los brazos horizontalmente sin mover el torso.', 'Aducción horizontal con estación de poleas.', ['Elevar los hombros.', 'Usar impulso.']),
    legacyEntry('legacy-press-inclinado-maquina', 'Press inclinado máquina', 'Máquina', 'Ajusta el asiento para alinear las manijas con la parte alta del pecho.', 'Empuja en diagonal siguiendo la guía y regresa controlando.', 'Press inclinado guiado.', ['Despegar la espalda.', 'Bloquear con impacto.']),
    legacyEntry('legacy-fondos-pecho-dips', 'Fondos pecho (Dips)', 'Barras paralelas', 'Colócate entre las barras y estabiliza hombros y tronco.', 'Desciende con inclinación ligera del torso y empuja sin rebote.', 'Empuje vertical con peso corporal y énfasis pectoral.', ['Descender fuera del rango tolerado.', 'Balancearse.']),
    legacyEntry('legacy-pullover-pecho-polea', 'Pull-over pecho polea', 'Polea Alta', 'Coloca la polea alta y toma el accesorio con codos semiflexionados.', 'Lleva los brazos hacia los muslos en arco sin flexionar los codos.', 'Extensión de hombro con cable para pectoral y dorsal.', ['Convertirlo en press.', 'Mover el torso.']),
    legacyEntry('legacy-elevaciones-laterales-mancuernas', 'Elevaciones laterales mancuernas', 'Mancuernas', 'Sujeta las mancuernas a los lados con postura estable.', 'Eleva guiando con los codos hasta el rango prescrito y baja controlando.', 'Abducción de hombro con mancuernas.', ['Balancear el cuerpo.', 'Elevar los hombros.']),
    legacyEntry('legacy-curl-barra-recta', 'Curl barra recta', 'Barra olímpica', 'Sujeta la barra con agarre supino y codos junto al torso.', 'Flexiona los codos sin balancear y desciende de forma controlada.', 'Flexión de codo con barra.', ['Impulsarse con la espalda.', 'Adelantar los codos.']),
    legacyEntry('legacy-curl-mancuerna-bilateral', 'Curl mancuerna bilateral', 'Mancuernas', 'Adopta una postura estable con una mancuerna en cada mano.', 'Flexiona ambos codos manteniendo hombros y muñecas controlados.', 'Flexión bilateral de codo con mancuernas.', ['Balancearse.', 'Perder la posición de muñeca.']),
    legacyEntry('legacy-curl-polea-baja', 'Curl polea baja', 'Polea Baja', 'Coloca la polea baja y toma el agarre con tensión inicial.', 'Flexiona los codos junto al torso y regresa sin perder tensión.', 'Flexión de codo con vector bajo constante.', ['Separar los codos.', 'Soltar la carga.']),
    legacyEntry('legacy-prensa-45', 'Prensa 45°', 'Prensa de pierna', 'Ajusta el respaldo y coloca los pies simétricos en la plataforma.', 'Desciende hasta conservar pelvis estable y empuja con todo el pie.', 'Extensión guiada de rodilla y cadera.', ['Despegar la pelvis.', 'Bloquear con impacto.']),
    legacyEntry('legacy-hack-squat-maquina', 'Hack squat máquina', 'Hack squat', 'Ajusta hombros y espalda en los apoyos y libera los seguros.', 'Desciende con rodillas alineadas y sube manteniendo el contacto con el respaldo.', 'Sentadilla guiada con soporte de tronco.', ['Colapsar rodillas.', 'Perder contacto lumbar.']),
    legacyEntry('legacy-extension-cuadriceps-maquina', 'Extensión cuádriceps máquina', 'Extensión de rodilla', 'Alinea la rodilla con el pivote y ajusta el rodillo distal.', 'Extiende y baja controlando sin golpear el tope.', 'Extensión de rodilla aislada.', ['Desalinear la rodilla.', 'Dejar caer la carga.'])
  );
  sharedGymCatalog.legacyEntries = legacyVisualEntries;
  // T508: canonical EQUIPMENT identity for the shared Smart Fit San Diego / Bugambilias catalog. Explicit ids and
  // explicit aliases only (matched by exact normalized label: case / accents / whitespace, never similarity). Each
  // item is ONE physical implement named by its catalog label; the same label on several exercises is the same id.
  // Labels that name a FAMILY of implements, a generic "Máquina" or an attachment are NOT identities and stay
  // unresolved (listed below with the reason). No increment lives here: identity is not metadata.
  sharedGymCatalog.equipment = [
    { equipmentId:'sf-sd-eq-belt-squat', name:'Belt Squat', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-eq-sentadilla-pendular', name:'Sentadilla Pendular', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-eq-banco-predicador', name:'Banco predicador', equipmentType:'bench', aliases:[] },
    { equipmentId:'sf-sd-eq-hip-thrust-machine', name:'Hip Thrust Machine', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-eq-smith', name:'Smith', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-eq-polea-ajustable', name:'Polea ajustable', equipmentType:'cable', aliases:[] },
    { equipmentId:'sf-sd-eq-polea-alta', name:'Polea alta', equipmentType:'cable', aliases:[] },
    { equipmentId:'sf-sd-eq-polea-baja', name:'Polea baja', equipmentType:'cable', aliases:[] },
    { equipmentId:'sf-sd-eq-barra-fija', name:'Barra fija', equipmentType:'barbell', aliases:[] },
    { equipmentId:'sf-sd-eq-barras-paralelas', name:'Barras paralelas', equipmentType:'barbell', aliases:[] },
    { equipmentId:'sf-sd-eq-prensa-de-pierna', name:'Prensa de pierna', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-eq-hack-squat', name:'Hack squat', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-eq-extension-de-rodilla', name:'Extensión de rodilla', equipmentType:'machine', aliases:[] },
    { equipmentId:'sf-sd-converging-lat-pulldown-plate-loaded', name:'Máquina plate-loaded · discos', equipmentType:'machine', aliases:[] }
  ];
  sharedGymCatalog.unresolvedEquipment = [
    { name:'Impulse · discos', reason:'FAMILY_LABEL_MULTIPLE_IMPLEMENTS' },
    { name:'Impulse · peso integrado', reason:'FAMILY_LABEL_MULTIPLE_IMPLEMENTS' },
    { name:'Matrix · placas', reason:'FAMILY_LABEL_MULTIPLE_IMPLEMENTS' },
    { name:'Matrix · peso integrado', reason:'FAMILY_LABEL_MULTIPLE_IMPLEMENTS' },
    { name:'Máquina', reason:'GENERIC_LABEL' },
    { name:'Accesorio de polea', reason:'ATTACHMENT_NOT_LOAD_IMPLEMENT' }
  ];
  return {
    version: '2026.09.27',
    functionalEquipment: functionalEquipment,
    gyms: {
      'smart-fit-san-diego': sharedGymCatalog,
      'bugambilias': sharedGymCatalog
    }
  };
});
