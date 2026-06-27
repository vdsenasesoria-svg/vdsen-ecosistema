// vdsen-push.js — Carga unificada de planes a Firebase para clientes VDSEN
//
// Uso:
//   node vdsen-push.js --client "ayrton" [opciones]
//
// Opciones (todas opcionales, se aplican las que pases):
//   --client "<nombre|uid>"     Busca por displayName (contains, case-insensitive) o UID exacto. OBLIGATORIO.
//   --training <archivo.json>   Plan de entrenamiento → plans/{id} + clients.activePlanId
//   --rir <json>                RIR por semana p.ej. '{"1":2,"2":2,"3":1,"4":1,"5":0,"6":3}'
//   --nutrition <archivo.json>  Plan nutricional → clients.nutritionPlan (auto-genera .texto si trae comidas[])
//   --pharma <archivo.json>     Protocolo PED → clients.pharmaPlan
//   --supplements <archivo.json> Plan de suplementación → clients.supplementPlan
//   --evaluation <archivo.json> Evaluación fotogramétrica → clients.evaluation
//   --note "<texto>"            Mensaje al atleta → clients.coachMessage
//   --profile "<tipo>"          Setea perfil del cliente: hipertrofia | rendimiento | hibrido → clients.profileType
//   --no-backup                 No respaldar plan anterior (default: respalda en plans_backup)
//   --dry-run                   Solo muestra qué se haría, sin escribir
//
// Estructuras esperadas en los JSON:
//   training: { weeks, daysPerWeek, days:[...] }  (mismo schema que ayrton-plan-v4.json)
//   nutrition: { calorias, proteina, carbos, grasas, comidas:[{nombre,alimentos:[{alimento,cantidad}],macros:{p,c,g,kcal},notas}] }
//                o bien { ..., texto: "..." } si ya viene en texto.
//   pharma:    { protocolo, justificacion, compuestos_base:[...], incretinico, ancilares, soporte_organico, monitoreo, alarmas_suspension, plan_pct, ... }
//   supplements: { texto: "..." }
//   evaluation: { ... } estructura libre (schema de fotogrametria.md)

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SA_PATH = 'C:/Users/bonaf/Downloads/vdsen-ecosistema-firebase-adminsdk-fbsvc-e738a58bf6.json';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    }
  }
  return args;
}

