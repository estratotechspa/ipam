// Utilidades compartidas: atajos del DOM, formato, constructor h(), cliente de la API y el estado de la sesión (YO).
import { icono } from '../iconos.js';

/** Estado de la interfaz compartido entre módulos (los módulos ES no pueden reasignar variables importadas). */
export const ESTADO = {
  vista: 'pools',
  busquedaAsig: '', // texto del buscador de Asignaciones
  ultimoJira: null, // resultado de la última simulación (se muestra tras recargar la pestaña)
  poolsAviso: null, // aviso que Pools muestra tras crear o eliminar un pool
};

export const $ = (id) => document.getElementById(id);

export const I = icono;

/** Icono como elemento (para el constructor h()): el SVG es de este código, no de datos del usuario. */
export const ico = (nombre, tam) => {
  const e = document.createElement('span');
  e.className = 'ic-envoltorio';
  e.innerHTML = icono(nombre, tam);
  return e;
};

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (n) => Number(n).toLocaleString('es-CL');

export const fecha = (s) => new Date(s).toLocaleDateString('es-CL');

export const size = (c) => 2 ** (32 - Number(c.split('/')[1]));

export const tag = (a) => `<span class="tag ${esc(a)}">${esc(a)}</span>`;

export const CAB = { 'X-Requested-With': 'ipam' };

export async function api(url, opt) {
  const init =
    opt && opt.body !== undefined
      ? { method: opt.method || 'POST', headers: { 'Content-Type': 'application/json', ...CAB, ...(opt.headers || {}) }, body: JSON.stringify(opt.body) }
      : { headers: CAB, method: (opt && opt.method) || 'GET' };
  const r = await fetch(url, init);
  if (r.status === 401 && YO.modo === 'oidc') {
    location.href = '/auth/login?next=' + encodeURIComponent(location.pathname);
    return { ok: false, status: 401, data: null };
  }
  let j = null;
  try {
    j = await r.json();
  } catch (e) {}
  return { ok: r.ok, status: r.status, data: j };
}

// Todas las máscaras que acepta la API (de /8 a /32).
export const MASCARAS = Array.from({ length: 25 }, (_, i) => i + 8);

export const YO = { modo: 'none', rol: 'admin', usuario: '', nombre: '' };

export const NIVEL = { lector: 0, agente: 1, solicitante: 2, admin: 3 };

export const puede = (min) => NIVEL[YO.rol] >= NIVEL[min];

// La API entrega las asignaciones en páginas de hasta 1000 (X-Total-Count trae el total): la interfaz las reúne todas.
export async function todasLasAsignaciones() {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await api('/api/asignaciones?limit=1000&offset=' + desde);
    if (!r.ok) throw new Error('Error ' + r.status);
    todas.push(...r.data);
    if (r.data.length < 1000 || todas.length >= (r.total || 0)) return todas;
  }
}

export const get = async (u) => {
  const r = await api(u);
  if (!r.ok) throw new Error('Error ' + r.status);
  return r.data;
};

export const fail = (id, e) => ($(id).innerHTML = `<div class="alert" role="alert">${I('error')} No se pudo cargar: ${esc(e.message)}</div>`);

/* ===== Ayudante para construir DOM sin innerHTML: todo texto entra como nodo de texto (nada de lo que escriba un usuario se interpreta como HTML) ===== */
export const h = (tag, attrs, ...hijos) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
};

export const fechaHora = (s) => (s ? new Date(s).toLocaleString('es-CL') : '—');

export const msg = (el, texto, tipo) => {
  el.replaceChildren(
    texto ? h('div', { class: tipo === 'ok' ? 'ok' : 'alert', role: tipo === 'ok' ? 'status' : 'alert' }, ico(tipo === 'ok' ? 'ok' : 'error'), ' ', texto) : '',
  );
};

export const errorApi = (r) => (r.data && (r.data.mensaje || r.data.error)) || 'Error ' + r.status;
