// @ts-check
// Módulo Command Palette (Cmd + K / Ctrl + K): búsqueda universal instantánea y acciones rápidas.
import { $, esc, get, h, ico, todasLasAsignaciones } from './base.js';
import { show } from './navegacion.js';
import { fichaAsignacion, fichaPool } from './fichas.js';

let INDICE_CACHE = null;
let DIALOGO_ABIERTO = false;

async function cargarIndice() {
  if (INDICE_CACHE) return INDICE_CACHE;
  try {
    const [pools, asignaciones] = await Promise.all([get('/api/v1/pools').catch(() => []), todasLasAsignaciones().catch(() => [])]);
    INDICE_CACHE = { pools, asignaciones };
    return INDICE_CACHE;
  } catch {
    return { pools: [], asignaciones: [] };
  }
}

export function refrescarIndiceComando() {
  INDICE_CACHE = null;
}

function crearFilaItem(icono, titulo, sub, badgeTexto, badgeClase, onAccion) {
  return h(
    'div',
    { class: 'cmd-item', role: 'option', onclick: onAccion },
    h(
      'div',
      { class: 'cmd-item-izq' },
      ico(icono, 16),
      h('div', null, h('div', { class: 'cmd-item-titulo' }, titulo), h('div', { class: 'cmd-item-sub' }, sub)),
    ),
    h('span', { class: `subnav-badge ${badgeClase}` }, badgeTexto),
  );
}

function poblarResultados(lista, query, cerrar) {
  const q = query.trim().toLowerCase();
  lista.replaceChildren();
  const items = [];
  const datos = INDICE_CACHE || { pools: [], asignaciones: [] };

  const acciones = [
    { titulo: 'Reservar nuevo segmento', sub: 'Apartar un bloque CIDR en un pool', icono: 'mas', accion: () => show('segmentos') },
    { titulo: 'Reconciliación de Nube (Drift)', sub: 'Auditar discrepancias contra la nube', icono: 'sincronizar', accion: () => show('reconciliacion') },
    { titulo: 'Ver Direcciones IP fijas', sub: 'Inventario de IPs reservadas en subredes', icono: 'servidor', accion: () => show('ips') },
  ];

  const poolsMatch = datos.pools.filter(
    (p) =>
      !q ||
      [p.id, p.cidr, p.tipo, p.ambiente, p.proveedor].some((v) =>
        String(v || '')
          .toLowerCase()
          .includes(q),
      ),
  );
  const asigMatch = datos.asignaciones
    .filter(
      (a) =>
        !q ||
        [a.codigo, a.cidr, a.proyecto, a.vpc, a.subred, a.ticket].some((v) =>
          String(v || '')
            .toLowerCase()
            .includes(q),
        ),
    )
    .slice(0, 15);

  if (poolsMatch.length > 0) {
    lista.appendChild(h('div', { class: 'cmd-grupo-titulo' }, `Pools de Red (${poolsMatch.length})`));
    for (const p of poolsMatch.slice(0, 6)) {
      const obj = {
        accion: () => {
          show('pools');
          fichaPool(p.id);
        },
      };
      lista.appendChild(
        crearFilaItem('capas', p.id, `${p.cidr} · ${p.tipo} · ${p.ambiente} · ${p.proveedor}`, 'Pool', 'gris', () => {
          obj.accion();
          cerrar();
        }),
      );
      items.push(obj);
    }
  }

  if (asigMatch.length > 0) {
    lista.appendChild(h('div', { class: 'cmd-grupo-titulo' }, `Segmentos Asignados (${asigMatch.length})`));
    for (const a of asigMatch) {
      const obj = {
        accion: () => {
          show('segmentos');
          fichaAsignacion(a.id);
        },
      };
      lista.appendChild(
        crearFilaItem('tabla', a.cidr, `Proyecto: ${a.proyecto || '—'} · VPC: ${a.vpc || '—'} · Subred: ${a.subred || '—'}`, 'Segmento', 'azul', () => {
          obj.accion();
          cerrar();
        }),
      );
      items.push(obj);
    }
  }

  const accMatch = acciones.filter((ac) => !q || ac.titulo.toLowerCase().includes(q) || ac.sub.toLowerCase().includes(q));
  if (accMatch.length > 0) {
    lista.appendChild(h('div', { class: 'cmd-grupo-titulo' }, 'Acciones Rápidas'));
    for (const ac of accMatch) {
      const obj = { accion: ac.accion };
      lista.appendChild(
        crearFilaItem(ac.icono, ac.titulo, ac.sub, 'Acción', 'gris', () => {
          obj.accion();
          cerrar();
        }),
      );
      items.push(obj);
    }
  }

  if (items.length === 0) {
    lista.appendChild(h('div', { style: 'padding:24px;text-align:center;color:var(--mut)' }, `No se encontraron resultados para «${esc(query)}»`));
  }
  return items;
}

