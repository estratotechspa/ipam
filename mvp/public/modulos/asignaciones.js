// Pestaña Asignaciones: lista con búsqueda, orden y paginación; liberar y nueva asignación.
import { fmt as _fmt } from '../calculos.js';
import { parseCidr, tamanoCidr } from '../calculos.js';
import { $, ESTADO, I, api, errorApi, esc, fail, fecha, fmt, get, h, ico, msg, puede, size, todasLasAsignaciones } from './base.js';
import { FILTRO, barraFiltro, pasaFiltro } from './filtro.js';
import { fichaAsignacion } from './fichas.js';
import { dialogoSimple, toast, vincularCidr } from './ui.js';
import { cargarDisponibilidad } from './disponibilidad.js';

// Orden por columna y paginación de Asignaciones (en el navegador, sobre la lista ya filtrada). Se conservan al cambiar de pestaña.
export const POR_PAGINA = 25;

export const ORDEN_ASIG = { col: 'fecha', dir: 'desc', pagina: 0 };

export const COLUMNAS_ASIG = [
  ['codigo', 'ID'],
  ['cidr', 'Segmento'],
  ['pool', 'Pool'],
  ['vpc', 'Proyecto / VPC'],
  ['vlan', 'VLAN'],
  ['dir', 'Direcciones'],
  ['sol', 'Solicitó'],
  ['origen', 'Origen'],
  ['ticket', 'Ticket'],
  ['fecha', 'Fecha'],
];

export const claveAsig = {
  codigo: (x) => Number(x.id),
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
  const a = claveAsig[col](x);
  const b = claveAsig[col](y);
  const c = typeof a === 'string' ? a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }) : a - b;
  return (dir === 'asc' ? c : -c) || Number(y.id) - Number(x.id);
};

