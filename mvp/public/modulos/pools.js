// Pestaña Pools: indicadores, tabla, alta, edición y baja de un pool.
import { fmt as _fmt } from '../calculos.js';
import { $, ESTADO, I, api, errorApi, esc, fail, get, h, ico, msg, puede, size, tag, todasLasAsignaciones } from './base.js';
import { barraFiltro, pasaFiltro, textoDeSegmento } from './filtro.js';
import { barraUsoHtml, pct } from './uso.js';
import { fichaAsignacion, fichaPool, segmentosDePool } from './fichas.js';
import { show } from './navegacion.js';
import { confirmar, vincularCidr } from './ui.js';

let ULTIMA_CARGA = 0; // una carga vieja no debe pisar a una nueva ni rehacer la pantalla mientras se escribe en el buscador
export async function renderPools() {
  const mia = ++ULTIMA_CARGA;
  try {
    const todos = await get('/api/v1/pools');
    const porFiltro = todos.filter(pasaFiltro); // por ambiente y proveedor: de aquí salen los indicadores
    const q = ESTADO.busquedaPools.trim().toLowerCase();
    const { pools, coincidencias } = q ? await buscarEnPools(porFiltro, q) : { pools: porFiltro, coincidencias: new Map() };
    if (mia !== ULTIMA_CARGA) return;
    // Uso total ponderado por tamaño: direcciones ocupadas (asignadas + reservadas) de todos los pools ÷ direcciones totales.
    const total = porFiltro.reduce((n, p) => n + size(p.cidr), 0);
    const ocupadas = porFiltro.reduce((n, p) => n + (p.uso + (p.uso_reservado || 0)) * size(p.cidr), 0);
    const sobre80 = porFiltro.filter((p) => p.uso + (p.uso_reservado || 0) > 0.8).length;
    $('pools').innerHTML =
      `<div class="cabecera"><h2 tabindex="-1">Estado de pools</h2><span class="acciones">${puede('admin') ? `<button type="button" class="btn" id="btn-importar">${I('subir')}Importar segmentos</button>` : ''}<a class="btn sec" href="/api/v1/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a></span></div>
  <div class="kpis"><div class="card"><div class="kpi">${porFiltro.length}</div><div class="sub">Pools</div></div>
  <div class="card"><div class="kpi">${porFiltro.reduce((n, p) => n + p.asignaciones, 0)}</div><div class="sub">Asignaciones activas</div></div>
  <div class="card"><div class="kpi">${pct(total ? ocupadas / total : 0)}</div><div class="sub">Uso total (asignado + reservado)</div></div>
  <div class="card"><div class="kpi ${sobre80 ? 'uso-txt-alto' : ''}">${sobre80}</div><div class="sub">Pools sobre 80 %</div></div>
  <div class="card"><div class="kpi">${_fmt(Math.max(0, Math.round(total - ocupadas)))}</div><div class="sub">Espacio libre (direcciones)</div></div></div>
  <p class="nota">${I('info')} Los solapamientos no son un indicador: la base de datos los impide con una restricción de exclusión.</p>
  <div id="pool-nuevo"></div><div id="pools-msg" aria-live="polite"></div>
  <p class="muted leyenda"><span><span class="muestra asig"></span> asignado</span> <span><span class="muestra res"></span> reservado</span> <span>La flecha ${I('derecha')} despliega los segmentos de un pool aquí mismo; su nombre abre la ficha en el panel lateral.</span></p>
  <div class="barra-pools"><button type="button" class="btn sec pequeno" id="pools-expandir">Expandir todos</button><button type="button" class="btn sec pequeno" id="pools-contraer">Contraer todos</button></div>
  <div class="card tablewrap" tabindex="0" role="region" aria-label="Pools"><table><thead><tr><th scope="col">Pool</th><th scope="col">Tipo</th><th scope="col">Ambiente</th><th scope="col">Proveedor</th><th scope="col">CIDR base</th><th scope="col">Asig.</th><th scope="col">Reservas</th><th scope="col">Uso</th>${puede('admin') ? '<th scope="col"><span class="sr-only">Acciones</span></th>' : ''}</tr></thead><tbody>
  ${pools
    .map(
      (
        p,
      ) => `<tr><td class="celda-pool"><button type="button" class="btn-expandir" data-expandir-pool="${esc(p.id)}" aria-expanded="false" aria-controls="seg-pool-${esc(p.id)}" aria-label="Mostrar los segmentos de ${esc(p.id)}">${I('derecha', 16)}</button><button type="button" class="enlace" data-ficha-pool="${esc(p.id)}">${esc(p.id)}</button></td><td>${esc(p.tipo)}</td><td>${tag(p.ambiente)}</td><td>${esc(p.proveedor)}</td><td><code>${esc(p.cidr)}</code></td><td>${p.asignaciones}</td><td>${p.reservas_vigentes || 0}</td>
  <td>${barraUsoHtml(p.uso, p.uso_reservado || 0)}</td>${puede('admin') ? `<td class="col-menu"><button type="button" class="btn-menu" data-menu-pool="${esc(p.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="Acciones de ${esc(p.id)}">⋮</button></td>` : ''}</tr>
  <tr class="detalle-pool" id="seg-pool-${esc(p.id)}" hidden><td colspan="9"></td></tr>`,
    )
    .join('')}</tbody></table></div>`;
    $('pools').prepend(barraDeBusqueda(todos, pools.length, porFiltro.length, coincidencias, q));
    $('pools')
      .querySelectorAll('[data-ficha-pool]')
      .forEach((b) => (b.onclick = () => fichaPool(b.dataset.fichaPool)));
    enlazarDespliegue($('pools'), coincidencias, q);
    $('pools')
      .querySelectorAll('[data-menu-pool]')
      .forEach(
        (b) =>
          (b.onclick = () =>
            menuPool(
              b,
              pools.find((p) => p.id === b.dataset.menuPool),
            )),
      );
    const imp = $('btn-importar');
    if (imp) imp.onclick = () => show('importar');
    if (puede('admin')) $('pool-nuevo').replaceWith(formularioNuevoPool(renderPools));
    if (ESTADO.poolsAviso) {
      msg($('pools-msg'), ESTADO.poolsAviso, 'ok');
      ESTADO.poolsAviso = null;
    }
  } catch (e) {
    fail('pools', e);
  }
}

