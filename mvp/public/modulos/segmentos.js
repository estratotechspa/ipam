// Pestaña Segmentos: asignaciones (definitivas) y reservas (apartadas, pendientes de aprobación) en una sola lista.
import { fmt as _fmt, parseCidr, tamanoCidr } from '../calculos.js';
import { $, ESTADO, I, YO, esc, fail, fecha, fechaHora, fmt, get, h, msg, puede, size, todasLasAsignaciones } from './base.js';
import { FILTRO, barraFiltro, pasaFiltro } from './filtro.js';
import { fichaAsignacion } from './fichas.js';
import { ASIG, liberarAsignacion, textoVlan } from './asignaciones.js';
import { RES, accionReserva, restante, tictac } from './reservas.js';
import { formularioNuevoSegmento } from './nuevo-segmento.js';

export const POR_PAGINA = 25;

// Por defecto las reservas pendientes van primero (son lo que un administrador tiene que atender), luego lo asignado.
export const ORDEN = { col: 'estado', dir: 'asc', pagina: 0 };

export const COLUMNAS = [
  ['estado', 'Estado'],
  ['codigo', 'ID'],
  ['cidr', 'Segmento'],
  ['pool', 'Pool'],
  ['vpc', 'Proyecto / VPC'],
  ['vlan', 'VLAN'],
  ['dir', 'Direcciones'],
  ['sol', 'Solicitó'],
  ['origen', 'Origen'],
  ['ticket', 'Ticket'],
  ['fecha', 'Fecha / vence en'],
];

export const VISTAS = [
  ['todos', 'Todos'],
  ['asignados', 'Asignados'],
  ['reservados', 'Reservados'],
  ['historial', 'Historial'],
];

const RANGO = { reservado: 0, asignado: 1, historial: 2 };
const ETIQUETA = { asignado: 'Asignado', reservado: 'Reservado', liberada: 'Liberada', expirada: 'Expirada' };
const origenDeReserva = (s) => (s === 'jira-webhook' ? 'jira' : String(s).startsWith('svc:') ? 'agente' : 'panel');

/** Une asignaciones y reservas en una sola forma. Las reservas confirmadas no se repiten: ya son la asignación. */
export function unificar(asignaciones, reservas) {
  const filas = asignaciones.map((x) => ({
    tipo: 'asignado',
    marca: 'asignado',
    id: x.codigo || String(x.id),
    orden: Number(x.id),
    ref: x,
    cidr: x.cidr,
    pool_id: x.pool_id,
    vpc: x.vpc,
    vlan: x.vlan,
    vlan_nombre: x.vlan_nombre,
    solicitante: x.solicitante,
    origen: x.origen,
    ticket: x.ticket,
    creado_en: x.creado_en,
  }));
  for (const r of reservas) {
    if (r.estado === 'confirmada') continue;
    filas.push({
      tipo: r.estado === 'reservada' ? 'reservado' : 'historial',
      marca: r.estado === 'reservada' ? 'reservado' : r.estado,
      id: 'RES-' + String(r.id).slice(0, 8).toUpperCase(),
      orden: 0,
      ref: r,
      cidr: r.cidr,
      pool_id: r.pool_id,
      vpc: r.vpc,
      vlan: r.vlan,
      vlan_nombre: r.vlan_nombre,
      solicitante: r.solicitante,
      origen: origenDeReserva(r.solicitante),
      ticket: r.ticket,
      creado_en: r.creado_en,
    });
  }
  return filas;
}

const clave = {
  estado: (x) => RANGO[x.tipo],
  codigo: (x) => x.id,
  cidr: (x) => {
    const c = parseCidr(x.cidr);
    return c ? c.ip * 64 + c.len : 0;
  },
  pool: (x) => x.pool_id,
  vpc: (x) => x.vpc,
  vlan: (x) => (x.vlan ? Number(x.vlan) : Infinity),
  dir: (x) => tamanoCidr(x.cidr),
  sol: (x) => x.solicitante,
  origen: (x) => x.origen,
  ticket: (x) => x.ticket,
  fecha: (x) => new Date(x.creado_en).getTime(),
};

