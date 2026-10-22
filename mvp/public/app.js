const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('es-CL');
const fecha = (s) => new Date(s).toLocaleDateString('es-CL');
const size = (c) => 2 ** (32 - Number(c.split('/')[1]));
const tag = (a) => `<span class="tag ${esc(a)}">${esc(a)}</span>`;
const CAB = { 'X-Requested-With': 'ipam' };
async function api(url, opt) {
  const init =
    opt && opt.body !== undefined
      ? { method: opt.method || 'POST', headers: { 'Content-Type': 'application/json', ...CAB }, body: JSON.stringify(opt.body) }
      : { headers: CAB, method: (opt && opt.method) || 'GET' };
  const r = await fetch(url, init);
  if (r.status === 401 && YO.modo === 'oidc') {
    location.href = '/auth/login?next=' + encodeURIComponent(location.pathname);
    return { ok: false, status: 401, data: null };
  }
  let j = null;
  try {
    j = await r.json();
  } catch (e) {}
  return { ok: r.ok, status: r.status, data: j };
}
let YO = { modo: 'none', rol: 'admin', usuario: '', nombre: '' };
const NIVEL = { lector: 0, agente: 1, solicitante: 2, admin: 3 };
const puede = (min) => NIVEL[YO.rol] >= NIVEL[min];
const get = async (u) => {
  const r = await api(u);
  if (!r.ok) throw new Error('Error ' + r.status);
  return r.data;
};

function show(t) {
  if (!$(t) || $('nav').querySelector('[data-t="' + t + '"]').hidden) t = 'pools';
  clearInterval(RES.timer);
  document.querySelectorAll('.wrap').forEach((w) => w.classList.toggle('hide', w.id !== t));
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.t === t);
    if (b.dataset.t === t) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  render(t);
}
$('nav').onclick = (e) => {
  if (e.target.dataset.t) show(e.target.dataset.t);
};
const fail = (id, e) => ($(id).innerHTML = `<div class="alert">No se pudo cargar: ${esc(e.message)}</div>`);

