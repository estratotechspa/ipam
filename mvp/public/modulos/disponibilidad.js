// Tabla de disponibilidad por máscara de un pool.
import { api, fmt, h } from './base.js';
import { pct } from './uso.js';

/* ===== Reservas (todos los roles; opera según permisos: dueño o admin) ===== */
// Disponibilidad del pool elegido, por máscara: direcciones por bloque, utilizables y cuántos bloques libres quedan.
// Rehace el selector de máscara con SOLO las que caben en el pool («/24 · 15 libres»; las agotadas, deshabilitadas). Un clic en una fila elige esa máscara.
export async function cargarDisponibilidad(contenedor, poolId, selectMascara) {
  contenedor.dataset.pool = poolId;
  if (!poolId) {
    selectMascara.replaceChildren(h('option', { value: '' }, 'Elige primero un pool'));
    selectMascara.disabled = true;
    return contenedor.replaceChildren(h('p', { class: 'muted' }, 'Elige un pool para ver cuánto espacio libre tiene y de qué tamaños.'));
  }
  contenedor.replaceChildren(h('p', { class: 'muted' }, 'Calculando disponibilidad…'));
  const r = await api('/api/v1/pools/' + encodeURIComponent(poolId) + '/disponibilidad');
  if (contenedor.dataset.pool !== poolId) return; // se eligió otro pool mientras tanto
  if (!r.ok) return contenedor.replaceChildren(h('p', { class: 'muted' }, 'No se pudo calcular la disponibilidad.'));
  const d = r.data;
  const elegida = selectMascara.value;
  selectMascara.replaceChildren(
    h('option', { value: '' }, 'Elige una máscara…'),
    ...d.por_mascara.map((x) =>
      h(
        'option',
        { value: x.mascara, disabled: !x.bloques_libres },
        `/${x.mascara} · ${x.bloques_libres ? `${fmt(x.bloques_libres)} libre${x.bloques_libres === 1 ? '' : 's'}` : 'sin espacio'}`,
      ),
    ),
  );
  selectMascara.disabled = false;
  if (d.por_mascara.some((x) => String(x.mascara) === elegida && x.bloques_libres)) selectMascara.value = elegida;
  contenedor.replaceChildren(
    h(
      'p',
      { style: 'margin:0 0 8px' },
      h('b', null, d.pool),
      ` (${d.cidr}): ${fmt(d.libres)} de ${fmt(d.total)} direcciones libres · ${pct(d.total ? d.ocupadas / d.total : 0)} ocupado (asignado + reservado).`,
    ),
    h(
      'div',
      { class: 'tablewrap', style: 'max-height:260px;overflow:auto' },
      h(
        'table',
        { 'aria-label': 'Disponibilidad por máscara' },
        h(
          'tr',
          null,
          ['Máscara', 'Direcciones por bloque', 'Utilizables', 'Bloques libres', 'Direcciones libres'].map((t) => h('th', null, t)),
        ),
        d.por_mascara.map((x) =>
          h(
            'tr',
            {
              class: x.bloques_libres ? 'elegible' : 'agotado',
              style: x.bloques_libres ? 'cursor:pointer' : '',
              title: x.bloques_libres ? 'Elegir esta máscara' : 'No queda espacio de este tamaño',
              onclick: () => {
                if (!x.bloques_libres) return;
                selectMascara.value = String(x.mascara);
                selectMascara.dispatchEvent(new Event('change'));
              },
            },
            h('td', null, h('code', null, '/' + x.mascara)),
            h('td', null, fmt(x.direcciones)),
            h('td', null, fmt(x.utilizables)),
            h('td', null, h('b', null, fmt(x.bloques_libres))),
            h('td', null, fmt(x.direcciones_libres)),
          ),
        ),
      ),
    ),
  );
}
