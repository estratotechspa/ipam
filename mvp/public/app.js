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
      ? { method: opt.method || 'POST', headers: { 'Content-Type': 'application/json', ...CAB, ...(opt.headers || {}) }, body: JSON.stringify(opt.body) }
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
// Todas las máscaras que acepta la API (de /8 a /32).
const MASCARAS = Array.from({ length: 25 }, (_, i) => i + 8);
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

// Filtro global por ambiente y proveedor: vale para Pools, Asignaciones y Reservas (se conserva al cambiar de pestaña).
const FILTRO = { ambiente: '', proveedor: '' };
const pasaFiltro = (p) => (!FILTRO.ambiente || p.ambiente === FILTRO.ambiente) && (!FILTRO.proveedor || p.proveedor === FILTRO.proveedor);
const camposFiltro = (todos, recargar) => {
  const unicos = (k) => [...new Set(todos.map((p) => p[k]))].sort();
  const reponer = async (id) => {
    await recargar();
    const el = document.getElementById(id);
    if (el) el.focus();
  };
  const sel = (id, k, etiqueta) =>
    h(
      'label',
      null,
      etiqueta,
      h(
        'select',
        {
          id,
          onchange: (e) => {
            FILTRO[k] = e.target.value;
            reponer(id);
          },
        },
        h('option', { value: '' }, 'Todos'),
        unicos(k).map((v) => h('option', { value: v, selected: FILTRO[k] === v }, v)),
      ),
    );
  return [
    sel('f-ambiente', 'ambiente', 'Ambiente'),
    sel('f-proveedor', 'proveedor', 'Proveedor'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn sec',
        onclick: () => {
          FILTRO.ambiente = '';
          FILTRO.proveedor = '';
          recargar();
        },
      },
      'Limpiar filtro',
    ),
  ];
};
const barraFiltro = (todos, recargar) =>
  h(
    'form',
    { class: 'filtros', role: 'search', 'aria-label': 'Filtrar por ambiente y proveedor', onsubmit: (e) => e.preventDefault() },
    camposFiltro(todos, recargar),
  );

async function renderPools() {
  try {
    const [todos, r] = await Promise.all([get('/api/pools'), get('/api/resumen')]);
    const pools = todos.filter(pasaFiltro);
    $('pools').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2>Estado de pools</h2><a class="btn sec" href="/api/exportar.xlsx" download>⬇ Exportar a Excel</a></div>
  <div class="row"><div class="card"><div class="kpi">${pools.length}</div><div class="sub">Pools</div></div>
  <div class="card"><div class="kpi">${pools.reduce((n, p) => n + p.asignaciones, 0)}</div><div class="sub">Asignaciones activas</div></div>
  <div class="card"><div class="kpi">${((pools.length ? pools.reduce((n, p) => n + p.uso, 0) / pools.length : 0) * 100).toFixed(1).replace('.', ',')}%</div><div class="sub">Uso promedio</div></div>
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
    $('pools').prepend(barraFiltro(todos, renderPools));
  } catch (e) {
    fail('pools', e);
  }
}

