// Piezas de interfaz reutilizables: diálogos accesibles, avisos (toasts), validación de CIDR en vivo y tablas.
import { validarCidr } from '../calculos.js';
import { $, h, ico } from './base.js';

// ---- Diálogos simples (clave temporal, cambio de contraseña) ----
export function abrirDialogo(construir, { cerrable = true } = {}) {
  const dlg = h('dialog', { 'aria-modal': 'true' });
  const cerrar = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('close', () => dlg.remove());
  if (!cerrable) dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  construir(dlg, cerrar);
  dlg.showModal();
  return dlg;
}

/** Aviso breve (reemplaza a alert()): desaparece solo (los errores tardan más) y se puede cerrar. Los errores usan role="alert". */
export function toast(texto, tipo = 'ok') {
  const caja = $('toasts');
  while (caja.children.length >= 4) caja.firstElementChild.remove();
  const el = h(
    'div',
    { class: `toast toast-${tipo}`, role: tipo === 'error' ? 'alert' : 'status' },
    ico(tipo === 'error' ? 'error' : tipo === 'info' ? 'info' : 'ok', 20),
    h('span', { class: 'toast-texto' }, texto),
    h('button', { type: 'button', class: 'toast-cerrar', 'aria-label': 'Cerrar aviso', onclick: () => el.remove() }, ico('cerrar')),
  );
  caja.append(el);
  let t;
  const programar = () => {
    t = setTimeout(() => el.remove(), tipo === 'error' ? 9000 : 5000);
  };
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', programar);
  programar();
}

/**
 * Valida el CIDR mientras se escribe (formato, alineación con sugerencia y que quede dentro del pool) y deshabilita el envío si hay
 * un error. El servidor sigue siendo quien decide: esto solo anticipa el error. `cidrDePool()` devuelve el CIDR del pool elegido
 * (o nada); `soloBase` exige además que sea un bloque base válido (/8 a /30).
 */
export function vincularCidr(input, boton, cidrDePool = () => undefined, { soloBase = false } = {}) {
  const aviso = h('p', { class: 'campo-msg', id: input.id + '-msg', 'aria-live': 'polite' });
  input.setAttribute('aria-describedby', aviso.id);
  const revisar = () => {
    if (!aviso.isConnected && input.parentNode) input.after(aviso); // el campo se crea antes de entrar a la página: se inserta al primer uso
    let v = validarCidr(input.value, cidrDePool());
    const len = Number(input.value.split('/')[1]);
    if (soloBase && v.estado === 'ok' && (len < 8 || len > 30)) v = { estado: 'error', mensaje: 'Un bloque base va de /8 a /30.' };
    aviso.className = 'campo-msg' + (v.estado === 'error' ? ' campo-error' : v.estado === 'ok' ? ' campo-ok' : '');
    aviso.replaceChildren(...(v.estado === 'vacio' ? [] : [ico(v.estado === 'error' ? 'error' : 'ok'), ' ' + v.mensaje]));
    if (v.estado === 'error') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    boton.disabled = v.estado === 'error';
  };
  input.addEventListener('input', revisar);
  return revisar; // para volver a revisar cuando cambia el pool elegido
}

/**
 * Diálogo de confirmación accesible (reemplaza a confirm() y prompt()): usa <dialog> con showModal(), así el foco queda atrapado,
 * Esc cancela y el foco vuelve a quien lo abrió. Con `peligro` el foco inicial va a «Cancelar». Con `campo` pide un texto
 * (obligatorio si se indica). Devuelve { aceptado, valor }.
 */
export function dialogoSimple({ titulo, mensaje, confirmar: textoOk = 'Aceptar', cancelar: textoNo = 'Cancelar', peligro = false, campo = null }) {
  return new Promise((resolver) => {
    const id = 'dlg-' + Math.random().toString(36).slice(2, 8);
    const entrada = campo ? h('input', { id: id + '-c', maxlength: 200, autocomplete: 'off', 'aria-describedby': id + '-e' }) : null;
    const error = h('p', { id: id + '-e', class: 'campo-msg campo-error', role: 'alert' });
    const no = h('button', { type: 'button', class: 'btn sec' }, textoNo);
    const si = h('button', { type: 'submit', class: 'btn' + (peligro ? ' peligro' : '') }, textoOk);
    const d = h(
      'dialog',
      { class: 'confirmar', 'aria-labelledby': id + '-t', 'aria-describedby': id + '-m' },
      h(
        'form',
        { method: 'dialog' },
        h('h3', { id: id + '-t' }, titulo),
        h('p', { id: id + '-m' }, mensaje),
        campo && h('label', { for: id + '-c' }, campo.etiqueta),
        entrada,
        error,
        h('div', { class: 'fila-botones' }, no, si),
      ),
    );
    let aceptado = false;
    d.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (campo && campo.obligatorio && !entrada.value.trim()) {
        error.textContent = `Indica ${campo.etiqueta.toLowerCase()}: queda registrado.`;
        entrada.setAttribute('aria-invalid', 'true');
        entrada.focus();
        return;
      }
      if (campo && campo.debeCoincidir && entrada.value.trim() !== campo.debeCoincidir) {
        error.textContent = `Escribe exactamente ${campo.debeCoincidir} para confirmar.`;
        entrada.setAttribute('aria-invalid', 'true');
        entrada.focus();
        return;
      }
      aceptado = true;
      d.close();
    });
    no.addEventListener('click', () => d.close());
    d.addEventListener('close', () => {
      const valor = entrada ? entrada.value.trim() : '';
      d.remove();
      resolver({ aceptado, valor });
    });
    document.body.append(d);
    d.showModal();
    (entrada || (peligro ? no : si)).focus();
  });
}

export const confirmar = async (opciones) => (await dialogoSimple(opciones)).aceptado;

/**
 * Segunda confirmación antes de liberar un segmento ya entregado: si el bloque está en uso, liberarlo por error es grave. Hay que
 * escribir el CIDR exacto, así un clic o una tecla de más no basta. Devuelve true solo si se confirmó.
 */
export const confirmarLiberacionDefinitiva = (cidr) =>
  confirmar({
    titulo: 'Última confirmación',
    mensaje: `Vas a liberar ${cidr}. Si este bloque está en uso, las redes que lo usan podrían quedar sin direcciones o chocar con la próxima persona a la que se le entregue. Hazlo solo si la red ya se eliminó.`,
    confirmar: 'Sí, liberar ahora',
    peligro: true,
    campo: { etiqueta: `Escribe ${cidr} para confirmar`, obligatorio: true, debeCoincidir: cidr },
  });

export function tabla(titulo, cabeceras, filas, vacio) {
  if (!filas.length) return h('div', { class: 'card vacio' }, vacio);
  return h(
    'div',
    { class: 'card tablewrap' },
    h(
      'table',
      null,
      h('caption', { class: 'sr-only' }, titulo),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          cabeceras.map((c) => h('th', { scope: 'col' }, c)),
        ),
      ),
      h('tbody', null, filas),
    ),
  );
}
