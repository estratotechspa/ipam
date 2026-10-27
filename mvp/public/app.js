import { icono } from '/iconos.js';
import { fmt as _fmt, nivelUso, parseCidr, validarCidr, mapaBloques, tamanoCidr } from '/calculos.js';

const $ = (id) => document.getElementById(id);
const I = icono;
/** Icono como elemento (para el constructor h()): el SVG es de este código, no de datos del usuario. */
const ico = (nombre, tam) => {
  const e = document.createElement('span');
  e.className = 'ic-envoltorio';
  e.innerHTML = icono(nombre, tam);
  return e;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('es-CL');
const fecha = (s) => new Date(s).toLocaleDateString('es-CL');
const size = (c) => 2 ** (32 - Number(c.split('/')[1]));
const tag = (a) => `<span class="tag ${esc(a)}">${esc(a)}</span>`;
const CAB = { 'X-Requested-With': 'ipam' };
async function api(url, opt) {
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
const MASCARAS = Array.from({ length: 25 }, (_, i) => i + 8);
let YO = { modo: 'none', rol: 'admin', usuario: '', nombre: '' };
const NIVEL = { lector: 0, agente: 1, solicitante: 2, admin: 3 };
const puede = (min) => NIVEL[YO.rol] >= NIVEL[min];
// La API entrega las asignaciones en páginas de hasta 1000 (X-Total-Count trae el total): la interfaz las reúne todas.
async function todasLasAsignaciones() {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await api('/api/asignaciones?limit=1000&offset=' + desde);
    if (!r.ok) throw new Error('Error ' + r.status);
    todas.push(...r.data);
    if (r.data.length < 1000 || todas.length >= (r.total || 0)) return todas;
  }
}
const get = async (u) => {
  const r = await api(u);
  if (!r.ok) throw new Error('Error ' + r.status);
  return r.data;
};

// Vistas sin botón propio en la barra: se abren desde su pestaña (Importar, desde Pools) y solo las ve un admin.
const SUBVISTAS = { importar: 'pools' };
let VISTA = 'pools';
function show(t) {
  const boton = $('nav').querySelector('[data-t="' + t + '"]');
  if (!$(t) || (SUBVISTAS[t] ? !puede('admin') : !boton || boton.hidden)) t = 'pools';
  VISTA = t;
  const marcada = SUBVISTAS[t] || t;
  clearInterval(RES.timer);
  document.querySelectorAll('.wrap').forEach((w) => w.classList.toggle('hide', w.id !== t));
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.t === marcada);
    if (b.dataset.t === marcada) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  render(t);
}
$('nav').onclick = (e) => {
  const b = e.target.closest('[data-t]');
  if (b) show(b.dataset.t);
};
document.querySelectorAll('#nav [data-ic]').forEach((b) => b.insertAdjacentHTML('afterbegin', I(b.dataset.ic)));
const fail = (id, e) => ($(id).innerHTML = `<div class="alert" role="alert">${I('error')} No se pudo cargar: ${esc(e.message)}</div>`);

