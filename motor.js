// SYNC: esta logica debe ser IDENTICA en las 3 copias de este motor —
// caja_movil/motor.js, app_soporte/motor.js, y minimarket_pro/frontend/src/lib/motorEquipos.js.
// Para confirmar que no se desincronizaron, comparalas con diff (ignorando este
// encabezado y, en la copia de minimarket_pro, el bloque final de "export {...}",
// que solo existe ahi porque esa copia es un modulo ES).
// ============================================================================
// App Maestra IH Sistemas - motor de clientes y equipos.
//
// Idea central: cuando Nacho crea un "Cliente" con capacidad para N equipos,
// se genera UN SOLO token firmado (no N por separado) que dice "este cliente
// existe, tiene capacidad para N equipos". El PRIMER celular que lo escanea
// se vuelve "maestro" de ese cliente, y es el maestro (no la app de Nacho)
// quien despues reparte el acceso a los demas equipos, hasta el limite N -
// sin que Nacho tenga que estar presente cada vez.
//
// El maestro mantiene su PROPIA lista local de "equipos vinculados" (nombre +
// id de cada uno). Puede soltar un equipo de esa lista para liberar espacio
// y agregar un reemplazo - la capacidad es "maximo N AL MISMO TIEMPO", no
// "maximo N durante toda la vida del cliente".
// ============================================================================

const MAESTRA_SECRET = "IH-SISTEMAS-APP-MAESTRA-V1-PRIVATE-2026"; // DISTINTO al de Caja Movil y Minimarket Pro
const MAESTRA_PREFIX = "IHCLI";
const LARGO_FIRMA = 10; // bytes (80 bits) - mismo criterio que los otros candados

const B32_ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32Encode(bytes) {
  let bits = ""; for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) { const c = bits.slice(i, i + 5).padEnd(5, "0"); out += B32_ALFABETO[parseInt(c, 2)]; }
  return out;
}
function b32Decode(text) {
  const limpio = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = ""; for (const c of limpio) { const idx = B32_ALFABETO.indexOf(c); if (idx === -1) continue; bits += idx.toString(2).padStart(5, "0"); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}
function bytesToHex(b) { return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) { const b = []; for (let i = 0; i < h.length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16)); return new Uint8Array(b); }

async function hmacSha256Hex(secreto, mensaje) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const f = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(mensaje));
  return bytesToHex(new Uint8Array(f));
}

// ---- Registro LOCAL del maestro: que equipos tiene vinculados este cliente ----
// Vive en el localStorage del celular MAESTRO unicamente - cada maestro solo
// conoce sus propios equipos, no los de otros clientes.
function cargarEquiposVinculados() {
  try { return JSON.parse(localStorage.getItem("ih_equipos_vinculados") || "[]"); }
  catch (e) { return []; }
}
function guardarEquiposVinculados(lista) {
  localStorage.setItem("ih_equipos_vinculados", JSON.stringify(lista));
}
function agregarEquipoVinculado({ device_id, nombre, rol }) {
  const lista = cargarEquiposVinculados();
  lista.push({ device_id, nombre, rol, fecha: new Date().toISOString() });
  guardarEquiposVinculados(lista);
}
function soltarEquipoVinculado(device_id) {
  const lista = cargarEquiposVinculados().filter((e) => e.device_id !== device_id);
  guardarEquiposVinculados(lista);
}
function hayCupoDisponible(cliente) {
  return cargarEquiposVinculados().length < (cliente.capacidad || 2);
}

// ============================================================================
// INVITACIONES: el MAESTRO genera esto (no Nacho) para sumar un equipo mas,
// sin que Nacho tenga que estar presente. Formato distinto (IHINV, no IHCLI)
// para que un equipo nunca confunda "este es un cliente nuevo" con "esto es
// una invitacion a un cliente que ya existe".
// ============================================================================
const INVITACION_PREFIX = "IHINV";

// Las invitaciones ya NO cargan capacidad/licencia adentro - el equipo que
// se suma consulta esos datos FRESCOS directo al servidor (obtenerClienteRemoto)
// apenas se activa, asi siempre ve el estado real, no una foto vieja de el
// momento en que se genero la invitacion. Solo hace falta decir A QUE
// cliente se esta invitando.
function payloadInvitacion(inv) {
  return [inv.cliente_id, inv.nombre_cliente, inv.fecha_invitacion].join("|");
}
async function firmarInvitacion(inv) {
  return await hmacSha256Hex(MAESTRA_SECRET, payloadInvitacion(inv));
}
async function generarInvitacion(cliente) {
  const inv = {
    cliente_id: cliente.cliente_id, nombre_cliente: cliente.nombre,
    fecha_invitacion: new Date().toISOString(),
  };
  const firmaCompleta = await firmarInvitacion(inv);
  const payloadB32 = b32Encode(new TextEncoder().encode(payloadInvitacion(inv)));
  const firmaB32 = b32Encode(hexToBytes(firmaCompleta).slice(0, LARGO_FIRMA));
  return `${INVITACION_PREFIX}-${payloadB32}-SIG-${firmaB32}`;
}
async function validarInvitacion(codigo) {
  const raw = (codigo || "").trim().toUpperCase().replace(/\s/g, "");
  if (!raw.startsWith(INVITACION_PREFIX + "-") || !raw.includes("-SIG-")) return [null, "Formato invalido"];
  const [izq, sigParte] = raw.split("-SIG-");
  const pb = izq.slice(INVITACION_PREFIX.length + 1);
  try {
    const payloadTexto = new TextDecoder().decode(b32Decode(pb));
    const [cliente_id, nombre_cliente, fecha_invitacion] = payloadTexto.split("|");
    const inv = { cliente_id, nombre_cliente, fecha_invitacion };
    const firmaEsperada = (await firmarInvitacion(inv)).slice(0, LARGO_FIRMA * 2);
    const firmaRecibida = bytesToHex(b32Decode(sigParte)).slice(0, LARGO_FIRMA * 2);
    if (firmaRecibida !== firmaEsperada) return [null, "Firma invalida — invitación alterada o corrupta"];
    return [inv, "OK"];
  } catch (e) {
    return [null, "Error al leer invitación: " + e.message];
  }
}

