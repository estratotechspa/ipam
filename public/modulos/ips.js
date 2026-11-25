// Direcciones IP fijas: pestaña, formularios y tablas (también dentro de las fichas).
import { $, api, errorApi, fail, get, h, ico, msg, puede } from './base.js';
import { abrirDialogo, confirmar, tabla, toast } from './ui.js';
import { fichaAsignacion } from './fichas.js';

/* ===== Direcciones IP fijas (interfaces de router, switch, firewall…) ===== */
export const ROLES_IP = [
  ['interfaz', 'Interfaz'],
  ['gateway', 'Gateway'],
  ['gestion', 'Gestión'],
  ['loopback', 'Loopback'],
  ['vip', 'VIP / HSRP'],
  ['servidor', 'Servidor'],
  ['otro', 'Otro'],
];

export const nombreRol = (r) => (ROLES_IP.find(([v]) => v === r) || [r, r])[1];

export const selectorRol = (id, valor) =>
  h(
    'select',
    { id },
    ROLES_IP.map(([v, t]) => h('option', { value: v, selected: v === (valor || 'interfaz') }, t)),
  );

export const camposIp = (pre, d = {}) => ({
  dispositivo: h('input', { id: pre + '-dispositivo', maxlength: 80, placeholder: 'rtr-core-01', value: d.dispositivo || '' }),
  interfaz: h('input', { id: pre + '-interfaz', maxlength: 80, placeholder: 'Gi0/1', value: d.interfaz || '' }),
  rol: selectorRol(pre + '-rol', d.rol),
  dns: h('input', { id: pre + '-dns', maxlength: 253, placeholder: 'gw.sitio.interno', value: d.dns || '' }),
  descripcion: h('input', { id: pre + '-descripcion', maxlength: 200, value: d.descripcion || '' }),
  excepcion: h('input', { id: pre + '-excepcion', maxlength: 200, placeholder: 'solo si está fuera de un segmento', value: d.excepcion || '' }),
});

export const valoresIp = (c) => Object.fromEntries(Object.entries(c).map(([k, el]) => [k, el.value.trim()]));

/**
 * Formulario para registrar una IP fija. `pool` fijo (fichas) o elegible (pestaña Direcciones IP).
 * @param {{prefijo: string, pool?: string, pools?: any[], alGuardar: Function}} o
 */
export function formularioDireccion({ prefijo, pool, pools, alGuardar }) {
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
export function editarDireccion(d, recargar) {
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
export function tablaDirecciones(lista, recargar, { conSegmento = true } = {}) {
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
export async function panelDirecciones({ filtro, pool, resumen }) {
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
export const IPS = { q: '', aviso: null };

export async function renderIps() {
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
export const ip2n = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

export const n2ip = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