// Filtro global por ambiente y proveedor: vale para Pools, Asignaciones y Reservas (se conserva al cambiar de pestaña).
const FILTRO = { ambiente: '', proveedor: '' };
const pasaFiltro = (p) => (!FILTRO.ambiente || p.ambiente === FILTRO.ambiente) && (!FILTRO.proveedor || p.proveedor === FILTRO.proveedor);
const camposFiltro = (todos, recargar) => {
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
const barraFiltro = (todos, recargar) =>
  h(
    'form',
    { class: 'filtros', role: 'search', 'aria-label': 'Filtrar por ambiente y proveedor', onsubmit: (e) => e.preventDefault() },
    camposFiltro(todos, recargar),
  );

// Uso de un pool: lo asignado (definitivo) más lo reservado (apartado). Es la misma cuenta en la tabla, la ficha y la disponibilidad.
const pct = (x) => (x * 100).toFixed(1).replace('.', ',') + ' %';
const anchoUso = (x) => (x > 0 ? Math.max(x * 100, 1) : 0);
const textoUso = (asig, res) => `Asignado ${pct(asig)} · reservado ${pct(res)}`;
/** Barra de uso: verde < 70 %, ámbar 70–90 %, rojo > 90 % (sobre lo asignado + lo reservado), con el porcentaje en número. En uso alto
 *  lleva además un icono: el color no es lo único que informa. */
const textoNivel = { bajo: 'uso bajo', medio: 'uso medio', alto: 'uso alto' };
const barraUsoHtml = (asig, res) => {
  const nivel = nivelUso(asig + res);
  const detalle = `${textoUso(asig, res)}, ${textoNivel[nivel]}`;
  return `<span class="uso"><span class="bar" role="img" aria-label="${detalle}" title="${detalle}"><i class="uso-${nivel}" style="width:${anchoUso(asig)}%"></i><i class="res" style="width:${anchoUso(res)}%"></i></span><span class="uso-pct uso-txt-${nivel} num">${nivel === 'alto' ? I('alerta') : ''}${pct(asig + res)}</span></span>`;
};
const barraUso = (asig, res) => {
  const nivel = nivelUso(asig + res);
  const detalle = `${textoUso(asig, res)}, ${textoNivel[nivel]}`;
  return h(
    'span',
    { class: 'uso' },
    h(
      'span',
      { class: 'bar', role: 'img', 'aria-label': detalle, title: detalle },
      h('i', { class: `uso-${nivel}`, style: `width:${anchoUso(asig)}%` }),
      h('i', { class: 'res', style: `width:${anchoUso(res)}%` }),
    ),
    h('span', { class: `uso-pct uso-txt-${nivel} num` }, nivel === 'alto' ? ico('alerta') : null, pct(asig + res)),
  );
};

async function renderPools() {
  try {
    const todos = await get('/api/pools');
    const pools = todos.filter(pasaFiltro);
    // Uso total ponderado por tamaño: direcciones ocupadas (asignadas + reservadas) de todos los pools ÷ direcciones totales.
    const total = pools.reduce((n, p) => n + size(p.cidr), 0);
    const ocupadas = pools.reduce((n, p) => n + (p.uso + (p.uso_reservado || 0)) * size(p.cidr), 0);
    const sobre80 = pools.filter((p) => p.uso + (p.uso_reservado || 0) > 0.8).length;
    $('pools').innerHTML =
      `<div class="cabecera"><h2 tabindex="-1">Estado de pools</h2><span class="acciones">${puede('admin') ? `<button type="button" class="btn" id="btn-importar">${I('subir')}Importar segmentos</button>` : ''}<a class="btn sec" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a></span></div>
  <div class="kpis"><div class="card"><div class="kpi">${pools.length}</div><div class="sub">Pools</div></div>
  <div class="card"><div class="kpi">${pools.reduce((n, p) => n + p.asignaciones, 0)}</div><div class="sub">Asignaciones activas</div></div>
  <div class="card"><div class="kpi">${pct(total ? ocupadas / total : 0)}</div><div class="sub">Uso total (asignado + reservado)</div></div>
  <div class="card"><div class="kpi ${sobre80 ? 'uso-txt-alto' : ''}">${sobre80}</div><div class="sub">Pools sobre 80 %</div></div>
  <div class="card"><div class="kpi">${_fmt(Math.max(0, Math.round(total - ocupadas)))}</div><div class="sub">Espacio libre (direcciones)</div></div></div>
  <p class="nota">${I('info')} Los solapamientos no son un indicador: la base de datos los impide con una restricción de exclusión.</p>
  <div id="pool-nuevo"></div><div id="pools-msg" aria-live="polite"></div>
  <p class="muted leyenda"><span class="muestra asig"></span> asignado <span class="muestra res"></span> reservado · Haz clic en un pool para ver su ficha.</p>
  <div class="card tablewrap" tabindex="0" role="region" aria-label="Pools"><table><thead><tr><th scope="col">Pool</th><th scope="col">Tipo</th><th scope="col">Ambiente</th><th scope="col">Proveedor</th><th scope="col">CIDR base</th><th scope="col">Asig.</th><th scope="col">Reservas</th><th scope="col">Uso</th></tr></thead><tbody>
  ${pools
    .map(
      (
        p,
      ) => `<tr><td><button type="button" class="enlace" data-ficha-pool="${esc(p.id)}">${esc(p.id)}</button></td><td>${esc(p.tipo)}</td><td>${tag(p.ambiente)}</td><td>${esc(p.proveedor)}</td><td><code>${esc(p.cidr)}</code></td><td>${p.asignaciones}</td><td>${p.reservas_vigentes || 0}</td>
  <td>${barraUsoHtml(p.uso, p.uso_reservado || 0)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
    $('pools').prepend(barraFiltro(todos, renderPools));
    $('pools')
      .querySelectorAll('[data-ficha-pool]')
      .forEach((b) => (b.onclick = () => fichaPool(b.dataset.fichaPool)));
    const imp = $('btn-importar');
    if (imp) imp.onclick = () => show('importar');
    if (puede('admin')) $('pool-nuevo').replaceWith(formularioNuevoPool(renderPools));
    if (POOLS_AVISO) {
      msg($('pools-msg'), POOLS_AVISO, 'ok');
      POOLS_AVISO = null;
    }
  } catch (e) {
    fail('pools', e);
  }
}

let busquedaAsig = ''; // texto del buscador de Asignaciones
// Orden por columna y paginación de Asignaciones (en el navegador, sobre la lista ya filtrada). Se conservan al cambiar de pestaña.
const POR_PAGINA = 25;
const ORDEN_ASIG = { col: 'fecha', dir: 'desc', pagina: 0 };
const COLUMNAS_ASIG = [
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
const claveAsig = {
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
const comparar = (col, dir) => (x, y) => {
  const a = claveAsig[col](x);
  const b = claveAsig[col](y);
  const c = typeof a === 'string' ? a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }) : a - b;
  return (dir === 'asc' ? c : -c) || Number(y.id) - Number(x.id);
};
const encabezadoAsig = () =>
  COLUMNAS_ASIG.map(([col, texto]) => {
    const activa = ORDEN_ASIG.col === col;
    const sentido = activa ? (ORDEN_ASIG.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" aria-sort="${sentido}"><button type="button" class="orden" data-orden="${col}">${texto}${activa ? I(ORDEN_ASIG.dir === 'asc' ? 'arriba' : 'abajo') : ''}</button></th>`;
  }).join('') + '<th scope="col"><span class="sr-only">Acciones</span></th>';
const paginacionAsig = (total) => {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const desde = total === 0 ? 0 : ORDEN_ASIG.pagina * POR_PAGINA + 1;
  const hasta = Math.min(total, (ORDEN_ASIG.pagina + 1) * POR_PAGINA);
  return `<nav class="paginacion" aria-label="Paginación"><span class="muted" role="status">${total === 0 ? 'Sin resultados' : `Mostrando ${_fmt(desde)}–${_fmt(hasta)} de ${_fmt(total)}`}</span>
    <span class="paginacion-botones"><button type="button" class="btn sec" id="a-ant" ${ORDEN_ASIG.pagina === 0 ? 'disabled' : ''}>${I('izquierda')}Anterior</button>
    <span class="num">Página ${_fmt(ORDEN_ASIG.pagina + 1)} de ${_fmt(paginas)}</span>
    <button type="button" class="btn sec" id="a-sig" ${ORDEN_ASIG.pagina >= paginas - 1 ? 'disabled' : ''}>Siguiente${I('derecha')}</button></span></nav>`;
};
const ASIG = { formAbierto: false, aviso: null };
const textoVlan = (x) => (x.vlan ? `${x.vlan}${x.vlan_nombre ? ' · ' + x.vlan_nombre : ''}` : x.vlan_nombre || '—');
async function renderAsig() {
  try {
    const [todosPools, todasAsig] = await Promise.all([get('/api/pools'), todasLasAsignaciones()]);
    const deEsePool = new Map(todosPools.map((p) => [p.id, p]));
    const q = busquedaAsig.trim().toLowerCase();
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
      value: busquedaAsig,
      placeholder: 'ID, segmento, proyecto, VLAN, ticket…',
      oninput: async (e) => {
        busquedaAsig = e.target.value;
        ORDEN_ASIG.pagina = 0;
        await renderAsig();
        const el = document.getElementById('f-buscar');
        if (el) {
          el.focus();
          el.setSelectionRange(busquedaAsig.length, busquedaAsig.length);
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
async function liberarAsignacion(id, cidr, despues) {
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
const camposVlan = (prefijo) => ({
  vlan: h('input', { id: prefijo + '-vlan', type: 'number', min: 1, max: 4094, step: 1, inputmode: 'numeric', placeholder: '1–4094' }),
  vlanNombre: h('input', { id: prefijo + '-vlan-nombre', maxlength: 80, placeholder: 'p. ej. Branch_Data' }),
});
const cuerpoVlan = ({ vlan, vlanNombre }) => ({
  ...(vlan.value.trim() ? { vlan: Number(vlan.value) } : {}),
  ...(vlanNombre.value.trim() ? { vlan_nombre: vlanNombre.value.trim() } : {}),
});

// Pool y máscara de los formularios: NINGÚN pool viene elegido; la máscara se habilita al elegirlo y solo ofrece las que caben en él.
function selectorPoolMascara(prefijo, pools) {
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
function formularioNuevaAsignacion(pools, recargar) {
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

let ultimoJira = null; // resultado de la última simulación (se muestra tras recargar la pestaña)

// tipo de evento → [texto para personas, tono]. Los errores son lo que conviene revisar.
const EVENTOS_JIRA = {
  jira_ticket_creado: ['Ticket creado en Jira', 'ok'],
  jira_ticket_actualizado: ['Ticket de Jira actualizado', 'ok'],
  jira_actualiza_ticket: ['Ticket actualizado (simulado)', 'ok'],
  jira_pendiente_aprobacion: ['Reserva pendiente de aprobación', 'info'],
  jira_webhook_recibido: ['Webhook recibido (simulado)', 'info'],
  jira_rechazo: ['Solicitud de Jira rechazada', 'error'],
  jira_firma_invalida: ['Webhook con firma inválida', 'error'],
  jira_error: ['Error al hablar con Jira', 'error'],
};
const ICONO_TONO = { ok: 'ok', info: 'info', error: 'alerta' };
const filaEventoJira = (e) => {
  const [texto, tono] = EVENTOS_JIRA[e.tipo] || [e.tipo, 'info'];
  const d = e.detalle || {};
  const detalle = d.motivo || d.rango || [d.ambiente, d.tipo, d.mascara && `/${d.mascara}`, d.vpc].filter(Boolean).join(' · ') || '';
  return `<tr><td class="num">${new Date(e.ts).toLocaleTimeString('es-CL')}</td><td><span class="evento evento-${tono}">${I(ICONO_TONO[tono])} ${esc(texto)}</span></td><td>${esc(d.ticket || '')}</td><td>${esc(detalle)}</td></tr>`;
};
const cajaJira = (texto, clase = '') => `<div class="box ${clase}">${texto}</div>`;
const flujoJira = (pasos) => `<div class="flow">${pasos.map(([t, c]) => cajaJira(t, c)).join(`<span class="arrow">${I('flecha', 20)}</span>`)}</div>`;

async function renderJira() {
  let ev = [],
    je = { activa: false, faltantes: [] };
  try {
    ev = await get('/api/eventos');
    je = await get('/api/jira/estado');
  } catch (e) {}
  const incompleta = je.activa && je.faltantes.length > 0;
  const insignia = !je.activa
    ? `<span class="tag qa">${I('info')} Desactivada</span>`
    : incompleta
      ? `<span class="tag prod">${I('alerta')} Activa, incompleta</span>`
      : `<span class="tag dev">${I('ok')} Activa</span>`;
  const textoEstado = !je.activa
    ? `<p>La integración saliente está <b>desactivada</b>: el número de ticket (<code>NET-xxx</code>) lo genera el propio IPAM y no se llama a Jira. Para activarla define <code>JIRA_ENABLED=true</code> y las variables de conexión.</p><p class="muted">El webhook de entrada (de Jira al IPAM) funciona igual, con o sin esta integración.</p>`
    : incompleta
      ? `<div class="alert" role="alert">${I('alerta')} La integración está activada pero faltan variables, así que no se crean tickets en Jira:<ul>${je.faltantes.map((v) => `<li><code>${esc(v)}</code></li>`).join('')}</ul></div>`
      : '<p>La integración está <b>activa</b>: cada asignación crea su ticket en Jira en segundo plano (con reintentos), y los tickets que llegan por webhook se comentan y se cierran al aprobar la reserva.</p>';
  const eventos = ev.filter((e) => e.tipo.startsWith('jira')).slice(0, 15);
  const simulador =
    je.simulador === false
      ? `<h3>Simular un ticket entrante</h3><p class="muted">${I('info')} El simulador está deshabilitado en este entorno (producción). Se habilita con ENABLE_SIMULADOR=true.</p>`
      : `<h3>Simular un ticket entrante</h3><p class="muted">Arma un ticket, lo firma como lo haría Jira y lo procesa por el mismo camino del webhook. Crea una reserva real que un admin debe aprobar.</p>
   <div class="row"><div><label for="j-amb">Ambiente</label><select id="j-amb"><option>prod</option><option>qa</option><option>dev</option></select></div>
   <div><label for="j-tipo">Tipo</label><select id="j-tipo"><option>Nodos</option><option selected>Pods</option><option>Servicios</option><option>Control plane</option></select></div>
   <div><label for="j-len">Máscara</label><select id="j-len">${MASCARAS.map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select></div>
   <div><label for="j-vpc">VPC</label><input id="j-vpc" value="vpc-nueva" maxlength="100"></div></div>
   <p><button type="button" class="btn" id="j-go">${I('flujo')}Enviar webhook</button></p><div id="j-res" role="status"></div>`;
  $('jira').innerHTML =
    `<div class="cabecera"><h2 tabindex="-1">Integración con Jira</h2><button type="button" class="btn sec" id="j-actualizar">${I('reintentar')}Actualizar</button></div>
  <div class="card"><h3 style="margin-top:0">Estado ${insignia}</h3>${textoEstado}</div>
  <div class="card tablewrap" style="margin-top:var(--sp-4)" tabindex="0" role="region" aria-label="Últimos eventos de Jira"><h3 style="margin-top:0">Últimos eventos</h3>${
    eventos.length
      ? `<table><thead><tr><th scope="col">Hora</th><th scope="col">Evento</th><th scope="col">Ticket</th><th scope="col">Detalle</th></tr></thead><tbody>${eventos.map(filaEventoJira).join('')}</tbody></table>`
      : '<p class="muted">Todavía no hay eventos de Jira. Aparecerán aquí cuando se cree un ticket o llegue un webhook.</p>'
  }</div>
  <details class="plegable" id="j-como"><summary>${I('ayuda')} Cómo funciona</summary>
    <h3>Sentido 1 · IPAM ${I('flecha')} Jira</h3>${flujoJira([['Panel / API<br>asigna un segmento'], ['IPAM<br>valida y asigna'], ['Jira crea el ticket<br>(en segundo plano)', 'jira'], ['Guarda la clave<br>del ticket']])}
    <p class="muted">Con la integración desactivada, el número de ticket lo genera el IPAM (secuencia NET-xxx). Al activarla (JIRA_ENABLED=true) se crea el ticket real en Jira, con reintentos.</p>
    <h3>Sentido 2 · Jira ${I('flecha')} IPAM</h3>${flujoJira([['Ticket «Solicitud de Segmento IPAM»<br>ambiente, tipo, máscara, VPC', 'jira'], ['Webhook<br>(firmado con HMAC y hora)'], ['IPAM calcula<br>y reserva'], ['Aprobación manual<br>de un admin (Reservas)', 'aprob'], ['Se asigna y se<br>actualiza el ticket', 'jira']])}
    ${simulador}</details>`;
  $('j-actualizar').onclick = renderJira;
  if (je.simulador === false) return;
  if (ultimoJira) {
    $('j-como').open = true;
    $('j-res').className = ultimoJira.ok ? 'ok' : 'alert';
    $('j-res').textContent = ultimoJira.texto;
  }
  $('j-go').onclick = async () => {
    $('j-go').disabled = true;
    const r = await api('/api/jira/simular', {
      body: { ambiente: $('j-amb').value, tipo: $('j-tipo').value, mascara: +$('j-len').value, vpc: $('j-vpc').value.trim() || 'vpc-sin-nombre' },
    });
    ultimoJira = r.ok
      ? {
          ok: true,
          texto: `Ticket ${r.data.ticket}: se reservó ${r.data.cidr} en ${r.data.pool}. Falta la aprobación manual de un admin en la pestaña Reservas; si no se aprueba, expira sola.`,
        }
      : { ok: false, texto: (r.data && (r.data.mensaje || r.data.error)) || 'Error ' + r.status };
    renderJira();
  };
}

// ---- Diálogos simples (clave temporal, cambio de contraseña) ----
function abrirDialogo(construir, { cerrable = true } = {}) {
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

/** Muestra UNA vez la clave temporal de una cuenta local (nunca se guarda ni se vuelve a mostrar). */
function mostrarClaveTemporal(usuario, clave, titulo) {
  abrirDialogo((dlg, cerrar) => {
    const estado = h('div', { id: 'ct-copia', 'aria-live': 'polite' });
    const valor = h('input', { id: 'ct-valor', class: 'token-valor', readonly: true, 'aria-label': 'Clave temporal', onfocus: (e) => e.target.select() });
    valor.value = clave;
    const copiar = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        id: 'ct-copiar',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(valor.value);
            msg(estado, 'Copiada al portapapeles.', 'ok');
          } catch {
            valor.focus();
            valor.select();
            msg(estado, 'No se pudo copiar sola: el texto quedó seleccionado, copia con Ctrl+C.', 'error');
          }
        },
      },
      'Copiar',
    );
    dlg.replaceChildren(
      h(
        'div',
        null,
        h('h3', null, titulo + ': ' + usuario),
        h(
          'div',
          { class: 'aviso', role: 'alert' },
          h('b', null, 'Cópiala ahora. '),
          'No se podrá ver de nuevo. La persona deberá cambiarla al entrar por primera vez.',
        ),
        h('label', { for: 'ct-valor' }, 'Clave temporal'),
        valor,
        estado,
        h('div', { class: 'fila-botones' }, copiar, h('button', { class: 'btn sec', type: 'button', id: 'ct-cerrar', onclick: cerrar }, 'Cerrar')),
      ),
    );
    copiar.focus();
  });
}

/** Cambio de la contraseña propia (cuentas locales). Si es obligatorio (clave temporal), el diálogo no se puede cerrar. */
function dialogoCambioClave({ obligatorio = false } = {}) {
  abrirDialogo(
    (dlg, cerrar) => {
      const estado = h('div', { id: 'cc-msg', 'aria-live': 'polite' });
      const actual = h('input', { id: 'cc-actual', type: 'password', required: true, autocomplete: 'current-password' });
      const nueva = h('input', { id: 'cc-nueva', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' });
      const repite = h('input', { id: 'cc-repite', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' });
      const boton = h('button', { class: 'btn', type: 'submit', id: 'cc-go' }, 'Cambiar contraseña');
      const enviar = async (e) => {
        e.preventDefault();
        if (nueva.value !== repite.value) return msg(estado, 'La contraseña nueva y su repetición no coinciden.', 'error');
        boton.disabled = true;
        const r = await api('/api/v1/yo/clave', { body: { actual: actual.value, nueva: nueva.value } });
        boton.disabled = false;
        if (!r.ok) return msg(estado, errorApi(r), 'error');
        msg(estado, 'Contraseña cambiada. El navegador te pedirá entrar de nuevo con la nueva.', 'ok');
        setTimeout(() => location.reload(), 1200);
      };
      dlg.replaceChildren(
        h(
          'form',
          { onsubmit: enviar, 'aria-label': 'Cambiar contraseña' },
          h('h3', null, obligatorio ? 'Debes cambiar tu contraseña' : 'Cambiar mi contraseña'),
          obligatorio ? h('p', { class: 'muted' }, 'Entraste con una clave temporal. Elige una propia de al menos 12 caracteres para seguir.') : null,
          h('label', { for: 'cc-actual' }, 'Contraseña actual'),
          actual,
          h('label', { for: 'cc-nueva' }, 'Contraseña nueva (mínimo 12 caracteres)'),
          nueva,
          h('label', { for: 'cc-repite' }, 'Repite la contraseña nueva'),
          repite,
          estado,
          h('div', { class: 'fila-botones' }, boton, obligatorio ? null : h('button', { class: 'btn sec', type: 'button', onclick: cerrar }, 'Cancelar')),
        ),
      );
      actual.focus();
    },
    { cerrable: !obligatorio },
  );
}

// ---- Pestaña Usuarios (admin). SSO: pre-registro por correo y baja. Cuentas locales (AUTH_LOCAL): clave temporal de un solo uso. ----
/** Panel de la pestaña Usuarios cuando el modo de acceso no permite crear cuentas (Basic sin AUTH_LOCAL, o acceso abierto). */
function usuariosSinCuentas(raiz) {
  const quien =
    YO.modo === 'none'
      ? 'El acceso está <b>abierto</b>: cualquiera que llegue al servicio entra como administrador.'
      : `Hoy se entra con el usuario y la clave únicos del administrador de emergencia (<b>${esc(YO.usuario)}</b>). Su clave no se cambia desde esta pantalla: vive en la configuración (<code>APP_PASS</code>, mejor como hash <code>scrypt$…</code>).`;
  raiz.innerHTML = `<h2>Usuarios</h2><div class="card" style="max-width:820px">
    <p><b>Las cuentas de usuario no están habilitadas en este modo de acceso.</b></p><p>${quien}</p>
    <p>Para tener varias personas con su rol (lector, solicitante o admin) hay dos caminos:</p>
    <ul>
      <li><b>Cuentas locales</b> (pruebas y POC): activa <code>AUTH_LOCAL=true</code> (Helm: <code>auth.local=true</code>) con Basic (<code>APP_USER</code> y <code>APP_PASS</code>) y reinicia.
        Aquí podrás crear cuentas con una clave temporal, desactivarlas, eliminarlas y restablecer su clave; cada persona cambia la suya al entrar y tiene su botón «Mi contraseña».</li>
      <li><b>SSO</b> (recomendado para uso real): configura OpenID Connect (Google Workspace, Entra, Okta…) y pre-registra aquí a las personas por correo.</li>
    </ul><p class="muted">Se cambia en la configuración del servicio (variables de entorno o los values de Helm), no desde la interfaz.</p></div>`;
}

async function renderUsuarios() {
  const raiz = $('usuarios');
  if (YO.modo !== 'oidc' && !YO.cuentas_locales) return usuariosSinCuentas(raiz);
  try {
    const usuarios = await get('/api/v1/usuarios');
    const local = YO.modo !== 'oidc'; // en modo SSO se pre-registra; en modo Basic con AUTH_LOCAL se crean cuentas locales
    const estado = h('div', { id: 'us-msg', 'aria-live': 'polite' });
    const recargar = () => renderUsuarios();

    const email = h('input', {
      id: 'us-email',
      required: true,
      maxlength: 120,
      placeholder: local ? 'nombre de usuario' : 'correo@empresa.cl',
      autocomplete: 'off',
    });
    const nombre = h('input', { id: 'us-nombre', maxlength: 120, placeholder: 'opcional' });
    const rol = h(
      'select',
      { id: 'us-rol' },
      ['lector', 'solicitante', 'admin'].map((r) => h('option', { value: r }, r)),
    );
    const boton = h('button', { class: 'btn', type: 'submit', id: 'us-crear' }, local ? 'Crear cuenta local' : 'Pre-registrar');
    const crear = async (e) => {
      e.preventDefault();
      boton.disabled = true;
      const r = await api('/api/v1/usuarios', { body: { email: email.value.trim(), nombre: nombre.value.trim(), rol: rol.value, local } });
      boton.disabled = false;
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      if (r.data.clave_temporal) mostrarClaveTemporal(r.data.email, r.data.clave_temporal, 'Cuenta creada');
      else RES_USUARIOS.aviso = `Pre-registrado ${r.data.email} como ${r.data.rol}: entrará con su proveedor de identidad con ese rol.`;
      recargar();
    };

    const accion = async (ruta, metodo, confirmacion, alTerminar) => {
      if (confirmacion && !(await confirmar({ titulo: 'Confirma la acción', mensaje: confirmacion, peligro: true }))) return;
      const r = await api(ruta, { method: metodo, body: {} });
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      if (alTerminar) alTerminar(r.data);
      recargar();
    };
    const boton2 = (texto, onclick, extra = {}) => h('button', { class: 'btn sec', type: 'button', onclick, ...extra }, texto);
    const ruta = (u) => '/api/v1/usuarios/' + encodeURIComponent(u.email);
    const filas = usuarios.map((u) => {
      const yoMismo = u.email === YO.usuario;
      return h(
        'tr',
        { class: u.activo ? '' : 'inactivo' },
        h('td', null, u.email),
        h('td', null, u.nombre || '—'),
        h('td', null, u.local ? 'Local' : 'SSO'),
        h(
          'td',
          null,
          h(
            'select',
            {
              'aria-label': 'Rol de ' + u.email,
              onchange: async (e) => {
                const r = await api(ruta(u), { method: 'PUT', body: { rol: e.target.value || null } });
                if (!r.ok) msg(estado, errorApi(r), 'error');
                recargar();
              },
            },
            u.local ? null : h('option', { value: '' }, 'Heredar'),
            ['lector', 'solicitante', 'admin'].map((r) => h('option', { value: r, selected: u.rol === r }, r)),
          ),
        ),
        h('td', null, u.activo ? 'Activo' : 'Desactivado', u.debe_cambiar_clave ? ' · clave temporal' : ''),
        h('td', null, fechaHora(u.ultimo_acceso)),
        h(
          'td',
          { class: 'acciones' },
          u.activo
            ? boton2(
                'Desactivar',
                () => accion(ruta(u) + '/desactivar', 'POST', `¿Desactivar a ${u.email}? No podrá entrar hasta que lo reactives (su historial se conserva).`),
                { disabled: yoMismo },
              )
            : boton2('Activar', () => accion(ruta(u) + '/activar', 'POST')),
          u.local
            ? boton2('Restablecer clave', () =>
                accion(ruta(u) + '/restablecer-clave', 'POST', `¿Restablecer la clave de ${u.email}? Se generará una clave temporal nueva.`, (d) =>
                  mostrarClaveTemporal(d.email, d.clave_temporal, 'Clave restablecida'),
                ),
              )
            : null,
          boton2('Eliminar', () => accion(ruta(u), 'DELETE', `¿Eliminar a ${u.email}? Para conservar su historial prefiere Desactivar.`), {
            disabled: yoMismo,
            class: 'btn peligro',
          }),
        ),
      );
    });
    if (RES_USUARIOS.aviso) {
      msg(estado, RES_USUARIOS.aviso, 'ok');
      RES_USUARIOS.aviso = null;
    }
    raiz.replaceChildren(
      h('h2', null, 'Usuarios'),
      h(
        'p',
        { class: 'muted' },
        local
          ? 'Cuentas locales con contraseña (modo de pruebas). La clave temporal se muestra una sola vez y la persona debe cambiarla al entrar. El administrador de emergencia (variables APP_USER y APP_PASS) siempre puede entrar. Para uso real, configura SSO.'
          : 'Las personas entran con tu proveedor de identidad (SSO). Aquí puedes pre-registrarlas con su rol antes de que entren, cambiarlo o darlas de baja; el cambio rige desde su próximo inicio de sesión. «Heredar» usa los grupos del proveedor.',
      ),
      h(
        'details',
        { class: 'card', style: 'margin:0 0 14px' },
        h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), local ? 'Nueva cuenta local' : 'Pre-registrar a una persona'),
        h(
          'form',
          { class: 'filtros', style: 'margin-top:12px', onsubmit: crear, 'aria-label': 'Nuevo usuario' },
          h('label', null, local ? 'Usuario' : 'Correo', email),
          h('label', null, 'Nombre', nombre),
          h('label', null, 'Rol', rol),
          boton,
        ),
      ),
      estado,
      h(
        'div',
        { class: 'card tablewrap' },
        h(
          'table',
          null,
          h(
            'tr',
            null,
            ['Usuario', 'Nombre', 'Tipo', 'Rol', 'Estado', 'Último acceso', ''].map((t) => h('th', null, t)),
          ),
          filas.length ? filas : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'Todavía no hay usuarios.')),
        ),
      ),
    );
  } catch (e) {
    fail('usuarios', e);
  }
}
const RES_USUARIOS = { aviso: null };
// ---- Pestaña Importar (admin): segmentos que ya existen (Excel/CSV). Primero se SIMULA (no escribe nada), luego se aplica. ----
const IMP = { archivo: null, sim: null, aprobadas: new Set(), filtro: '', defectos: { proveedor: '', ambiente: '', tipo: '' } };
const ESTADO_IMP = {
  ok: ['imp-ok', 'Listo para importar'],
  ya_existe: ['imp-omitida', 'Ya registrado (se omite)'],
  solapa_otro_pool: ['imp-aviso', 'Solapa con otro pool: requiere aprobación'],
  choca_mismo_pool: ['imp-error', 'Choca dentro del mismo pool'],
  invalida: ['imp-error', 'Inválida'],
};
const aBase64 = (buf) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const cuerpoImportacion = () => ({ ...IMP.archivo, ...Object.fromEntries(Object.entries(IMP.defectos).filter(([, v]) => v)) });

async function renderImportar() {
  const raiz = $('importar');
  const estado = h('div', { id: 'imp-msg', 'aria-live': 'polite' });
  const archivo = h('input', { id: 'imp-archivo', type: 'file', accept: '.xlsx,.csv,text/csv' });
  const proveedor = h('input', { id: 'imp-prov', list: 'imp-provs', maxlength: 40, placeholder: 'p. ej. GCP u On-prem', value: IMP.defectos.proveedor });
  const provs = h(
    'datalist',
    { id: 'imp-provs' },
    ['GCP', 'On-prem', 'AWS', 'Azure'].map((v) => h('option', { value: v })),
  );
  const ambiente = h(
    'select',
    { id: 'imp-amb' },
    [['', '(el archivo lo trae)'], ...['dev', 'qa', 'pre', 'prod'].map((v) => [v, v])].map(([v, t]) =>
      h('option', { value: v, selected: IMP.defectos.ambiente === v }, t),
    ),
  );
  const boton = h('button', { class: 'btn', type: 'submit', id: 'imp-simular' }, 'Simular importación');
  const simular = async (e) => {
    e.preventDefault();
    const f = archivo.files[0];
    if (!f) return msg(estado, 'Elige un archivo .xlsx o .csv.', 'error');
    const formato = /\.csv$/i.test(f.name) ? 'csv' : 'xlsx';
    boton.disabled = true;
    IMP.archivo = { nombre: f.name, formato, contenido_base64: aBase64(await f.arrayBuffer()) };
    IMP.defectos = { proveedor: proveedor.value.trim(), ambiente: ambiente.value, tipo: '' };
    const r = await api('/api/v1/importaciones/simular', { body: cuerpoImportacion() });
    boton.disabled = false;
    if (!r.ok) {
      IMP.sim = null;
      return msg(estado, errorApi(r), 'error');
    }
    IMP.sim = r.data;
    IMP.aprobadas = new Set();
    IMP.filtro = '';
    renderImportar();
  };

  const partes = [
    h('p', null, h('button', { type: 'button', class: 'btn sec', id: 'imp-volver', onclick: () => show('pools') }, ico('volver'), 'Volver a Pools')),
    h('h2', null, 'Importar segmentos que ya existen'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Sube un Excel (.xlsx) o un CSV con los segmentos que ya están en uso (on-premise, GCP, otras nubes). Primero se ',
      h('b', null, 'simula'),
      ': no se escribe nada hasta que confirmes. Si no hay pools que los contengan, el IPAM crea uno por proveedor, ambiente y familia de red. Los segmentos que se ',
      h('b', null, 'solapan con otro pool'),
      ' los apruebas o rechazas tú; los que chocan dentro del mismo pool no se pueden importar. Columnas reconocidas: ',
      h('code', null, 'cidr, proyecto, proveedor, ambiente, tipo, ticket, descripcion, vlan, nombre vlan'),
      ' (solo el CIDR es obligatorio). ',
      h('a', { href: '/plantilla-importacion.csv', download: '' }, 'Descargar plantilla de ejemplo'),
      '.',
    ),
    h(
      'form',
      { class: 'filtros card', style: 'margin:0 0 14px;padding:14px', onsubmit: simular, 'aria-label': 'Importar segmentos' },
      h('label', { style: 'min-width:260px' }, 'Archivo', archivo),
      h('label', null, 'Proveedor por defecto', proveedor, provs),
      h('label', null, 'Ambiente por defecto', ambiente),
      boton,
    ),
    estado,
  ];
  if (IMP.sim) partes.push(...resultadoSimulacion(estado));
  raiz.replaceChildren(...partes);
}

function resultadoSimulacion(estado) {
  const sim = IMP.sim;
  const r = sim.resumen;
  const aplicables = r.ok + IMP.aprobadas.size;
  const chip = (clave) => h('span', { class: 'tag ' + ESTADO_IMP[clave][0], style: 'margin-right:8px' }, `${r[clave]} · ${ESTADO_IMP[clave][1]}`);
  const filas = sim.filas.filter((f) => !IMP.filtro || f.estado === IMP.filtro);
  const aplicar = async () => {
    const resumen = `${aplicables} segmento${aplicables === 1 ? '' : 's'}${sim.pools_a_crear.length ? ` y crear ${sim.pools_a_crear.length} pool${sim.pools_a_crear.length === 1 ? '' : 's'}` : ''}`;
    if (!(await confirmar({ titulo: 'Importar segmentos', mensaje: `¿Importar ${resumen}? Queda registrado a tu nombre.`, confirmar: 'Importar' }))) return;
    const res = await api('/api/v1/importaciones/aplicar', { body: { ...cuerpoImportacion(), aprobar: [...IMP.aprobadas] } });
    if (!res.ok) return msg(estado, errorApi(res), 'error');
    const d = res.data;
    IMP.sim = null;
    IMP.aprobadas = new Set();
    await renderImportar();
    msg(
      $('imp-msg'),
      `Importados ${d.importadas} segmento${d.importadas === 1 ? '' : 's'}; pools creados: ${d.pools_creados}; omitidos por ya existir: ${d.omitidas}; rechazados por solapamiento: ${d.rechazadas_por_solapamiento}; no importables: ${d.no_importables}. Míralos en Pools y Asignaciones.`,
      'ok',
    );
  };
  const casilla = (f) =>
    f.estado === 'solapa_otro_pool'
      ? h('input', {
          type: 'checkbox',
          'aria-label': `Aprobar la fila ${f.n}`,
          checked: IMP.aprobadas.has(f.n),
          onchange: (e) => {
            if (e.target.checked) IMP.aprobadas.add(f.n);
            else IMP.aprobadas.delete(f.n);
            renderImportar();
          },
        })
      : null;
  return [
    h('h3', null, `Resultado de la simulación (${sim.total} filas)`),
    h('p', null, ['ok', 'solapa_otro_pool', 'ya_existe', 'choca_mismo_pool', 'invalida'].filter((k) => r[k]).map(chip)),
    sim.pools_a_crear.length
      ? h('p', { class: 'muted' }, 'Se crearán estos pools: ', sim.pools_a_crear.map((p) => `${p.id} (${p.cidr})`).join(', '), '.')
      : null,
    h(
      'form',
      { class: 'filtros', onsubmit: (e) => e.preventDefault(), 'aria-label': 'Filtrar el resultado' },
      h(
        'label',
        null,
        'Mostrar',
        h(
          'select',
          {
            id: 'imp-filtro',
            onchange: (e) => {
              IMP.filtro = e.target.value;
              renderImportar();
            },
          },
          [['', 'Todas'], ...Object.entries(ESTADO_IMP).map(([k, v]) => [k, v[1]])].map(([v, t]) => h('option', { value: v, selected: IMP.filtro === v }, t)),
        ),
      ),
      r.solapa_otro_pool
        ? h(
            'button',
            {
              class: 'btn sec',
              type: 'button',
              onclick: () => {
                sim.filas.filter((f) => f.estado === 'solapa_otro_pool').forEach((f) => IMP.aprobadas.add(f.n));
                renderImportar();
              },
            },
            'Aprobar todos los solapamientos',
          )
        : null,
      r.solapa_otro_pool
        ? h(
            'button',
            {
              class: 'btn sec',
              type: 'button',
              onclick: () => {
                IMP.aprobadas = new Set();
                renderImportar();
              },
            },
            'Rechazar todos',
          )
        : null,
      h(
        'button',
        { class: 'btn', type: 'button', id: 'imp-aplicar', disabled: aplicables === 0, onclick: aplicar },
        `Importar ${aplicables} segmento${aplicables === 1 ? '' : 's'}`,
      ),
    ),
    h(
      'div',
      { class: 'card tablewrap' },
      h(
        'table',
        { 'aria-label': 'Filas de la importación' },
        h(
          'tr',
          null,
          ['Aprobar', 'Fila', 'Segmento', 'Proyecto', 'Proveedor', 'Ambiente', 'Pool', 'Estado', 'Detalle'].map((t) => h('th', null, t)),
        ),
        filas.map((f) =>
          h(
            'tr',
            null,
            h('td', null, casilla(f)),
            h('td', null, String(f.n)),
            h('td', null, h('code', null, f.cidr)),
            h('td', null, f.vpc || '—'),
            h('td', null, f.proveedor || '—'),
            h('td', null, f.ambiente || '—'),
            h('td', null, f.pool || '—'),
            h('td', null, h('span', { class: 'tag ' + ESTADO_IMP[f.estado][0] }, ESTADO_IMP[f.estado][1])),
            h('td', { class: 'muted' }, f.detalle),
          ),
        ),
      ),
    ),
  ];
}

/* ===== Ayudante para construir DOM sin innerHTML: todo texto entra como nodo de texto (nada de lo que escriba un usuario se interpreta como HTML) ===== */
const h = (tag, attrs, ...hijos) => {
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
const fechaHora = (s) => (s ? new Date(s).toLocaleString('es-CL') : '—');
const msg = (el, texto, tipo) => {
  el.replaceChildren(
    texto ? h('div', { class: tipo === 'ok' ? 'ok' : 'alert', role: tipo === 'ok' ? 'status' : 'alert' }, ico(tipo === 'ok' ? 'ok' : 'error'), ' ', texto) : '',
  );
};
const errorApi = (r) => (r.data && (r.data.mensaje || r.data.error)) || 'Error ' + r.status;

/** Aviso breve (reemplaza a alert()): desaparece solo (los errores tardan más) y se puede cerrar. Los errores usan role="alert". */
function toast(texto, tipo = 'ok') {
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
function vincularCidr(input, boton, cidrDePool = () => undefined, { soloBase = false } = {}) {
  const aviso = h('p', { class: 'campo-msg', id: input.id + '-msg', 'aria-live': 'polite' });
  input.setAttribute('aria-describedby', aviso.id);
  const revisar = () => {
    if (!aviso.isConnected && input.parentNode) input.after(aviso); // el campo se crea antes de entrar a la página: se inserta al primer uso
    let v = validarCidr(input.value, cidrDePool());
    const len = Number(input.value.split('/')[1]);
    if (soloBase && v.estado === 'ok' && (len < 8 || len > 30)) v = { estado: 'error', mensaje: 'Un bloque base va de /8 a /30.' };
    aviso.className = 'campo-msg' + (v.estado === 'error' ? ' campo-error' : v.estado === 'ok' ? ' campo-ok' : '');
    aviso.replaceChildren(...(v.estado === 'vacio' ? [] : [ico(v.estado === 'error' ? 'error' : 'ok'), ' ' + v.mensaje]));
    if (v.estado === 'error') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    boton.disabled = v.estado === 'error';
  };
  input.addEventListener('input', revisar);
  return revisar; // para volver a revisar cuando cambia el pool elegido
}

/**
 * Diálogo de confirmación accesible (reemplaza a confirm() y prompt()): usa <dialog> con showModal(), así el foco queda atrapado,
 * Esc cancela y el foco vuelve a quien lo abrió. Con `peligro` el foco inicial va a «Cancelar». Con `campo` pide un texto
 * (obligatorio si se indica). Devuelve { aceptado, valor }.
 */
function dialogoSimple({ titulo, mensaje, confirmar: textoOk = 'Aceptar', cancelar: textoNo = 'Cancelar', peligro = false, campo = null }) {
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
const confirmar = async (opciones) => (await dialogoSimple(opciones)).aceptado;
function tabla(titulo, cabeceras, filas, vacio) {
  if (!filas.length) return h('div', { class: 'card vacio' }, vacio);
  return h(
    'div',
    { class: 'card tablewrap' },
    h(
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
    ),
  );
}

/* ===== Reservas (todos los roles; opera según permisos: dueño o admin) ===== */
// Disponibilidad del pool elegido, por máscara: direcciones por bloque, utilizables y cuántos bloques libres quedan.
// Rehace el selector de máscara con SOLO las que caben en el pool («/24 · 15 libres»; las agotadas, deshabilitadas). Un clic en una fila elige esa máscara.
async function cargarDisponibilidad(contenedor, poolId, selectMascara) {
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

// Formulario «Nueva reserva» (solicitante y admin): aparta un rango por un tiempo; un admin debe aprobarla para que sea asignación.
function formularioNuevaReserva(pools, estado, recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const { pool, mascara, disp } = selectorPoolMascara('nr', pools);
  const vpc = h('input', { id: 'nr-vpc', required: true, maxlength: 120, placeholder: 'vpc-mi-proyecto' });
  const ticket = h('input', { id: 'nr-ticket', maxlength: 60, placeholder: 'opcional (si no, se genera NET-xxx)' });
  const cidr = h('input', { id: 'nr-cidr', placeholder: 'opcional: vacío = el primer rango libre' });
  const vl = camposVlan('nr');
  const ttl = h('input', { id: 'nr-ttl', type: 'number', min: 1, max: 72, value: 24 });
  const boton = h('button', { class: 'btn', type: 'submit', id: 'nr-go' }, 'Reservar');
  const revisarCidr = vincularCidr(cidr, boton, () => (pools.find((x) => x.id === pool.value) || {}).cidr);
  pool.addEventListener('change', revisarCidr);
  const enviar = async (e) => {
    e.preventDefault();
    if (!pool.value) return msg(estado, 'Elige un pool.', 'error');
    if (!cidr.value.trim() && !mascara.value) return msg(estado, 'Elige una máscara o escribe un CIDR.', 'error');
    boton.disabled = true;
    const cuerpo = { pool: pool.value, vpc: vpc.value.trim(), ttl_horas: +ttl.value || 24, ...cuerpoVlan(vl) };
    if (cidr.value.trim()) cuerpo.cidr = cidr.value.trim();
    else cuerpo.mascara = +mascara.value;
    if (ticket.value.trim()) cuerpo.ticket = ticket.value.trim();
    const r = await api('/api/v1/reservas', { body: cuerpo, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    boton.disabled = false;
    if (!r.ok) return msg(estado, errorApi(r) + (r.data && r.data.sugeridos ? ' Libres sugeridos: ' + r.data.sugeridos.join(', ') : ''), 'error');
    RES.aviso = {
      texto: `Reservado ${r.data.cidr} en ${r.data.pool_id} por ${ttl.value || 24} h. Falta la aprobación de un admin para que sea asignación; si no se aprueba, expira sola.`,
      tipo: 'ok',
    };
    recargar();
  };
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 14px' },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Nueva reserva'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Nueva reserva', onsubmit: enviar },
      campo('Pool', pool),
      campo('Proyecto / VPC', vpc),
      campo('Máscara', mascara),
      campo('CIDR manual', cidr),
      campo('VLAN (opcional)', vl.vlan),
      campo('Nombre VLAN / subred (opcional)', vl.vlanNombre),
      campo('Ticket', ticket),
      campo('Vigencia (horas, máx. 72)', ttl),
      boton,
      disp,
    ),
  );
}

/* ===== Pools: alta (admin) ===== */
const PROVEEDORES = ['GCP', 'On-prem', 'AWS', 'Azure'];
function formularioNuevoPool(recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const id = h('input', { id: 'np-id', required: true, maxlength: 63, placeholder: 'lan-sucursal-prod', pattern: '[a-z0-9][a-z0-9\\-]{1,62}' });
  const tipo = h('input', { id: 'np-tipo', required: true, maxlength: 40, placeholder: 'Nodos, Pods, LAN, Gestión…' });
  const ambiente = h(
    'select',
    { id: 'np-ambiente', required: true },
    h('option', { value: '' }, 'Elige…'),
    ['dev', 'qa', 'pre', 'prod'].map((v) => h('option', { value: v }, v)),
  );
  const proveedor = h('input', { id: 'np-proveedor', required: true, maxlength: 40, list: 'np-provs', placeholder: 'GCP, On-prem…' });
  const provs = h(
    'datalist',
    { id: 'np-provs' },
    PROVEEDORES.map((v) => h('option', { value: v })),
  );
  const cidr = h('input', { id: 'np-cidr', required: true, placeholder: '10.40.0.0/16' });
  const estado = h('div', { id: 'np-msg', 'aria-live': 'polite', style: 'flex:1 1 100%' });
  const boton = h('button', { class: 'btn', type: 'submit', id: 'np-go' }, 'Crear pool');
  vincularCidr(cidr, boton, () => undefined, { soloBase: true });
  const enviar = async (e) => {
    e.preventDefault();
    boton.disabled = true;
    const r = await api('/api/v1/pools', {
      body: { id: id.value.trim(), tipo: tipo.value.trim(), ambiente: ambiente.value, proveedor: proveedor.value.trim(), cidr: cidr.value.trim() },
    });
    boton.disabled = false;
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    POOLS_AVISO = `Pool ${r.data.id} (${r.data.cidr}) creado.`;
    recargar();
  };
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 14px' },
    h('summary', { class: 'btn', style: 'display:inline-block;cursor:pointer' }, ico('mas'), 'Nuevo pool'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Crea un bloque base en el ambiente que corresponda (dev, qa, pre o prod). CIDR alineado de /8 a /30. No puede solaparse con otro pool del mismo proveedor y ambiente; en otro ambiente o proveedor el mismo rango sí se permite.',
    ),
    h(
      'form',
      { class: 'filtros', 'aria-label': 'Nuevo pool', onsubmit: enviar },
      campo('Nombre del pool', id),
      campo('Tipo', tipo),
      campo('Ambiente', ambiente),
      campo('Proveedor', proveedor),
      provs,
      campo('CIDR', cidr),
      boton,
      estado,
    ),
  );
}
let POOLS_AVISO = null;

/** Acciones de admin en la ficha del pool: editar tipo y proveedor, o eliminarlo si está vacío. */
function accionesPool(p, cerrar) {
  const estado = h('div', { 'aria-live': 'polite' });
  const tipo = h('input', { id: 'ep-tipo', maxlength: 40, value: p.tipo });
  const proveedor = h('input', { id: 'ep-proveedor', maxlength: 40, value: p.proveedor, list: 'np-provs-ficha' });
  const guardar = async (e) => {
    e.preventDefault();
    const r = await api('/api/v1/pools/' + encodeURIComponent(p.id), { method: 'PATCH', body: { tipo: tipo.value.trim(), proveedor: proveedor.value.trim() } });
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    cerrar();
    show(VISTA);
    fichaPool(p.id);
  };
  const eliminar = async () => {
    const seguro = await confirmar({
      titulo: `¿Eliminar el pool ${p.id}?`,
      mensaje: `${p.cidr}. Solo se puede si no tiene segmentos, reservas vigentes ni IPs.`,
      confirmar: 'Eliminar pool',
      peligro: true,
    });
    if (!seguro) return;
    const r = await api('/api/v1/pools/' + encodeURIComponent(p.id), { method: 'DELETE' });
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    POOLS_AVISO = `Pool ${p.id} eliminado.`;
    cerrar();
    show('pools');
  };
  return h(
    'details',
    { class: 'acciones-ficha' },
    h('summary', null, 'Editar o eliminar este pool'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:10px', 'aria-label': 'Editar pool', onsubmit: guardar },
      h('label', null, 'Tipo', tipo),
      h('label', null, 'Proveedor', proveedor),
      h(
        'datalist',
        { id: 'np-provs-ficha' },
        PROVEEDORES.map((v) => h('option', { value: v })),
      ),
      h('button', { class: 'btn', type: 'submit' }, 'Guardar'),
      h('button', { class: 'btn peligro', type: 'button', onclick: eliminar }, 'Eliminar pool'),
    ),
    h('p', { class: 'muted' }, 'El CIDR y el ambiente no se editan: dejarían segmentos fuera de su pool.'),
    estado,
  );
}

/* ===== Direcciones IP fijas (interfaces de router, switch, firewall…) ===== */
const ROLES_IP = [
  ['interfaz', 'Interfaz'],
  ['gateway', 'Gateway'],
  ['gestion', 'Gestión'],
  ['loopback', 'Loopback'],
  ['vip', 'VIP / HSRP'],
  ['servidor', 'Servidor'],
  ['otro', 'Otro'],
];
const nombreRol = (r) => (ROLES_IP.find(([v]) => v === r) || [r, r])[1];
const selectorRol = (id, valor) =>
  h(
    'select',
    { id },
    ROLES_IP.map(([v, t]) => h('option', { value: v, selected: v === (valor || 'interfaz') }, t)),
  );
const camposIp = (pre, d = {}) => ({
  dispositivo: h('input', { id: pre + '-dispositivo', maxlength: 80, placeholder: 'rtr-core-01', value: d.dispositivo || '' }),
  interfaz: h('input', { id: pre + '-interfaz', maxlength: 80, placeholder: 'Gi0/1', value: d.interfaz || '' }),
  rol: selectorRol(pre + '-rol', d.rol),
  dns: h('input', { id: pre + '-dns', maxlength: 253, placeholder: 'gw.sitio.interno', value: d.dns || '' }),
  descripcion: h('input', { id: pre + '-descripcion', maxlength: 200, value: d.descripcion || '' }),
  excepcion: h('input', { id: pre + '-excepcion', maxlength: 200, placeholder: 'solo si está fuera de un segmento', value: d.excepcion || '' }),
});
const valoresIp = (c) => Object.fromEntries(Object.entries(c).map(([k, el]) => [k, el.value.trim()]));

/**
 * Formulario para registrar una IP fija. `pool` fijo (fichas) o elegible (pestaña Direcciones IP).
 * @param {{prefijo: string, pool?: string, pools?: any[], alGuardar: Function}} o
 */
function formularioDireccion({ prefijo, pool, pools, alGuardar }) {
  const ip = h('input', { id: prefijo + '-ip', required: true, placeholder: '10.20.0.1' });
  const c = camposIp(prefijo);
  const selPool = pools
    ? h(
        'select',
        { id: prefijo + '-pool' },
        h('option', { value: '' }, 'Automático'),
        pools.map((p) => h('option', { value: p.id }, `${p.id} · ${p.cidr}`)),
      )
    : null;
  const estado = h('div', { id: prefijo + '-msg', 'aria-live': 'polite', style: 'flex:1 1 100%' });
  const boton = h('button', { class: 'btn', type: 'submit', id: prefijo + '-go' }, 'Registrar IP');
  const enviar = async (e) => {
    e.preventDefault();
    const v = valoresIp(c);
    const cuerpo = Object.fromEntries(Object.entries({ ip: ip.value.trim(), ...v }).filter(([, x]) => x));
    const elegido = pool || (selPool && selPool.value);
    if (elegido) cuerpo.pool = elegido;
    boton.disabled = true;
    const r = await api('/api/v1/direcciones', { body: cuerpo });
    boton.disabled = false;
    if (!r.ok) {
      const ops = r.data && r.data.opciones ? ' Opciones: ' + r.data.opciones.map((o) => o.pool + (o.segmento ? ` (${o.segmento})` : '')).join(', ') : '';
      return msg(estado, errorApi(r) + ops, 'error');
    }
    const d = r.data;
    alGuardar(`${d.ip} registrada${d.segmento ? ` en ${d.segmento_codigo || d.segmento}` : ' como excepción'}.${d.aviso ? ' Atención: ' + d.aviso : ''}`);
  };
  const campo = (t, el) => h('label', null, t, el);
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 12px' },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Registrar IP fija'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:10px', 'aria-label': 'Registrar IP fija', onsubmit: enviar },
      campo('IP', ip),
      selPool ? campo('Pool (solo si la IP existe en varios)', selPool) : null,
      campo('Dispositivo', c.dispositivo),
      campo('Interfaz', c.interfaz),
      campo('Rol', c.rol),
      campo('DNS', c.dns),
      campo('Descripción', c.descripcion),
      campo('Excepción (motivo)', c.excepcion),
      boton,
      estado,
    ),
    h('p', { class: 'muted' }, 'La IP se ubica sola en su segmento asignado. Si está fuera de todo segmento, indica el motivo de la excepción.'),
  );
}

/** Edita los datos de una IP (no la IP misma). */
function editarDireccion(d, recargar) {
  abrirDialogo((dlg, cerrar) => {
    const c = camposIp('ed', d);
    const estado = h('div', { 'aria-live': 'polite' });
    const guardar = async (e) => {
      e.preventDefault();
      const v = valoresIp(c);
      const cuerpo = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null]));
      cuerpo.rol = v.rol;
      const r = await api('/api/v1/direcciones/' + d.id, { method: 'PATCH', body: cuerpo });
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      cerrar();
      recargar();
    };
    const campo = (t, el) => h('label', null, t, el);
    dlg.append(
      h('h3', null, `Editar ${d.ip}`),
      h(
        'form',
        { onsubmit: guardar, 'aria-label': 'Editar IP' },
        campo('Dispositivo', c.dispositivo),
        campo('Interfaz', c.interfaz),
        campo('Rol', c.rol),
        campo('DNS', c.dns),
        campo('Descripción', c.descripcion),
        d.asignacion_id ? null : campo('Excepción (motivo, obligatorio)', c.excepcion),
        estado,
        h(
          'div',
          { class: 'fila-botones' },
          h('button', { type: 'button', class: 'btn sec', onclick: cerrar }, 'Cancelar'),
          h('button', { type: 'submit', class: 'btn' }, 'Guardar'),
        ),
      ),
    );
  });
}

/** Tabla de IPs fijas. `conSegmento` agrega la columna del segmento o la excepción. */
function tablaDirecciones(lista, recargar, { conSegmento = true } = {}) {
  const eliminar = async (d) => {
    const que = `${d.ip}${d.dispositivo ? ` (${d.dispositivo} ${d.interfaz || ''})` : ''}`;
    if (!(await confirmar({ titulo: `¿Eliminar ${d.ip}?`, mensaje: `Se borra la IP fija ${que}.`, confirmar: 'Eliminar', peligro: true }))) return;
    const r = await api('/api/v1/direcciones/' + d.id, { method: 'DELETE' });
    if (r.ok) toast(`IP ${d.ip} eliminada.`);
    else toast(errorApi(r), 'error');
    recargar();
  };
  return tabla(
    'Direcciones IP fijas',
    ['IP', 'Dispositivo', 'Interfaz', 'Rol', 'DNS', 'Descripción', ...(conSegmento ? ['Segmento / excepción'] : []), 'Acciones'],
    lista.map((d) =>
      h(
        'tr',
        null,
        h('td', null, h('code', null, d.ip)),
        h('td', null, d.dispositivo || '—'),
        h('td', null, d.interfaz || '—'),
        h('td', null, nombreRol(d.rol)),
        h('td', null, d.dns || '—'),
        h('td', null, d.descripcion || '—'),
        conSegmento
          ? h(
              'td',
              null,
              d.asignacion_id
                ? h('button', { type: 'button', class: 'enlace', onclick: () => fichaAsignacion(d.asignacion_id) }, d.segmento_codigo || d.segmento)
                : h('span', { class: 'tag imp-aviso', title: d.excepcion || '' }, 'Excepción: ' + (d.excepcion || '')),
            )
          : null,
        h(
          'td',
          null,
          h(
            'div',
            { class: 'acciones' },
            puede('agente') && h('button', { type: 'button', class: 'btn sec', onclick: () => editarDireccion(d, recargar) }, 'Editar'),
            puede('admin') && h('button', { type: 'button', class: 'btn peligro', onclick: () => eliminar(d) }, 'Eliminar'),
          ),
        ),
      ),
    ),
    'Todavía no hay IPs fijas registradas aquí.',
  );
}

/** Contenido de la pestaña «Direcciones IP» de una ficha (pool o segmento). */
async function panelDirecciones({ filtro, pool, resumen }) {
  const cont = h('div');
  const estado = h('div', { 'aria-live': 'polite' });
  const cargar = async (aviso) => {
    const lista = await get('/api/v1/direcciones?' + new URLSearchParams(filtro));
    cont.replaceChildren(
      resumen ? h('p', { class: 'muted' }, resumen(lista)) : '',
      estado,
      puede('agente') ? formularioDireccion({ prefijo: 'fi', pool, alGuardar: cargar }) : '',
      tablaDirecciones(lista, () => cargar(), { conSegmento: !filtro.asignacion }),
    );
    msg(estado, aviso || '', 'ok');
  };
  await cargar();
  return cont;
}

/* ===== Pestaña «Direcciones IP»: todas, con buscador ===== */
const IPS = { q: '', aviso: null };
async function renderIps() {
  const raiz = $('ips');
  try {
    const [lista, pools] = await Promise.all([get('/api/v1/direcciones?' + new URLSearchParams(IPS.q ? { q: IPS.q } : {})), get('/api/v1/pools')]);
    const estado = h('div', { id: 'ips-msg', 'aria-live': 'polite' });
    const buscador = h('input', {
      id: 'ips-buscar',
      type: 'search',
      value: IPS.q,
      placeholder: 'IP, equipo, interfaz, DNS…',
      oninput: (e) => {
        IPS.q = e.target.value;
        clearTimeout(IPS.deb);
        IPS.deb = setTimeout(async () => {
          await renderIps();
          const el = $('ips-buscar');
          el.focus();
          el.setSelectionRange(IPS.q.length, IPS.q.length);
        }, 250);
      },
    });
    raiz.replaceChildren(
      h('h2', null, 'Direcciones IP fijas'),
      h(
        'p',
        { class: 'muted', style: 'max-width:760px' },
        'IPs de interfaces de routers, switches y firewalls, gateways, VIP, gestión… Normalmente dentro de un segmento asignado; si no, como excepción con su motivo. Busca por IP, equipo o interfaz para saber qué IP tiene cada interfaz.',
      ),
      estado,
      puede('agente')
        ? formularioDireccion({
            prefijo: 'ni',
            pools,
            alGuardar: (aviso) => {
              IPS.aviso = aviso;
              renderIps();
            },
          })
        : '',
      h(
        'form',
        { class: 'filtros', role: 'search', 'aria-label': 'Buscar direcciones IP', onsubmit: (e) => e.preventDefault() },
        h('label', null, 'Buscar', buscador),
      ),
      tablaDirecciones(lista, renderIps),
    );
    if (IPS.aviso) {
      msg(estado, IPS.aviso, 'ok');
      IPS.aviso = null;
    }
  } catch (e) {
    fail('ips', e);
  }
}

/* ===== Ficha de detalle (panel lateral, al estilo de NetBox): un pool o un segmento, con su historial ===== */
const ip2n = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const n2ip = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
function rango(cidr) {
  const [ip, l] = String(cidr).split('/');
  const len = Number(l);
  const total = 2 ** (32 - len);
  const ini = Math.floor(ip2n(ip) / total) * total;
  return { primera: n2ip(ini), ultima: n2ip(ini + total - 1), total, utilizables: len >= 31 ? total : total - 2, len };
}
const datos = (pares) =>
  h(
    'dl',
    { class: 'datos' },
    pares.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v)]),
  );
const ACCIONES = {
  asignar: 'asignó',
  liberar: 'liberó',
  reservar: 'reservó',
  confirmar_reserva: 'aprobó la reserva de',
  liberar_reserva: 'liberó la reserva de',
  jira_reserva_creada: 'Jira reservó',
  jira_reserva_aprobada: 'Jira registró la aprobación de',
  registrar_ip: 'registró la IP',
  editar_ip: 'editó la IP',
  eliminar_ip: 'eliminó la IP',
  crear_pool: 'creó el pool',
  editar_pool: 'editó el pool',
  eliminar_pool: 'eliminó el pool',
};
const describir = (d = {}) =>
  [
    d.ip || d.cidr,
    d.ip && d.cidr && `en ${d.cidr}`,
    (d.dispositivo || d.interfaz) && [d.dispositivo, d.interfaz].filter(Boolean).join(' '),
    d.excepcion && `excepción: «${d.excepcion}»`,
    d.tipo && d.proveedor && `${d.tipo} · ${d.proveedor}`,
    d.vpc && `para ${d.vpc}`,
    d.vlan && `VLAN ${d.vlan}`,
    d.ticket && `ticket ${d.ticket}`,
    d.motivo && `motivo: «${d.motivo}»`,
  ]
    .filter(Boolean)
    .join(' · ');

/** Historial de un pool o de un segmento (solo admin: sale de la bitácora de auditoría). */
async function historial(filtro) {
  const filas = await get('/api/v1/auditoria?' + new URLSearchParams(filtro));
  if (!filas.length)
    return h('p', { class: 'muted' }, 'Sin acciones registradas. Los segmentos importados o de la semilla muestran su origen y fecha en Detalle.');
  return h(
    'ol',
    { class: 'historial', 'aria-label': 'Historial' },
    filas.map((f) =>
      h(
        'li',
        null,
        h('time', { datetime: f.ts }, fechaHora(f.ts)),
        ' · ',
        h('b', null, f.usuario),
        ` ${ACCIONES[f.accion] || f.accion} `,
        describir(f.detalle),
      ),
    ),
  );
}

/** Abre el panel lateral con pestañas. Cada pestaña se construye al elegirla: construir(cerrar) → Node. */
function abrirPanel(titulo, subtitulo, pestanas) {
  abrirDialogo((dlg, cerrar) => {
    dlg.classList.add('ficha');
    dlg.setAttribute('aria-labelledby', 'ficha-titulo');
    const cuerpo = h('div', { class: 'ficha-cuerpo', role: 'tabpanel', id: 'ficha-panel' });
    const botones = pestanas.map((p, i) =>
      h('button', { type: 'button', role: 'tab', id: 'ficha-tab-' + i, 'aria-controls': 'ficha-panel', onclick: () => elegir(i) }, p.nombre),
    );
    const elegir = async (i) => {
      botones.forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      cuerpo.setAttribute('aria-labelledby', 'ficha-tab-' + i);
      cuerpo.replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
      try {
        cuerpo.replaceChildren(await pestanas[i].construir(cerrar));
      } catch (e) {
        cuerpo.replaceChildren(h('div', { class: 'alert' }, 'No se pudo cargar: ' + e.message));
      }
    };
    dlg.append(
      h(
        'div',
        { class: 'ficha-cab' },
        h('div', null, h('h2', { id: 'ficha-titulo' }, titulo), h('p', { class: 'muted' }, subtitulo)),
        h('button', { type: 'button', class: 'btn sec', onclick: cerrar }, 'Cerrar'),
      ),
      h('div', { class: 'ficha-tabs', role: 'tablist', 'aria-label': 'Secciones de la ficha' }, botones),
      cuerpo,
    );
    elegir(0);
  });
}

/**
 * Mapa de bloques de un pool: hasta 256 cuadros iguales; lleno = ocupado (asignado o reservado), rayado = parcial, vacío = libre.
 * No depende solo del color y su detalle está también en la pestaña «Segmentos» (el mapa se explora con el cursor).
 */
const TEXTO_BLOQUE = { libre: 'libre', parcial: 'parcialmente ocupado', ocupado: 'ocupado' };
function mapaDelPool(p, ocupantes) {
  const { granularidad, bloques, resumen } = mapaBloques(p.cidr, ocupantes);
  if (!bloques.length) return null;
  const linea = h('p', { class: 'mapa-detalle', 'aria-live': 'polite' }, '\u00a0');
  const celdas = bloques.map((b) => {
    const quien = b.asignaciones.map((a) => `${a.vpc} (${a.cidr}${a.reserva ? ', reserva' : a.ticket ? ', ' + a.ticket : ''})`).join('; ');
    const texto = `${b.cidr} · ${TEXTO_BLOQUE[b.estado]}${quien ? ' · ' + quien : ''}`;
    return h('div', { class: `bloque bloque-${b.estado}`, title: texto, onmouseenter: () => (linea.textContent = texto) });
  });
  const tam = 2 ** (32 - granularidad);
  return h(
    'div',
    null,
    h('h3', null, 'Mapa del espacio'),
    h(
      'p',
      { class: 'muted' },
      `Cada cuadro es un bloque /${granularidad} (${fmt(tam)} ${tam === 1 ? 'dirección' : 'direcciones'}). Pasa el cursor para ver quién lo usa; la pestaña «Segmentos» tiene el mismo detalle.`,
    ),
    h(
      'div',
      {
        class: 'mapa',
        style: `--cols:${Math.min(16, bloques.length)}`,
        role: 'img',
        'aria-label': `Mapa de ${p.id}: ${bloques.length} bloques /${granularidad}: ${resumen.libre} libres, ${resumen.parcial} parciales, ${resumen.ocupado} ocupados`,
        onmouseleave: () => (linea.textContent = '\u00a0'),
      },
      celdas,
    ),
    linea,
    h(
      'ul',
      { class: 'leyenda-mapa' },
      h('li', null, h('span', { class: 'bloque bloque-libre' }), ` Libre (${resumen.libre})`),
      h('li', null, h('span', { class: 'bloque bloque-parcial' }), ` Parcial (${resumen.parcial})`),
      h('li', null, h('span', { class: 'bloque bloque-ocupado' }), ` Ocupado (${resumen.ocupado})`),
    ),
  );
}

async function fichaPool(id) {
  const pools = await get('/api/v1/pools');
  const p = pools.find((x) => x.id === id);
  if (!p) return toast('Ese pool ya no existe.', 'error');
  const r = rango(p.cidr);
  const res = p.uso_reservado || 0;
  abrirPanel(
    p.cidr,
    `Pool ${p.id} · ${p.tipo} · ${p.ambiente} · ${p.proveedor}`,
    [
      {
        nombre: 'Detalle',
        construir: async (cerrar) => {
          const [d, asig, reservas] = await Promise.all([
            get('/api/v1/pools/' + encodeURIComponent(id) + '/disponibilidad'),
            todasLasAsignaciones(),
            get('/api/v1/reservas?' + new URLSearchParams({ pool: id, estado: 'reservada' })),
          ]);
          const mayor = d.por_mascara.find((x) => x.bloques_libres > 0);
          return h(
            'div',
            null,
            h('p', { class: 'ficha-uso' }, barraUso(p.uso, res), ` ocupado (asignado ${pct(p.uso)} · reservado ${pct(res)})`),
            mapaDelPool(p, [...asig.filter((a) => a.pool_id === id), ...reservas.map((x) => ({ ...x, reserva: true }))]),
            datos([
              ['Pool', p.id],
              ['CIDR base', h('code', null, p.cidr)],
              ['Primera dirección', r.primera],
              ['Última dirección', r.ultima],
              ['Tipo', p.tipo],
              ['Ambiente', h('span', { class: 'tag ' + p.ambiente }, p.ambiente)],
              ['Proveedor', p.proveedor],
              ['Direcciones', fmt(r.total)],
              ['Utilizables', fmt(r.utilizables)],
              ['Libres', `${fmt(d.libres)} (${pct(d.total ? d.libres / d.total : 0)})`],
              ['Bloque libre más grande', mayor ? `/${mayor.mascara} (${fmt(mayor.direcciones)} direcciones)` : 'sin espacio'],
              ['Asignaciones', fmt(p.asignaciones)],
              ['Reservas vigentes', fmt(p.reservas_vigentes || 0)],
            ]),
            puede('admin') ? accionesPool(p, cerrar) : null,
          );
        },
      },
      {
        nombre: 'Segmentos',
        construir: async (cerrar) => {
          const [asig, reservas] = await Promise.all([
            todasLasAsignaciones(),
            get('/api/v1/reservas?' + new URLSearchParams({ pool: id, estado: 'reservada' })),
          ]);
          const filas = [
            ...asig.filter((a) => a.pool_id === id).map((a) => ({ ...a, estado: 'asignada' })),
            ...reservas.map((x) => ({ ...x, estado: 'reservada' })),
          ].sort((a, b) => ip2n(a.cidr.split('/')[0]) - ip2n(b.cidr.split('/')[0]));
          if (!filas.length) return h('p', { class: 'muted' }, 'Este pool todavía no tiene segmentos asignados ni reservados.');
          return tabla(
            'Segmentos del pool',
            ['Segmento', 'Estado', 'Proyecto / VPC', 'VLAN', 'Direcciones'],
            filas.map((x) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  x.estado === 'asignada'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'enlace',
                          onclick: () => {
                            cerrar();
                            fichaAsignacion(x.id);
                          },
                        },
                        h('code', null, x.cidr),
                      )
                    : h('code', null, x.cidr),
                ),
                h('td', null, h('span', { class: 'tag ' + (x.estado === 'asignada' ? 'confirmada' : 'reservada') }, x.estado)),
                h('td', null, x.vpc),
                h('td', null, textoVlan(x)),
                h('td', null, fmt(size(x.cidr))),
              ),
            ),
            '',
          );
        },
      },
      {
        nombre: 'Direcciones IP',
        construir: () =>
          panelDirecciones({
            filtro: { pool: id },
            pool: id,
            resumen: (l) => `${fmt(l.length)} IPs fijas registradas en el pool (incluidas las excepciones).`,
          }),
      },
      puede('admin') && { nombre: 'Historial', construir: () => historial({ pool: id }) },
    ].filter(Boolean),
  );
}

