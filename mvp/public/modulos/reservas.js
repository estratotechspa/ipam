// Pestaña Reservas: lista, cuenta regresiva, alta, confirmar y liberar.
import { $, YO, api, errorApi, fail, fechaHora, get, h, ico, msg, puede } from './base.js';
import { camposVlan, cuerpoVlan, selectorPoolMascara, textoVlan } from './asignaciones.js';
import { confirmar, confirmarLiberacionDefinitiva, tabla, vincularCidr } from './ui.js';
import { camposFiltro, pasaFiltro } from './filtro.js';

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
    h('summary', { style: 'cursor:pointer;font-weight:600' }, ico('mas'), 'Nueva reserva'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Nueva reserva', onsubmit: enviar },
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

export function celdaRestante(r) {
  if (r.estado !== 'reservada') return h('td', null, '—');
  const fin = Date.now() + r.segundos_restantes * 1000,
    t = h('time', { class: 'restante', datetime: r.expira_en, title: 'Vence ' + fechaHora(r.expira_en) });
  t.dataset.fin = fin;
  return h('td', null, t);
}

export function tictac() {
  document.querySelectorAll('#reservas time[data-fin]').forEach((t) => {
    const seg = Math.max(0, Math.round((Number(t.dataset.fin) - Date.now()) / 1000));
    t.textContent = seg ? restante(seg) : 'vencida';
    t.classList.toggle('poco', seg > 0 && seg < 3600);
  });
}

let ULTIMA_CARGA = 0; // número de la carga más reciente: una respuesta vieja no debe pisar a una nueva ni rehacer el formulario mientras se escribe
export async function renderReservas() {
  const mia = ++ULTIMA_CARGA;
  const raiz = $('reservas'),
    puedeOperar = (r) => puede('agente') && (YO.rol === 'admin' || r.solicitante === YO.usuario);
  try {
    const f = RES.filtro,
      qs = new URLSearchParams();
    if (f.estado) qs.set('estado', f.estado);
    if (f.pool) qs.set('pool', f.pool);
    const [pools, todas] = await Promise.all([get('/api/v1/pools'), get('/api/v1/reservas' + (String(qs) ? '?' + qs : ''))]);
    if (mia !== ULTIMA_CARGA) return;
    const poolDe = new Map(pools.map((p) => [p.id, p]));
    const lista = todas.filter(
      (r) =>
        (!f.solicitante || r.solicitante.toLowerCase().includes(f.solicitante.toLowerCase())) && poolDe.has(r.pool_id) && pasaFiltro(poolDe.get(r.pool_id)),
    );
    const estado = h('div', { id: 'res-msg', 'aria-live': 'polite' });
    if (RES.aviso) {
      msg(estado, RES.aviso.texto, RES.aviso.tipo);
      RES.aviso = null;
    }
    const filtros = h(
      'form',
      { class: 'filtros', role: 'search', 'aria-label': 'Filtrar reservas', onsubmit: (e) => e.preventDefault() },
      camposFiltro(pools, renderReservas),
      h(
        'label',
        null,
        'Estado',
        h(
          'select',
          {
            id: 'res-f-estado',
            onchange: (e) => {
              f.estado = e.target.value;
              RES.foco = 'res-f-estado';
              renderReservas();
            },
          },
          [
            ['', 'Todos'],
            ['reservada', 'Reservada'],
            ['confirmada', 'Confirmada'],
            ['liberada', 'Liberada'],
            ['expirada', 'Expirada'],
          ].map(([v, t]) => h('option', { value: v, selected: f.estado === v }, t)),
        ),
      ),
      h(
        'label',
        null,
        'Pool',
        h(
          'select',
          {
            id: 'res-f-pool',
            onchange: (e) => {
              f.pool = e.target.value;
              RES.foco = 'res-f-pool';
              renderReservas();
            },
          },
          [h('option', { value: '' }, 'Todos'), ...pools.map((p) => h('option', { value: p.id, selected: f.pool === p.id }, p.id))],
        ),
      ),
      h(
        'label',
        null,
        'Solicitante',
        h('input', {
          id: 'res-f-sol',
          type: 'search',
          value: f.solicitante,
          placeholder: 'svc:agente-redes',
          oninput: (e) => {
            f.solicitante = e.target.value;
            clearTimeout(RES.deb);
            RES.deb = setTimeout(() => {
              RES.foco = 'res-f-sol';
              renderReservas();
            }, 300);
          },
        }),
      ),
    );
    const filas = lista.map((r) =>
      h(
        'tr',
        null,
        h('td', null, h('code', null, r.cidr)),
        h('td', null, r.pool_id),
        h('td', null, r.vpc),
        h('td', null, textoVlan(r)),
        h('td', null, r.solicitante),
        h('td', null, r.ticket),
        h('td', null, h('span', { class: 'tag ' + r.estado }, r.estado)),
        h('td', null, fechaHora(r.creado_en)),
        celdaRestante(r),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'acciones' },
            r.estado === 'reservada' &&
              puedeOperar(r) &&
              h(
                'button',
                { class: 'btn', type: 'button', 'aria-label': 'Confirmar la reserva ' + r.cidr, onclick: () => accionReserva(r, 'confirmar', estado) },
                'Confirmar',
              ),
            (r.estado === 'reservada' || r.estado === 'confirmada') &&
              puedeOperar(r) &&
              h(
                'button',
                { class: 'btn sec', type: 'button', 'aria-label': 'Liberar la reserva ' + r.cidr, onclick: () => accionReserva(r, 'liberar', estado) },
                'Liberar',
              ),
          ),
        ),
      ),
    );
    raiz.replaceChildren(
      h('h2', { id: 'res-titulo', tabindex: '-1' }, 'Reservas'),
      h(
        'p',
        { class: 'muted' },
        'Una reserva aparta un rango por un tiempo. ',
        h('b', null, 'No es definitiva'),
        ': se vuelve asignación solo al confirmarla (tras la aprobación de una persona) y, si no se confirma, expira sola.',
      ),
      puede('solicitante') ? formularioNuevaReserva(pools, estado, renderReservas) : null,
      filtros,
      estado,
      tabla(
        'Reservas de rangos IP',
        ['Segmento', 'Pool', 'Proyecto / VPC', 'VLAN', 'Solicitante', 'Ticket', 'Estado', 'Creada', 'Vence en', 'Acciones'],
        filas,
        'No hay reservas con estos filtros.',
      ),
    );
    clearInterval(RES.timer);
    tictac();
    RES.timer = setInterval(tictac, 1000);
    if (RES.foco) {
      const el = $(RES.foco);
      RES.foco = null;
      if (el) {
        el.focus();
        if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  } catch (e) {
    fail('reservas', e);
  }
}

