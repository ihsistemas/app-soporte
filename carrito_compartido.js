// ============================================================================
// Envio de carritos a caja - CADA dispositivo arma su propio carrito, y lo
// manda al dispositivo/dispositivos en modo Caja de SU MISMO NEGOCIO (sin
// tener que escribir ningun codigo - se encuentra solo usando el cliente_id
// que ya existe en el sistema de equipos/licencias).
//
// CONFIGURACION: reemplazar CONFIG_FIREBASE con las credenciales reales del
// proyecto de Firebase antes de usar esto en serio.
// ============================================================================

const CONFIG_FIREBASE = {
  apiKey: "AIzaSyCvJF95IEvA_3KhX0aX90vIxP-R3dfJaqg",
  authDomain: "ih-sistemas.firebaseapp.com",
  projectId: "ih-sistemas",
  storageBucket: "ih-sistemas.firebasestorage.app",
  messagingSenderId: "967603772155",
  appId: "1:967603772155:web:ea47a58448851ede872e5e",
};

let firebaseApp = null;
let db = null;
let unsubscribeActual = null;

function inicializarFirebase(configPersonalizada) {
  const config = configPersonalizada || CONFIG_FIREBASE;
  firebaseApp = FirebaseSync.initializeApp(config);
  db = FirebaseSync.getFirestore(firebaseApp);
  // Deja que seguir funcionando con la ultima copia conocida si se corta el
  // internet. Si falla (ej: 2 pestañas abiertas a la vez), no es grave -
  // simplemente no habria cache offline en esa pestaña, el resto sigue igual.
  FirebaseSync.enableIndexedDbPersistence(db).catch(() => {});
  if (FirebaseSync.getAuth) auth = FirebaseSync.getAuth(firebaseApp);
}

function conectarAEmulador(host, puerto) {
  FirebaseSync.connectFirestoreEmulator(db, host, puerto);
}

// El documento de la caja usa el mismo cliente_id de siempre como su ID -
// asi cualquier equipo del mismo negocio la encuentra sola, sin codigo.
// Se puede llamar de los 2 lados (carrito o caja) sin problema - crea el
// documento si no existe, no hace nada si ya existia (idempotente).
async function asegurarCajaDelNegocio(clienteId) {
  const ref = FirebaseSync.doc(db, 'cajas', clienteId);
  const snap = await FirebaseSync.getDoc(ref);
  if (!snap.exists()) {
    await FirebaseSync.setDoc(ref, { cliente_id: clienteId, creada: FirebaseSync.serverTimestamp() });
  }
}

// callback(listaCarritos) cada vez que cambia algo - solo carritos
// pendientes, mas recientes primero.
function escucharCarritosEntrantes(clienteId, callback, errorCallback) {
  dejarDeEscuchar();
  const col = FirebaseSync.collection(db, 'cajas', clienteId, 'carritos_recibidos');
  const consulta = FirebaseSync.query(col, FirebaseSync.where('estado', '==', 'pendiente'));
  unsubscribeActual = FirebaseSync.onSnapshot(consulta,
    (snap) => {
      const carritos = [];
      snap.forEach((doc) => carritos.push({ id: doc.id, ...doc.data() }));
      carritos.sort((a, b) => (b.fecha_envio?.toMillis?.() || 0) - (a.fecha_envio?.toMillis?.() || 0));
      callback(carritos);
    },
    (error) => { if (errorCallback) errorCallback(error); }
  );
  return unsubscribeActual;
}

async function marcarCarritoProcesado(clienteId, idCarrito) {
  const ref = FirebaseSync.doc(db, 'cajas', clienteId, 'carritos_recibidos', idCarrito);
  await FirebaseSync.updateDoc(ref, { estado: 'procesado' });
  incrementarUsoDiario(clienteId, 'carrito_procesado');
}

function dejarDeEscuchar() {
  if (unsubscribeActual) { unsubscribeActual(); unsubscribeActual = null; }
}