let busquedaAsig = ''; // texto del buscador de Asignaciones
async function renderAsig() {
  try {
    const [todosPools, todasAsig] = await Promise.all([get('/api/pools'), get('/api/asignaciones')]);
    const deEsePool = new Map(todosPools.map((p) => [p.id, p]));
    const q = busquedaAsig.trim().toLowerCase();
    const a = todasAsig
      .filter((x) => deEsePool.has(x.pool_id) && pasaFiltro(deEsePool.get(x.pool_id)))
      .filter((x) => !q || [x.codigo, x.cidr, x.vpc, x.ticket, x.solicitante, x.pool_id, x.origen].join(' ').toLowerCase().includes(q));
    $('asig').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2>Asignaciones</h2><span><a class="btn" href="/api/exportar.xlsx" download>⬇ Exportar a Excel</a> ${puede('admin') ? '<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">⬇ Respaldo JSON</a>' : ''}</span></div><div class="card tablewrap"><table><tr><th>ID</th><th>Segmento</th><th>Pool</th><th>Proyecto / VPC</th><th>Direcciones</th><th>Solicitó</th><th>Origen</th><th>Ticket</th><th>Fecha</th><th></th></tr>
  ${a
    .map(
      (
        x,
      ) => `<tr><td><code>${esc(x.codigo || '')}</code></td><td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${esc(x.vpc)}</td><td>${fmt(size(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${fecha(x.creado_en)}</td>
  <td>${puede('admin') ? `<button class="btn sec" data-del="${x.id}" data-c="${esc(x.cidr)}">Liberar</button>` : ''}</td></tr>`,
    )
    .join('')}</table></div>`;
    const buscador = h('input', {
      id: 'f-buscar',
      type: 'search',
      value: busquedaAsig,
      placeholder: 'ID, segmento, proyecto, ticket…',
      oninput: async (e) => {
        busquedaAsig = e.target.value;
        await renderAsig();
        const el = document.getElementById('f-buscar');
        if (el) {
          el.focus();
          el.setSelectionRange(busquedaAsig.length, busquedaAsig.length);
        }
      },
    });
    const barra = barraFiltro(todosPools, renderAsig);
    barra.insertBefore(h('label', null, 'Buscar', buscador), barra.firstChild);
    $('asig').prepend(barra);
    $('asig')
      .querySelectorAll('[data-del]')
      .forEach(
        (b) =>
          (b.onclick = async () => {
            const motivo = prompt('¿Por qué se libera ' + b.dataset.c + '? (queda en la auditoría)');
            if (motivo === null) return;
            if (!motivo.trim()) return alert('Indica el motivo: queda registrado en la auditoría.');
            const r = await api('/api/asignaciones/' + b.dataset.del, { method: 'DELETE', body: { motivo: motivo.trim() } });
            if (!r.ok) alert((r.data && (r.data.mensaje || r.data.error)) || 'No se pudo liberar');
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
  $('sol').innerHTML =
    `<h2>Asignar directo</h2><p class="muted" style="max-width:720px">Entrega el segmento <b>de inmediato y de forma definitiva</b>, sin pasar por una reserva ni por la aprobación de otra persona: queda registrado en la auditoría a tu nombre. Para el flujo normal (pedir, aprobar, asignar) usa <b>Reservas → Nueva reserva</b>.</p><div class="row"><div class="card" style="max-width:420px;flex:none;width:100%">
  <label>Pool</label><select id="s-pool">${pools.map((p) => `<option value="${esc(p.id)}" >${esc(p.id)} (${esc(p.cidr)})</option>`).join('')}</select>
  <label>Proyecto / VPC</label><input id="s-vpc" value="" placeholder="vpc-mi-proyecto">
  <label>CIDR manual (opcional; vacío = asignar el primer libre)</label><input id="s-cidr" value="" placeholder="ej. 10.210.48.0/22 (debe caer dentro del pool)">
  <label>Máscara (si no hay CIDR manual)</label><select id="s-len">${MASCARAS.map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select>
  <p><button class="btn" id="s-go">Asignar</button></p></div>
  <div class="card" style="flex:1;min-width:320px"><b>Disponibilidad del pool elegido</b><div id="s-disp"></div></div>
  <div class="card" id="s-res"><p class="muted">Si pides un CIDR que choque con uno existente, la base de datos lo rechaza y se sugieren segmentos libres. Con el CIDR vacío se asigna el primer segmento libre del tamaño elegido.</p></div></div>`;
  $('s-go').onclick = solicitar;
  const actualizarDisp = () => cargarDisponibilidad($('s-disp'), $('s-pool').value, $('s-len'));
  $('s-pool').onchange = actualizarDisp;
  actualizarDisp();
}

async function solicitar() {
  const body = { pool: $('s-pool').value, vpc: $('s-vpc').value.trim(), cidr: $('s-cidr').value.trim() || undefined, mascara: +$('s-len').value };
  const res = $('s-res');
  $('s-go').disabled = true;
  const r = await api('/api/solicitudes', { body });
  $('s-go').disabled = false;
  const d = r.data || {};
  if (r.ok) {
    cargarDisponibilidad($('s-disp'), $('s-pool').value, $('s-len'));
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

let ultimoJira = null; // resultado de la última simulación (se muestra tras recargar la pestaña)
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
  <div class="card" style="margin-top:16px"><b>Sentido 2 · Jira → IPAM</b><div class="flow"><div class="box jira">Ticket «Solicitud de Segmento IPAM»<br>ambiente, tipo, pool, máscara, VPC</div><span class="arrow">→</span><div class="box">Webhook<br>(firmado HMAC)</div><span class="arrow">→</span><div class="box">IPAM calcula<br>y <b>reserva</b> (24 h)</div><span class="arrow">→</span><div class="box aprob">✋ Aprobación manual<br>de un admin (Reservas)</div><span class="arrow">→</span><div class="box">IPAM<br>asigna el CIDR</div><span class="arrow">→</span><div class="box jira">Actualiza ticket<br>con el rango</div></div><p class="muted" style="margin:10px 0 0">Nada se asigna sin aprobación humana: si nadie aprueba, la reserva <b>expira sola</b> y el rango vuelve al pool.</p>
  <div class="row"><div style="flex:1;min-width:240px"><b>Simular ticket entrante</b>
   <label>Ambiente</label><select id="j-amb"><option>prod</option><option>qa</option><option>dev</option></select>
   <label>Tipo</label><select id="j-tipo"><option>Nodos</option><option selected>Pods</option><option>Servicios</option><option>Control plane</option></select>
   <label>Máscara</label><select id="j-len">${MASCARAS.map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select>
   <label>VPC</label><input id="j-vpc" value="vpc-nueva"><p><button class="btn" id="j-go">Enviar webhook</button></p><div id="j-res" role="status"></div></div>
  <div style="flex:2;min-width:260px"><b>Registro de eventos</b><div class="log">${esc(ev.map(linea).join('\n')) || '(sin eventos)'}</div></div></div></div>`;
  if (ultimoJira) {
    $('j-res').className = ultimoJira.ok ? 'ok' : 'alert';
    $('j-res').textContent = ultimoJira.texto;
  }
  $('j-go').onclick = async () => {
    $('j-go').disabled = true;
    const r = await api('/api/jira/simular', {
      body: { ambiente: $('j-amb').value, tipo: $('j-tipo').value, mascara: +$('j-len').value, vpc: $('j-vpc').value.trim() || 'vpc-sin-nombre' },
    });
    ultimoJira = r.ok
      ? {
          ok: true,
          texto: `Ticket ${r.data.ticket}: se reservó ${r.data.cidr} en ${r.data.pool}. Falta la aprobación manual de un admin en la pestaña Reservas; si no se aprueba, expira sola.`,
        }
      : { ok: false, texto: (r.data && (r.data.mensaje || r.data.error)) || 'Error ' + r.status };
    renderJira();
  };
}

// ---- Diálogos simples (clave temporal, cambio de contraseña) ----
function abrirDialogo(construir, { cerrable = true } = {}) {
  const dlg = h('dialog', { 'aria-modal': 'true' });
  const cerrar = () => {
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('close', () => dlg.remove());
  if (!cerrable) dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  construir(dlg, cerrar);
  dlg.showModal();
  return dlg;
}

/** Muestra UNA vez la clave temporal de una cuenta local (nunca se guarda ni se vuelve a mostrar). */
function mostrarClaveTemporal(usuario, clave, titulo) {
  abrirDialogo((dlg, cerrar) => {
    const estado = h('div', { id: 'ct-copia', 'aria-live': 'polite' });
    const valor = h('input', { id: 'ct-valor', class: 'token-valor', readonly: true, 'aria-label': 'Clave temporal', onfocus: (e) => e.target.select() });
    valor.value = clave;
    const copiar = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        id: 'ct-copiar',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(valor.value);
            msg(estado, 'Copiada al portapapeles.', 'ok');
          } catch {
            valor.focus();
            valor.select();
            msg(estado, 'No se pudo copiar sola: el texto quedó seleccionado, copia con Ctrl+C.', 'error');
          }
        },
      },
      'Copiar',
    );
    dlg.replaceChildren(
      h(
        'div',
        null,
        h('h3', null, titulo + ': ' + usuario),
        h(
          'div',
          { class: 'aviso', role: 'alert' },
          h('b', null, 'Cópiala ahora. '),
          'No se podrá ver de nuevo. La persona deberá cambiarla al entrar por primera vez.',
        ),
        h('label', { for: 'ct-valor' }, 'Clave temporal'),
        valor,
        estado,
        h('div', { class: 'fila-botones' }, copiar, h('button', { class: 'btn sec', type: 'button', id: 'ct-cerrar', onclick: cerrar }, 'Cerrar')),
      ),
    );
    copiar.focus();
  });
}

