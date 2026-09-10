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

// REEMPLAZAR con la clave real de reCAPTCHA v3 una vez que Nacho la genere.
const RECAPTCHA_SITE_KEY = "6LeLwactAAAAAF2nD88ZzMDM9icR49c6V1Js80GL";

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
  if (!RECAPTCHA_SITE_KEY.startsWith('REEMPLAZAR') && FirebaseSync.initializeAppCheck) {
    FirebaseSync.initializeAppCheck(firebaseApp, {
      provider: new FirebaseSync.ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
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

// A qué colección van los usuarios de un cliente depende de qué programa
// tiene habilitado: Minimarket/Caja Móvil los guarda bajo negocios/{id},
// Parking los guarda bajo clientes/{id} directo (un cliente de Parking no
// tiene por qué tener un documento de "negocio"). Todo lo que lee/escribe
// usuarios de acá en adelante recibe la raíz como parámetro (con 'negocios'
// de default, para no romper nada de lo que ya llamaba a esto sin decir
// cuál raíz usar).
function raizUsuariosParaCliente(cliente) {
  return (cliente && cliente.modulos && cliente.modulos.parking) ? 'clientes' : 'negocios';
}

async function crearUsuarioRemoto(clienteId, datos, raiz) {
  const col = FirebaseSync.collection(db, raiz || 'negocios', clienteId, 'usuarios');
  const ref = await FirebaseSync.addDoc(col, { ...datos, activo: true });
  incrementarUsoDiario(clienteId, 'usuario_creado');
  return ref.id;
}

async function editarUsuarioRemoto(clienteId, usuarioId, cambios, raiz) {
  const ref = FirebaseSync.doc(db, raiz || 'negocios', clienteId, 'usuarios', usuarioId);
  await FirebaseSync.updateDoc(ref, cambios);
  incrementarUsoDiario(clienteId, 'usuario_editado');
}

// ---- Claves: PBKDF2 con sal propia por usuario, nunca texto plano - mismo
// esquema exacto que ya usan Caja Móvil (datos.js) y Parking
// (parking-sync.js), para que una clave creada acá sirva para entrar en
// cualquiera de las 2 apps sin conversión. ----
const PBKDF2_ITERACIONES = 100000;
function saltAleatoria() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexABytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return new Uint8Array(bytes);
}
async function hashClave(clave, saltHex) {
  const salt = saltHex || saltAleatoria();
  const claveKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits']);
  const derivado = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexABytes(salt), iterations: PBKDF2_ITERACIONES, hash: 'SHA-256' },
    claveKey, 256
  );
  const hash = Array.from(new Uint8Array(derivado)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return { hash, salt };
}
function generarClaveRespaldo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const grupo = (offset) => Array.from({ length: 4 }, (_, i) => chars[bytes[offset + i] % chars.length]).join('');
  return `${grupo(0)}-${grupo(4)}-${grupo(8)}`;
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
async function crearClienteRemoto({ nombre, capacidad, capacidadUsuarios, tipoLicencia, diasPrueba, modulo }) {
  const clienteId = generarClienteId();
  const tipo = tipoLicencia === 'trial' ? 'trial' : 'permanente';
  let vence = null;
  if (tipo === 'trial') {
    const horaServidor = await horaServidorActual();
    const fechaVence = new Date(horaServidor);
    fechaVence.setDate(fechaVence.getDate() + (Number(diasPrueba) || 15));
    vence = fechaVence.toISOString().slice(0, 10);
  }
  const moduloInicial = modulo || 'minimarket';
  const ref = FirebaseSync.doc(db, 'clientes', clienteId);
  await FirebaseSync.setDoc(ref, {
    nombre, capacidad: capacidad || 2, capacidad_usuarios: capacidadUsuarios || 6,
    tipo_licencia: tipo, vence, modulos: { [moduloInicial]: true },
    fecha_creado: FirebaseSync.serverTimestamp(),
  });
  return { cliente_id: clienteId, nombre, capacidad: capacidad || 2, tipo_licencia: tipo, vence, modulos: { [moduloInicial]: true } };
}

// Trae TODOS los clientes desde el servidor (antes esta lista solo vivía en
// localStorage de cada navegador) - hace falta para las pestañas por
// programa y para el panel de uso total, que necesitan ver todos los
// clientes, no solo los que este navegador creó alguna vez.
async function listarTodosLosClientes() {
  const col = FirebaseSync.collection(db, 'clientes');
  const snap = await FirebaseSync.getDocs(col);
  const clientes = [];
  snap.forEach((doc) => clientes.push({ cliente_id: doc.id, ...doc.data() }));
  return clientes;
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

// ============================================================================
// REVISION DE BIBLIOTECA - solo App Soporte. Nacho ve lo que cada cliente
// propuso, y decide que aprobar (sube a la biblioteca general), que
// descartar (queda marcado, no estorba mas), o que dejar tal cual esta.
// ============================================================================

async function listarPendientesBiblioteca(clienteId) {
  const col = FirebaseSync.collection(db, 'clientes', clienteId, 'biblioteca_pendiente');
  const consulta = FirebaseSync.query(col, FirebaseSync.where('estado', '==', 'pendiente'));
  const snap = await FirebaseSync.getDocs(consulta);
  const items = [];
  snap.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
  return items;
}

// incluirImagen=false -> solo se aprueba codigo+nombre, sin la foto que
// mando el cliente (por si Nacho prefiere poner su propia foto despues).
async function aprobarProductoPendiente(clienteId, itemPendienteId, { codigoBarra, nombre, imagenData, incluirImagen }) {
  const refBiblioteca = FirebaseSync.doc(db, 'biblioteca_productos', codigoBarra);
  await FirebaseSync.setDoc(refBiblioteca, {
    nombre, imagen_data: incluirImagen ? (imagenData || null) : null,
    creado_por: 'cliente', cliente_id_origen: clienteId,
    fecha_creacion: FirebaseSync.serverTimestamp(),
  });
  const refPendiente = FirebaseSync.doc(db, 'clientes', clienteId, 'biblioteca_pendiente', itemPendienteId);
  await FirebaseSync.updateDoc(refPendiente, { estado: 'aprobado' });
}

async function descartarProductoPendiente(clienteId, itemPendienteId) {
  const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'biblioteca_pendiente', itemPendienteId);
  await FirebaseSync.updateDoc(ref, { estado: 'descartado' });
}

// Para la seccion de "editar biblioteca general en cualquier momento" -
// busca por codigo exacto (la biblioteca puede llegar a ser grande, no se
// lista completa sin filtro).
async function buscarEnBiblioteca(codigoBarra) {
  if (!codigoBarra) return null;
  const ref = FirebaseSync.doc(db, 'biblioteca_productos', codigoBarra);
  const snap = await FirebaseSync.getDoc(ref);
  return snap.exists() ? { codigo_barra: snap.id, ...snap.data() } : null;
}

async function editarEntradaBiblioteca(codigoBarra, cambios) {
  const ref = FirebaseSync.doc(db, 'biblioteca_productos', codigoBarra);
  await FirebaseSync.updateDoc(ref, cambios);
}

// ============================================================================
// EQUIPOS DE UN CLIENTE - traído desde Caja Móvil para que Manager IH tenga
// visibilidad real de cuántos equipos tiene activados cada cliente y pueda
// dar de baja uno (libera cupo al instante) sin pedirle el celular a nadie.
// ============================================================================

async function listarEquiposRemoto(clienteId) {
  const col = FirebaseSync.collection(db, 'clientes', clienteId, 'equipos');
  const snap = await FirebaseSync.getDocs(col);
  const equipos = [];
  snap.forEach((doc) => equipos.push({ device_id: doc.id, ...doc.data() }));
  return equipos;
}

async function soltarEquipoRemoto(clienteId, deviceId) {
  const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'equipos', deviceId);
  await FirebaseSync.deleteDoc(ref);
}