async function enviarCarritoACaja(clienteId, items, total, nombreEquipo) {
  await asegurarCajaDelNegocio(clienteId);
  const col = FirebaseSync.collection(db, 'cajas', clienteId, 'carritos_recibidos');
  await FirebaseSync.addDoc(col, {
    items, total, enviado_por: nombreEquipo,
    fecha_envio: FirebaseSync.serverTimestamp(),
    estado: 'pendiente',
  });
  incrementarUsoDiario(clienteId, 'carrito_enviado');
}

// ============================================================================
// USUARIOS - viven en el servidor (Firestore), no en cada celular por
// separado. Un listener continuo mantiene una copia en memoria siempre al
// dia (tanto online como offline, gracias al cache local que Firestore
// maneja solo) - listarUsuarios/verificarClave leen de esa copia, sin tener
// que esperar una consulta nueva cada vez.
// ============================================================================

let unsubscribeUsuarios = null;
let _cacheUsuarios = null; // null = todavia no llego el primer valor

// Hay que llamar esto UNA vez, apenas se conoce el cliente_id (antes de
// intentar loguear a nadie) - deja _cacheUsuarios lista para consultar.
function iniciarEscuchaUsuarios(clienteId, alListo) {
  if (unsubscribeUsuarios) unsubscribeUsuarios();
  const col = FirebaseSync.collection(db, 'negocios', clienteId, 'usuarios');
  let esPrimeraVez = true;
  unsubscribeUsuarios = FirebaseSync.onSnapshot(col, (snap) => {
    const usuarios = [];
    snap.forEach((doc) => usuarios.push({ id: doc.id, ...doc.data() }));
    _cacheUsuarios = usuarios;
    if (esPrimeraVez) { esPrimeraVez = false; if (alListo) alListo(); }
  });
}

function listarUsuariosRemoto() {
  if (_cacheUsuarios === null) return [];
  return _cacheUsuarios.filter((u) => u.activo !== false);
}
function escuchaUsuariosActiva() {
  return _cacheUsuarios !== null;
}

async function crearUsuarioRemoto(clienteId, datos) {
  const col = FirebaseSync.collection(db, 'negocios', clienteId, 'usuarios');
  const ref = await FirebaseSync.addDoc(col, { ...datos, activo: true });
  incrementarUsoDiario(clienteId, 'usuario_creado');
  return ref.id;
}

async function editarUsuarioRemoto(clienteId, usuarioId, cambios) {
  const ref = FirebaseSync.doc(db, 'negocios', clienteId, 'usuarios', usuarioId);
  await FirebaseSync.updateDoc(ref, cambios);
  incrementarUsoDiario(clienteId, 'usuario_editado');
}

// ============================================================================
// SEÑAL DE CIERRE DEL MAESTRO - si el equipo maestro cierra sesion, los
// equipos sub se enteran y cierran la suya tambien, solos. Simple a
// proposito: un campo con la hora del ultimo cierre, todos escuchando.
// ============================================================================

let unsubscribeCierreMaestro = null;

async function avisarCierreDeSesionMaestro(clienteId) {
  const ref = FirebaseSync.doc(db, 'negocios', clienteId);
  await FirebaseSync.setDoc(ref, { ultimo_cierre_maestro: FirebaseSync.serverTimestamp() }, { merge: true });
}

// callback() se llama SOLO cuando aparece un cierre NUEVO (no en el primer
// valor que ya hubiera de antes) - asi un equipo que recien se conecta no se
// cierra solo por un aviso viejo de la ultima vez que el maestro cerro.
function escucharCierreDeSesionMaestro(clienteId, callback) {
  if (unsubscribeCierreMaestro) unsubscribeCierreMaestro();
  const ref = FirebaseSync.doc(db, 'negocios', clienteId);
  let esPrimeraVez = true;
  unsubscribeCierreMaestro = FirebaseSync.onSnapshot(ref, (snap) => {
    if (esPrimeraVez) { esPrimeraVez = false; return; }
    if (snap.exists() && snap.data().ultimo_cierre_maestro) callback();
  });
  return unsubscribeCierreMaestro;
}
function dejarDeEscucharCierreMaestro() {
  if (unsubscribeCierreMaestro) { unsubscribeCierreMaestro(); unsubscribeCierreMaestro = null; }
}

