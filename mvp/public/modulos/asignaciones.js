// Asignaciones definitivas: liberar un segmento y el formulario «Asignar ahora» (la lista está en segmentos.js).
import { api, errorApi, h, ico, msg } from './base.js';
import { confirmarLiberacionDefinitiva, dialogoSimple, toast, vincularCidr } from './ui.js';
import { cargarDisponibilidad } from './disponibilidad.js';

export const ASIG = { formAbierto: false, aviso: null };

export const textoVlan = (x) => (x.vlan ? `${x.vlan}${x.vlan_nombre ? ' · ' + x.vlan_nombre : ''}` : x.vlan_nombre || '—');

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
  if (!(await confirmarLiberacionDefinitiva(cidr))) return false;
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

// Formulario «Asignar ahora» (solo admin): entrega definitiva e inmediata, sin reserva ni aprobación de otra persona.
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
    { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Asignar ahora', onsubmit: enviar },
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
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Asignar ahora (solo admin, sin aprobación)'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Entrega el segmento ',
      h('b', null, 'de inmediato y de forma definitiva'),
      ', sin reserva ni aprobación de otra persona; queda en el historial a tu nombre. Para el flujo normal (pedir, aprobar, asignar) usa «Reservar un segmento».',
    ),
    form,
  );
}