// ============================================================================
// CUENTA DEL JEFE - Manager IH crea el primer usuario ("jefe") de un negocio
// con una clave provisoria (clave_temporal=true) y genera un código que
// combina el cliente_id con este usuario_id. Ese código (QR o texto) es lo
// que Nacho le entrega al dueño del negocio - cuando lo escanea en
// Minimarket IH (antes Caja Móvil), debe entrar directo como este usuario y
// quedar obligado a elegir su propia clave (mismo mecanismo de
// clave_temporal que ya existe para invitar empleados). Ese lado (leer el
// código en la activación) se construye en otra conversación - ver
// CONTEXTO_HANDOFF_JEFE_QR.md.
// ============================================================================

// Lectura puntual (no un listener en vivo) - esta pantalla se abre, se
// muestra una foto del momento, y se refresca solo cuando el usuario hace
// una acción (dar de baja, agregar) - no hace falta un listener permanente
// como el que sí usa Caja Móvil mientras un cajero trabaja.
async function obtenerUsuariosDeNegocio(clienteId, raiz) {
  const col = FirebaseSync.collection(db, raiz || 'negocios', clienteId, 'usuarios');
  const snap = await FirebaseSync.getDocs(col);
  const usuarios = [];
  snap.forEach((doc) => usuarios.push({ id: doc.id, ...doc.data() }));
  return usuarios;
}

