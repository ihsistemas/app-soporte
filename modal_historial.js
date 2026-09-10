// Hace que el boton "atras" del navegador (o el gesto de atras en celular)
// cierre el modal que este abierto, en vez de salir de la pagina entera o
// volver a una pantalla anterior de forma confusa. Funciona para CUALQUIER
// elemento con clase "modal" que se abra/cierre agregando/quitando la clase
// "activo" - que es como ya estan armados todos los modales existentes, asi
// que no hace falta tocar cada boton de abrir/cerrar uno por uno.
//
// Se incluye una vez por pagina (un <script src="modal_historial.js">) y
// queda funcionando solo para todos los modales presentes, incluidos los
// que se agreguen despues.

(function () {
  let historialEmpujado = false;
  let navegandoFuera = false;
  window.addEventListener('beforeunload', () => { navegandoFuera = true; });

  function hayModalAbierto() {
    return document.querySelector('.modal.activo') !== null;
  }

  function alCambiarModales() {
    const abierto = hayModalAbierto();
    if (abierto && !historialEmpujado) {
      // Se abrio un modal (el primero, si hay varios apilados) - empujamos
      // UN estado nuevo al historial, para que "atras" lo consuma a el
      // primero, no a la pagina entera.
      history.pushState({ modalAbierto: true }, '', location.href);
      historialEmpujado = true;
    } else if (!abierto && historialEmpujado) {
      // El modal se cerro con su propio boton (no con "atras") - hay que
      // consumir el estado que habiamos empujado, para que el historial no
      // quede con una entrada de mas esperando un "atras" que ya no hace falta.
      historialEmpujado = false;
      // Se retrasa (en vez de llamarlo ya mismo) - si el codigo que cerro
      // el modal tambien navega a otra pagina justo despues (ej: "cerrar
      // este modal y despues ir a otra pantalla"), esto le da tiempo a esa
      // navegacion real de ganar primero. El chequeo de "navegandoFuera"
      // (via beforeunload) es la protección real - el timeout es solo para
      // darle una oportunidad de que beforeunload llegue a dispararse antes.
      setTimeout(() => { if (!navegandoFuera && !hayModalAbierto()) history.back(); }, 80);
    }
  }

  // Este script se carga al final de la pagina (junto a los demas <script>),
  // asi que el DOM ya esta completamente armado para cuando esto se
  // ejecuta - no hace falta esperar DOMContentLoaded (ese evento ya paso
  // para cuando este archivo termina de cargar, esperarlo lo dejaba sin
  // efecto).
  const observador = new MutationObserver(alCambiarModales);
  document.querySelectorAll('.modal').forEach((modal) => {
    observador.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
  const observadorNuevosNodos = new MutationObserver((mutaciones) => {
    mutaciones.forEach((m) => {
      m.addedNodes.forEach((nodo) => {
        if (nodo.nodeType === 1 && nodo.classList && nodo.classList.contains('modal')) {
          observador.observe(nodo, { attributes: true, attributeFilter: ['class'] });
        }
      });
    });
  });
  observadorNuevosNodos.observe(document.body, { childList: true });

  window.addEventListener('popstate', () => {
    if (hayModalAbierto()) {
      document.querySelectorAll('.modal.activo').forEach((m) => m.classList.remove('activo'));
      historialEmpujado = false;
    }
  });
})();