export function abrirCommandPalette() {
  if (DIALOGO_ABIERTO) return;
  DIALOGO_ABIERTO = true;

  const overlay = h('div', { class: 'cmd-modal-fondo', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Búsqueda universal en IPAM' });
  const input = h('input', { class: 'cmd-input', type: 'search', placeholder: 'Buscar pool, subred, VPC, IP… (Cmd+K)', autocomplete: 'off' });
  const lista = h('div', { class: 'cmd-lista', role: 'listbox' });
  const cabecera = h('div', { class: 'cmd-cabecera' }, ico('buscar', 18), input, h('kbd', { class: 'cmd-kbd' }, 'ESC'));
  const pie = h('div', { class: 'cmd-pie' }, h('span', null, 'Navega con ↑ ↓ y selecciona con Enter'), h('span', null, 'Cerrar con Esc'));

  overlay.appendChild(h('div', { class: 'cmd-caja' }, cabecera, lista, pie));
  document.body.appendChild(overlay);

  const cerrar = () => {
    DIALOGO_ABIERTO = false;
    overlay.remove();
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) cerrar();
  };

  let indice = 0;
  let itemsVisibles = [];

  const seleccionar = (idx) => {
    const domItems = lista.querySelectorAll('.cmd-item');
    domItems.forEach((it, i) => it.classList.toggle('seleccionado', i === idx));
    indice = idx;
    if (domItems[idx]) domItems[idx].scrollIntoView({ block: 'nearest' });
  };

  input.oninput = (e) => {
    // @ts-ignore
    itemsVisibles = poblarResultados(lista, e.target.value, cerrar);
    seleccionar(0);
  };

  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (itemsVisibles.length) seleccionar((indice + 1) % itemsVisibles.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (itemsVisibles.length) seleccionar((indice - 1 + itemsVisibles.length) % itemsVisibles.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (itemsVisibles[indice]) {
        itemsVisibles[indice].accion();
        cerrar();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cerrar();
    }
  };

  cargarIndice().then(() => {
    itemsVisibles = poblarResultados(lista, '', cerrar);
    seleccionar(0);
    input.focus();
  });
}

/** Inicializa listeners globales de teclado para Cmd+K / Ctrl+K */
export function inicializarComando() {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const fondo = document.querySelector('.cmd-modal-fondo');
      if (fondo) fondo.remove();
      else abrirCommandPalette();
    }
  });

  const nav = $('nav');
  if (nav && !$('btn-buscar-cmd')) {
    nav.prepend(
      h(
        'button',
        { id: 'btn-buscar-cmd', type: 'button', class: 'cmd-btn-abrir', title: 'Buscar en IPAM (Cmd + K)', onclick: () => abrirCommandPalette() },
        ico('buscar', 14),
        h('span', null, 'Buscar…'),
        h('kbd', { class: 'cmd-kbd' }, '⌘K'),
      ),
    );
  }
}