/** Cambio de la contraseña propia (cuentas locales). Si es obligatorio (clave temporal), el diálogo no se puede cerrar. */
function dialogoCambioClave({ obligatorio = false } = {}) {
  abrirDialogo(
    (dlg, cerrar) => {
      const estado = h('div', { id: 'cc-msg', 'aria-live': 'polite' });
      const actual = h('input', { id: 'cc-actual', type: 'password', required: true, autocomplete: 'current-password' });
      const nueva = h('input', { id: 'cc-nueva', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' });
      const repite = h('input', { id: 'cc-repite', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' });
      const boton = h('button', { class: 'btn', type: 'submit', id: 'cc-go' }, 'Cambiar contraseña');
      const enviar = async (e) => {
        e.preventDefault();
        if (nueva.value !== repite.value) return msg(estado, 'La contraseña nueva y su repetición no coinciden.', 'error');
        boton.disabled = true;
        const r = await api('/api/v1/yo/clave', { body: { actual: actual.value, nueva: nueva.value } });
        boton.disabled = false;
        if (!r.ok) return msg(estado, errorApi(r), 'error');
        msg(estado, 'Contraseña cambiada. El navegador te pedirá entrar de nuevo con la nueva.', 'ok');
        setTimeout(() => location.reload(), 1200);
      };
      dlg.replaceChildren(
        h(
          'form',
          { onsubmit: enviar, 'aria-label': 'Cambiar contraseña' },
          h('h3', null, obligatorio ? 'Debes cambiar tu contraseña' : 'Cambiar mi contraseña'),
          obligatorio ? h('p', { class: 'muted' }, 'Entraste con una clave temporal. Elige una propia de al menos 12 caracteres para seguir.') : null,
          h('label', { for: 'cc-actual' }, 'Contraseña actual'),
          actual,
          h('label', { for: 'cc-nueva' }, 'Contraseña nueva (mínimo 12 caracteres)'),
          nueva,
          h('label', { for: 'cc-repite' }, 'Repite la contraseña nueva'),
          repite,
          estado,
          h('div', { class: 'fila-botones' }, boton, obligatorio ? null : h('button', { class: 'btn sec', type: 'button', onclick: cerrar }, 'Cancelar')),
        ),
      );
      actual.focus();
    },
    { cerrable: !obligatorio },
  );
}

// ---- Pestaña Usuarios (admin). SSO: pre-registro por correo y baja. Cuentas locales (AUTH_LOCAL): clave temporal de un solo uso. ----
async function renderUsuarios() {
  const raiz = $('usuarios');
  try {
    const usuarios = await get('/api/v1/usuarios');
    const local = YO.modo !== 'oidc'; // en modo SSO se pre-registra; en modo Basic con AUTH_LOCAL se crean cuentas locales
    const estado = h('div', { id: 'us-msg', 'aria-live': 'polite' });
    const recargar = () => renderUsuarios();

    const email = h('input', {
      id: 'us-email',
      required: true,
      maxlength: 120,
      placeholder: local ? 'nombre de usuario' : 'correo@empresa.cl',
      autocomplete: 'off',
    });
    const nombre = h('input', { id: 'us-nombre', maxlength: 120, placeholder: 'opcional' });
    const rol = h(
      'select',
      { id: 'us-rol' },
      ['lector', 'solicitante', 'admin'].map((r) => h('option', { value: r }, r)),
    );
    const boton = h('button', { class: 'btn', type: 'submit', id: 'us-crear' }, local ? 'Crear cuenta local' : 'Pre-registrar');
    const crear = async (e) => {
      e.preventDefault();
      boton.disabled = true;
      const r = await api('/api/v1/usuarios', { body: { email: email.value.trim(), nombre: nombre.value.trim(), rol: rol.value, local } });
      boton.disabled = false;
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      if (r.data.clave_temporal) mostrarClaveTemporal(r.data.email, r.data.clave_temporal, 'Cuenta creada');
      else RES_USUARIOS.aviso = `Pre-registrado ${r.data.email} como ${r.data.rol}: entrará con su proveedor de identidad con ese rol.`;
      recargar();
    };

    const accion = async (ruta, metodo, confirmacion, alTerminar) => {
      if (confirmacion && !confirm(confirmacion)) return;
      const r = await api(ruta, { method: metodo, body: {} });
      if (!r.ok) return msg(estado, errorApi(r), 'error');
      if (alTerminar) alTerminar(r.data);
      recargar();
    };
    const boton2 = (texto, onclick, extra = {}) => h('button', { class: 'btn sec', type: 'button', onclick, ...extra }, texto);
    const ruta = (u) => '/api/v1/usuarios/' + encodeURIComponent(u.email);
    const filas = usuarios.map((u) => {
      const yoMismo = u.email === YO.usuario;
      return h(
        'tr',
        { class: u.activo ? '' : 'inactivo' },
        h('td', null, u.email),
        h('td', null, u.nombre || '—'),
        h('td', null, u.local ? 'Local' : 'SSO'),
        h(
          'td',
          null,
          h(
            'select',
            {
              'aria-label': 'Rol de ' + u.email,
              onchange: async (e) => {
                const r = await api(ruta(u), { method: 'PUT', body: { rol: e.target.value || null } });
                if (!r.ok) msg(estado, errorApi(r), 'error');
                recargar();
              },
            },
            u.local ? null : h('option', { value: '' }, 'Heredar'),
            ['lector', 'solicitante', 'admin'].map((r) => h('option', { value: r, selected: u.rol === r }, r)),
          ),
        ),
        h('td', null, u.activo ? 'Activo' : 'Desactivado', u.debe_cambiar_clave ? ' · clave temporal' : ''),
        h('td', null, fechaHora(u.ultimo_acceso)),
        h(
          'td',
          { class: 'acciones' },
          u.activo
            ? boton2(
                'Desactivar',
                () => accion(ruta(u) + '/desactivar', 'POST', `¿Desactivar a ${u.email}? No podrá entrar hasta que lo reactives (su historial se conserva).`),
                { disabled: yoMismo },
              )
            : boton2('Activar', () => accion(ruta(u) + '/activar', 'POST')),
          u.local
            ? boton2('Restablecer clave', () =>
                accion(ruta(u) + '/restablecer-clave', 'POST', `¿Restablecer la clave de ${u.email}? Se generará una clave temporal nueva.`, (d) =>
                  mostrarClaveTemporal(d.email, d.clave_temporal, 'Clave restablecida'),
                ),
              )
            : null,
          boton2('Eliminar', () => accion(ruta(u), 'DELETE', `¿Eliminar a ${u.email}? Para conservar su historial prefiere Desactivar.`), {
            disabled: yoMismo,
            class: 'btn peligro',
          }),
        ),
      );
    });
    if (RES_USUARIOS.aviso) {
      msg(estado, RES_USUARIOS.aviso, 'ok');
      RES_USUARIOS.aviso = null;
    }
    raiz.replaceChildren(
      h('h2', null, 'Usuarios'),
      h(
        'p',
        { class: 'muted' },
        local
          ? 'Cuentas locales con contraseña (modo de pruebas). La clave temporal se muestra una sola vez y la persona debe cambiarla al entrar. El administrador de emergencia (variables APP_USER y APP_PASS) siempre puede entrar. Para uso real, configura SSO.'
          : 'Las personas entran con tu proveedor de identidad (SSO). Aquí puedes pre-registrarlas con su rol antes de que entren, cambiarlo o darlas de baja; el cambio rige desde su próximo inicio de sesión. «Heredar» usa los grupos del proveedor.',
      ),
      h(
        'details',
        { class: 'card', style: 'margin:0 0 14px' },
        h('summary', { style: 'cursor:pointer;font-weight:600' }, local ? '＋ Nueva cuenta local' : '＋ Pre-registrar a una persona'),
        h(
          'form',
          { class: 'filtros', style: 'margin-top:12px', onsubmit: crear, 'aria-label': 'Nuevo usuario' },
          h('label', null, local ? 'Usuario' : 'Correo', email),
          h('label', null, 'Nombre', nombre),
          h('label', null, 'Rol', rol),
          boton,
        ),
      ),
      estado,
      h(
        'div',
        { class: 'card tablewrap' },
        h(
          'table',
          null,
          h(
            'tr',
            null,
            ['Usuario', 'Nombre', 'Tipo', 'Rol', 'Estado', 'Último acceso', ''].map((t) => h('th', null, t)),
          ),
          filas.length ? filas : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'Todavía no hay usuarios.')),
        ),
      ),
    );
  } catch (e) {
    fail('usuarios', e);
  }
}
const RES_USUARIOS = { aviso: null };
// ---- Pestaña Importar (admin): segmentos que ya existen (Excel/CSV). Primero se SIMULA (no escribe nada), luego se aplica. ----
const IMP = { archivo: null, sim: null, aprobadas: new Set(), filtro: '', defectos: { proveedor: '', ambiente: '', tipo: '' } };
const ESTADO_IMP = {
  ok: ['imp-ok', 'Listo para importar'],
  ya_existe: ['imp-omitida', 'Ya registrado (se omite)'],
  solapa_otro_pool: ['imp-aviso', '⚠ Solapa con otro pool: requiere aprobación'],
  choca_mismo_pool: ['imp-error', '✖ Choca dentro del mismo pool'],
  invalida: ['imp-error', '✖ Inválida'],
};
const aBase64 = (buf) => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const cuerpoImportacion = () => ({ ...IMP.archivo, ...Object.fromEntries(Object.entries(IMP.defectos).filter(([, v]) => v)) });

async function renderImportar() {
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
    h('h2', null, 'Importar segmentos que ya existen'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Sube un Excel (.xlsx) o un CSV con los segmentos que ya están en uso (on-premise, GCP, otras nubes). Primero se ',
      h('b', null, 'simula'),
      ': no se escribe nada hasta que confirmes. Si no hay pools que los contengan, el IPAM crea uno por proveedor, ambiente y familia de red. Los segmentos que se ',
      h('b', null, 'solapan con otro pool'),
      ' los apruebas o rechazas tú; los que chocan dentro del mismo pool no se pueden importar. Columnas reconocidas: ',
      h('code', null, 'cidr, proyecto, proveedor, ambiente, tipo, ticket, descripcion'),
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

function resultadoSimulacion(estado) {
  const sim = IMP.sim;
  const r = sim.resumen;
  const aplicables = r.ok + IMP.aprobadas.size;
  const chip = (clave) => h('span', { class: 'tag ' + ESTADO_IMP[clave][0], style: 'margin-right:8px' }, `${r[clave]} · ${ESTADO_IMP[clave][1]}`);
  const filas = sim.filas.filter((f) => !IMP.filtro || f.estado === IMP.filtro);
  const aplicar = async () => {
    if (
      !confirm(
        `¿Importar ${aplicables} segmento${aplicables === 1 ? '' : 's'}${sim.pools_a_crear.length ? ` y crear ${sim.pools_a_crear.length} pool${sim.pools_a_crear.length === 1 ? '' : 's'}` : ''}? Queda en la auditoría.`,
      )
    )
      return;
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
// Disponibilidad del pool elegido, por máscara: direcciones por bloque, utilizables y cuántos bloques libres quedan.
// También rotula el selector de máscara («/24 · 15 libres») y un clic en una fila elige esa máscara.
async function cargarDisponibilidad(contenedor, poolId, selectMascara) {
  contenedor.replaceChildren(h('p', { class: 'muted' }, 'Calculando disponibilidad…'));
  const r = await api('/api/v1/pools/' + encodeURIComponent(poolId) + '/disponibilidad');
  if (!r.ok) return contenedor.replaceChildren(h('p', { class: 'muted' }, 'No se pudo calcular la disponibilidad.'));
  const d = r.data;
  const porMascara = new Map(d.por_mascara.map((x) => [x.mascara, x]));
  const elegida = selectMascara.value;
  for (const op of selectMascara.options) {
    const x = porMascara.get(Number(op.value));
    op.textContent = x ? `/${op.value} · ${fmt(x.bloques_libres)} libre${x.bloques_libres === 1 ? '' : 's'}` : `/${op.value} · no cabe aquí`;
  }
  selectMascara.value = elegida;
  const pct = d.total ? (d.ocupadas / d.total) * 100 : 0;
  contenedor.replaceChildren(
    h(
      'p',
      { style: 'margin:0 0 8px' },
      h('b', null, d.pool),
      ` (${d.cidr}): ${fmt(d.libres)} de ${fmt(d.total)} direcciones libres · ${pct.toFixed(1).replace('.', ',')} % ocupado.`,
    ),
    h(
      'div',
      { class: 'tablewrap', style: 'max-height:260px;overflow:auto' },
      h(
        'table',
        { 'aria-label': 'Disponibilidad por máscara' },
        h(
          'tr',
          null,
          ['Máscara', 'Direcciones por bloque', 'Utilizables', 'Bloques libres', 'Direcciones libres'].map((t) => h('th', null, t)),
        ),
        d.por_mascara.map((x) =>
          h(
            'tr',
            {
              class: x.bloques_libres ? 'elegible' : 'agotado',
              style: 'cursor:pointer',
              title: x.bloques_libres ? 'Elegir esta máscara' : 'No queda espacio de este tamaño',
              onclick: () => {
                selectMascara.value = String(x.mascara);
                selectMascara.dispatchEvent(new Event('change'));
              },
            },
            h('td', null, h('code', null, '/' + x.mascara)),
            h('td', null, fmt(x.direcciones)),
            h('td', null, fmt(x.utilizables)),
            h('td', null, h('b', null, fmt(x.bloques_libres))),
            h('td', null, fmt(x.direcciones_libres)),
          ),
        ),
      ),
    ),
  );
}

// Formulario «Nueva reserva» (solicitante y admin): aparta un rango por un tiempo; un admin debe aprobarla para que sea asignación.
function formularioNuevaReserva(pools, estado, recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const pool = h(
    'select',
    { id: 'nr-pool', required: true },
    pools.map((p) => h('option', { value: p.id }, `${p.id} (${p.cidr})`)),
  );
  const vpc = h('input', { id: 'nr-vpc', required: true, maxlength: 120, placeholder: 'vpc-mi-proyecto' });
  const ticket = h('input', { id: 'nr-ticket', maxlength: 60, placeholder: 'opcional (si no, se genera NET-xxx)' });
  const mascara = h(
    'select',
    { id: 'nr-mascara' },
    MASCARAS.map((n) => h('option', { value: n, selected: n === 24 }, '/' + n)),
  );
  const cidr = h('input', { id: 'nr-cidr', placeholder: 'opcional: vacío = el primer rango libre' });
  const ttl = h('input', { id: 'nr-ttl', type: 'number', min: 1, max: 72, value: 24 });
  const boton = h('button', { class: 'btn', type: 'submit', id: 'nr-go' }, 'Reservar');
  const disp = h('div', { id: 'nr-disp', class: 'card', style: 'flex:1 1 100%' });
  const actualizar = () => cargarDisponibilidad(disp, pool.value, mascara);
  pool.addEventListener('change', actualizar);
  mascara.addEventListener('change', () => {});
  setTimeout(actualizar, 0);
  const enviar = async (e) => {
    e.preventDefault();
    boton.disabled = true;
    const cuerpo = { pool: pool.value, vpc: vpc.value.trim(), mascara: +mascara.value, ttl_horas: +ttl.value || 24 };
    if (cidr.value.trim()) cuerpo.cidr = cidr.value.trim();
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
    h('summary', { style: 'cursor:pointer;font-weight:600' }, '＋ Nueva reserva'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Nueva reserva', onsubmit: enviar },
      campo('Bloque base', pool),
      campo('Proyecto / VPC', vpc),
      campo('Máscara', mascara),
      campo('CIDR manual', cidr),
      campo('Ticket', ticket),
      campo('Vigencia (horas, máx. 72)', ttl),
      boton,
      disp,
    ),
  );
}

const RES = { filtro: { estado: '', pool: '', solicitante: '' }, timer: null, aviso: null };
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
    importar: renderImportar,
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
  nav.querySelector('[data-t="sol"]').hidden = !puede('admin');
  nav.querySelector('[data-t="tokens"]').hidden = !puede('admin');
  nav.querySelector('[data-t="usuarios"]').hidden = !(puede('admin') && (YO.modo === 'oidc' || YO.cuentas_locales));
  nav.querySelector('[data-t="audit"]').hidden = !puede('admin');
  nav.querySelector('[data-t="importar"]').hidden = !puede('admin');
  $('yo').innerHTML =
    YO.modo === 'oidc'
      ? `${esc(YO.nombre)} · <b>${esc(YO.rol)}</b> <button id="salir">Salir</button>`
      : YO.modo === 'none'
        ? '<span class="tag qa">Sin autenticación (demo)</span>'
        : `${esc(YO.usuario)}`;
  if (YO.local) {
    $('yo').append(' ', h('button', { id: 'mi-clave', type: 'button', onclick: () => dialogoCambioClave() }, 'Mi contraseña'));
  }
  const salir = $('salir');
  if (salir)
    salir.onclick = async () => {
      const x = await api('/auth/logout', { body: {} });
      location.href = (x.data && x.data.redirect) || '/';
    };
  show('pools');
  if (YO.debe_cambiar_clave) dialogoCambioClave({ obligatorio: true }); // clave temporal: no se puede seguir sin cambiarla
}
iniciar();
