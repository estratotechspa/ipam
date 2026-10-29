// Asignaciones definitivas: liberar un segmento y los campos compartidos de los formularios (la lista está en segmentos.js).
import { api, h } from './base.js';
import { confirmarLiberacionDefinitiva, dialogoSimple, toast } from './ui.js';
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
