// Pestaña Clústeres: los rangos reservados juntos (subnet, pods y servicios), vistos como una sola cosa y aprobados o liberados juntos.
import { ETIQUETA_RANGO, agruparPorGrupo } from '../calculos.js';
import { $, ESTADO, YO, api, errorApi, fail, fmt, get, h, ico, puede } from './base.js';
import { restante } from './reservas.js';
import { show } from './navegacion.js';
import { confirmar, toast } from './ui.js';
import { dialogoNuevoCluster } from './nuevo-cluster.js';

const ESTADOS = [
  ['', 'Todos'],
  ['reservada', 'Reservados'],
  ['confirmada', 'Aprobados'],
  ['mixto', 'A medias'],
  ['liberada', 'Liberados'],
  ['expirada', 'Expirados'],
];
const ETIQUETA = { reservada: 'Reservado', confirmada: 'Aprobado', mixto: 'A medias', liberada: 'Liberado', expirada: 'Expirado' };
const CLASE = { reservada: 'reservado', confirmada: 'confirmada', mixto: 'reservado', liberada: 'liberada', expirada: 'expirada' };
const ABIERTOS = new Set();
let ENFOCAR_BUSQUEDA = false; // al escribir se redibuja la lista: el cuadro de búsqueda recupera el foco y el cursor

const cidrsDe = (filas, rango) => filas.filter((f) => f.rango === rango).map((f) => f.cidr);
const celdaCidrs = (lista) =>
  lista.length
    ? h(
        'td',
        null,
        lista.flatMap((c, i) => (i ? [h('br'), h('code', null, c)] : [h('code', null, c)])),
      )
    : h('td', { class: 'muted' }, '—');
const subredes = (filas) => [...new Set(filas.map((f) => f.subred).filter(Boolean))].join(', ');

function vence(g) {
  if (g.estado !== 'reservada' && g.estado !== 'mixto') return h('td', { class: 'muted' }, '—');
  return h('td', null, g.segundos_restantes ? restante(g.segundos_restantes) : 'vencido', h('br'), h('span', { class: 'muted' }, 'falta aprobación'));
}

async function operar(g, que, recargar) {
  const aprobando = que === 'confirmar';
  const n = g.filas.length;
  const ok = await confirmar({
    titulo: aprobando ? 'Aprobar el grupo' : 'Liberar el grupo',
    mensaje: aprobando
      ? `¿Aprobar los ${n} rangos de ${g.proyecto || 'este proyecto'}? Pasan juntos a asignación definitiva.`
      : `¿Liberar los ${n} rangos de ${g.proyecto || 'este proyecto'}? Vuelven a sus pools${g.estado === 'confirmada' ? ' y se borran las asignaciones' : ''}.`,
    confirmar: aprobando ? 'Aprobar' : 'Liberar',
    peligro: !aprobando,
  });
  if (!ok) return;
  const x = aprobando
    ? await api(`/api/v1/reservas/grupo/${g.grupo}/confirmar`, { body: {} })
    : await api(`/api/v1/reservas/grupo/${g.grupo}`, { method: 'DELETE', body: {} });
  toast(x.ok ? (aprobando ? `Grupo aprobado: ${n} rangos asignados.` : 'Grupo liberado.') : errorApi(x), x.ok ? 'ok' : 'error');
  await recargar();
}

