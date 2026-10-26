// Pestaña «Pools»: tablero con los totales, tabla con barras de uso y vista de detalle de cada pool (mapa de bloques).
import { $, esc, fmt, fecha, tag, I, cargando, falla } from './util.js';
import { get, puede } from './api.js';
import { mapaBloques, nivelUso, porcentaje, resumirPools, tamanoCidr } from './calculos.js';

const ETIQUETA_NIVEL = { bajo: 'uso bajo', medio: 'uso medio', alto: 'uso alto' };

// Barra de uso con el porcentaje en número y color por umbral (verde < 70 %, ámbar 70–90 %, rojo > 90 %).
// El color no es lo único que informa: el número, la etiqueta oculta y, en uso alto, un icono.
export function barraUso(uso) {
  const nivel = nivelUso(uso);
  const p = porcentaje(uso);
  return `<div class="uso">
    <div class="bar" role="img" aria-label="${p}, ${ETIQUETA_NIVEL[nivel]}"><i class="uso-${nivel}" style="width:${Math.min(Math.max(uso * 100, 1), 100)}%"></i></div>
    <span class="uso-pct uso-txt-${nivel} num">${nivel === 'alto' ? I('alerta') : ''}${p}</span>
  </div>`;
}

export async function mostrar(panel, idPool) {
  return idPool ? detalle(panel, idPool) : lista(panel);
}

async function lista(panel) {
  cargando(panel);
  try {
    const pools = await get('/api/pools');
    const r = resumirPools(pools);
    panel.removeAttribute('aria-busy');
    panel.innerHTML = `
      <div class="cabecera"><h2 tabindex="-1">Estado de pools</h2>
        <a class="btn sec" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a></div>
      <div class="kpis">
        ${kpi(fmt(r.pools), 'Pools')}
        ${kpi(fmt(r.asignaciones), 'Asignaciones activas')}
        ${kpi(porcentaje(r.usoPromedio), 'Uso promedio')}
        ${kpi(fmt(r.sobre80), 'Pools sobre 80 %', r.sobre80 ? 'uso-txt-alto' : '')}
        ${kpi(fmt(r.libres), 'Espacio libre (direcciones)')}
      </div>
      <p class="nota">${I('info')} Los solapamientos no son un indicador: la base de datos los impide con una restricción de exclusión.</p>
      <div class="card tablewrap" tabindex="0" role="region" aria-label="Pools">
        <table>
          <thead><tr><th scope="col">Pool</th><th scope="col">Tipo</th><th scope="col">Ambiente</th><th scope="col">Proveedor</th>
            <th scope="col">CIDR base</th><th scope="col">Asig.</th><th scope="col">Uso</th></tr></thead>
          <tbody>${pools.map(fila).join('')}</tbody>
        </table>
      </div>`;
    panel.querySelectorAll('[data-pool]').forEach((b) => { b.onclick = () => { location.hash = `#pools/${encodeURIComponent(b.dataset.pool)}`; }; });
  } catch (e) { falla(panel, e, () => lista(panel)); }
}

const kpi = (valor, texto, clase = '') => `<div class="card"><div class="kpi ${clase}">${valor}</div><div class="sub">${texto}</div></div>`;
const fila = (p) => `<tr>
  <td><button type="button" class="enlace" data-pool="${esc(p.id)}" title="Ver el detalle de ${esc(p.id)}">${esc(p.id)}</button></td>
  <td>${esc(p.tipo)}</td><td>${tag(p.ambiente)}</td><td>${esc(p.proveedor)}</td><td><code>${esc(p.cidr)}</code></td>
  <td class="num">${p.asignaciones}</td><td>${barraUso(p.uso)}</td></tr>`;

// ---------- Detalle de un pool ----------
// Trae todas las asignaciones del pool (la API entrega hasta 200 por página).
async function asignacionesDe(id) {
  const todas = [];
  for (let desde = 0; ; desde += 200) {
    const url = `/api/asignaciones?pool=${encodeURIComponent(id)}&orden=cidr&dir=asc&limit=200&offset=${desde}`;
    const pagina = await get(url);
    todas.push(...pagina);
    if (pagina.length < 200 || desde > 5000) return todas;
  }
}

