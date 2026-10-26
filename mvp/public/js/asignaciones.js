// Pestaña «Asignaciones»: búsqueda, filtros por pool y ambiente, orden por columna y paginación contra /api/asignaciones.
import { $, esc, fmt, fecha, tag, I, debounce, cargando, falla } from './util.js';
import { api, get, puede } from './api.js';
import { tamanoCidr } from './calculos.js';
import { confirmar, toast } from './ui.js';

const POR_PAGINA = 25;
const COLUMNAS = [
  { orden: 'cidr', texto: 'Segmento' }, { orden: 'pool', texto: 'Pool' }, { texto: 'Ambiente' },
  { orden: 'vpc', texto: 'Proyecto / VPC' }, { orden: 'direcciones', texto: 'Direcciones' },
  { orden: 'solicitante', texto: 'Solicitó' }, { orden: 'origen', texto: 'Origen' },
  { orden: 'ticket', texto: 'Ticket' }, { orden: 'fecha', texto: 'Fecha' },
];

// El estado vive en el módulo: al volver a la pestaña se conservan la búsqueda, los filtros y la página.
const estado = { q: '', pool: '', ambiente: '', orden: 'fecha', dir: 'desc', pagina: 0 };
let panel = null;
let peticion = 0; // descarta respuestas lentas que llegan después de una consulta más nueva

export async function mostrar(destino) {
  panel = destino;
  if (!panel.dataset.listo) construir();
  await cargarPools();
  await cargar();
}

