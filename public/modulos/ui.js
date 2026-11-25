// Piezas de interfaz reutilizables: diálogos accesibles, avisos (toasts), validación de CIDR en vivo y tablas.
import { limitesCidr, validarCidr } from '../calculos.js';
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
    const lim = v.estado === 'ok' ? limitesCidr(input.value) : null;
    aviso.replaceChildren(
      ...(v.estado === 'vacio' ? [] : [ico(v.estado === 'error' ? 'error' : 'ok'), ' ' + v.mensaje]),
      ...(lim ? [h('br'), ...rangoDeIps(lim)] : []),
    );
    if (v.estado === 'error') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    boton.disabled = v.estado === 'error';
  };
  input.addEventListener('input', revisar);
  return revisar; // para volver a revisar cuando cambia el pool elegido
}

/** «Primera IP 10.0.0.0 · Última IP 10.0.0.255»: vista previa del bloque antes de reservarlo. */
export const rangoDeIps = (lim) => ['Primera IP ', h('code', null, lim.primera), ' · Última IP ', h('code', null, lim.ultima)];

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
  const t = h(
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
  );
  columnasAjustables(t, titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return h('div', { class: 'card tablewrap' }, t);
}

/* ===== Columnas ajustables: se arrastra el borde del encabezado (o se usan las flechas con el borde enfocado) para ensanchar o achicar una
   columna y leer mejor un texto largo. Doble clic restablece. Los anchos se recuerdan por tabla en este navegador. ===== */
const ANCHO_MIN = 56;
const PASO_TECLADO = 16;
const leerAnchos = (clave) => {
  try {
    return JSON.parse(localStorage.getItem('ipam.cols.' + clave) || '{}') || {};
  } catch {
    return {};
  }
};
const guardarAnchos = (clave, anchos) => {
  try {
    if (Object.keys(anchos).length) localStorage.setItem('ipam.cols.' + clave, JSON.stringify(anchos));
    else localStorage.removeItem('ipam.cols.' + clave);
  } catch {
    /* sin almacenamiento: el ajuste vale solo mientras la tabla esté en pantalla */
  }
};

/** @param {HTMLTableElement} tabla @param {string} clave identifica la tabla para recordar sus anchos */
export function columnasAjustables(tabla, clave) {
  const ths = [...tabla.querySelectorAll('thead th')];
  if (!ths.length) return;
  const id = (th, i) => (th.querySelector('[data-orden]') ? th.querySelector('[data-orden]').dataset.orden : th.textContent.trim() || 'c' + i);
  const anchos = leerAnchos(clave);
  let congelada = false;
  const ajustarTabla = () => {
    tabla.style.width = ths.reduce((t, th) => t + (parseFloat(th.style.width) || th.offsetWidth), 0) + 'px';
  };
  // Congela los anchos actuales (para que arrastrar una columna no reparta el cambio entre las demás).
  const congelar = () => {
    if (congelada) return;
    congelada = true;
    const actuales = ths.map((th) => th.offsetWidth + 3); // holgura: offsetWidth redondea hacia abajo y el texto ajustado justo se partiría
    tabla.classList.add('ajustable');
    ths.forEach((th, i) => (th.style.width = (anchos[id(th, i)] || actuales[i]) + 'px'));
    ajustarTabla();
  };
  const fijar = (th, i, px) => {
    congelar();
    const ancho = Math.max(ANCHO_MIN, Math.round(px));
    th.style.width = ancho + 'px';
    anchos[id(th, i)] = ancho;
    th.querySelector('.col-ajuste')?.setAttribute('aria-valuenow', String(ancho));
    ajustarTabla();
    guardarAnchos(clave, anchos);
  };
  const restablecer = () => {
    for (const k of Object.keys(anchos)) delete anchos[k];
    congelada = false;
    tabla.classList.remove('ajustable');
    tabla.style.width = '';
    ths.forEach((th) => (th.style.width = ''));
    guardarAnchos(clave, anchos);
  };

  ths.forEach((th, i) => {
    if (i === ths.length - 1 && !th.textContent.trim().replace(/Acciones/i, '')) return; // la columna de acciones no se ajusta
    const nombre = th.textContent.trim() || 'la columna';
    const asa = h('span', {
      class: 'col-ajuste',
      role: 'separator',
      'aria-orientation': 'vertical',
      tabindex: '0',
      'aria-label': `Ajustar el ancho de ${nombre}`,
      'aria-valuemin': String(ANCHO_MIN),
      'aria-valuemax': '1200',
      'aria-valuenow': String(anchos[id(th, i)] || Math.round(th.offsetWidth)),
      title: 'Arrastra para cambiar el ancho; doble clic para restablecer',
    });
    asa.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      congelar();
      const x0 = e.clientX;
      const w0 = th.offsetWidth;
      asa.setPointerCapture(e.pointerId);
      asa.classList.add('activa');
      const mover = (ev) => fijar(th, i, w0 + ev.clientX - x0);
      const soltar = () => {
        asa.classList.remove('activa');
        asa.removeEventListener('pointermove', mover);
        asa.removeEventListener('pointerup', soltar);
        asa.removeEventListener('pointercancel', soltar);
      };
      asa.addEventListener('pointermove', mover);
      asa.addEventListener('pointerup', soltar);
      asa.addEventListener('pointercancel', soltar);
    });
    asa.addEventListener('focus', () => asa.setAttribute('aria-valuenow', String(Math.round(th.offsetWidth))));
    asa.addEventListener('click', (e) => e.stopPropagation()); // no ordena la columna al soltar el borde
    asa.addEventListener('dblclick', restablecer);
    asa.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
      e.preventDefault();
      if (e.key === 'Escape') return restablecer();
      fijar(th, i, th.offsetWidth + (e.key === 'ArrowRight' ? PASO_TECLADO : -PASO_TECLADO));
    });
    th.append(asa);
  });
  // Anchos recordados: se aplican en cuanto la tabla está en pantalla (hay que medir las demás columnas).
  if (Object.keys(anchos).length) requestAnimationFrame(congelar);
}