export async function accionReserva(r, que, zona) {
  const confirmando = que === 'confirmar';
  const texto = confirmando
    ? `¿Confirmar la reserva ${r.cidr} (${r.vpc})? Pasará a asignación definitiva.`
    : `¿Liberar ${r.cidr}?${r.estado === 'confirmada' ? ' Como ya está confirmada, se borrará también la asignación definitiva.' : ''}`;
  if (
    !(await confirmar({
      titulo: confirmando ? 'Confirmar reserva' : 'Liberar reserva',
      mensaje: texto,
      confirmar: confirmando ? 'Confirmar' : 'Liberar',
      peligro: !confirmando,
    }))
  )
    return;
  // Liberar una reserva ya confirmada borra la asignación definitiva: pide la misma segunda confirmación que Asignaciones.
  if (!confirmando && r.estado === 'confirmada' && !(await confirmarLiberacionDefinitiva(r.cidr))) return;
  const x = confirmando ? await api(`/api/v1/reservas/${r.id}/confirmar`, { body: {} }) : await api(`/api/v1/reservas/${r.id}`, { method: 'DELETE', body: {} });
  await renderReservas();
  $('res-titulo').focus();
  msg(
    $('res-msg'),
    x.ok ? (confirmando ? `Reserva ${r.cidr} confirmada: ahora es una asignación definitiva.` : `Reserva ${r.cidr} liberada.`) : errorApi(x),
    x.ok ? 'ok' : 'error',
  );
}

/* ===== Tokens (solo admin) ===== */
export const diasPara = (s) => Math.max(0, Math.ceil((new Date(s) - Date.now()) / 86400000));
