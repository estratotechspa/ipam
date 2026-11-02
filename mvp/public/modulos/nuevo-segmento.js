// Formulario «Nuevo segmento»: una reserva (pide aprobación) o, solo para admin, una asignación definitiva e inmediata.
import { api, errorApi, h, ico, msg, puede } from './base.js';
import { ASIG, camposVlan, cuerpoVlan, selectorPoolMascara } from './asignaciones.js';
import { RES } from './reservas.js';
import { confirmar, vincularCidr } from './ui.js';

export function formularioNuevoSegmento(pools, estado, recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const esAdmin = puede('admin');
  const { pool, mascara, disp } = selectorPoolMascara('ns', pools);
  const vpc = h('input', { id: 'ns-vpc', required: true, maxlength: 120, placeholder: 'vpc-mi-proyecto' });
  const cidr = h('input', { id: 'ns-cidr', placeholder: 'opcional: vacío = el primer rango libre' });
  const vl = camposVlan('ns');
  const ticket = h('input', { id: 'ns-ticket', maxlength: 60, placeholder: 'opcional (si no, se genera NET-xxx)' });
  const ttl = h('input', { id: 'ns-ttl', type: 'number', min: 1, max: 72, value: 24 });
  // Reservar es lo normal y lo seguro: la casilla viene marcada. Quien no es admin no la ve y siempre reserva.
  const reserva = h('input', { id: 'ns-reserva', type: 'checkbox', checked: true });
  const boton = h('button', { class: 'btn', type: 'submit', id: 'ns-go' }, 'Reservar');
  const campoTtl = campo('Vigencia (horas, máx. 72)', ttl);
  const definitivo = h(
    'p',
    { id: 'ns-definitivo', class: 'alert', role: 'status', hidden: true, style: 'flex:1 1 100%;margin:0' },
    ico('alerta'),
    ' Se entrega ',
    h('b', null, 'de inmediato y de forma definitiva'),
    ', sin reserva ni aprobación de otra persona; queda en el historial a tu nombre.',
  );
  const res = h('div', { id: 'ns-res', 'aria-live': 'polite', style: 'flex:1 1 100%' });
  const esReserva = () => !esAdmin || reserva.checked;
  const actualizarModo = () => {
    const r = esReserva();
    campoTtl.hidden = !r;
    definitivo.hidden = r;
    boton.textContent = r ? 'Reservar' : 'Asignar ahora';
    boton.classList.toggle('peligro', !r);
  };
  reserva.addEventListener('change', actualizarModo);
  const revisarCidr = vincularCidr(cidr, boton, () => (pools.find((x) => x.id === pool.value) || {}).cidr);
  pool.addEventListener('change', revisarCidr);

  /** Un solapamiento se explica igual al reservar y al asignar: con quién choca y qué rangos libres hay. */
  const solapamiento = (d, pedido) =>
    res.replaceChildren(
      h(
        'div',
        { class: 'alert', role: 'alert' },
        h('b', null, ico('alerta'), ' Solapamiento detectado'),
        h('br'),
        `${pedido || 'El rango pedido'} se cruza con ${d.conflicto.cidr} de ${d.conflicto.vpc} (pidió ${d.conflicto.solicitante}, ticket ${d.conflicto.ticket}). No se creó nada.`,
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

  const enviar = async (e) => {
    e.preventDefault();
    res.replaceChildren();
    if (!pool.value) return msg(res, 'Elige un pool.', 'error');
    if (!cidr.value.trim() && !mascara.value) return msg(res, 'Elige una máscara o escribe un CIDR.', 'error');
    const comoReserva = esReserva();
    const cuerpo = { pool: pool.value, vpc: vpc.value.trim(), ...cuerpoVlan(vl) };
    if (cidr.value.trim()) cuerpo.cidr = cidr.value.trim();
    else cuerpo.mascara = +mascara.value;
    if (ticket.value.trim()) cuerpo.ticket = ticket.value.trim();
    if (comoReserva) cuerpo.ttl_horas = +ttl.value || 24;
    else if (
      !(await confirmar({
        titulo: '¿Asignar ahora, sin aprobación?',
        mensaje: `${cuerpo.cidr || `Un /${cuerpo.mascara}`} en ${cuerpo.pool} para ${cuerpo.vpc}. Se entrega de forma definitiva y de inmediato; para deshacerlo hay que liberar el segmento.`,
        confirmar: 'Asignar ahora',
        peligro: true,
      }))
    )
      return;
    boton.disabled = true;
    const r = comoReserva
      ? await api('/api/v1/reservas', { body: cuerpo, headers: { 'Idempotency-Key': crypto.randomUUID() } })
      : await api('/api/v1/solicitudes', { body: cuerpo });
    boton.disabled = false;
    const d = r.data || {};
    if (r.ok) {
      if (comoReserva)
        RES.aviso = {
          texto: `Reservado ${d.cidr} en ${d.pool_id} por ${ttl.value || 24} h. Falta la aprobación de un admin para que sea asignación; si no se aprueba, expira sola.`,
          tipo: 'ok',
        };
      else ASIG.aviso = `Asignado ${d.cidr} (${d.codigo || 'sin ID'}) en ${d.pool_id} para ${d.vpc}. Ticket ${d.ticket}.`;
      ASIG.formAbierto = false;
      return recargar();
    }
    if (d.error === 'solapamiento' && d.conflicto) return solapamiento(d, cuerpo.cidr);
    msg(res, errorApi(r) + (d.sugeridos ? ' Libres sugeridos: ' + d.sugeridos.join(', ') : ''), 'error');
  };

  return h(
    'details',
    { class: 'card', style: 'margin:0 0 14px', open: ASIG.formAbierto, ontoggle: (e) => (ASIG.formAbierto = e.target.open) },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Nuevo segmento'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Nuevo segmento', onsubmit: enviar },
      esAdmin
        ? h(
            'label',
            { class: 'casilla', style: 'flex:1 1 100%' },
            reserva,
            ' Es una reserva ',
            h('span', { class: 'muted' }, '(pide aprobación; si nadie la aprueba, expira sola). Desmárcala para asignar de inmediato.'),
          )
        : null,
      campo('Pool', pool),
      campo('Proyecto / VPC', vpc),
      campo('Máscara', mascara),
      campo('CIDR manual', cidr),
      campo('VLAN (opcional)', vl.vlan),
      campo('Nombre VLAN / subred (opcional)', vl.vlanNombre),
      campo('Ticket', ticket),
      campoTtl,
      definitivo,
      boton,
      res,
      disp,
    ),
  );
}