async function fichaAsignacion(id) {
  const [todas, pools] = await Promise.all([todasLasAsignaciones(), get('/api/v1/pools')]);
  const a = todas.find((x) => String(x.id) === String(id));
  if (!a) return toast('Esa asignación ya no existe (¿se liberó?).', 'error');
  const p = pools.find((x) => x.id === a.pool_id);
  const r = rango(a.cidr);
  abrirPanel(
    a.cidr,
    `${a.codigo || 'Asignación'} · ${a.vpc}`,
    [
      {
        nombre: 'Detalle',
        construir: async (cerrar) =>
          h(
            'div',
            null,
            datos([
              ['ID', h('code', null, a.codigo || String(a.id))],
              ['Segmento', h('code', null, a.cidr)],
              ['Primera dirección', r.primera],
              ['Última dirección', r.ultima],
              ['Máscara', '/' + r.len],
              ['Direcciones', fmt(r.total)],
              ['Utilizables', fmt(r.utilizables)],
              [
                'Pool',
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'enlace',
                    onclick: () => {
                      cerrar();
                      fichaPool(a.pool_id);
                    },
                  },
                  p ? `${a.pool_id} (${p.cidr})` : a.pool_id,
                ),
              ],
              p && ['Ambiente', h('span', { class: 'tag ' + p.ambiente }, p.ambiente)],
              p && ['Proveedor', p.proveedor],
              ['Proyecto / VPC', a.vpc],
              ['VLAN', a.vlan],
              ['Nombre VLAN / subred', a.vlan_nombre],
              ['Ticket', a.ticket],
              ['Origen', a.origen],
              ['Solicitó', a.solicitante],
              ['Creada', fechaHora(a.creado_en)],
            ]),
            puede('admin')
              ? h(
                  'p',
                  { style: 'margin-top:18px' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn peligro',
                      onclick: async () => {
                        if (await liberarAsignacion(a.id, a.cidr)) {
                          cerrar();
                          show(VISTA);
                        }
                      },
                    },
                    'Liberar segmento',
                  ),
                )
              : null,
          ),
      },
      {
        nombre: 'Direcciones IP',
        construir: () =>
          panelDirecciones({
            filtro: { asignacion: a.id },
            pool: a.pool_id,
            resumen: (l) => `${fmt(l.length)} de ${fmt(r.utilizables)} direcciones utilizables registradas como IP fija (${r.primera} – ${r.ultima}).`,
          }),
      },
      puede('admin') && { nombre: 'Historial', construir: () => historial({ pool: a.pool_id, cidr: a.cidr }) },
    ].filter(Boolean),
  );
}

