// Pestaña «Jerarquía»: los segmentos ordenados como en GCP. Proyecto → VPC → subred (con su VLAN) → rangos secundarios (Pods y Servicios).
import { armarJerarquia, limitesCidr, SIN } from '../calculos.js';
import { ESTADO, fail, fmt, get, h, ico, todasLasAsignaciones } from './base.js';
import { rangoDeIps } from './ui.js';

let DATOS = null; // última carga: al escribir en el buscador solo se vuelve a armar el árbol, sin pedir nada
let ULTIMA_CARGA = 0;

const ETIQUETA_RANGO = { pods: 'Pods', servicios: 'Servicios' };
const subredes = (n) => `${n} ${n === 1 ? 'subred' : 'subredes'}`;
const textoDe = (x) => [x.proyecto, x.vpc, x.subred, x.vlan, x.vlan_nombre, x.nombre, x.cidr, x.pool_id, x.codigo].filter(Boolean).join(' ').toLowerCase();

/** Un rango (principal o secundario) con su estado y su primera y última IP. */
function fila(x, etiqueta) {
  const lim = limitesCidr(x.cidr);
  return h(
    'li',
    { class: 'arbol-rango' },
    etiqueta ? h('span', { class: 'arbol-uso' }, etiqueta + (x.nombre ? ` · ${x.nombre}` : '')) : null,
    h('code', null, x.cidr),
    h('span', { class: 'tag ' + (x.tipo === 'reservado' ? 'reservada' : 'confirmada') }, x.tipo === 'reservado' ? 'reservado' : 'asignado'),
    lim ? h('span', { class: 'muted arbol-ips' }, ...rangoDeIps(lim), ` · ${fmt(lim.direcciones)} direcciones`) : null,
  );
}

function subred(s) {
  const vlan = s.principales.find((x) => x.vlan || x.vlan_nombre);
  return h(
    'li',
    { class: 'arbol-subred' },
    h(
      'div',
      { class: 'arbol-nombre' },
      h('b', { class: s.nombre === SIN.subred ? 'arbol-sin' : '' }, s.nombre),
      vlan ? h('span', { class: 'muted' }, ` VLAN ${vlan.vlan || ''}${vlan.vlan_nombre ? ` (${vlan.vlan_nombre})` : ''}`.trimEnd()) : null,
      h('span', { class: 'muted' }, ` · ${fmt(s.direcciones)} direcciones`),
    ),
    h(
      'ul',
      { class: 'arbol-rangos' },
      s.principales.map((x) => fila(x, 'Principal')),
      s.secundarios.map((x) => fila(x, ETIQUETA_RANGO[x.rango] || x.rango)),
    ),
  );
}

function vpc(v) {
  return h(
    'details',
    { class: 'arbol-nodo arbol-vpc', open: true },
    h(
      'summary',
      null,
      ico('capas'),
      h('b', { class: v.nombre === SIN.vpc ? 'arbol-sin' : '' }, v.nombre),
      h('span', { class: 'muted' }, ` · ${subredes(v.subredes.length)} · ${fmt(v.direcciones)} direcciones`),
    ),
    v.bloques.length
      ? h(
          'ul',
          { class: 'arbol-rangos' },
          v.bloques.map((x) => fila(x, 'Bloque de la VPC')),
        )
      : null,
    h('ul', { class: 'arbol-lista' }, v.subredes.map(subred)),
  );
}

function proyecto(p) {
  return h(
    'details',
    { class: 'arbol-nodo arbol-proyecto', open: true },
    h(
      'summary',
      null,
      h('b', { class: p.nombre === SIN.proyecto ? 'arbol-sin' : '' }, p.nombre),
      h('span', { class: 'muted' }, ` · ${p.vpcs.length} VPC · ${subredes(p.subredes)}`),
    ),
    p.vpcs.map(vpc),
  );
}

function dibujar() {
  const q = ESTADO.busquedaJerarquia.trim().toLowerCase();
  const items = DATOS.filter((x) => !q || textoDe(x).includes(q));
  const arbol = armarJerarquia(items);
  const cont = document.getElementById('jerarquia-arbol');
  cont.replaceChildren(
    ...(arbol.length
      ? arbol.map(proyecto)
      : [
          h(
            'p',
            { class: 'vacio' },
            q
              ? `Ningún segmento coincide con «${ESTADO.busquedaJerarquia.trim()}».`
              : 'Todavía no hay segmentos. Reserva el primero desde la pestaña Segmentos.',
          ),
        ]),
  );
  document.getElementById('jerarquia-cuenta').textContent = `${items.length} de ${DATOS.length} segmentos`;
}

export async function renderJerarquia() {
  const mia = ++ULTIMA_CARGA;
  const cont = document.getElementById('jerarquia');
  try {
    const [asignaciones, reservadas] = await Promise.all([todasLasAsignaciones(), get('/api/v1/reservas?limite=500&estado=reservada')]);
    if (mia !== ULTIMA_CARGA) return;
    DATOS = [...asignaciones.map((x) => ({ ...x, tipo: 'asignado' })), ...reservadas.map((x) => ({ ...x, tipo: 'reservado' }))];
    const buscador = h('input', {
      id: 'j-buscar',
      type: 'search',
      value: ESTADO.busquedaJerarquia,
      placeholder: 'Proyecto, VPC, subred, VLAN o CIDR…',
      oninput: (e) => {
        ESTADO.busquedaJerarquia = e.target.value;
        dibujar();
      },
    });
    const abrir = (si) => () => document.querySelectorAll('#jerarquia-arbol details').forEach((d) => (d.open = si));
    cont.replaceChildren(
      h('div', { class: 'cabecera' }, h('h2', { tabindex: '-1' }, 'Jerarquía de la red')),
      h(
        'p',
        { class: 'muted' },
        'Cada proyecto tiene VPC; cada VPC, subredes (con su VLAN); y cada subred, sus rangos secundarios de Pods y Servicios. Lo que aún no tiene proyecto, VPC o subred aparece como «(sin …)» al final de su nivel.',
      ),
      h(
        'div',
        { class: 'filtros' },
        h('label', { class: 'campo-buscar' }, 'Buscar', buscador),
        h('button', { type: 'button', class: 'btn sec', onclick: abrir(true) }, 'Expandir todo'),
        h('button', { type: 'button', class: 'btn sec', onclick: abrir(false) }, 'Contraer todo'),
      ),
      h('p', { class: 'muted', id: 'jerarquia-cuenta', role: 'status' }),
      h('div', { id: 'jerarquia-arbol', class: 'arbol' }),
    );
    dibujar();
  } catch (e) {
    fail('jerarquia', e);
  }
}
