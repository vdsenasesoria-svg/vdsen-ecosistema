// VDSEN — vínculos plan ↔ catálogo desde la consola del Coach (puente hasta que la ventana "Vínculos" llegue a producción).
// Qué hace: lee el plan activo de UN atleta (con tu sesión de Coach), propone qué ejercicio del catálogo corresponde a cada ejercicio prescrito y,
// SOLO en modo 'apply', guarda coaches/{tuUid}.exerciseLinks.<prescriptionExerciseId> = <catalogExerciseId> en TU propio documento.
// No modifica el plan, el cliente, los logs ni ningún otro documento. Nunca adivina: exactas por nombre idéntico + las que apruebes en EXTRA.
// Cómo usarlo: abre la app del Coach (con sesión), F12 → Console, pega TODO este archivo, Enter. Primero se queda en MODE='dry' (solo imprime).
(async () => {
  // ===================== CONFIGURACIÓN =====================
  const CLIENT_NAME = 'ayrton';   // parte del nombre del atleta (sin importar mayúsculas ni acentos)
  const MODE = 'dry';             // 'dry' = solo muestra | 'apply' = guarda los vínculos
  // Aprobaciones EXPLÍCITAS por nombre exacto del ejercicio en el plan -> exerciseId del catálogo (revisa que sean correctas):
  const EXTRA = {
    'Press Convergente Horizontal': 'sf-sd-matrix-chest-press-selectorized',
    'Curl femoral sentado máquina': 'sf-sd-matrix-seated-leg-curl',
    'Hip thrust máquina': 'sf-sd-hip-thrust-machine',
    'Elevaciones laterales polea baja': 'sf-sd-low-pulley',
  };
  // =========================================================
  const G = 'https://www.gstatic.com/firebasejs/10.12.0/';
  const [A, F, Au] = await Promise.all([import(G + 'firebase-app.js'), import(G + 'firebase-firestore.js'), import(G + 'firebase-auth.js')]);
  const app = A.getApp(), db = F.getFirestore(app), me = Au.getAuth(app).currentUser;
  if (!me) throw new Error('Inicia sesión como Coach primero.');
  const cat = window.VDSEN_EXERCISE_VISUAL_CATALOG;
  if (!cat || !cat.gyms) throw new Error('No se encontró el catálogo de ejercicios en esta página.');
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const entries = [];
  Object.keys(cat.gyms).forEach((k) => { const g = cat.gyms[k]; (g.entries || []).concat(g.legacyEntries || []).forEach((e) => entries.push(e)); });
  const byId = {}; entries.forEach((e) => { byId[e.exerciseId] = e; });
  const names = (e) => [e.exerciseName, e.name].concat(e.aliases || []).filter(Boolean);

  // 1) atleta
  const mine = await F.getDocs(F.query(F.collection(db, 'clients'), F.where('coachId', '==', me.uid)));
  const hits = []; mine.forEach((d) => { const n = norm((d.data() || {}).displayName); if (n.indexOf(norm(CLIENT_NAME)) >= 0) hits.push({ id: d.id, name: d.data().displayName, planId: d.data().activePlanId }); });
  if (hits.length !== 1) { console.log('Atletas que coinciden con "' + CLIENT_NAME + '":', hits); throw new Error(hits.length ? 'Hay más de uno: afina CLIENT_NAME.' : 'No encontré ese atleta entre tus clientes.'); }
  const cl = hits[0]; if (!cl.planId) throw new Error(cl.name + ' no tiene plan activo.');
  const planSnap = await F.getDoc(F.doc(db, 'plans', cl.planId));
  if (!planSnap.exists()) throw new Error('No se pudo leer el plan activo.');
  const plan = planSnap.data();

  // 2) propuesta
  const extraN = {}; Object.keys(EXTRA).forEach((k) => { extraN[norm(k)] = EXTRA[k]; });
  const rows = [], links = {}, problems = [];
  (plan.days || []).forEach((d) => (d.exercises || []).forEach((e) => {
    const pid = typeof e.prescriptionExerciseId === 'string' ? e.prescriptionExerciseId : '';
    const key = norm(e.exerciseName), already = e.exerciseId || null;
    let id = null, how = '';
    const exact = entries.filter((x) => names(x).some((a) => norm(a) === key));
    if (extraN[key]) { id = extraN[key]; how = 'APROBADO (EXTRA)'; }
    else if (exact.length) { id = exact[0].exerciseId; how = 'EXACTA'; }
    if (id && !byId[id]) { problems.push('"' + e.exerciseName + '": el id "' + id + '" no existe en el catálogo.'); id = null; }
    if (id && !pid) { problems.push('"' + e.exerciseName + '": sin prescriptionExerciseId, no se puede vincular.'); id = null; }
    if (id && /[.\/\\]/.test(pid)) { problems.push('"' + e.exerciseName + '": prescriptionExerciseId no válido.'); id = null; }
    if (id && links[pid] && links[pid] !== id) { problems.push('"' + e.exerciseName + '": PID repetido con otro ejercicio.'); id = null; }
    if (id) links[pid] = id;
    rows.push({ dia: d.label, ejercicio: e.exerciseName, estado: id ? how : 'sin vínculo', catalogo: id || '', ya_en_plan: already || '' });
  }));
  console.log('Atleta: ' + cl.name + ' · plan ' + cl.planId + ' · ejercicios: ' + rows.length + ' · vínculos propuestos: ' + Object.keys(links).length);
  console.table(rows);
  if (problems.length) console.warn('Avisos (se omiten):\n• ' + problems.join('\n• '));
  if (MODE !== 'apply') { console.log("MODO 'dry': no se guardó nada. Si la tabla es correcta, cambia MODE a 'apply' y vuelve a pegar el archivo."); return { guardado: 0, links }; }
  if (!Object.keys(links).length) { console.log('No hay vínculos para guardar.'); return { guardado: 0 }; }
  const upd = {}; Object.keys(links).forEach((pid) => { upd['exerciseLinks.' + pid] = links[pid]; });
  await F.updateDoc(F.doc(db, 'coaches', me.uid), upd);
  const back = (await F.getDoc(F.doc(db, 'coaches', me.uid))).data().exerciseLinks || {};
  const ok = Object.keys(links).every((pid) => back[pid] === links[pid]);
  console.log((ok ? '✔ Guardados y verificados: ' : '✖ Revisa: ') + Object.keys(links).length + ' vínculos en coaches/' + me.uid + '.exerciseLinks');
  return { guardado: Object.keys(links).length, verificado: ok };
})();