function construir() {
  panel.dataset.listo = 'si';
  panel.innerHTML = `
    <div class="cabecera"><h2 tabindex="-1">Asignaciones</h2>
      <span class="acciones-cab">
        <a class="btn" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a>
        ${puede('admin') ? `<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">${I('archivo')}Respaldo JSON</a>` : ''}
      </span></div>
    <form class="filtros" id="a-filtros" role="search" aria-label="Buscar y filtrar asignaciones">
      <div class="campo campo-buscar"><label for="a-q">Buscar</label>
        <div class="con-icono">${I('buscar')}<input id="a-q" type="search" placeholder="CIDR, proyecto, solicitante o ticket" autocomplete="off" maxlength="100"></div></div>
      <div class="campo"><label for="a-pool">Pool</label><select id="a-pool"><option value="">Todos</option></select></div>
      <div class="campo"><label for="a-amb">Ambiente</label>
        <select id="a-amb"><option value="">Todos</option><option>dev</option><option>qa</option><option>pre</option><option>prod</option></select></div>
      <div class="campo"><button type="button" class="btn sec" id="a-limpiar">${I('cerrar')}Limpiar filtros</button></div>
    </form>
    <div class="card tablewrap" tabindex="0" role="region" aria-label="Asignaciones" id="a-tabla"></div>
    <nav class="paginacion" id="a-pag" aria-label="Paginación"></nav>`;
  $('a-filtros').addEventListener('submit', (e) => e.preventDefault());
  $('a-q').addEventListener('input', debounce(() => { estado.q = $('a-q').value.trim(); estado.pagina = 0; cargar(); }, 300));
  $('a-pool').onchange = () => { estado.pool = $('a-pool').value; estado.pagina = 0; cargar(); };
  $('a-amb').onchange = () => { estado.ambiente = $('a-amb').value; estado.pagina = 0; cargar(); };
  $('a-limpiar').onclick = limpiar;
}

function limpiar() {
  Object.assign(estado, { q: '', pool: '', ambiente: '', pagina: 0 });
  $('a-q').value = ''; $('a-pool').value = ''; $('a-amb').value = '';
  cargar();
}

async function cargarPools() {
  try {
    const pools = await get('/api/pools');
    const sel = $('a-pool');
    sel.innerHTML = `<option value="">Todos</option>${pools.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('')}`;
    sel.value = estado.pool;
  } catch { /* el filtro queda solo con «Todos»; la tabla muestra su propio error si la API falla */ }
  $('a-q').value = estado.q; $('a-amb').value = estado.ambiente;
}

async function cargar() {
  const mia = ++peticion;
  const tabla = $('a-tabla');
  const params = new URLSearchParams({ limit: POR_PAGINA, offset: estado.pagina * POR_PAGINA, orden: estado.orden, dir: estado.dir });
  for (const k of ['q', 'pool', 'ambiente']) if (estado[k]) params.set(k, estado[k]);
  tabla.setAttribute('aria-busy', 'true');
  if (!tabla.querySelector('table')) cargando(tabla);
  const r = await api(`/api/asignaciones?${params}`);
  if (mia !== peticion) return;
  if (!r.ok) return falla(tabla, new Error(`error ${r.status}`), cargar);
  const total = r.total ?? r.data.length;
  if (r.data.length === 0 && total > 0 && estado.pagina > 0) { estado.pagina = Math.max(0, Math.ceil(total / POR_PAGINA) - 1); return cargar(); }
  pintarTabla(r.data, total);
  pintarPaginacion(total);
}

function cabecera(c) {
  if (!c.orden) return `<th scope="col">${c.texto}</th>`;
  const activa = estado.orden === c.orden;
  const sentido = activa ? (estado.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const flecha = activa ? I(estado.dir === 'asc' ? 'arriba' : 'abajo') : '';
  return `<th scope="col" aria-sort="${sentido}"><button type="button" class="orden" data-orden="${c.orden}">${c.texto}${flecha}</button></th>`;
}

function pintarTabla(filas, total) {
  const tabla = $('a-tabla');
  tabla.removeAttribute('aria-busy');
  const hayFiltros = estado.q || estado.pool || estado.ambiente;
  if (total === 0) {
    tabla.innerHTML = `<div class="vacio">${I('buscar', 20)}
      <p><b>${hayFiltros ? 'Ninguna asignación coincide con la búsqueda.' : 'Aún no hay asignaciones.'}</b></p>
      <p class="muted">${hayFiltros ? 'Prueba con otro texto o quita los filtros.' : 'Cuando se asigne un segmento aparecerá aquí.'}</p></div>`;
    return;
  }
  tabla.innerHTML = `<table>
    <thead><tr>${COLUMNAS.map(cabecera).join('')}<th scope="col"><span class="sr-only">Acciones</span></th></tr></thead>
    <tbody>${filas.map((x) => `<tr>
      <td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${tag(x.ambiente)}</td><td>${esc(x.vpc)}</td>
      <td class="num">${fmt(tamanoCidr(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${fecha(x.creado_en)}</td>
      <td>${puede('admin') ? botonLiberar(x) : ''}</td></tr>`).join('')}</tbody></table>`;
  tabla.querySelectorAll('[data-orden]').forEach((b) => { b.onclick = () => ordenarPor(b.dataset.orden); });
  tabla.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => liberar(b); });
}

const botonLiberar = (x) => `<button type="button" class="btn sec pequeno" data-del="${x.id}" data-c="${esc(x.cidr)}"
  data-pool="${esc(x.pool_id)}">${I('liberar')}Liberar</button>`;

function ordenarPor(columna) {
  if (estado.orden === columna) estado.dir = estado.dir === 'asc' ? 'desc' : 'asc';
  else { estado.orden = columna; estado.dir = columna === 'fecha' ? 'desc' : 'asc'; }
  estado.pagina = 0;
  cargar().then(() => { const b = panel.querySelector(`[data-orden="${columna}"]`); if (b) b.focus(); });
}

function pintarPaginacion(total) {
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const desde = total === 0 ? 0 : estado.pagina * POR_PAGINA + 1;
  const hasta = Math.min(total, (estado.pagina + 1) * POR_PAGINA);
  $('a-pag').innerHTML = `
    <span class="muted" role="status">${total === 0 ? 'Sin resultados' : `Mostrando ${fmt(desde)}–${fmt(hasta)} de ${fmt(total)}`}</span>
    <span class="paginacion-botones">
      <button type="button" class="btn sec" id="a-ant" ${estado.pagina === 0 ? 'disabled' : ''}>${I('izquierda')}Anterior</button>
      <span class="num">Página ${fmt(estado.pagina + 1)} de ${fmt(paginas)}</span>
      <button type="button" class="btn sec" id="a-sig" ${estado.pagina >= paginas - 1 ? 'disabled' : ''}>Siguiente${I('derecha')}</button>
    </span>`;
  $('a-ant').onclick = () => { estado.pagina--; cargar(); };
  $('a-sig').onclick = () => { estado.pagina++; cargar(); };
}

async function liberar(boton) {
  const cidr = boton.dataset.c;
  const ok = await confirmar({
    titulo: `¿Liberar ${cidr}?`, peligro: true, confirmar: 'Liberar segmento',
    mensaje: `El segmento ${cidr} del pool ${boton.dataset.pool} quedará disponible para otras solicitudes. La liberación queda registrada en la auditoría.`,
  });
  if (!ok) return;
  const r = await api(`/api/asignaciones/${boton.dataset.del}`, { method: 'DELETE', body: {} });
  if (r.ok) toast(`Segmento ${cidr} liberado.`);
  else toast((r.data && r.data.error) || 'No se pudo liberar el segmento.', 'error');
  await cargar();
}