// ============================================================================
// CONFIRMACIONES: el equipo SUB, apenas se une con una invitacion, genera
// esto para que el MAESTRO lo escanee de vuelta y lo agregue a su lista con
// nombre. Es el "segundo paso" del apreton de manos - sin esto, el maestro
// nunca se enteraria de que un nuevo equipo se unio, ni con que nombre.
// ============================================================================
const CONFIRMACION_PREFIX = "IHCONF";

function payloadConfirmacion(c) {
  return [c.cliente_id, c.device_id, c.nombre_equipo].join("|");
}
async function firmarConfirmacion(c) {
  return await hmacSha256Hex(MAESTRA_SECRET, payloadConfirmacion(c));
}
async function generarConfirmacion({ cliente_id, device_id, nombre_equipo }) {
  const c = { cliente_id, device_id, nombre_equipo };
  const firmaCompleta = await firmarConfirmacion(c);
  const payloadB32 = b32Encode(new TextEncoder().encode(payloadConfirmacion(c)));
  const firmaB32 = b32Encode(hexToBytes(firmaCompleta).slice(0, LARGO_FIRMA));
  return `${CONFIRMACION_PREFIX}-${payloadB32}-SIG-${firmaB32}`;
}
async function validarConfirmacion(codigo, cliente_id_esperado) {
  const raw = (codigo || "").trim().toUpperCase().replace(/\s/g, "");
  if (!raw.startsWith(CONFIRMACION_PREFIX + "-") || !raw.includes("-SIG-")) return [null, "Formato invalido"];
  const [izq, sigParte] = raw.split("-SIG-");
  const pb = izq.slice(CONFIRMACION_PREFIX.length + 1);
  try {
    const payloadTexto = new TextDecoder().decode(b32Decode(pb));
    const [cliente_id, device_id, nombre_equipo] = payloadTexto.split("|");
    const c = { cliente_id, device_id, nombre_equipo };
    const firmaEsperada = (await firmarConfirmacion(c)).slice(0, LARGO_FIRMA * 2);
    const firmaRecibida = bytesToHex(b32Decode(sigParte)).slice(0, LARGO_FIRMA * 2);
    if (firmaRecibida !== firmaEsperada) return [null, "Firma invalida"];
    if (cliente_id_esperado && cliente_id !== cliente_id_esperado) return [null, "Esta confirmación es de otro cliente"];
    return [c, "OK"];
  } catch (e) {
    return [null, "Error al leer confirmación: " + e.message];
  }
}

// ============================================================================
// Identidad de ESTE dispositivo (celular/PC) - random, generado una vez,
// persistido localmente. Es lo que se firma en cada confirmacion, para que
// el maestro sepa exactamente cual equipo es cual.
// ============================================================================
function getDeviceId() {
  let id = localStorage.getItem("ih_device_id");
  if (!id) {
    id = "EQ-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
    localStorage.setItem("ih_device_id", id);
  }
  return id;
}

// ---- Estado local: a que cliente pertenece ESTE equipo, y con que rol ----
function cargarEstadoEquipo() {
  try { return JSON.parse(localStorage.getItem("ih_estado_equipo") || "null"); }
  catch (e) { return null; }
}
function guardarEstadoEquipo(estado) {
  localStorage.setItem("ih_estado_equipo", JSON.stringify(estado));
}

// Se llama cada vez que se ABRE la app (no solo al activar) - asi una prueba
// que vence MIENTRAS el programa esta cerrado tambien se bloquea la proxima
// vez que se abra, sin depender de que nadie este mirando en el momento
// exacto del vencimiento.
// Chequeo LOCAL rapido (sin red) usado solo para la primera pintada de
// pantalla, antes de que la revision contra el servidor (mas lenta, de
// verdad confiable) termine. No es la fuente de verdad - esa es
// obtenerClienteRemoto en carrito_compartido.js.
function licenciaVencida(cliente) {
  if (!cliente || cliente.tipo_licencia !== "trial") return false;
  if (!cliente.vence) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  return hoy > cliente.vence;
}

function estadoEquipoVigente() {
  const estado = cargarEstadoEquipo();
  if (!estado) return { vigente: false, motivo: "sin_activar" };
  if (licenciaVencida(estado)) return { vigente: false, motivo: "vencida", estado };
  return { vigente: true, estado };
}