// ============================================================================
// LICENCIA REAL, CONTRA EL SERVIDOR - reemplaza el token auto-firmado que
// cualquiera con el codigo fuente podia falsificar (HMAC con secreto
// embebido en el JS = no es un secreto de verdad una vez que el cliente
// final tiene el codigo). Ahora el cliente VIVE en Firestore - el codigo
// que se comparte es solo el ID para encontrarlo, no un certificado que se
// pueda armar a mano. El vencimiento se compara contra la HORA DEL
// SERVIDOR, no la del dispositivo - asi atrasar el reloj del celular ya no
// sirve para estirar una prueba vencida.
// ============================================================================

// Escribe una marca con la hora real del servidor y la vuelve a leer -
// asi se obtiene la hora verdadera de Firebase, no la del dispositivo
// (que el dueño del celular podria atrasar a mano). Cuesta 1 escritura +
// 1 lectura cada vez que se llama - se usa solo al activar y al revisar
// vencimiento, no en cada accion.
async function horaServidorActual() {
  const ref = FirebaseSync.doc(db, '_verificacion_hora', 'ahora');
  await FirebaseSync.setDoc(ref, { t: FirebaseSync.serverTimestamp() });
  const snap = await FirebaseSync.getDoc(ref);
  return snap.data().t.toDate();
}

function generarClienteId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let codigo = 'CLI-';
  for (let i = 0; i < 10; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
  return codigo;
}

// Lo usa App Soporte para crear un cliente nuevo. El "codigo" que se
// comparte con el cliente final es simplemente este ID - no hay nada que
// firmar ni que falsificar, porque la unica fuente de verdad es el
// documento en Firestore, no lo que el dispositivo pueda calcular solo.
async function crearClienteRemoto({ nombre, capacidad, capacidadUsuarios, tipoLicencia, diasPrueba }) {
  const clienteId = generarClienteId();
  const tipo = tipoLicencia === 'trial' ? 'trial' : 'permanente';
  let vence = null;
  if (tipo === 'trial') {
    const horaServidor = await horaServidorActual();
    const fechaVence = new Date(horaServidor);
    fechaVence.setDate(fechaVence.getDate() + (Number(diasPrueba) || 15));
    vence = fechaVence.toISOString().slice(0, 10);
  }
  const ref = FirebaseSync.doc(db, 'clientes', clienteId);
  await FirebaseSync.setDoc(ref, {
    nombre, capacidad: capacidad || 2, capacidad_usuarios: capacidadUsuarios || 6,
    tipo_licencia: tipo, vence,
    fecha_creado: FirebaseSync.serverTimestamp(),
  });
  return { cliente_id: clienteId, nombre, capacidad: capacidad || 2, tipo_licencia: tipo, vence };
}

// Lo usa cualquier dispositivo al activarse (o al revisar si sigue vigente
// despues). Consulta DIRECTO al servidor - no hay forma de que el
// dispositivo "calcule" una respuesta valida el solo, tiene que
// preguntarle a Firestore de verdad.
async function obtenerClienteRemoto(clienteId) {
  const ref = FirebaseSync.doc(db, 'clientes', (clienteId || '').trim().toUpperCase());
  const snap = await FirebaseSync.getDoc(ref);
  if (!snap.exists()) return [null, 'Ese código de cliente no existe.'];
  const cliente = { cliente_id: snap.id, ...snap.data() };
  if (cliente.tipo_licencia === 'trial' && cliente.vence) {
    const horaServidor = await horaServidorActual();
    const hoyServidor = horaServidor.toISOString().slice(0, 10);
    if (hoyServidor > cliente.vence) return [null, `La prueba venció el ${cliente.vence}`];
  }
  return [cliente, 'OK'];
}