function readJson(p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

// ── Generador de texto plano desde comidas[] ──
// Produce el formato que el parser de vdsen-cliente.html sabe leer.
function comidasToTexto(np) {
  if (!np) return '';
  const lines = [];
  lines.push(`OBJETIVO: ${np.calorias || 0} kcal | P ${np.proteina || 0}g · C ${np.carbos || 0}g · G ${np.grasas || 0}g`);
  lines.push('');
  (np.comidas || []).forEach(cm => {
    lines.push(cm.nombre || 'COMIDA');
    (cm.alimentos || []).forEach(a => {
      const cant = a.cantidad || '';
      const nom = a.alimento || '';
      lines.push(`${cant} ${nom}`.trim());
    });
    if (cm.macros) {
      const m = cm.macros;
      lines.push(`Macros: P ${m.p || 0}g · C ${m.c || 0}g · G ${m.g || 0}g · ${m.kcal || 0} kcal`);
    }
    if (cm.notas) {
      // Separa suplementos del resto si la nota incluye palabras tipo "Leucina/Creatina/Omega/Vit/Mg/etc."
      const notas = String(cm.notas);
      const supKeywords = /(leucina|creatina|omega|vitamina|berberina|tudca|nac|telmisart|magnesio|coq10|k2|d3|whey|iso\s?xp|cafe[ií]na|melatonina|metformina|inositol|colina)/i;
      if (supKeywords.test(notas)) {
        const partes = notas.split(/\.\s+|\|\s+/).map(s => s.trim()).filter(Boolean);
        const sup = [], desc = [];
        partes.forEach(p => (supKeywords.test(p) ? sup : desc).push(p));
        if (desc.length) lines.push('Descripción: ' + desc.join('. '));
        if (sup.length) {
          lines.push('💊 Suplementos con esta comida');
          sup.forEach(s => lines.push(s));
        }
      } else {
        lines.push('Descripción: ' + notas);
      }
    }
    lines.push('');
  });
  if (np.assumptions && np.assumptions.length) {
    lines.push('─── SUPUESTOS ───');
    np.assumptions.forEach(a => lines.push('• ' + a));
  }
  return lines.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);

  if (!args.client) {
    console.error('ERROR: --client "<nombre o uid>" es obligatorio.');
    process.exit(1);
  }
  const targets = ['training', 'nutrition', 'pharma', 'supplements', 'evaluation', 'note', 'profile'];
  const anything = targets.some(k => args[k]);
  if (!anything) {
    console.error('ERROR: necesitas al menos una opción de carga (--training, --nutrition, --pharma, --supplements, --evaluation, --note).');
    process.exit(1);
  }

  // Cargar JSONs
  let training = null, nutrition = null, pharma = null, supplements = null, evaluation = null;
  try {
    if (args.training)     training    = readJson(args.training);
    if (args.nutrition)    nutrition   = readJson(args.nutrition);
    if (args.pharma)       pharma      = readJson(args.pharma);
    if (args.supplements)  supplements = readJson(args.supplements);
    if (args.evaluation)   evaluation  = readJson(args.evaluation);
  } catch (e) {
    console.error('ERROR leyendo JSON:', e.message);
    process.exit(1);
  }

  const rirByWeek = args.rir ? JSON.parse(args.rir) : null;
  const dryRun = !!args['dry-run'];
  const doBackup = !args['no-backup'];

  // Init Firebase
  const sa = require(SA_PATH);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  // Buscar cliente
  let client = null;
  const q = String(args.client).toLowerCase();
  // 1) Intento por UID exacto
  try {
    const direct = await db.collection('clients').doc(args.client).get();
    if (direct.exists) client = { id: direct.id, ...direct.data() };
  } catch (e) {}
  // 2) Búsqueda por displayName / email contains
  if (!client) {
    const snap = await db.collection('clients').get();
    const matches = [];
    snap.forEach(d => {
      const data = d.data();
      const name = (data.displayName || '').toLowerCase();
      const email = (data.email || '').toLowerCase();
      if (name.includes(q) || email.includes(q)) matches.push({ id: d.id, ...data });
    });
    if (matches.length === 0) { console.error(`Cliente no encontrado: "${args.client}"`); process.exit(1); }
    if (matches.length > 1) {
      console.error(`Múltiples coincidencias para "${args.client}":`);
      matches.forEach(m => console.error(`  - ${m.displayName || '(sin nombre)'} <${m.email || ''}> [${m.id}]`));
      console.error('Refina el filtro o pasa el UID exacto.');
      process.exit(1);
    }
    client = matches[0];
  }
  console.log(`Cliente: ${client.displayName || '(sin nombre)'} <${client.email || ''}> [${client.id}]`);
  if (dryRun) console.log('--- DRY RUN: no se escribirá nada ---');

  const ts = new Date().toISOString();
  const clientRef = db.collection('clients').doc(client.id);
  const clientUpdate = {};

  // ── TRAINING ──
  if (training) {
    if (doBackup && client.activePlanId) {
      try {
        const prev = await db.collection('plans').doc(client.activePlanId).get();
        if (prev.exists) {
          if (!dryRun) {
            await db.collection('plans_backup').add({
              ...prev.data(), backupOf: client.activePlanId, backupAt: ts
            });
          }
          console.log(`  ✓ Backup plan anterior: ${client.activePlanId}`);
        }
      } catch (e) { console.error('  ⚠ No se pudo respaldar plan anterior:', e.message); }
    }
    const newPlan = {
      ...training,
      ...(rirByWeek ? { rirByWeek } : {}),
      coachId: client.coachId,
      clientId: client.id,
      status: 'active',
      generatedBy: 'vdsen-push',
      createdAt: ts,
    };
    if (!dryRun) {
      const planRef = await db.collection('plans').add(newPlan);
      clientUpdate.activePlanId = planRef.id;
      console.log(`  ✓ Plan de entrenamiento creado: ${planRef.id}`);
      // Borrar plan anterior tras backup
      if (doBackup && client.activePlanId && client.activePlanId !== planRef.id) {
        try { await db.collection('plans').doc(client.activePlanId).delete(); console.log(`  ✓ Plan anterior eliminado: ${client.activePlanId}`); } catch (e) {}
      }
    } else {
      console.log(`  ✓ [dry-run] Plan de entrenamiento (${(training.days||[]).length} días, ${training.weeks || '?'} semanas)`);
    }
  }

  // ── NUTRITION ──
  if (nutrition) {
    const np = { ...nutrition };
    // Si trae comidas[] y no trae .texto, generarlo para el parser del cliente
    if (Array.isArray(np.comidas) && !np.texto) {
      np.texto = comidasToTexto(np);
    }
    np.updatedAt = ts;
    clientUpdate.nutritionPlan = np;
    console.log(`  ✓ Plan nutricional: ${np.calorias || '?'} kcal, ${(np.comidas || []).length} comidas`);
    if (dryRun) console.log('    --- texto generado (preview) ---\n' + (np.texto || '').split('\n').slice(0, 15).join('\n') + '\n    ...');
  }

  // ── PHARMA ──
  if (pharma) {
    clientUpdate.pharmaPlan = { ...pharma, updatedAt: ts };
    console.log(`  ✓ Protocolo farmacológico: ${pharma.protocolo_seleccionado || pharma.protocolo || '(sin etiqueta)'}`);
  }

  // ── SUPPLEMENTS ──
  if (supplements) {
    const sp = typeof supplements === 'string' ? { texto: supplements } : { ...supplements };
    sp.updatedAt = ts;
    clientUpdate.supplementPlan = sp;
    console.log(`  ✓ Plan de suplementación cargado`);
  }

  // ── EVALUATION ──
  if (evaluation) {
    clientUpdate.evaluation = { ...evaluation, updatedAt: ts };
    console.log(`  ✓ Evaluación fotogramétrica cargada`);
  }

  // ── COACH NOTE ──
  if (args.note) {
    clientUpdate.coachMessage = { texto: args.note, updatedAt: ts };
    console.log(`  ✓ Mensaje del coach actualizado`);
  }

  // ── PROFILE ──
  if (args.profile) {
    const validProfiles = ['hipertrofia', 'rendimiento', 'hibrido'];
    const prof = String(args.profile).toLowerCase().trim();
    if (!validProfiles.includes(prof)) {
      console.error(`ERROR: --profile debe ser uno de: ${validProfiles.join(', ')} (recibido: "${args.profile}")`);
      process.exit(1);
    }
    clientUpdate.profileType = prof;
    console.log(`  ✓ Perfil del cliente: ${prof}`);
  }

  if (Object.keys(clientUpdate).length === 0) {
    console.log('(sin cambios al doc del cliente)');
  } else if (!dryRun) {
    await clientRef.update(clientUpdate);
    console.log(`✓ Cliente actualizado: ${Object.keys(clientUpdate).join(', ')}`);
  } else {
    console.log(`[dry-run] Se actualizaría cliente con: ${Object.keys(clientUpdate).join(', ')}`);
  }

  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