export const encabezadoAsig = () =>
  COLUMNAS_ASIG.map(([col, texto]) => {
    const activa = ORDEN_ASIG.col === col;
    const sentido = activa ? (ORDEN_ASIG.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${sentido}"><button type="button" class="orden" data-orden="${col}">${texto}${activa ? I(ORDEN_ASIG.dir === 'asc' ? 'arriba' : 'abajo') : ''}</button></th>`;
  }).join('') + '<th scope="col"><span class="sr-only">Acciones</span></th>';

export const paginacionAsig = (total) => {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const desde = total === 0 ? 0 : ORDEN_ASIG.pagina * POR_PAGINA + 1;
  const hasta = Math.min(total, (ORDEN_ASIG.pagina + 1) * POR_PAGINA);
  return `<nav class="paginacion" aria-label="Paginación"><span class="muted" role="status">${total === 0 ? 'Sin resultados' : `Mostrando ${_fmt(desde)}–${_fmt(hasta)} de ${_fmt(total)}`}</span>
    <span class="paginacion-botones"><button type="button" class="btn sec" id="a-ant" ${ORDEN_ASIG.pagina === 0 ? 'disabled' : ''}>${I('izquierda')}Anterior</button>
    <span class="num">Página ${_fmt(ORDEN_ASIG.pagina + 1)} de ${_fmt(paginas)}</span>
    <button type="button" class="btn sec" id="a-sig" ${ORDEN_ASIG.pagina >= paginas - 1 ? 'disabled' : ''}>Siguiente${I('derecha')}</button></span></nav>`;
};

export const ASIG = { formAbierto: false, aviso: null };

export const textoVlan = (x) => (x.vlan ? `${x.vlan}${x.vlan_nombre ? ' · ' + x.vlan_nombre : ''}` : x.vlan_nombre || '—');

export async function renderAsig() {
  try {
    const [todosPools, todasAsig] = await Promise.all([get('/api/pools'), todasLasAsignaciones()]);
    const deEsePool = new Map(todosPools.map((p) => [p.id, p]));
    const q = ESTADO.busquedaAsig.trim().toLowerCase();
    const a = todasAsig
      .filter((x) => deEsePool.has(x.pool_id) && pasaFiltro(deEsePool.get(x.pool_id)))
      .filter((x) => !q || [x.codigo, x.cidr, x.vpc, x.ticket, x.solicitante, x.pool_id, x.origen, x.vlan, x.vlan_nombre].join(' ').toLowerCase().includes(q));
    const total = a.length;
    a.sort(comparar(ORDEN_ASIG.col, ORDEN_ASIG.dir));
    ORDEN_ASIG.pagina = Math.min(ORDEN_ASIG.pagina, Math.max(0, Math.ceil(total / POR_PAGINA) - 1));
    const pagina = a.slice(ORDEN_ASIG.pagina * POR_PAGINA, (ORDEN_ASIG.pagina + 1) * POR_PAGINA);
    $('asig').innerHTML =
      `<div class="cabecera"><h2 tabindex="-1">Asignaciones</h2><span class="acciones"><a class="btn" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a>${puede('admin') ? `<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">${I('archivo')}Respaldo JSON</a>` : ''}</span></div>${
        total === 0
          ? `<div class="card vacio">${I('buscar', 20)}<p><b>${q || FILTRO.ambiente || FILTRO.proveedor ? 'Ninguna asignación coincide con la búsqueda.' : 'Aún no hay asignaciones.'}</b></p><p class="muted">${q || FILTRO.ambiente || FILTRO.proveedor ? 'Prueba con otro texto o quita los filtros.' : 'Cuando se asigne un segmento aparecerá aquí.'}</p></div>`
          : `<div class="card tablewrap" tabindex="0" role="region" aria-label="Asignaciones"><table><thead><tr>${encabezadoAsig()}</tr></thead><tbody>
  ${pagina
    .map(
      (
        x,
      ) => `<tr><td><button type="button" class="enlace" data-ficha-asig="${esc(x.id)}"><code>${esc(x.codigo || x.id)}</code></button></td><td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${esc(x.vpc)}</td><td>${esc(textoVlan(x))}</td><td>${fmt(size(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${fecha(x.creado_en)}</td>
  <td>${puede('admin') ? `<button type="button" class="btn sec pequeno" data-del="${x.id}" data-c="${esc(x.cidr)}">${I('liberar')}Liberar</button>` : ''}</td></tr>`,
    )
    .join('')}</tbody></table></div>`
      }${paginacionAsig(total)}`;
    $('asig')
      .querySelectorAll('[data-orden]')
      .forEach(
        (b) =>
          (b.onclick = async () => {
            const col = b.dataset.orden;
            if (ORDEN_ASIG.col === col) ORDEN_ASIG.dir = ORDEN_ASIG.dir === 'asc' ? 'desc' : 'asc';
            else Object.assign(ORDEN_ASIG, { col, dir: col === 'fecha' ? 'desc' : 'asc' });
            ORDEN_ASIG.pagina = 0;
            await renderAsig();
            const otra = $('asig').querySelector(`[data-orden="${col}"]`);
            if (otra) otra.focus();
          }),
      );
    for (const [id, paso] of [
      ['a-ant', -1],
      ['a-sig', 1],
    ]) {
      const b = $(id);
      if (b)
        b.onclick = async () => {
          ORDEN_ASIG.pagina += paso;
          await renderAsig();
          const sigue = $(id);
          (sigue && !sigue.disabled ? sigue : $('asig').querySelector('.paginacion .btn:not([disabled])'))?.focus();
        };
    }
    const buscador = h('input', {
      id: 'f-buscar',
      type: 'search',
      value: ESTADO.busquedaAsig,
      placeholder: 'ID, segmento, proyecto, VLAN, ticket…',
      oninput: async (e) => {
        ESTADO.busquedaAsig = e.target.value;
        ORDEN_ASIG.pagina = 0;
        await renderAsig();
        const el = document.getElementById('f-buscar');
        if (el) {
          el.focus();
          el.setSelectionRange(ESTADO.busquedaAsig.length, ESTADO.busquedaAsig.length);
        }
      },
    });
    const barra = barraFiltro(todosPools, renderAsig);
    barra.insertBefore(h('label', null, 'Buscar', buscador), barra.firstChild);
    $('asig').prepend(barra);
    const aviso = h('div', { id: 'asig-msg', 'aria-live': 'polite' });
    if (ASIG.aviso) {
      msg(aviso, ASIG.aviso, 'ok');
      ASIG.aviso = null;
    }
    $('asig').prepend(aviso);
    if (puede('admin')) $('asig').prepend(formularioNuevaAsignacion(todosPools, renderAsig));
    $('asig')
      .querySelectorAll('[data-ficha-asig]')
      .forEach((b) => (b.onclick = () => fichaAsignacion(b.dataset.fichaAsig)));
    $('asig')
      .querySelectorAll('[data-del]')
      .forEach((b) => (b.onclick = () => liberarAsignacion(b.dataset.del, b.dataset.c, renderAsig)));
  } catch (e) {
    fail('asig', e);
  }
}

/** Libera una asignación pidiendo el motivo (queda en el historial). Devuelve true si se liberó. */
export async function liberarAsignacion(id, cidr, despues) {
  const { aceptado, valor: motivo } = await dialogoSimple({
    titulo: `¿Liberar ${cidr}?`,
    mensaje: 'El segmento quedará disponible para otras solicitudes. Indica por qué se libera: queda en el historial.',
    confirmar: 'Liberar segmento',
    peligro: true,
    campo: { etiqueta: 'Motivo', obligatorio: true },
  });
  if (!aceptado) return false;
  const r = await api('/api/asignaciones/' + id, { method: 'DELETE', body: { motivo } });
  if (r.ok) toast(`Segmento ${cidr} liberado.`);
  else toast((r.data && (r.data.mensaje || r.data.error)) || 'No se pudo liberar', 'error');
  if (despues) await despues();
  return r.ok;
}

// VLAN opcional (número y nombre) en los formularios de asignación y reserva.
export const camposVlan = (prefijo) => ({
  vlan: h('input', { id: prefijo + '-vlan', type: 'number', min: 1, max: 4094, step: 1, inputmode: 'numeric', placeholder: '1–4094' }),
  vlanNombre: h('input', { id: prefijo + '-vlan-nombre', maxlength: 80, placeholder: 'p. ej. Branch_Data' }),
});

export const cuerpoVlan = ({ vlan, vlanNombre }) => ({
  ...(vlan.value.trim() ? { vlan: Number(vlan.value) } : {}),
  ...(vlanNombre.value.trim() ? { vlan_nombre: vlanNombre.value.trim() } : {}),
});

// Pool y máscara de los formularios: NINGÚN pool viene elegido; la máscara se habilita al elegirlo y solo ofrece las que caben en él.
export function selectorPoolMascara(prefijo, pools) {
  const pool = h(
    'select',
    { id: prefijo + '-pool', required: true },
    h('option', { value: '' }, 'Elige un pool…'),
    pools.map((p) => h('option', { value: p.id }, `${p.id} · ${p.ambiente} · ${p.cidr}`)),
  );
  const mascara = h('select', { id: prefijo + '-mascara', disabled: true }, h('option', { value: '' }, 'Elige primero un pool'));
  const disp = h(
    'div',
    { id: prefijo + '-disp', class: 'card', style: 'flex:1 1 100%' },
    h('p', { class: 'muted' }, 'Elige un pool para ver cuánto espacio libre tiene y de qué tamaños.'),
  );
  pool.addEventListener('change', () => cargarDisponibilidad(disp, pool.value, mascara));
  return { pool, mascara, disp };
}

// Formulario «Nueva asignación» (solo admin): entrega definitiva e inmediata, sin reserva ni aprobación de otra persona.
export function formularioNuevaAsignacion(pools, recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const { pool, mascara, disp } = selectorPoolMascara('na', pools);
  const vpc = h('input', { id: 'na-vpc', required: true, maxlength: 120, placeholder: 'vpc-mi-proyecto' });
  const cidr = h('input', { id: 'na-cidr', placeholder: 'opcional: vacío = el primer libre' });
  const vl = camposVlan('na');
  const boton = h('button', { class: 'btn', type: 'submit', id: 'na-go' }, 'Asignar');
  const revisarCidr = vincularCidr(cidr, boton, () => (pools.find((x) => x.id === pool.value) || {}).cidr);
  pool.addEventListener('change', revisarCidr);
  const res = h('div', { id: 'na-res', 'aria-live': 'polite', style: 'flex:1 1 100%' });
  const enviar = async (e) => {
    e.preventDefault();
    if (!pool.value) return msg(res, 'Elige un pool.', 'error');
    if (!cidr.value.trim() && !mascara.value) return msg(res, 'Elige una máscara o escribe un CIDR.', 'error');
    const body = {
      pool: pool.value,
      vpc: vpc.value.trim(),
      ...(cidr.value.trim() ? { cidr: cidr.value.trim() } : { mascara: +mascara.value }),
      ...cuerpoVlan(vl),
    };
    boton.disabled = true;
    const r = await api('/api/v1/solicitudes', { body });
    boton.disabled = false;
    const d = r.data || {};
    if (r.ok) {
      ASIG.aviso = `Asignado ${d.cidr} (${d.codigo || 'sin ID'}) en ${d.pool_id} para ${d.vpc}. Ticket ${d.ticket}.`;
      ASIG.formAbierto = false;
      return recargar();
    }
    if (d.error === 'solapamiento' && d.conflicto) {
      const x = d.conflicto;
      return res.replaceChildren(
        h(
          'div',
          { class: 'alert', role: 'alert' },
          h('b', null, ico('alerta'), ' Solapamiento detectado'),
          h('br'),
          `${body.cidr} se cruza con ${x.cidr} de ${x.vpc} (pidió ${x.solicitante}, ticket ${x.ticket}). No se asignó nada.`,
        ),
        h('b', null, 'Segmentos libres sugeridos'),
        ...((d.sugeridos || []).length
          ? d.sugeridos.map((s) =>
              h(
                'div',
                { class: 'sug' },
                h('code', null, s),
                h(
                  'button',
                  {
                    class: 'btn',
                    type: 'button',
                    onclick: (ev) => {
                      cidr.value = s;
                      ev.currentTarget.closest('form').requestSubmit();
                    },
                  },
                  'Usar',
                ),
              ),
            )
          : [h('p', { class: 'muted' }, 'No hay segmentos libres de ese tamaño.')]),
      );
    }
    msg(res, errorApi(r), 'error');
  };
  const form = h(
    'form',
    { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Nueva asignación', onsubmit: enviar },
    campo('Pool', pool),
    campo('Proyecto / VPC', vpc),
    campo('Máscara', mascara),
    campo('CIDR manual', cidr),
    campo('VLAN (opcional)', vl.vlan),
    campo('Nombre VLAN / subred (opcional)', vl.vlanNombre),
    boton,
    res,
    disp,
  );
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 14px', open: ASIG.formAbierto, ontoggle: (e) => (ASIG.formAbierto = e.target.open) },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Nueva asignación (directa, solo admin)'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Entrega el segmento ',
      h('b', null, 'de inmediato y de forma definitiva'),
      ', sin reserva ni aprobación de otra persona; queda en el historial a tu nombre. Para el flujo normal (pedir, aprobar, asignar) usa Reservas, «Nueva reserva».',
    ),
    form,
  );
}