// El código QR de "primer ingreso" (clienteId#usuarioId) solo tiene sentido
// para Minimarket/Caja Móvil, que sabe leerlo en su propia activación. Un
// jefe de Parking entra distinto (activa un equipo a una sede, y ahí recién
// inicia sesión con usuario/clave) - por eso acá no se genera "codigo" para
// Parking, y la clave queda con hash de verdad (antes se guardaba en texto
// plano, y ese jefe no podía iniciar sesión en ningún lado con esa clave).
async function crearJefeRemoto(clienteId, nombre, raiz) {
  const esParking = raiz === 'clientes';
  const col = FirebaseSync.collection(db, raiz || 'negocios', clienteId, 'usuarios');
  const claveProvisoria = Math.floor(1000 + Math.random() * 9000).toString();
  const { hash, salt } = await hashClave(claveProvisoria);
  const claveRespaldo = generarClaveRespaldo();
  const respaldo = await hashClave(claveRespaldo);
  const ref = await FirebaseSync.addDoc(col, {
    nombre, rol: 'jefe', clave_hash: hash, clave_salt: salt,
    clave_respaldo_hash: respaldo.hash, clave_respaldo_salt: respaldo.salt,
    puede_gestionar_usuarios: true, clave_temporal: true, activo: true,
  });
  return {
    usuario_id: ref.id, clave_provisoria: claveProvisoria,
    codigo: esParking ? null : `${clienteId}#${ref.id}`,
  };
}

// ============================================================================
// ESTACIONAMIENTOS (Parking) - clientes/{clienteId}/estacionamientos/{loteId}.
// Un cliente de Parking puede tener varias sedes (ej: un hospital con 2
// ubicaciones) - cada una con su propia capacidad de calzos, su propio tope
// de equipos, y sus propios usuarios/movimientos/garitas, sin mezclarse
// entre sí. Nacho crea cada sede desde acá (Manager IH) y le entrega el
// código de activación resultante (clienteId#loteId) a esa ubicación en
// particular. Los usuarios (trabajadores) NO se crean acá - eso lo hace el
// jefe desde dentro de la app de Parking, una vez que activa la primera
// sede (ver parking_movil/parking-sync.js).
// ============================================================================

function generarLoteId(estacionamientosActuales) {
  // Etiquetas cortas y legibles (E1, E2, ...) en vez de IDs largos al azar -
  // el código de activación completo ya es bastante largo con el clienteId
  // adelante, no hace falta sumarle más caracteres de los necesarios.
  let n = (estacionamientosActuales || []).length + 1;
  let candidato = `E${n}`;
  const existentes = new Set((estacionamientosActuales || []).map((e) => e.lote_id));
  while (existentes.has(candidato)) { n += 1; candidato = `E${n}`; }
  return candidato;
}

async function listarEstacionamientosRemoto(clienteId) {
  const col = FirebaseSync.collection(db, 'clientes', clienteId, 'estacionamientos');
  const snap = await FirebaseSync.getDocs(col);
  const items = [];
  snap.forEach((doc) => items.push({ lote_id: doc.id, ...doc.data() }));
  return items.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
}

async function crearEstacionamientoRemoto(clienteId, { nombre, capacidadEquipos, esPago }) {
  const existentes = await listarEstacionamientosRemoto(clienteId);
  const loteId = generarLoteId(existentes);
  const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'estacionamientos', loteId);
  await FirebaseSync.setDoc(ref, {
    nombre: nombre || loteId, capacidad_equipos: Number(capacidadEquipos) || 2,
    capacidad_total: 0, ocupados: 0, es_pago: !!esPago, fecha_creado: FirebaseSync.serverTimestamp(),
  });
  return { lote_id: loteId, codigo: `${clienteId}#${loteId}` };
}

// El "plus" de cobro por minuto - Nacho lo prende/apaga acá (es el gate
// comercial), pero el PRECIO en sí (pesos por minuto, minutos de gracia,
// etc.) lo ajusta el jefe desde su propia app una vez que está activado -
// mismo patrón que la capacidad de calzos.
async function editarModoPagoLote(clienteId, loteId, esPago) {
  const ref = FirebaseSync.doc(db, 'clientes', clienteId, 'estacionamientos', loteId);
  await FirebaseSync.setDoc(ref, { es_pago: !!esPago }, { merge: true });
}

async function eliminarEstacionamientoRemoto(clienteId, loteId) {
  // Borrado simple del documento de la sede - NO borra en cascada sus
  // subcolecciones (movimientos, usuarios asignados, equipos) porque
  // Firestore no lo hace solo y esto es una acción rara (una sede que se
  // cierra de verdad). Si hace falta limpiar el historial también, se hace
  // a mano desde la consola de Firebase.
  await FirebaseSync.deleteDoc(FirebaseSync.doc(db, 'clientes', clienteId, 'estacionamientos', loteId));
}