const textoDePool = (p) => [p.id, p.tipo, p.ambiente, p.proveedor, p.cidr].join(' ').toLowerCase();

/**
 * Pools que coinciden con el texto: por sus propios datos (nombre, tipo, ambiente, proveedor, CIDR) o porque alguno de sus segmentos
 * coincide (proyecto, VPC, subred, ticket, responsable…). Devuelve también, por pool, cuántos segmentos coinciden.
 */
async function buscarEnPools(porFiltro, q) {
  const asignaciones = await todasLasAsignaciones();
  const ids = new Set(porFiltro.map((p) => p.id));
  const coincidencias = new Map();
  for (const a of asignaciones) {
    if (ids.has(a.pool_id) && textoDeSegmento(a).includes(q)) coincidencias.set(a.pool_id, (coincidencias.get(a.pool_id) || 0) + 1);
  }
  return { pools: porFiltro.filter((p) => textoDePool(p).includes(q) || coincidencias.has(p.id)), coincidencias };
}

/** Cuadro «Buscar» + filtros por ambiente y proveedor, con el resultado en palabras para quien usa lector de pantalla. */
function barraDeBusqueda(todos, visibles, total, coincidencias, q) {
  const buscador = h('input', {
    id: 'p-buscar',
    type: 'search',
    value: ESTADO.busquedaPools,
    placeholder: 'Pool, CIDR, proyecto, VPC, subred, ticket…',
    oninput: (e) => {
      ESTADO.busquedaPools = e.target.value;
      clearTimeout(ESTADO.retardoBusquedaPools);
      // Con una pausa breve: cada render vuelve a pedir los datos y rehace la pantalla, y no debe pisar lo que se está escribiendo.
      ESTADO.retardoBusquedaPools = setTimeout(async () => {
        await renderPools();
        const el = $('p-buscar');
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }, 250);
    },
  });
  const barra = barraFiltro(todos, renderPools);
  barra.insertBefore(h('label', null, 'Buscar', buscador), barra.firstChild);
  const segmentos = [...coincidencias.values()].reduce((n, c) => n + c, 0);
  barra.append(
    h(
      'p',
      { class: 'muted', role: 'status', style: 'flex:1 1 100%;margin:0' },
      q
        ? visibles
          ? `${visibles} de ${total} pools coinciden con «${ESTADO.busquedaPools.trim()}»${segmentos ? ` (${segmentos} segmentos)` : ''}.`
          : `Ningún pool ni segmento coincide con «${ESTADO.busquedaPools.trim()}».`
        : '',
    ),
  );
  return barra;
}