const RES = { filtro: { estado: '', pool: '', solicitante: '' }, timer: null, aviso: null };
function restante(seg) {
  const d = Math.floor(seg / 86400),
    hh = Math.floor((seg % 86400) / 3600),
    m = Math.floor((seg % 3600) / 60),
    s = seg % 60;
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}
function celdaRestante(r) {
  if (r.estado !== 'reservada') return h('td', null, '—');
  const fin = Date.now() + r.segundos_restantes * 1000,
    t = h('time', { class: 'restante', datetime: r.expira_en, title: 'Vence ' + fechaHora(r.expira_en) });
  t.dataset.fin = fin;
  return h('td', null, t);
}
function tictac() {
  document.querySelectorAll('#reservas time[data-fin]').forEach((t) => {
    const seg = Math.max(0, Math.round((Number(t.dataset.fin) - Date.now()) / 1000));
    t.textContent = seg ? restante(seg) : 'vencida';
    t.classList.toggle('poco', seg > 0 && seg < 3600);
  });
}
async function renderReservas() {
  const raiz = $('reservas'),
    puedeOperar = (r) => puede('agente') && (YO.rol === 'admin' || r.solicitante === YO.usuario);
  try {
    const f = RES.filtro,
      qs = new URLSearchParams();
    if (f.estado) qs.set('estado', f.estado);
    if (f.pool) qs.set('pool', f.pool);
    const [pools, todas] = await Promise.all([get('/api/v1/pools'), get('/api/v1/reservas' + (String(qs) ? '?' + qs : ''))]);
    const poolDe = new Map(pools.map((p) => [p.id, p]));
    const lista = todas.filter(
      (r) =>
        (!f.solicitante || r.solicitante.toLowerCase().includes(f.solicitante.toLowerCase())) && poolDe.has(r.pool_id) && pasaFiltro(poolDe.get(r.pool_id)),
    );
    const estado = h('div', { id: 'res-msg', 'aria-live': 'polite' });
    if (RES.aviso) {
      msg(estado, RES.aviso.texto, RES.aviso.tipo);
      RES.aviso = null;
    }
    const filtros = h(
      'form',
      { class: 'filtros', role: 'search', 'aria-label': 'Filtrar reservas', onsubmit: (e) => e.preventDefault() },
      camposFiltro(pools, renderReservas),
      h(
        'label',
        null,
        'Estado',
        h(
          'select',
          {
            id: 'res-f-estado',
            onchange: (e) => {
              f.estado = e.target.value;
              RES.foco = 'res-f-estado';
              renderReservas();
            },
          },
          [
            ['', 'Todos'],
            ['reservada', 'Reservada'],
            ['confirmada', 'Confirmada'],
            ['liberada', 'Liberada'],
            ['expirada', 'Expirada'],
          ].map(([v, t]) => h('option', { value: v, selected: f.estado === v }, t)),
        ),
      ),
      h(
        'label',
        null,
        'Pool',
        h(
          'select',
          {
            id: 'res-f-pool',
            onchange: (e) => {
              f.pool = e.target.value;
              RES.foco = 'res-f-pool';
              renderReservas();
            },
          },
          [h('option', { value: '' }, 'Todos'), ...pools.map((p) => h('option', { value: p.id, selected: f.pool === p.id }, p.id))],
        ),
      ),
      h(
        'label',
        null,
        'Solicitante',
        h('input', {
          id: 'res-f-sol',
          type: 'search',
          value: f.solicitante,
          placeholder: 'svc:agente-redes',
          oninput: (e) => {
            f.solicitante = e.target.value;
            clearTimeout(RES.deb);
            RES.deb = setTimeout(() => {
              RES.foco = 'res-f-sol';
              renderReservas();
            }, 300);
          },
        }),
      ),
    );
    const filas = lista.map((r) =>
      h(
        'tr',
        null,
        h('td', null, h('code', null, r.cidr)),
        h('td', null, r.pool_id),
        h('td', null, r.vpc),
        h('td', null, textoVlan(r)),
        h('td', null, r.solicitante),
        h('td', null, r.ticket),
        h('td', null, h('span', { class: 'tag ' + r.estado }, r.estado)),
        h('td', null, fechaHora(r.creado_en)),
        celdaRestante(r),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'acciones' },
            r.estado === 'reservada' &&
              puedeOperar(r) &&
              h(
                'button',
                { class: 'btn', type: 'button', 'aria-label': 'Confirmar la reserva ' + r.cidr, onclick: () => accionReserva(r, 'confirmar', estado) },
                'Confirmar',
              ),
            (r.estado === 'reservada' || r.estado === 'confirmada') &&
              puedeOperar(r) &&
              h(
                'button',
                { class: 'btn sec', type: 'button', 'aria-label': 'Liberar la reserva ' + r.cidr, onclick: () => accionReserva(r, 'liberar', estado) },
                'Liberar',
              ),
          ),
        ),
      ),
    );
    raiz.replaceChildren(
      h('h2', { id: 'res-titulo', tabindex: '-1' }, 'Reservas'),
      h(
        'p',
        { class: 'muted' },
        'Una reserva aparta un rango por un tiempo. ',
        h('b', null, 'No es definitiva'),
        ': se vuelve asignación solo al confirmarla (tras la aprobación de una persona) y, si no se confirma, expira sola.',
      ),
      puede('solicitante') ? formularioNuevaReserva(pools, estado, renderReservas) : null,
      filtros,
      estado,
      tabla(
        'Reservas de rangos IP',
        ['Segmento', 'Pool', 'Proyecto / VPC', 'VLAN', 'Solicitante', 'Ticket', 'Estado', 'Creada', 'Vence en', 'Acciones'],
        filas,
        'No hay reservas con estos filtros.',
      ),
    );
    clearInterval(RES.timer);
    tictac();
    RES.timer = setInterval(tictac, 1000);
    if (RES.foco) {
      const el = $(RES.foco);
      RES.foco = null;
      if (el) {
        el.focus();
        if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  } catch (e) {
    fail('reservas', e);
  }
}
async function accionReserva(r, que, zona) {
  const confirmando = que === 'confirmar';
  const texto = confirmando
    ? `¿Confirmar la reserva ${r.cidr} (${r.vpc})? Pasará a asignación definitiva.`
    : `¿Liberar ${r.cidr}?${r.estado === 'confirmada' ? ' Como ya está confirmada, se borrará también la asignación definitiva.' : ''}`;
  if (
    !(await confirmar({
      titulo: confirmando ? 'Confirmar reserva' : 'Liberar reserva',
      mensaje: texto,
      confirmar: confirmando ? 'Confirmar' : 'Liberar',
      peligro: !confirmando,
    }))
  )
    return;
  const x = confirmando ? await api(`/api/v1/reservas/${r.id}/confirmar`, { body: {} }) : await api(`/api/v1/reservas/${r.id}`, { method: 'DELETE', body: {} });
  await renderReservas();
  $('res-titulo').focus();
  msg(
    $('res-msg'),
    x.ok ? (confirmando ? `Reserva ${r.cidr} confirmada: ahora es una asignación definitiva.` : `Reserva ${r.cidr} liberada.`) : errorApi(x),
    x.ok ? 'ok' : 'error',
  );
}

