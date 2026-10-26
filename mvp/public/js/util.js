// Utilidades de presentación compartidas por las vistas.
import { icono } from '/iconos.js';
export { fmt } from './calculos.js';

export const $ = (id) => document.getElementById(id);
export const I = icono;

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fecha = (s) => new Date(s).toLocaleDateString('es-CL');
export const fechaHora = (s) => new Date(s).toLocaleString('es-CL');
export const hora = (s) => new Date(s).toLocaleTimeString('es-CL');
export const tag = (ambiente) => `<span class="tag ${esc(ambiente)}">${esc(ambiente)}</span>`;

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Estados de una vista: cargando y error (con botón para reintentar).
export function cargando(el, texto = 'Cargando…') {
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = `<p class="cargando" role="status">${I('reintentar')} ${esc(texto)}</p>`;
}
export function falla(el, error, reintentar) {
  el.removeAttribute('aria-busy');
  el.innerHTML = `<div class="alert" role="alert">${I('error')} No se pudo cargar: ${esc(error.message)}
    ${reintentar ? '<button type="button" class="btn sec" data-reintentar>Reintentar</button>' : ''}</div>`;
  const b = el.querySelector('[data-reintentar]');
  if (b) b.onclick = reintentar;
}