/**
 * Despliegue de los segmentos de cada pool dentro de la misma tabla (además de la ficha en el panel lateral).
 * Los pools abiertos se recuerdan en ESTADO.poolsAbiertos: al filtrar o recargar la pestaña siguen abiertos.
 */
function enlazarDespliegue(raiz, coincidencias = new Map(), q = '') {
  const abiertos = (ESTADO.poolsAbiertos ||= new Set());
  const columnas = raiz.querySelectorAll('thead th').length;
  const botones = [...raiz.querySelectorAll('[data-expandir-pool]')];
  const cargados = new Set();
  const fijar = async (boton, abrir, sinRecordar = false) => {
    const id = boton.dataset.expandirPool;
    const fila = document.getElementById('seg-pool-' + id);
    if (!fila) return;
    boton.setAttribute('aria-expanded', String(abrir));
    boton.setAttribute('aria-label', `${abrir ? 'Ocultar' : 'Mostrar'} los segmentos de ${id}`);
    fila.hidden = !abrir;
    if (!sinRecordar) {
      if (abrir) abiertos.add(id);
      else abiertos.delete(id);
    }
    if (!abrir || cargados.has(id)) return;
    cargados.add(id);
    const celda = fila.firstElementChild;
    celda.colSpan = columnas;
    celda.replaceChildren(h('p', { class: 'muted', role: 'status' }, 'Cargando segmentos…'));
    try {
      // Con una búsqueda activa y coincidencias en este pool, se muestran solo los segmentos que coinciden.
      const solo = q && coincidencias.has(id) ? (s) => textoDeSegmento(s).includes(q) : undefined;
      const tabla = await segmentosDePool(id, fichaAsignacion, solo);
      celda.replaceChildren(
        ...(solo
          ? [h('p', { class: 'muted' }, `Solo los segmentos que coinciden con «${ESTADO.busquedaPools.trim()}». Borra la búsqueda para ver todos.`)]
          : []),
        tabla,
      );
    } catch (e) {
      cargados.delete(id);
      celda.replaceChildren(h('p', { class: 'alert', role: 'alert' }, ico('error'), ' No se pudieron cargar los segmentos: ' + e.message));
    }
  };
  botones.forEach((b) => (b.onclick = () => fijar(b, b.getAttribute('aria-expanded') !== 'true')));
  const todos = (abrir) => Promise.all(botones.map((b) => fijar(b, abrir)));
  raiz.querySelector('#pools-expandir').onclick = () => todos(true);
  raiz.querySelector('#pools-contraer').onclick = () => todos(false);
  // Abiertos por el usuario y, mientras se busca, los pools donde coincide algún segmento (sin recordarlos: al borrar la búsqueda vuelven a su estado).
  botones
    .filter((b) => abiertos.has(b.dataset.expandirPool) || coincidencias.has(b.dataset.expandirPool))
    .forEach((b) => fijar(b, true, coincidencias.has(b.dataset.expandirPool) && !abiertos.has(b.dataset.expandirPool)));
}