/* ===== Tokens (solo admin) ===== */
const diasPara = (s) => Math.max(0, Math.ceil((new Date(s) - Date.now()) / 86400000));
async function renderTokens() {
  const raiz = $('tokens');
  try {
    const lista = await get('/api/v1/tokens');
    const estado = h('div', { id: 'tk-msg', 'aria-live': 'polite' });
    const filas = lista.map((t) =>
      h(
        'tr',
        null,
        h('td', null, t.nombre),
        h('td', null, h('code', null, t.prefijo + '…')),
        h('td', null, t.rol),
        h('td', null, fecha(t.expira_en), ' ', t.por_vencer && h('span', { class: 'tag pronto' }, 'vence en ' + diasPara(t.expira_en) + ' d')),
        h('td', null, t.ultimo_uso ? fechaHora(t.ultimo_uso) : 'nunca'),
        h('td', null, h('span', { class: 'tag ' + t.estado }, t.estado)),
        h(
          'td',
          null,
          t.estado === 'activo'
            ? h(
                'button',
                { class: 'btn peligro', type: 'button', 'aria-label': 'Revocar el token ' + t.nombre, onclick: () => revocarToken(t, estado) },
                'Revocar',
              )
            : null,
        ),
      ),
    );
    raiz.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px' },
        h('h2', { id: 'tk-titulo', tabindex: '-1' }, 'Tokens de servicio'),
        h('button', { class: 'btn', type: 'button', id: 'tk-nuevo', onclick: () => dialogoToken(estado) }, 'Crear token'),
      ),
      h(
        'p',
        { class: 'muted' },
        'Credenciales para agentes y sistemas (no para personas). El token se muestra una sola vez al crearlo; aquí solo queda su prefijo. Rotar: crea uno nuevo, actualiza el agente y revoca el anterior.',
      ),
      estado,
      tabla('Tokens de servicio', ['Nombre', 'Prefijo', 'Rol', 'Vence', 'Último uso', 'Estado', 'Acciones'], filas, 'Todavía no hay tokens.'),
    );
  } catch (e) {
    fail('tokens', e);
  }
}
async function revocarToken(t, zona) {
  const revocar = await confirmar({
    titulo: `¿Revocar el token «${t.nombre}»?`,
    mensaje: 'Los agentes que lo usen dejarán de funcionar de inmediato.',
    confirmar: 'Revocar token',
    peligro: true,
  });
  if (!revocar) return;
  const r = await api('/api/v1/tokens/' + t.id, { method: 'DELETE', body: {} });
  await renderTokens();
  $('tk-titulo').focus();
  msg($('tk-msg'), r.ok ? `Token «${t.nombre}» revocado.` : errorApi(r), r.ok ? 'ok' : 'error');
}
function dialogoToken(zona) {
  const dlg = h('dialog', { id: 'tk-dlg', 'aria-labelledby': 'tk-dlg-t' });
  const cierre = () => {
    const v = dlg.querySelector('#tk-valor');
    if (v) v.value = '';
    dlg.close();
  };
  dlg.addEventListener('close', async () => {
    dlg.remove();
    await renderTokens();
    const b = $('tk-nuevo');
    if (b) b.focus();
  });
  const error = h('div', { id: 'tk-err', 'aria-live': 'assertive' });
  const nombre = h('input', {
    id: 'tk-nombre',
    name: 'nombre',
    required: true,
    pattern: '[a-z0-9][a-z0-9\\-]{1,40}',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'tk-nombre-ayuda',
  });
  const rol = h(
    'select',
    { id: 'tk-rol', name: 'rol' },
    h('option', { value: 'agente', selected: true }, 'agente (reserva, confirma y libera las suyas)'),
    h('option', { value: 'lector' }, 'lector (solo consulta)'),
  );
  const dias = h('input', { id: 'tk-dias', name: 'expira_dias', type: 'number', min: '1', max: '365', value: '90', required: true });
  const cuota = h('input', { id: 'tk-cuota', name: 'cuota_reservas', type: 'number', min: '1', placeholder: '(la general)' });
  const enviar = h('button', { class: 'btn', type: 'submit', id: 'tk-crear' }, 'Crear token');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        enviar.disabled = true;
        const body = { nombre: nombre.value.trim(), rol: rol.value, expira_dias: Number(dias.value) };
        if (cuota.value) body.cuota_reservas = Number(cuota.value);
        const r = await api('/api/v1/tokens', { body });
        enviar.disabled = false;
        if (!r.ok) {
          msg(error, errorApi(r), 'error');
          return;
        }
        mostrarToken(dlg, r.data, cierre);
      },
    },
    h('h3', { id: 'tk-dlg-t' }, 'Crear token de servicio'),
    h('label', { for: 'tk-nombre' }, 'Nombre'),
    nombre,
    h('p', { class: 'ayuda', id: 'tk-nombre-ayuda' }, 'Minúsculas, números y guiones (p. ej. agente-redes). Debe ser único.'),
    h('label', { for: 'tk-rol' }, 'Rol'),
    rol,
    h('label', { for: 'tk-dias' }, 'Vigencia (días, 1 a 365)'),
    dias,
    h('label', { for: 'tk-cuota' }, 'Cuota de reservas vigentes (opcional)'),
    cuota,
    error,
    h('div', { class: 'fila-botones' }, h('button', { class: 'btn sec', type: 'button', onclick: cierre }, 'Cancelar'), enviar),
  );
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  nombre.focus();
}
function mostrarToken(dlg, t, cierre) {
  const estado = h('div', { id: 'tk-copia', 'aria-live': 'polite' });
  const valor = h('input', { id: 'tk-valor', class: 'token-valor', readonly: true, 'aria-label': 'Token de servicio', onfocus: (e) => e.target.select() });
  valor.value = t.token;
  const copiar = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      id: 'tk-copiar',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(valor.value);
          msg(estado, 'Copiado al portapapeles.', 'ok');
        } catch {
          valor.focus();
          valor.select();
          msg(estado, 'No se pudo copiar solo: el texto quedó seleccionado, copia con Ctrl+C.', 'error');
        }
      },
    },
    'Copiar',
  );
  dlg.replaceChildren(
    h(
      'div',
      null,
      h('h3', { id: 'tk-dlg-t' }, 'Token creado: ' + t.nombre),
      h(
        'div',
        { class: 'aviso', role: 'alert' },
        h('b', null, 'Cópialo ahora. '),
        'No se podrá ver de nuevo: si lo pierdes, tendrás que crear otro y revocar este.',
      ),
      h('label', { for: 'tk-valor' }, 'Token'),
      valor,
      estado,
      h('p', { class: 'ayuda' }, `Rol ${t.rol} · vence ${fecha(t.expira_en)}. Úsalo así:  Authorization: Bearer <token>`),
      h('div', { class: 'fila-botones' }, copiar, h('button', { class: 'btn sec', type: 'button', id: 'tk-cerrar', onclick: cierre }, 'Cerrar')),
    ),
  );
  copiar.focus();
}

