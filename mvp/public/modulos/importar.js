// Importación masiva de segmentos (simular y aplicar).
import { $, api, errorApi, h, ico, msg } from './base.js';
import { show } from './navegacion.js';
import { confirmar } from './ui.js';

// ---- Pestaña Importar (admin): segmentos que ya existen (Excel/CSV). Primero se SIMULA (no escribe nada), luego se aplica. ----
export const IMP = { archivo: null, sim: null, aprobadas: new Set(), filtro: '', defectos: { proveedor: '', ambiente: '', tipo: '' } };

export const ESTADO_IMP = {
  ok: ['imp-ok', 'Listo para importar'],
  ya_existe: ['imp-omitida', 'Ya registrado (se omite)'],
  solapa_otro_pool: ['imp-aviso', 'Solapa con otro pool: requiere aprobación'],
  choca_mismo_pool: ['imp-error', 'Choca dentro del mismo pool'],
  invalida: ['imp-error', 'Inválida'],
};

export const aBase64 = (buf) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const cuerpoImportacion = () => ({ ...IMP.archivo, ...Object.fromEntries(Object.entries(IMP.defectos).filter(([, v]) => v)) });

export async function renderImportar() {
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

export function resultadoSimulacion(estado) {
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