/** Menú de tres puntos de una fila: ver ficha o eliminar. Va con position:fixed para que la tabla con scroll no lo recorte. */
function menuPool(boton, p) {
  document.querySelectorAll('.menu-pool').forEach((m) => m.remove());
  const cerrar = () => {
    menu.remove();
    boton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', fuera, true);
    document.removeEventListener('keydown', tecla, true);
    window.removeEventListener('scroll', colocar, true);
  };
  const fuera = (e) => {
    if (!menu.contains(e.target)) cerrar();
  };
  const tecla = (e) => {
    if (e.key === 'Escape') {
      cerrar();
      boton.focus();
    }
  };
  const item = (texto, peligro, accion) =>
    h('button', { type: 'button', role: 'menuitem', class: 'menu-item' + (peligro ? ' peligro' : ''), onclick: () => (cerrar(), accion()) }, texto);
  const menu = h(
    'div',
    { class: 'menu-pool', role: 'menu', 'aria-label': 'Acciones de ' + p.id },
    item('Ver ficha', false, () => fichaPool(p.id)),
    item('Eliminar pool', true, () => eliminarPool(p)),
  );
  document.body.append(menu);
  const colocar = () => {
    const r = boton.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
  };
  colocar();
  boton.setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
  document.addEventListener('click', fuera, true);
  document.addEventListener('keydown', tecla, true);
  window.addEventListener('scroll', colocar, true);
}

/** Confirma y elimina un pool vacío. Si tiene contenido, la API responde pool_en_uso y se muestra el motivo. Devuelve true si se eliminó. */
async function eliminarPool(p, estado = $('pools-msg')) {
  const seguro = await confirmar({
    titulo: `¿Eliminar el pool ${p.id}?`,
    mensaje: `${p.cidr}. Solo se puede si no tiene segmentos, reservas vigentes ni IPs.`,
    confirmar: 'Eliminar pool',
    peligro: true,
  });
  if (!seguro) return false;
  const r = await api('/api/v1/pools/' + encodeURIComponent(p.id), { method: 'DELETE' });
  if (!r.ok) {
    msg(estado, errorApi(r), 'error');
    return false;
  }
  ESTADO.poolsAviso = `Pool ${p.id} eliminado.`;
  show('pools');
  return true;
}

/* ===== Pools: alta (admin) ===== */
export const PROVEEDORES = ['GCP', 'On-prem', 'AWS', 'Azure'];

export function formularioNuevoPool(recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const id = h('input', { id: 'np-id', required: true, maxlength: 63, placeholder: 'lan-sucursal-prod', pattern: '[a-z0-9][a-z0-9\\-]{1,62}' });
  const tipo = h('input', { id: 'np-tipo', required: true, maxlength: 40, placeholder: 'Nodos, Pods, LAN, Gestión…' });
  const ambiente = h(
    'select',
    { id: 'np-ambiente', required: true },
    h('option', { value: '' }, 'Elige…'),
    ['dev', 'qa', 'lab', 'pre', 'prod'].map((v) => h('option', { value: v }, v)),
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
    ESTADO.poolsAviso = `Pool ${r.data.id} (${r.data.cidr}) creado.`;
    recargar();
  };
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 14px' },
    h('summary', { class: 'btn', style: 'display:inline-block;cursor:pointer' }, ico('mas'), 'Nuevo pool'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Crea un bloque base en el ambiente que corresponda (dev, qa, lab, pre o prod). CIDR alineado de /8 a /30. No puede solaparse con otro pool del mismo proveedor y ambiente; en otro ambiente o proveedor el mismo rango sí se permite.',
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

/** Acciones de admin en la ficha del pool: editar tipo y proveedor, o eliminarlo si está vacío. */
export function accionesPool(p, cerrar) {
  const estado = h('div', { 'aria-live': 'polite' });
  const tipo = h('input', { id: 'ep-tipo', maxlength: 40, value: p.tipo });
  const proveedor = h('input', { id: 'ep-proveedor', maxlength: 40, value: p.proveedor, list: 'np-provs-ficha' });
  const guardar = async (e) => {
    e.preventDefault();
    const r = await api('/api/v1/pools/' + encodeURIComponent(p.id), { method: 'PATCH', body: { tipo: tipo.value.trim(), proveedor: proveedor.value.trim() } });
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    cerrar();
    show(ESTADO.vista);
    fichaPool(p.id);
  };
  const eliminar = async () => {
    if (await eliminarPool(p, estado)) cerrar();
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
