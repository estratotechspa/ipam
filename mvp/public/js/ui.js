// Diálogo de confirmación accesible (reemplaza a confirm()) y avisos breves (reemplazan a alert()).
import { esc, I } from './util.js';

const FOCUSABLES = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let contadorDialogos = 0;

// confirmar({ titulo, mensaje, confirmar, cancelar, peligro }) → Promise<boolean>
//   role="dialog" + aria-modal, el foco queda atrapado dentro, Esc o clic fuera cancelan, y al cerrar el foco vuelve a
//   quien lo abrió. Con `peligro` (acciones destructivas) el foco inicial va al botón de cancelar.
export function confirmar({ titulo, mensaje, confirmar: textoOk = 'Aceptar', cancelar: textoNo = 'Cancelar', peligro = false }) {
  return new Promise((resolver) => {
    const id = `dlg-${++contadorDialogos}`;
    const previo = document.activeElement;
    const fondo = document.createElement('div');
    fondo.className = 'modal-fondo';
    fondo.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-m">
        <h2 id="${id}-t">${esc(titulo)}</h2>
        <p id="${id}-m">${esc(mensaje)}</p>
        <div class="modal-acciones">
          <button type="button" class="btn sec" data-no>${esc(textoNo)}</button>
          <button type="button" class="btn${peligro ? ' peligro' : ''}" data-si>${esc(textoOk)}</button>
        </div>
      </div>`;
    const resto = [...document.body.children].filter((e) => !e.classList.contains('toasts'));
    resto.forEach((e) => { e.inert = true; });          // lo de fondo no recibe foco ni lectores de pantalla
    document.body.append(fondo);
    document.body.classList.add('modal-abierto');

    const cerrar = (resultado) => {
      document.removeEventListener('keydown', teclas, true);
      fondo.remove();
      resto.forEach((e) => { e.inert = false; });
      document.body.classList.remove('modal-abierto');
      if (previo && previo.isConnected) previo.focus();
      resolver(resultado);
    };
    const teclas = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cerrar(false); return; }
      if (e.key !== 'Tab') return;
      const dentro = [...fondo.querySelectorAll(FOCUSABLES)];
      const primero = dentro[0];
      const ultimo = dentro[dentro.length - 1];
      if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
      else if (!fondo.contains(document.activeElement)) { e.preventDefault(); primero.focus(); }
    };
    document.addEventListener('keydown', teclas, true);
    fondo.addEventListener('mousedown', (e) => { if (e.target === fondo) cerrar(false); });
    fondo.querySelector('[data-no]').onclick = () => cerrar(false);
    fondo.querySelector('[data-si]').onclick = () => cerrar(true);
    fondo.querySelector(peligro ? '[data-no]' : '[data-si]').focus();
  });
}

// toast(texto, tipo) con tipo 'ok' (por defecto), 'error' o 'info'. Desaparece solo (más tarde si es un error) y se
// puede cerrar; los errores usan role="alert" (se leen de inmediato) y el resto role="status".
export function toast(texto, tipo = 'ok') {
  const contenedor = document.getElementById('toasts');
  if (!contenedor) return;
  while (contenedor.children.length >= 4) contenedor.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${tipo}`;
  el.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
  el.innerHTML = `${I(tipo === 'error' ? 'error' : tipo === 'info' ? 'info' : 'ok', 20)}<span class="toast-texto">${esc(texto)}</span>
    <button type="button" class="toast-cerrar" aria-label="Cerrar aviso">${I('cerrar')}</button>`;
  contenedor.append(el);
  let t;
  const programar = () => { t = setTimeout(() => el.remove(), tipo === 'error' ? 9000 : 5000); };
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', programar);
  el.querySelector('.toast-cerrar').onclick = () => { clearTimeout(t); el.remove(); };
  programar();
}
