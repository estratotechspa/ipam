// Filtro por ambiente y proveedor, común a Pools y Segmentos.
import { h } from './base.js';

// Filtro global por ambiente y proveedor: vale para Pools y Segmentos (se conserva al cambiar de pestaña).
export const FILTRO = { ambiente: '', proveedor: '' };

export const pasaFiltro = (p) => (!FILTRO.ambiente || p.ambiente === FILTRO.ambiente) && (!FILTRO.proveedor || p.proveedor === FILTRO.proveedor);

export const camposFiltro = (todos, recargar) => {
  const unicos = (k) => [...new Set(todos.map((p) => p[k]))].sort();
  const reponer = async (id) => {
    await recargar();
    const el = document.getElementById(id);
    if (el) el.focus();
  };
  const sel = (id, k, etiqueta) =>
    h(
      'label',
      null,
      etiqueta,
      h(
        'select',
        {
          id,
          onchange: (e) => {
            FILTRO[k] = e.target.value;
            reponer(id);
          },
        },
        h('option', { value: '' }, 'Todos'),
        unicos(k).map((v) => h('option', { value: v, selected: FILTRO[k] === v }, v)),
      ),
    );
  return [
    sel('f-ambiente', 'ambiente', 'Ambiente'),
    sel('f-proveedor', 'proveedor', 'Proveedor'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn sec',
        onclick: () => {
          FILTRO.ambiente = '';
          FILTRO.proveedor = '';
          recargar();
        },
      },
      'Limpiar filtro',
    ),
  ];
};

export const barraFiltro = (todos, recargar) =>
  h(
    'form',
    { class: 'filtros', role: 'search', 'aria-label': 'Filtrar por ambiente y proveedor', onsubmit: (e) => e.preventDefault() },
    camposFiltro(todos, recargar),
  );
