// Panel lateral (fichas de pool y de segmento), mapa de bloques e historial.
import { mapaBloques } from '../calculos.js';
import { ip2n, n2ip, panelDirecciones } from './ips.js';
import { ESTADO, fechaHora, fmt, get, h, puede, size, todasLasAsignaciones } from './base.js';
import { abrirDialogo, tabla, toast } from './ui.js';
import { barraUso, pct } from './uso.js';
import { accionesPool } from './pools.js';
import { liberarAsignacion, textoVlan } from './asignaciones.js';
import { show } from './navegacion.js';

export function rango(cidr) {
  const [ip, l] = String(cidr).split('/');
  const len = Number(l);
  const total = 2 ** (32 - len);
  const ini = Math.floor(ip2n(ip) / total) * total;
  return { primera: n2ip(ini), ultima: n2ip(ini + total - 1), total, utilizables: len >= 31 ? total : total - 2, len };
}

export const datos = (pares) =>
  h(
    'dl',
    { class: 'datos' },
    pares.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v)]),
  );

export const ACCIONES = {
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

export const describir = (d = {}) =>
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
export async function historial(filtro) {
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
export function abrirPanel(titulo, subtitulo, pestanas) {
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
export const TEXTO_BLOQUE = { libre: 'libre', parcial: 'parcialmente ocupado', ocupado: 'ocupado' };

export function mapaDelPool(p, ocupantes) {
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

export async function fichaPool(id) {
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

export async function fichaAsignacion(id) {
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
                          show(ESTADO.vista);
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