async function renderPools() {
  try {
    const [pools, r] = await Promise.all([get('/api/pools'), get('/api/resumen')]);
    $('pools').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2>Estado de pools</h2><a class="btn sec" href="/api/exportar.xlsx" download>⬇ Exportar a Excel</a></div>
  <div class="row"><div class="card"><div class="kpi">${r.pools}</div><div class="sub">Pools</div></div>
  <div class="card"><div class="kpi">${r.asignaciones}</div><div class="sub">Asignaciones activas</div></div>
  <div class="card"><div class="kpi">${(r.uso_promedio * 100).toFixed(1).replace('.', ',')}%</div><div class="sub">Uso promedio</div></div>
  <div class="card"><div class="kpi">${r.solapamientos}</div><div class="sub">Solapamientos (la base de datos los impide)</div></div></div>
  <div class="card tablewrap" style="margin-top:16px"><table><tr><th>Pool</th><th>Tipo</th><th>Ambiente</th><th>Proveedor</th><th>CIDR base</th><th>Asig.</th><th>Uso</th></tr>
  ${pools
    .map(
      (
        p,
      ) => `<tr><td>${esc(p.id)}</td><td>${esc(p.tipo)}</td><td>${tag(p.ambiente)}</td><td>${esc(p.proveedor)}</td><td><code>${esc(p.cidr)}</code></td><td>${p.asignaciones}</td>
  <td><div class="bar" title="${(p.uso * 100).toFixed(2)}%"><i style="width:${Math.max(p.uso * 100, 1)}%"></i></div></td></tr>`,
    )
    .join('')}</table></div>`;
  } catch (e) {
    fail('pools', e);
  }
}

async function renderAsig() {
  try {
    const a = await get('/api/asignaciones');
    $('asig').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2>Asignaciones</h2><span><a class="btn" href="/api/exportar.xlsx" download>⬇ Exportar a Excel</a> ${puede('admin') ? '<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">⬇ Respaldo JSON</a>' : ''}</span></div><div class="card tablewrap"><table><tr><th>Segmento</th><th>Pool</th><th>Proyecto / VPC</th><th>Direcciones</th><th>Solicitó</th><th>Origen</th><th>Ticket</th><th>Fecha</th><th></th></tr>
  ${a
    .map(
      (
        x,
      ) => `<tr><td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${esc(x.vpc)}</td><td>${fmt(size(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${fecha(x.creado_en)}</td>
  <td>${puede('admin') ? `<button class="btn sec" data-del="${x.id}" data-c="${esc(x.cidr)}">Liberar</button>` : ''}</td></tr>`,
    )
    .join('')}</table></div>`;
    $('asig')
      .querySelectorAll('[data-del]')
      .forEach(
        (b) =>
          (b.onclick = async () => {
            if (!confirm('¿Liberar ' + b.dataset.c + '?')) return;
            await api('/api/asignaciones/' + b.dataset.del, { method: 'DELETE', body: {} });
            renderAsig();
          }),
      );
  } catch (e) {
    fail('asig', e);
  }
}

let pools = [];
async function renderSol() {
  try {
    pools = await get('/api/pools');
  } catch (e) {
    return fail('sol', e);
  }
  $('sol').innerHTML = `<h2>Solicitar segmento</h2><div class="row"><div class="card" style="max-width:420px;flex:none;width:100%">
  <label>Pool</label><select id="s-pool">${pools.map((p) => `<option value="${esc(p.id)}" ${p.id === 'gke-pods-prod' ? 'selected' : ''}>${esc(p.id)} (${esc(p.cidr)})</option>`).join('')}</select>
  <label>Proyecto / VPC</label><input id="s-vpc" value="vpc-pagos">
  <label>CIDR manual (opcional; vacío = asignar el primer libre)</label><input id="s-cidr" value="10.64.8.0/22" placeholder="10.64.16.0/22">
  <label>Máscara (si no hay CIDR manual)</label><select id="s-len">${[16, 18, 19, 20, 21, 22, 23, 24, 26, 28].map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select>
  <p><button class="btn" id="s-go">Solicitar</button></p></div>
  <div class="card" id="s-res"><p class="muted">Prueba un CIDR que choque con uno existente (ej. 10.64.8.0/22 en gke-pods-prod): la base de datos lo rechaza y se sugieren segmentos libres.</p></div></div>`;
  $('s-go').onclick = solicitar;
}

async function solicitar() {
  const body = { pool: $('s-pool').value, vpc: $('s-vpc').value.trim(), cidr: $('s-cidr').value.trim() || undefined, mascara: +$('s-len').value };
  const res = $('s-res');
  $('s-go').disabled = true;
  const r = await api('/api/solicitudes', { body });
  $('s-go').disabled = false;
  const d = r.data || {};
  if (r.ok) {
    res.innerHTML = `<div class="ok">✔ Asignado <code>${esc(d.cidr)}</code> en ${esc(d.pool_id)} para ${esc(d.vpc)}. Jira creó el ticket <b>${esc(d.ticket)}</b>.</div><p class="muted">Míralo en la pestaña Asignaciones.</p>`;
    return;
  }
  if (d.error === 'solapamiento') {
    const x = d.conflicto,
      len = (body.cidr || '').split('/')[1];
    res.innerHTML = `<div class="alert"><b>⚠ Solapamiento detectado</b><br><code>${esc(body.cidr)}</code> se cruza con <code>${esc(x.cidr)}</code> asignado a <b>${esc(x.vpc)}</b> por <b>${esc(x.solicitante)}</b> el ${fecha(x.creado_en)} (ticket ${esc(x.ticket)}).</div>
    <b>Segmentos libres sugeridos (/${esc(len)})</b><br><br>${d.sugeridos.length ? d.sugeridos.map((s) => `<div class="sug"><code>${esc(s)}</code><button class="btn" data-use="${esc(s)}">Usar</button></div>`).join('') : '<p class="muted">No hay segmentos libres de ese tamaño.</p>'}`;
    res.querySelectorAll('[data-use]').forEach(
      (b) =>
        (b.onclick = () => {
          $('s-cidr').value = b.dataset.use;
          solicitar();
        }),
    );
    return;
  }
  res.innerHTML = `<div class="alert">${esc(d.error || 'Error ' + r.status)}</div>`;
}

async function renderJira() {
  let ev = [],
    je = { activa: false };
  try {
    ev = await get('/api/eventos');
    je = await get('/api/jira/estado');
  } catch (e) {}
  const estado = je.activa
    ? je.faltantes.length
      ? `<span class="tag prod">Activa · faltan: ${esc(je.faltantes.join(', '))}</span>`
      : '<span class="tag dev">Activa</span>'
    : '<span class="tag qa">Desactivada (simulada)</span>';
  const linea = (e) => `${new Date(e.ts).toLocaleTimeString('es-CL')}  ${e.tipo}  ${JSON.stringify(e.detalle)}`;
  $('jira').innerHTML = `<h2>Integración bidireccional con Jira ${estado}</h2>
  <div class="card"><b>Sentido 1 · IPAM → Jira</b><div class="flow"><div class="box">Panel / API<br>solicita segmento</div><span class="arrow">→</span><div class="box">IPAM<br>valida y asigna</div><span class="arrow">→</span><div class="box jira">Jira crea ticket<br>NET-1xx</div><span class="arrow">→</span><div class="box">Guarda<br>ticket_jira_id</div></div>
  <span class="muted">Con la integración desactivada, el número de ticket lo genera el IPAM (secuencia NET-xxx). Al activarla (JIRA_ENABLED=true) se crea el ticket real en Jira.</span></div>
  <div class="card" style="margin-top:16px"><b>Sentido 2 · Jira → IPAM</b><div class="flow"><div class="box jira">Ticket «Solicitud de Segmento IPAM»<br>ambiente, tipo, pool, máscara, VPC</div><span class="arrow">→</span><div class="box">Webhook<br>(firmado HMAC)</div><span class="arrow">→</span><div class="box">IPAM calcula<br>y asigna</div><span class="arrow">→</span><div class="box jira">Actualiza ticket<br>con el rango</div></div>
  <div class="row"><div style="flex:1;min-width:240px"><b>Simular ticket entrante</b>
   <label>Ambiente</label><select id="j-amb"><option>prod</option><option>qa</option><option>dev</option></select>
   <label>Tipo</label><select id="j-tipo"><option>Nodos</option><option selected>Pods</option><option>Servicios</option><option>Control plane</option></select>
   <label>Máscara</label><select id="j-len">${[16, 20, 22, 24, 28].map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select>
   <label>VPC</label><input id="j-vpc" value="vpc-nueva"><p><button class="btn" id="j-go">Enviar webhook</button></p></div>
  <div style="flex:2;min-width:260px"><b>Registro de eventos</b><div class="log">${esc(ev.map(linea).join('\n')) || '(sin eventos)'}</div></div></div></div>`;
  $('j-go').onclick = async () => {
    $('j-go').disabled = true;
    await api('/api/jira/simular', {
      body: { ambiente: $('j-amb').value, tipo: $('j-tipo').value, mascara: +$('j-len').value, vpc: $('j-vpc').value.trim() || 'vpc-sin-nombre' },
    });
    renderJira();
  };
}

async function renderUsuarios() {
  try {
    const u = await get('/api/usuarios');
    $('usuarios').innerHTML =
      `<h2>Usuarios</h2><p class="muted">El rol asignado aquí rige desde el próximo inicio de sesión de cada persona. «Heredar» usa los grupos / la configuración del proveedor.</p>
  <div class="card tablewrap"><table><tr><th>Correo</th><th>Nombre</th><th>Último acceso</th><th>Rol asignado</th></tr>
  ${
    u
      .map(
        (x) => `<tr><td>${esc(x.email)}</td><td>${esc(x.nombre)}</td><td>${x.ultimo_acceso ? new Date(x.ultimo_acceso).toLocaleString('es-CL') : '—'}</td>
  <td><select data-u="${esc(x.email)}"><option value="">Heredar</option>${['lector', 'solicitante', 'admin'].map((r) => `<option ${x.rol === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td></tr>`,
      )
      .join('') || '<tr><td colspan="4" class="muted">Nadie ha iniciado sesión todavía.</td></tr>'
  }</table></div>`;
    $('usuarios')
      .querySelectorAll('select[data-u]')
      .forEach(
        (s) =>
          (s.onchange = async () => {
            const r = await api('/api/usuarios/' + encodeURIComponent(s.dataset.u), { method: 'PUT', body: { rol: s.value || null } });
            if (!r.ok) alert((r.data && r.data.error) || 'No se pudo guardar');
            renderUsuarios();
          }),
      );
  } catch (e) {
    fail('usuarios', e);
  }
}
async function renderAudit() {
  try {
    const a = await get('/api/auditoria');
    $('audit').innerHTML =
      `<h2>Auditoría</h2><div class="card tablewrap"><table><tr><th>Fecha</th><th>Usuario</th><th>Rol</th><th>Acción</th><th>Detalle</th></tr>
  ${a.map((x) => `<tr><td>${new Date(x.ts).toLocaleString('es-CL')}</td><td>${esc(x.usuario)}</td><td>${esc(x.rol || '—')}</td><td>${esc(x.accion)}</td><td><code>${esc(JSON.stringify(x.detalle))}</code></td></tr>`).join('')}</table></div>`;
  } catch (e) {
    fail('audit', e);
  }
}

/* ===== Ayudante para construir DOM sin innerHTML: todo texto entra como nodo de texto (nada de lo que escriba un usuario se interpreta como HTML) ===== */
const h = (tag, attrs, ...hijos) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
};
const fechaHora = (s) => (s ? new Date(s).toLocaleString('es-CL') : '—');
const msg = (el, texto, tipo) => {
  el.replaceChildren(texto ? h('div', { class: tipo === 'ok' ? 'ok' : 'alert', role: tipo === 'ok' ? 'status' : 'alert' }, texto) : '');
};
const errorApi = (r) => (r.data && (r.data.mensaje || r.data.error)) || 'Error ' + r.status;
function tabla(titulo, cabeceras, filas, vacio) {
  if (!filas.length) return h('div', { class: 'card vacio' }, vacio);
  return h(
    'div',
    { class: 'card tablewrap' },
    h(
      'table',
      null,
      h('caption', { class: 'sr-only' }, titulo),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          cabeceras.map((c) => h('th', { scope: 'col' }, c)),
        ),
      ),
      h('tbody', null, filas),
    ),
  );
}

/* ===== Reservas (todos los roles; opera según permisos: dueño o admin) ===== */
const RES = { filtro: { estado: '', pool: '', solicitante: '' }, timer: null };
function restante(seg) {
  const d = Math.floor(seg / 86400),
    hh = Math.floor((seg % 86400) / 3600),
    m = Math.floor((seg % 3600) / 60),
    s = seg % 60;
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}
function celdaRestante(r) {
  if (r.estado !== 'reservada') return h('td', null, '—');
  const fin = Date.now() + r.segundos_restantes * 1000,
    t = h('time', { class: 'restante', datetime: r.expira_en, title: 'Vence ' + fechaHora(r.expira_en) });
  t.dataset.fin = fin;
  return h('td', null, t);
}
function tictac() {
  document.querySelectorAll('#reservas time[data-fin]').forEach((t) => {
    const seg = Math.max(0, Math.round((Number(t.dataset.fin) - Date.now()) / 1000));
    t.textContent = seg ? restante(seg) : 'vencida';
    t.classList.toggle('poco', seg > 0 && seg < 3600);
  });
}
async function renderReservas() {
  const raiz = $('reservas'),
    puedeOperar = (r) => puede('agente') && (YO.rol === 'admin' || r.solicitante === YO.usuario);
  try {
    const f = RES.filtro,
      qs = new URLSearchParams();
    if (f.estado) qs.set('estado', f.estado);
    if (f.pool) qs.set('pool', f.pool);
    const [pools, todas] = await Promise.all([get('/api/v1/pools'), get('/api/v1/reservas' + (String(qs) ? '?' + qs : ''))]);
    const lista = todas.filter((r) => !f.solicitante || r.solicitante.toLowerCase().includes(f.solicitante.toLowerCase()));
    const estado = h('div', { id: 'res-msg', 'aria-live': 'polite' });
    const filtros = h(
      'form',
      { class: 'filtros', role: 'search', 'aria-label': 'Filtrar reservas', onsubmit: (e) => e.preventDefault() },
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
      filtros,
      estado,
      tabla(
        'Reservas de rangos IP',
        ['Segmento', 'Pool', 'Proyecto / VPC', 'Solicitante', 'Ticket', 'Estado', 'Creada', 'Vence en', 'Acciones'],
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
async function accionReserva(r, que, zona) {
  const confirmando = que === 'confirmar';
  const texto = confirmando
    ? `¿Confirmar la reserva ${r.cidr} (${r.vpc})? Pasará a asignación definitiva.`
    : `¿Liberar ${r.cidr}?${r.estado === 'confirmada' ? ' Como ya está confirmada, se borrará también la asignación definitiva.' : ''}`;
  if (!confirm(texto)) return;
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
const diasPara = (s) => Math.max(0, Math.ceil((new Date(s) - Date.now()) / 86400000));
async function renderTokens() {
  const raiz = $('tokens');
  try {
    const lista = await get('/api/v1/tokens');
    const estado = h('div', { id: 'tk-msg', 'aria-live': 'polite' });
    const filas = lista.map((t) =>
      h(
        'tr',
        null,
        h('td', null, t.nombre),
        h('td', null, h('code', null, t.prefijo + '…')),
        h('td', null, t.rol),
        h('td', null, fecha(t.expira_en), ' ', t.por_vencer && h('span', { class: 'tag pronto' }, 'vence en ' + diasPara(t.expira_en) + ' d')),
        h('td', null, t.ultimo_uso ? fechaHora(t.ultimo_uso) : 'nunca'),
        h('td', null, h('span', { class: 'tag ' + t.estado }, t.estado)),
        h(
          'td',
          null,
          t.estado === 'activo'
            ? h(
                'button',
                { class: 'btn peligro', type: 'button', 'aria-label': 'Revocar el token ' + t.nombre, onclick: () => revocarToken(t, estado) },
                'Revocar',
              )
            : null,
        ),
      ),
    );
    raiz.replaceChildren(
      h(
        'div',
        { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px' },
        h('h2', { id: 'tk-titulo', tabindex: '-1' }, 'Tokens de servicio'),
        h('button', { class: 'btn', type: 'button', id: 'tk-nuevo', onclick: () => dialogoToken(estado) }, 'Crear token'),
      ),
      h(
        'p',
        { class: 'muted' },
        'Credenciales para agentes y sistemas (no para personas). El token se muestra una sola vez al crearlo; aquí solo queda su prefijo. Rotar: crea uno nuevo, actualiza el agente y revoca el anterior.',
      ),
      estado,
      tabla('Tokens de servicio', ['Nombre', 'Prefijo', 'Rol', 'Vence', 'Último uso', 'Estado', 'Acciones'], filas, 'Todavía no hay tokens.'),
    );
  } catch (e) {
    fail('tokens', e);
  }
}
async function revocarToken(t, zona) {
  if (!confirm(`¿Revocar el token «${t.nombre}»? Los agentes que lo usen dejarán de funcionar de inmediato.`)) return;
  const r = await api('/api/v1/tokens/' + t.id, { method: 'DELETE', body: {} });
  await renderTokens();
  $('tk-titulo').focus();
  msg($('tk-msg'), r.ok ? `Token «${t.nombre}» revocado.` : errorApi(r), r.ok ? 'ok' : 'error');
}
function dialogoToken(zona) {
  const dlg = h('dialog', { id: 'tk-dlg', 'aria-labelledby': 'tk-dlg-t' });
  const cierre = () => {
    const v = dlg.querySelector('#tk-valor');
    if (v) v.value = '';
    dlg.close();
  };
  dlg.addEventListener('close', async () => {
    dlg.remove();
    await renderTokens();
    const b = $('tk-nuevo');
    if (b) b.focus();
  });
  const error = h('div', { id: 'tk-err', 'aria-live': 'assertive' });
  const nombre = h('input', {
    id: 'tk-nombre',
    name: 'nombre',
    required: true,
    pattern: '[a-z0-9][a-z0-9\\-]{1,40}',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'tk-nombre-ayuda',
  });
  const rol = h(
    'select',
    { id: 'tk-rol', name: 'rol' },
    h('option', { value: 'agente', selected: true }, 'agente (reserva, confirma y libera las suyas)'),
    h('option', { value: 'lector' }, 'lector (solo consulta)'),
  );
  const dias = h('input', { id: 'tk-dias', name: 'expira_dias', type: 'number', min: '1', max: '365', value: '90', required: true });
  const cuota = h('input', { id: 'tk-cuota', name: 'cuota_reservas', type: 'number', min: '1', placeholder: '(la general)' });
  const enviar = h('button', { class: 'btn', type: 'submit', id: 'tk-crear' }, 'Crear token');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        enviar.disabled = true;
        const body = { nombre: nombre.value.trim(), rol: rol.value, expira_dias: Number(dias.value) };
        if (cuota.value) body.cuota_reservas = Number(cuota.value);
        const r = await api('/api/v1/tokens', { body });
        enviar.disabled = false;
        if (!r.ok) {
          msg(error, errorApi(r), 'error');
          return;
        }
        mostrarToken(dlg, r.data, cierre);
      },
    },
    h('h3', { id: 'tk-dlg-t' }, 'Crear token de servicio'),
    h('label', { for: 'tk-nombre' }, 'Nombre'),
    nombre,
    h('p', { class: 'ayuda', id: 'tk-nombre-ayuda' }, 'Minúsculas, números y guiones (p. ej. agente-redes). Debe ser único.'),
    h('label', { for: 'tk-rol' }, 'Rol'),
    rol,
    h('label', { for: 'tk-dias' }, 'Vigencia (días, 1 a 365)'),
    dias,
    h('label', { for: 'tk-cuota' }, 'Cuota de reservas vigentes (opcional)'),
    cuota,
    error,
    h('div', { class: 'fila-botones' }, h('button', { class: 'btn sec', type: 'button', onclick: cierre }, 'Cancelar'), enviar),
  );
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  nombre.focus();
}
function mostrarToken(dlg, t, cierre) {
  const estado = h('div', { id: 'tk-copia', 'aria-live': 'polite' });
  const valor = h('input', { id: 'tk-valor', class: 'token-valor', readonly: true, 'aria-label': 'Token de servicio', onfocus: (e) => e.target.select() });
  valor.value = t.token;
  const copiar = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      id: 'tk-copiar',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(valor.value);
          msg(estado, 'Copiado al portapapeles.', 'ok');
        } catch {
          valor.focus();
          valor.select();
          msg(estado, 'No se pudo copiar solo: el texto quedó seleccionado, copia con Ctrl+C.', 'error');
        }
      },
    },
    'Copiar',
  );
  dlg.replaceChildren(
    h(
      'div',
      null,
      h('h3', { id: 'tk-dlg-t' }, 'Token creado: ' + t.nombre),
      h(
        'div',
        { class: 'aviso', role: 'alert' },
        h('b', null, 'Cópialo ahora. '),
        'No se podrá ver de nuevo: si lo pierdes, tendrás que crear otro y revocar este.',
      ),
      h('label', { for: 'tk-valor' }, 'Token'),
      valor,
      estado,
      h('p', { class: 'ayuda' }, `Rol ${t.rol} · vence ${fecha(t.expira_en)}. Úsalo así:  Authorization: Bearer <token>`),
      h('div', { class: 'fila-botones' }, copiar, h('button', { class: 'btn sec', type: 'button', id: 'tk-cerrar', onclick: cierre }, 'Cerrar')),
    ),
  );
  copiar.focus();
}

function render(t) {
  ({
    pools: renderPools,
    asig: renderAsig,
    reservas: renderReservas,
    sol: renderSol,
    jira: renderJira,
    tokens: renderTokens,
    usuarios: renderUsuarios,
    audit: renderAudit,
  })[t]();
}

async function marca() {
  try {
    const m = await (await fetch('/api/config')).json();
    document.title = m.nombre + ' · Gestión de segmentos';
    $('nombre').textContent = m.nombre + ' · Gestión de segmentos';
    $('subtitulo').textContent = m.subtitulo || '';
    if (m.logo) {
      $('logo').src = m.logo;
      $('logo').hidden = false;
    }
    $('pie').textContent = m.pie || '';
  } catch (e) {}
}
async function iniciar() {
  marca();
  const r = await fetch('/api/me', { headers: CAB });
  if (r.status === 401) {
    location.href = '/auth/login?next=' + encodeURIComponent(location.pathname);
    return;
  }
  YO = await r.json();
  const nav = $('nav');
  nav.querySelector('[data-t="sol"]').hidden = !puede('solicitante');
  nav.querySelector('[data-t="tokens"]').hidden = !puede('admin');
  nav.querySelector('[data-t="usuarios"]').hidden = !(puede('admin') && YO.modo === 'oidc');
  nav.querySelector('[data-t="audit"]').hidden = !puede('admin');
  $('yo').innerHTML =
    YO.modo === 'oidc'
      ? `${esc(YO.nombre)} · <b>${esc(YO.rol)}</b> <button id="salir">Salir</button>`
      : YO.modo === 'none'
        ? '<span class="tag qa">Sin autenticación (demo)</span>'
        : `${esc(YO.usuario)}`;
  const salir = $('salir');
  if (salir)
    salir.onclick = async () => {
      const x = await api('/auth/logout', { body: {} });
      location.href = (x.data && x.data.redirect) || '/';
    };
  show('pools');
}
iniciar();