function detalle(g, pools, recargar) {
  const admin = puede('admin');
  const dueno = admin || g.solicitante === YO.nombre || g.solicitante === 'svc:' + YO.usuario;
  const vigente = g.estado === 'reservada' || g.estado === 'mixto';
  return h(
    'tr',
    { class: 'detalle-cluster' },
    h('td'),
    h(
      'td',
      { colspan: 7 },
      h(
        'table',
        { class: 'rangos' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ['Rango', 'Nombre', 'Subred', 'CIDR', 'Pool', 'Estado'].map((t) => h('th', { scope: 'col' }, t)),
          ),
        ),
        h(
          'tbody',
          null,
          g.filas.map((f) =>
            h(
              'tr',
              null,
              h('td', null, h('span', { class: `chip-rango rango-${f.rango}` }, ETIQUETA_RANGO[f.rango] || '—')),
              h('td', null, f.nombre || '—'),
              h('td', null, f.subred || '—'),
              h('td', null, h('code', null, f.cidr)),
              h('td', null, f.pool_id),
              h('td', null, ETIQUETA[f.estado] || f.estado),
            ),
          ),
        ),
      ),
      h(
        'p',
        { class: 'acciones' },
        vigente && admin
          ? h('button', { type: 'button', class: 'btn', onclick: () => operar(g, 'confirmar', recargar) }, `Aprobar los ${g.filas.length} rangos`)
          : null,
        (vigente && dueno) || (g.estado === 'confirmada' && admin)
          ? h(
              'button',
              { type: 'button', class: 'btn sec', onclick: () => operar(g, 'liberar', recargar) },
              vigente ? 'Rechazar y liberar' : 'Liberar el grupo',
            )
          : null,
        vigente && !admin ? h('span', { class: 'muted' }, ' Solo un admin aprueba.') : null,
        ` Ticket ${g.ticket} · pidió ${g.solicitante}`,
      ),
    ),
  );
}

function fila(g, pools, recargar) {
  const abierto = ABIERTOS.has(g.grupo);
  const amb = (pools.find((p) => p.id === g.filas[0].pool_id) || {}).ambiente;
  const boton = h(
    'button',
    {
      type: 'button',
      class: 'btn-expandir',
      'aria-expanded': String(abierto),
      'aria-label': `${abierto ? 'Contraer' : 'Expandir'} ${g.proyecto || 'grupo'}`,
      onclick: () => {
        if (ABIERTOS.has(g.grupo)) ABIERTOS.delete(g.grupo);
        else ABIERTOS.add(g.grupo);
        recargar();
      },
    },
    ico(abierto ? 'abajo' : 'derecha', 16),
  );
  const principal = h(
    'tr',
    { class: 'grupo-cluster' },
    h('td', null, boton),
    h('td', null, h('strong', null, g.proyecto || 'Sin proyecto'), h('br'), h('span', { class: 'muted' }, subredes(g.filas) || 'sin nombre de subred')),
    h('td', null, amb ? h('span', { class: 'tag ' + amb }, amb) : '—'),
    celdaCidrs(cidrsDe(g.filas, 'principal')),
    celdaCidrs(cidrsDe(g.filas, 'pods')),
    celdaCidrs(cidrsDe(g.filas, 'servicios')),
    h('td', null, h('span', { class: `tag ${CLASE[g.estado]}` }, ETIQUETA[g.estado] || g.estado)),
    vence(g),
  );
  return abierto ? [principal, detalle(g, pools, recargar)] : [principal];
}

/** Desde Segmentos: abre la pestaña Clústeres con ese grupo desplegado. */
export function abrirCluster(grupo) {
  ABIERTOS.add(grupo);
  show('clusteres');
}