async function detalle(panel, id) {
  cargando(panel);
  try {
    const [pools, asignaciones] = await Promise.all([get('/api/pools'), asignacionesDe(id)]);
    const p = pools.find((x) => x.id === id);
    if (!p) throw new Error(`el pool «${id}» no existe`);
    const mapa = mapaBloques(p.cidr, asignaciones);
    panel.removeAttribute('aria-busy');
    panel.innerHTML = `
      <p><a class="btn sec" href="#pools">${I('volver')}Volver a pools</a></p>
      <div class="cabecera"><h2 tabindex="-1">${esc(p.id)} ${tag(p.ambiente)}</h2>
        ${puede('solicitante') ? `<a class="btn" href="#sol/${encodeURIComponent(p.id)}">${I('mas')}Solicitar un segmento aquí</a>` : ''}</div>
      <p class="muted">${esc(p.tipo)} · ${esc(p.proveedor)} · <code>${esc(p.cidr)}</code></p>
      <div class="kpis">
        ${kpi(porcentaje(p.uso), 'Uso')}
        ${kpi(fmt(p.usadas), 'Direcciones asignadas')}
        ${kpi(fmt(p.libres), 'Direcciones libres')}
        ${kpi(fmt(p.asignaciones), 'Segmentos')}
      </div>
      <div class="card" style="margin-top:var(--sp-4)">
        <h3 style="margin-top:0">Mapa del espacio</h3>
        ${dibujarMapa(p, mapa)}
      </div>
      <div class="card tablewrap" style="margin-top:var(--sp-4)" tabindex="0" role="region" aria-label="Asignaciones de ${esc(p.id)}">
        <h3 style="margin-top:0">Asignaciones</h3>
        ${asignaciones.length ? `<table>
          <thead><tr><th scope="col">Segmento</th><th scope="col">Proyecto / VPC</th><th scope="col">Direcciones</th>
            <th scope="col">Solicitó</th><th scope="col">Ticket</th><th scope="col">Fecha</th></tr></thead>
          <tbody>${asignaciones.map((a) => `<tr><td><code>${esc(a.cidr)}</code></td><td>${esc(a.vpc)}</td><td class="num">${fmt(tamanoCidr(a.cidr))}</td>
            <td>${esc(a.solicitante)}</td><td>${esc(a.ticket)}</td><td>${fecha(a.creado_en)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Este pool no tiene segmentos asignados: todo su espacio está libre.</p>'}
      </div>`;
    activarMapa(panel);
  } catch (e) { falla(panel, e, () => detalle(panel, id)); }
}

const TEXTO_ESTADO = { libre: 'libre', parcial: 'parcialmente ocupado', ocupado: 'ocupado' };

function dibujarMapa(p, { granularidad, bloques, resumen }) {
  const columnas = Math.min(16, bloques.length);
  const resumenTexto = `${bloques.length} bloques /${granularidad}: ${resumen.libre} libres, ${resumen.parcial} parciales, ${resumen.ocupado} ocupados`;
  const celdas = bloques.map((b) => {
    const quien = b.asignaciones.map((a) => `${a.vpc} (${a.cidr}, ${a.ticket})`).join('; ');
    const texto = `${b.cidr} · ${TEXTO_ESTADO[b.estado]}${quien ? ` · ${quien}` : ''}`;
    return `<div class="bloque bloque-${b.estado}" data-texto="${esc(texto)}" title="${esc(texto)}"></div>`;
  }).join('');
  return `
    <p class="muted">Cada cuadro es un bloque /${granularidad} (${fmt(2 ** (32 - granularidad))} ${2 ** (32 - granularidad) === 1 ? 'dirección' : 'direcciones'}) de ${esc(p.cidr)}.
      Pasa el cursor por un bloque para ver quién lo usa; la tabla de abajo tiene el mismo detalle.</p>
    <div class="mapa" style="--cols:${columnas}" role="img" aria-label="Mapa de ${esc(p.id)}: ${esc(resumenTexto)}">${celdas}</div>
    <p class="mapa-detalle" id="mapa-detalle" aria-live="polite">&nbsp;</p>
    <ul class="leyenda">
      <li><span class="bloque bloque-libre"></span> Libre (${resumen.libre})</li>
      <li><span class="bloque bloque-parcial"></span> Parcial (${resumen.parcial})</li>
      <li><span class="bloque bloque-ocupado"></span> Ocupado (${resumen.ocupado})</li>
    </ul>`;
}

function activarMapa(panel) {
  const linea = $('mapa-detalle');
  panel.querySelectorAll('.mapa .bloque').forEach((b) => {
    b.addEventListener('mouseenter', () => { linea.textContent = b.dataset.texto; });
  });
  const mapa = panel.querySelector('.mapa');
  if (mapa) mapa.addEventListener('mouseleave', () => { linea.innerHTML = '&nbsp;'; });
}