function render(t) {
  ({
    pools: renderPools,
    asig: renderAsig,
    reservas: renderReservas,
    jira: renderJira,
    tokens: renderTokens,
    usuarios: renderUsuarios,
    importar: renderImportar,
    ips: renderIps,
  })[t]();
}

async function marca() {
  try {
    const m = await (await fetch('/api/config')).json();
    document.title = m.nombre + ' · Gestión de segmentos';
    $('nombre').textContent = m.nombre + ' · Gestión de segmentos';
    $('subtitulo').textContent = m.subtitulo || '';
    if (m.logo) {
      $('logo').src = m.logo;
      $('logo').hidden = false;
      $('favicon').href = m.logo; // el logo de la marca también es el icono de la pestaña
      $('favicon').removeAttribute('type');
    }
    $('pie').textContent = m.pie || '';
  } catch (e) {}
}
/** Llama a /auth/salir con credenciales falsas: el 401 hace que el navegador reemplace las que tenía guardadas. */
function olvidarCredencialesBasic() {
  return new Promise((listo) => {
    const x = new XMLHttpRequest();
    x.open('GET', '/auth/salir', true, 'salir', 'salir');
    x.onloadend = () => listo();
    x.send();
  });
}
async function iniciar() {
  marca();
  const r = await fetch('/api/me', { headers: CAB });
  if (r.status === 401) {
    location.href = '/auth/login?next=' + encodeURIComponent(location.pathname);
    return;
  }
  YO = await r.json();
  const nav = $('nav');
  nav.querySelector('[data-t="tokens"]').hidden = !puede('admin');
  nav.querySelector('[data-t="usuarios"]').hidden = !puede('admin'); // sin cuentas habilitadas explica cómo habilitarlas
  $('yo').innerHTML =
    YO.modo === 'oidc'
      ? `${esc(YO.nombre)} · <b>${esc(YO.rol)}</b> <button type="button" id="salir">${I('salir')}Salir</button>`
      : YO.modo === 'none'
        ? `<span class="tag qa">${I('alerta')} Sin autenticación (demo)</span>`
        : `${esc(YO.usuario)} · <b>${esc(YO.rol)}</b> <button type="button" id="salir">${I('salir')}Salir</button>`;
  if (YO.local) {
    $('yo').append(' ', h('button', { id: 'mi-clave', type: 'button', onclick: () => dialogoCambioClave() }, ico('llave'), 'Mi contraseña'));
  }
  const salir = $('salir');
  if (salir)
    salir.onclick = async () => {
      if (YO.modo === 'basic') {
        // Basic Auth no tiene sesión: se le pide al navegador que olvide las credenciales (ver src/adaptadores/auth/basic.js).
        await olvidarCredencialesBasic();
        location.href = '/auth/sesion-cerrada';
        return;
      }
      const x = await api('/auth/logout', { body: {} });
      location.href = (x.data && x.data.redirect) || '/';
    };
  show('pools');
  if (YO.debe_cambiar_clave) dialogoCambioClave({ obligatorio: true }); // clave temporal: no se puede seguir sin cambiarla
}
iniciar();
