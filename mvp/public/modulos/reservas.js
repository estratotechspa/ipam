// Reservas (apartados con vencimiento): cuenta regresiva, confirmar y liberar. La lista está en segmentos.js; el alta, en nuevo-segmento.js.
import { $, api, errorApi } from './base.js';
import { confirmar } from './ui.js';

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