export async function renderClusteres() {
  const sec = $('clusteres');
  try {
    const [reservas, pools] = await Promise.all([get('/api/v1/reservas?limite=500'), get('/api/v1/pools')]);
    const grupos = agruparPorGrupo(reservas);
    const q = (ESTADO.busquedaClusteres || '').trim().toLowerCase();
    const filtro = ESTADO.estadoClusteres || '';
    const visibles = grupos.filter(
      (g) =>
        (!filtro || g.estado === filtro) &&
        (!q ||
          [g.proyecto, g.ticket, g.solicitante, ...g.filas.flatMap((f) => [f.cidr, f.subred, f.nombre, f.pool_id])].some((v) =>
            String(v || '')
              .toLowerCase()
              .includes(q),
          )),
    );
    const recargar = () => renderClusteres();
    sec.replaceChildren(
      h(
        'div',
        { class: 'cabecera', style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px' },
        h('h2', { tabindex: '-1', id: 'clusteres-titulo' }, 'Clústeres Kubernetes / GKE'),
        puede('agente')
          ? h('button', { class: 'btn', type: 'button', id: 'cl-nuevo', onclick: () => dialogoNuevoCluster(pools, recargar) }, '+ Nuevo clúster')
          : null,
      ),
      h(
        'div',
        {
          class: 'card-info-cluster',
          style: 'background:rgba(30, 41, 59, 0.5);border:1px solid var(--line, #334155);border-radius:8px;padding:14px 18px;margin:8px 0 16px',
        },
        h(
          'div',
          { style: 'font-weight:600;margin-bottom:6px;color:var(--text, #f8fafc);display:flex;align-items:center;gap:8px' },
          ico('capas', 16),
          '¿Cómo funcionan los clústeres en IPAM?',
        ),
        h(
          'p',
          { class: 'muted', style: 'margin:0;font-size:13px;line-height:1.5' },
          'Cada clúster requiere 3 rangos simultáneos y coordinados: ',
          h('b', null, 'Subnet (Nodos)'),
          ' (rango primario de la VPC donde residen las máquinas y VMs), ',
          h('b', null, 'Pods'),
          ' (rango secundario amplio para contenedores) y ',
          h('b', null, 'Servicios'),
          ' (rango secundario para ClusterIP virtuales). IPAM los reserva de forma atómica en un solo grupo para garantizar que no existan solapamientos y que quepan juntos en el ambiente.',
        ),
      ),
      h(
        'div',
        { class: 'filtros' },
        h(
          'label',
          null,
          'Estado ',
          h(
            'select',
            { id: 'f-estado-cl', onchange: (e) => ((ESTADO.estadoClusteres = e.target.value), recargar()) },
            ESTADOS.map(([v, t]) => h('option', { value: v, selected: v === filtro }, t)),
          ),
        ),
        h(
          'label',
          { class: 'campo-buscar' },
          'Buscar ',
          h('input', {
            id: 'f-buscar-cl',
            type: 'search',
            placeholder: 'Proyecto, subred, CIDR o ticket',
            value: ESTADO.busquedaClusteres || '',
            oninput: (e) => ((ESTADO.busquedaClusteres = e.target.value), (ENFOCAR_BUSQUEDA = true), recargar()),
          }),
        ),
      ),
      h('div', { id: 'clusteres-msg', 'aria-live': 'polite' }),
      visibles.length
        ? h(
            'div',
            { class: 'tablewrap' },
            h(
              'table',
              { class: 'clusteres' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['', 'Proyecto / subred', 'Amb.', 'Subnet', 'Pods', 'Servicios', 'Estado', 'Vence'].map((t) => h('th', { scope: 'col' }, t)),
                ),
              ),
              h(
                'tbody',
                null,
                visibles.flatMap((g) => fila(g, pools, recargar)),
              ),
            ),
          )
        : h(
            'div',
            { class: 'vacio' },
            grupos.length
              ? 'Ningún clúster coincide con el filtro.'
              : puede('agente')
                ? h(
                    'div',
                    null,
                    h('p', null, 'Aún no hay clústeres reservados.'),
                    h(
                      'button',
                      { class: 'btn', type: 'button', style: 'margin-top:8px', onclick: () => dialogoNuevoCluster(pools, recargar) },
                      '+ Reservar primer clúster',
                    ),
                  )
                : 'Aún no hay clústeres reservados. El agente de redes los pide con la API (POST /api/v1/reservas/lote).',
          ),
      h('p', { class: 'muted' }, `${fmt(visibles.length)} de ${fmt(grupos.length)} grupos.`),
    );
    const buscar = $('f-buscar-cl');
    if (buscar && ENFOCAR_BUSQUEDA) {
      buscar.focus();
      buscar.setSelectionRange(buscar.value.length, buscar.value.length);
      ENFOCAR_BUSQUEDA = false;
    }
  } catch (e) {
    fail('clusteres', e);
  }
}