export const comparar = (col, dir) => (x, y) => {
  const a = clave[col](x);
  const b = clave[col](y);
  const c = typeof a === 'string' ? a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }) : a - b;
  return (dir === 'asc' ? c : -c) || new Date(y.creado_en) - new Date(x.creado_en) || y.orden - x.orden;
};

const pasaVista = (x, vista) =>
  vista === 'todos'
    ? x.tipo !== 'historial'
    : vista === 'asignados'
      ? x.tipo === 'asignado'
      : vista === 'reservados'
        ? x.tipo === 'reservado'
        : x.tipo === 'historial';

const encabezado = () =>
  COLUMNAS.map(([col, texto]) => {
    const activa = ORDEN.col === col;
    const sentido = activa ? (ORDEN.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${sentido}"><button type="button" class="orden" data-orden="${col}">${texto}${activa ? I(ORDEN.dir === 'asc' ? 'arriba' : 'abajo') : ''}</button></th>`;
  }).join('') + '<th scope="col"><span class="sr-only">Acciones</span></th>';

const paginacion = (total) => {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const desde = total === 0 ? 0 : ORDEN.pagina * POR_PAGINA + 1;
  const hasta = Math.min(total, (ORDEN.pagina + 1) * POR_PAGINA);
  return `<nav class="paginacion" aria-label="Paginación"><span class="muted" role="status">${total === 0 ? 'Sin resultados' : `Mostrando ${_fmt(desde)}–${_fmt(hasta)} de ${_fmt(total)}`}</span>
    <span class="paginacion-botones"><button type="button" class="btn sec" id="a-ant" ${ORDEN.pagina === 0 ? 'disabled' : ''}>${I('izquierda')}Anterior</button>
    <span class="num">Página ${_fmt(ORDEN.pagina + 1)} de ${_fmt(paginas)}</span>
    <button type="button" class="btn sec" id="a-sig" ${ORDEN.pagina >= paginas - 1 ? 'disabled' : ''}>Siguiente${I('derecha')}</button></span></nav>`;
};

const celdaFecha = (x) => {
  if (x.tipo !== 'reservado') return fecha(x.creado_en);
  const fin = Date.now() + x.ref.segundos_restantes * 1000;
  return `<time class="restante" datetime="${esc(x.ref.expira_en)}" data-fin="${fin}" title="Vence ${esc(fechaHora(x.ref.expira_en))}">${restante(x.ref.segundos_restantes)}</time>`;
};

const celdaAcciones = (x, puedeOperar) => {
  if (x.tipo === 'asignado')
    return puede('admin') ? `<button type="button" class="btn sec pequeno" data-del="${x.ref.id}" data-c="${esc(x.cidr)}">${I('liberar')}Liberar</button>` : '';
  if (x.tipo !== 'reservado' || !puedeOperar(x.ref)) return '';
  return `<span class="acciones"><button type="button" class="btn pequeno" data-res="confirmar" data-id="${esc(x.ref.id)}" aria-label="Confirmar la reserva ${esc(x.cidr)}">Confirmar</button>
    <button type="button" class="btn sec pequeno" data-res="liberar" data-id="${esc(x.ref.id)}" aria-label="Liberar la reserva ${esc(x.cidr)}">${I('liberar')}Liberar</button></span>`;
};

const fila = (x, puedeOperar) =>
  `<tr class="seg-${x.tipo}"><td><span class="tag ${esc(x.marca)}">${ETIQUETA[x.marca]}</span></td>
  <td>${x.tipo === 'asignado' ? `<button type="button" class="enlace" data-ficha-asig="${esc(x.ref.id)}"><code>${esc(x.id)}</code></button>` : `<code>${esc(x.id)}</code>`}</td>
  <td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${esc(x.vpc)}</td><td>${esc(textoVlan(x))}</td><td>${fmt(size(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${celdaFecha(x)}</td>
  <td>${celdaAcciones(x, puedeOperar)}</td></tr>`;

const textoVacio = (vista, filtrando) =>
  filtrando
    ? ['Ningún segmento coincide con la búsqueda.', 'Prueba con otro texto o quita los filtros.']
    : {
        todos: ['Aún no hay segmentos.', 'Cuando se asigne o reserve un segmento aparecerá aquí.'],
        asignados: ['Aún no hay segmentos asignados.', 'Un segmento queda asignado cuando se asigna directo o se aprueba una reserva.'],
        reservados: ['No hay reservas pendientes.', 'Cuando alguien reserve un segmento y falte aprobarlo, aparecerá aquí.'],
        historial: ['Todavía no hay reservas liberadas ni vencidas.', 'Aquí se ven las que se devolvieron o expiraron sin aprobarse.'],
      }[vista];

function chips(cuentas) {
  return `<div class="chips" role="group" aria-label="Mostrar">${VISTAS.map(
    ([v, texto]) =>
      `<button type="button" class="chip${v === 'reservados' && cuentas.reservados ? ' pendiente' : ''}" data-vista="${v}" aria-pressed="${ESTADO.vistaSegmentos === v}">${texto}${
        cuentas[v] === undefined ? '' : ` <span class="n">${_fmt(cuentas[v])}</span>`
      }</button>`,
  ).join('')}</div>`;
}

let ULTIMA_CARGA = 0; // una carga vieja no debe pisar a una nueva ni rehacer la pantalla mientras se escribe
export async function renderSegmentos() {
  const mia = ++ULTIMA_CARGA;
  try {
    const vista = ESTADO.vistaSegmentos;
    const pedirReservas = (estado) => get('/api/v1/reservas?limite=500&estado=' + estado);
    const [pools, asignaciones, pendientes, historial] = await Promise.all([
      get('/api/pools'),
      todasLasAsignaciones(),
      pedirReservas('reservada'),
      vista === 'historial' ? Promise.all([pedirReservas('liberada'), pedirReservas('expirada')]).then((l) => l.flat()) : [],
    ]);
    if (mia !== ULTIMA_CARGA) return;
    const dePool = new Map(pools.map((p) => [p.id, p]));
    const q = ESTADO.busquedaAsig.trim().toLowerCase();
    const todas = unificar(asignaciones, [...pendientes, ...historial]).filter((x) => dePool.has(x.pool_id) && pasaFiltro(dePool.get(x.pool_id)));
    const cuentas = { asignados: todas.filter((x) => x.tipo === 'asignado').length, reservados: todas.filter((x) => x.tipo === 'reservado').length };
    cuentas.todos = cuentas.asignados + cuentas.reservados;
    const lista = todas
      .filter((x) => pasaVista(x, vista))
      .filter((x) => !q || [x.id, x.cidr, x.vpc, x.ticket, x.solicitante, x.pool_id, x.origen, x.vlan, x.vlan_nombre].join(' ').toLowerCase().includes(q));
    const total = lista.length;
    lista.sort(comparar(ORDEN.col, ORDEN.dir));
    ORDEN.pagina = Math.min(ORDEN.pagina, Math.max(0, Math.ceil(total / POR_PAGINA) - 1));
    const pagina = lista.slice(ORDEN.pagina * POR_PAGINA, (ORDEN.pagina + 1) * POR_PAGINA);
    const puedeOperar = (r) => puede('agente') && (YO.rol === 'admin' || r.solicitante === YO.usuario);
    const reservaPorId = new Map(pendientes.map((r) => [r.id, r]));
    const [titulo, ayuda] = textoVacio(vista, !!(q || FILTRO.ambiente || FILTRO.proveedor));
    const raiz = $('segmentos');
    raiz.innerHTML = `<div class="cabecera"><h2 id="seg-titulo" tabindex="-1">Segmentos</h2><span class="acciones"><a class="btn" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a>${
      puede('admin')
        ? `<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">${I('archivo')}Respaldo JSON</a>`
        : ''
    }</span></div>
    <p class="muted">Un segmento <b>asignado</b> es definitivo. Uno <b>reservado</b> está apartado por un tiempo: falta que un administrador lo apruebe y, si nadie lo hace, vence solo y el rango vuelve al pool.</p>${chips(cuentas)}${
      total === 0
        ? `<div class="card vacio">${I('buscar', 20)}<p><b>${titulo}</b></p><p class="muted">${ayuda}</p></div>`
        : `<div class="card tablewrap" tabindex="0" role="region" aria-label="Segmentos"><table><thead><tr>${encabezado()}</tr></thead><tbody>${pagina.map((x) => fila(x, puedeOperar)).join('')}</tbody></table></div>`
    }${paginacion(total)}`;
    enlazar(raiz, reservaPorId);
    montarEncabezados(raiz, pools);
    clearInterval(RES.timer);
    tictac();
    RES.timer = setInterval(tictac, 1000);
  } catch (e) {
    fail('segmentos', e);
  }
}

function enlazar(raiz, reservaPorId) {
  raiz.querySelectorAll('[data-orden]').forEach(
    (b) =>
      (b.onclick = async () => {
        const col = b.dataset.orden;
        if (ORDEN.col === col) ORDEN.dir = ORDEN.dir === 'asc' ? 'desc' : 'asc';
        else Object.assign(ORDEN, { col, dir: col === 'fecha' ? 'desc' : 'asc' });
        ORDEN.pagina = 0;
        await renderSegmentos();
        $('segmentos').querySelector(`[data-orden="${col}"]`)?.focus();
      }),
  );
  for (const [id, paso] of [
    ['a-ant', -1],
    ['a-sig', 1],
  ]) {
    const b = $(id);
    if (b)
      b.onclick = async () => {
        ORDEN.pagina += paso;
        await renderSegmentos();
        const sigue = $(id);
        (sigue && !sigue.disabled ? sigue : $('segmentos').querySelector('.paginacion .btn:not([disabled])'))?.focus();
      };
  }
  raiz.querySelectorAll('[data-vista]').forEach(
    (b) =>
      (b.onclick = async () => {
        ESTADO.vistaSegmentos = b.dataset.vista;
        ORDEN.pagina = 0;
        await renderSegmentos();
        $('segmentos').querySelector(`[data-vista="${b.dataset.vista}"]`)?.focus();
      }),
  );
  raiz.querySelectorAll('[data-ficha-asig]').forEach((b) => (b.onclick = () => fichaAsignacion(b.dataset.fichaAsig)));
  raiz.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => liberarAsignacion(b.dataset.del, b.dataset.c, renderSegmentos)));
  raiz.querySelectorAll('[data-res]').forEach((b) => (b.onclick = () => accionReserva(reservaPorId.get(b.dataset.id), b.dataset.res, renderSegmentos)));
}

/** Parte de arriba: formularios (reservar / asignar ahora), avisos, búsqueda y filtros por ambiente y proveedor. */
function montarEncabezados(raiz, pools) {
  const buscador = h('input', {
    id: 'f-buscar',
    type: 'search',
    value: ESTADO.busquedaAsig,
    placeholder: 'ID, segmento, proyecto, VLAN, ticket…',
    oninput: (e) => {
      ESTADO.busquedaAsig = e.target.value;
      clearTimeout(ESTADO.retardoBusqueda);
      // Con una pausa breve: cada render vuelve a pedir los datos y rehace la pantalla, y no debe pisar lo que se está escribiendo.
      ESTADO.retardoBusqueda = setTimeout(async () => {
        ORDEN.pagina = 0;
        await renderSegmentos();
        const el = $('f-buscar');
        if (el) {
          el.focus();
          el.setSelectionRange(ESTADO.busquedaAsig.length, ESTADO.busquedaAsig.length);
        }
      }, 250);
    },
  });
  const barra = barraFiltro(pools, renderSegmentos);
  barra.insertBefore(h('label', null, 'Buscar', buscador), barra.firstChild);
  const aviso = h('div', { id: 'seg-msg', 'aria-live': 'polite' });
  if (ASIG.aviso) {
    msg(aviso, ASIG.aviso, 'ok');
    ASIG.aviso = null;
  }
  if (RES.aviso) {
    msg(aviso, RES.aviso.texto, RES.aviso.tipo);
    RES.aviso = null;
  }
  const nuevo = h('div', { class: 'nuevo' }, puede('solicitante') ? formularioNuevoSegmento(pools, aviso, renderSegmentos) : null);
  raiz.querySelector('.cabecera').after(nuevo, aviso, barra);
}
