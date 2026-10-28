// Reservas (apartados con vencimiento): formulario «Reservar», cuenta regresiva, confirmar y liberar. La lista está en segmentos.js.
import { $, api, errorApi, h, ico, msg } from './base.js';
import { camposVlan, cuerpoVlan, selectorPoolMascara } from './asignaciones.js';
import { confirmar, vincularCidr } from './ui.js';

// Formulario «Nueva reserva» (solicitante y admin): aparta un rango por un tiempo; un admin debe aprobarla para que sea asignación.
export function formularioNuevaReserva(pools, estado, recargar) {
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
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Reservar un segmento (pide aprobación)'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Reservar un segmento', onsubmit: enviar },
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

export const RES = { filtro: { estado: '', pool: '', solicitante: '' }, timer: null, aviso: null };

export function restante(seg) {
  const d = Math.floor(seg / 86400),
    hh = Math.floor((seg % 86400) / 3600),
    m = Math.floor((seg % 3600) / 60),
    s = seg % 60;
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}

export function tictac() {
  document.querySelectorAll('#segmentos time[data-fin]').forEach((t) => {
    const seg = Math.max(0, Math.round((Number(t.dataset.fin) - Date.now()) / 1000));
    t.textContent = seg ? restante(seg) : 'vencida';
    t.classList.toggle('poco', seg > 0 && seg < 3600);
  });
}

export async function accionReserva(r, que, recargar) {
  const confirmando = que === 'confirmar';
  const texto = confirmando
    ? `¿Confirmar la reserva ${r.cidr} (${r.vpc})? Pasará a asignación definitiva.`
    : `¿Liberar la reserva ${r.cidr}? El rango vuelve al pool.`;
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
  // El aviso se deja en el estado y lo muestra la próxima carga: así no se pierde si otra carga redibuja la pantalla entre medio.
  RES.aviso = {
    texto: x.ok ? (confirmando ? `Reserva ${r.cidr} confirmada: ahora es una asignación definitiva.` : `Reserva ${r.cidr} liberada.`) : errorApi(x),
    tipo: x.ok ? 'ok' : 'error',
  };
  await recargar();
  $('seg-titulo')?.focus();
}

/* ===== Tokens (solo admin) ===== */
export const diasPara = (s) => Math.max(0, Math.ceil((new Date(s) - Date.now()) / 86400000));