// ============================================================================
// USO DIARIO POR CLIENTE - para poder avisarle a Nacho si un negocio se
// esta acercando al cupo gratis de Firebase, sin depender de que revise la
// consola de Firebase el mismo. Solo cuenta operaciones que TOCAN el
// servidor (enviar carrito, procesar carrito, usuarios) - "Cobrar aqui
// mismo" y el resto de la Venta normal NO gastan nada, no se cuentan.
// ============================================================================

function fechaHoyParaContador() {
  return new Date().toISOString().slice(0, 10);
}

// No espera a que termine (no queremos que una venta se sienta mas lenta
// por esto) - si falla, no pasa nada grave, es solo un contador informativo.
function incrementarUsoDiario(clienteId, tipo) {
  const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'uso_diario', fechaHoyParaContador());
  FirebaseSync.setDoc(ref, {
    operaciones: FirebaseSync.increment(1),
    [`por_tipo.${tipo}`]: FirebaseSync.increment(1),
  }, { merge: true }).catch(() => {});
}

async function obtenerUsoDeHoy(clienteId) {
  const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'uso_diario', fechaHoyParaContador());
  const snap = await FirebaseSync.getDoc(ref);
  return snap.exists() ? snap.data() : { operaciones: 0 };
}

// Trae los ultimos N dias de uso para ver una tendencia, no solo hoy.
async function obtenerUsoUltimosDias(clienteId, nDias) {
  const dias = [];
  for (let i = 0; i < nDias; i++) {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - i);
    const fechaTexto = fecha.toISOString().slice(0, 10);
    const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'uso_diario', fechaTexto);
    const snap = await FirebaseSync.getDoc(ref);
    dias.push({ fecha: fechaTexto, operaciones: snap.exists() ? (snap.data().operaciones || 0) : 0 });
  }
  return dias;
}

// Edita un cliente YA EXISTENTE (misma cliente_id) - lo usa App Soporte
// cuando el negocio contrata mas equipos o usuarios. Como el cliente_id no
// cambia, y todos los datos del negocio (usuarios, ventas locales, etc.)
// estan amarrados a ese mismo id, esto NO borra ni reinicia nada - los
// equipos ya activados simplemente ven la capacidad nueva la proxima vez
// que se conectan (al activar, o en la revision periodica de fondo).
async function editarClienteRemoto(clienteId, cambios) {
  const ref = FirebaseSync.doc(db, 'clientes', clienteId);
  await FirebaseSync.updateDoc(ref, cambios);
}

// ============================================================================
// LOGIN DE NACHO - solo App Soporte usa esto. Con esto, las reglas de
// Firestore pueden exigir "estar autenticado" para escribir en clientes/*,
// asi cualquiera con el link a App Soporte ya no puede editar licencias
// ajenas, sin necesitar que Nacho recuerde una clave distinta a la de
// Firebase - es la misma cuenta que ya administra el proyecto.
// ============================================================================

let auth = null;

async function iniciarSesionNacho(correo, clave) {
  try {
    await FirebaseSync.signInWithEmailAndPassword(auth, correo, clave);
    return [true, 'OK'];
  } catch (e) {
    const mensajes = {
      'auth/invalid-credential': 'Correo o clave incorrectos.',
      'auth/invalid-email': 'Ese correo no es válido.',
      'auth/too-many-requests': 'Demasiados intentos — espera un rato y volvé a intentar.',
    };
    return [false, mensajes[e.code] || ('No se pudo iniciar sesión: ' + e.message)];
  }
}

async function cerrarSesionNacho() {
  await FirebaseSync.signOut(auth);
}

// callback(usuario | null) cada vez que cambia el estado de sesion -
// incluye la primera vez que carga la pagina (para saber si ya estaba
// logueado de una sesion anterior, sin tener que volver a poner la clave).
function escucharSesionNacho(callback) {
  FirebaseSync.onAuthStateChanged(auth, callback);
}
