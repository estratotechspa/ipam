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

// Vistas sin botón propio en la barra: se abren desde su pestaña (Importar, desde Pools) y solo las ve un admin.
const SUBVISTAS = { importar: 'pools' };
let VISTA = 'pools';
function show(t) {
  const boton = $('nav').querySelector('[data-t="' + t + '"]');
  if (!$(t) || (SUBVISTAS[t] ? !puede('admin') : !boton || boton.hidden)) t = 'pools';
  VISTA = t;
  const marcada = SUBVISTAS[t] || t;
  clearInterval(RES.timer);
  document.querySelectorAll('.wrap').forEach((w) => w.classList.toggle('hide', w.id !== t));
  document.querySelectorAll('#nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.t === marcada);
    if (b.dataset.t === marcada) b.setAttribute('aria-current', 'page');
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

// Uso de un pool: lo asignado (definitivo) más lo reservado (apartado). Es la misma cuenta en la tabla, la ficha y la disponibilidad.
const pct = (x) => (x * 100).toFixed(1).replace('.', ',') + ' %';
const anchoUso = (x) => (x > 0 ? Math.max(x * 100, 1) : 0);
const textoUso = (asig, res) => `Asignado ${pct(asig)} · reservado ${pct(res)}`;
const barraUsoHtml = (asig, res) =>
  `<span class="uso"><span class="bar" role="img" aria-label="${textoUso(asig, res)}" title="${textoUso(asig, res)}"><i style="width:${anchoUso(asig)}%"></i><i class="res" style="width:${anchoUso(res)}%"></i></span>${pct(asig + res)}</span>`;
const barraUso = (asig, res) =>
  h(
    'span',
    { class: 'uso' },
    h(
      'span',
      { class: 'bar', role: 'img', 'aria-label': textoUso(asig, res), title: textoUso(asig, res) },
      h('i', { style: `width:${anchoUso(asig)}%` }),
      h('i', { class: 'res', style: `width:${anchoUso(res)}%` }),
    ),
    pct(asig + res),
  );

async function renderPools() {
  try {
    const [todos, r] = await Promise.all([get('/api/pools'), get('/api/resumen')]);
    const pools = todos.filter(pasaFiltro);
    // Uso total ponderado por tamaño: direcciones ocupadas (asignadas + reservadas) de todos los pools ÷ direcciones totales.
    const total = pools.reduce((n, p) => n + size(p.cidr), 0);
    const ocupadas = pools.reduce((n, p) => n + (p.uso + (p.uso_reservado || 0)) * size(p.cidr), 0);
    $('pools').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2>Estado de pools</h2><span class="acciones">${puede('admin') ? '<button type="button" class="btn" id="btn-importar">⬆ Importar segmentos</button>' : ''}<a class="btn sec" href="/api/exportar.xlsx" download>⬇ Exportar a Excel</a></span></div>
  <div class="row"><div class="card"><div class="kpi">${pools.length}</div><div class="sub">Pools</div></div>
  <div class="card"><div class="kpi">${pools.reduce((n, p) => n + p.asignaciones, 0)}</div><div class="sub">Asignaciones activas</div></div>
  <div class="card"><div class="kpi">${pct(total ? ocupadas / total : 0)}</div><div class="sub">Uso total (asignado + reservado, sobre todas las direcciones)</div></div>
  <div class="card"><div class="kpi">${r.solapamientos}</div><div class="sub">Solapamientos (la base de datos los impide)</div></div></div>
  <div id="pool-nuevo"></div><div id="pools-msg" aria-live="polite"></div>
  <p class="muted leyenda"><span class="muestra asig"></span> asignado <span class="muestra res"></span> reservado · Haz clic en un pool para ver su ficha.</p>
  <div class="card tablewrap"><table><tr><th>Pool</th><th>Tipo</th><th>Ambiente</th><th>Proveedor</th><th>CIDR base</th><th>Asig.</th><th>Reservas</th><th>Uso</th></tr>
  ${pools
    .map(
      (
        p,
      ) => `<tr><td><button type="button" class="enlace" data-ficha-pool="${esc(p.id)}">${esc(p.id)}</button></td><td>${esc(p.tipo)}</td><td>${tag(p.ambiente)}</td><td>${esc(p.proveedor)}</td><td><code>${esc(p.cidr)}</code></td><td>${p.asignaciones}</td><td>${p.reservas_vigentes || 0}</td>
  <td>${barraUsoHtml(p.uso, p.uso_reservado || 0)}</td></tr>`,
    )
    .join('')}</table></div>`;
    $('pools').prepend(barraFiltro(todos, renderPools));
    $('pools')
      .querySelectorAll('[data-ficha-pool]')
      .forEach((b) => (b.onclick = () => fichaPool(b.dataset.fichaPool)));
    const imp = $('btn-importar');
    if (imp) imp.onclick = () => show('importar');
    if (puede('admin')) $('pool-nuevo').replaceWith(formularioNuevoPool(renderPools));
    if (POOLS_AVISO) {
      msg($('pools-msg'), POOLS_AVISO, 'ok');
      POOLS_AVISO = null;
    }
  } catch (e) {
    fail('pools', e);
  }
}

let busquedaAsig = ''; // texto del buscador de Asignaciones
const ASIG = { formAbierto: false, aviso: null };
const textoVlan = (x) => (x.vlan ? `${x.vlan}${x.vlan_nombre ? ' · ' + x.vlan_nombre : ''}` : x.vlan_nombre || '—');
async function renderAsig() {
  try {
    const [todosPools, todasAsig] = await Promise.all([get('/api/pools'), get('/api/asignaciones')]);
    const deEsePool = new Map(todosPools.map((p) => [p.id, p]));
    const q = busquedaAsig.trim().toLowerCase();
    const a = todasAsig
      .filter((x) => deEsePool.has(x.pool_id) && pasaFiltro(deEsePool.get(x.pool_id)))
      .filter((x) => !q || [x.codigo, x.cidr, x.vpc, x.ticket, x.solicitante, x.pool_id, x.origen, x.vlan, x.vlan_nombre].join(' ').toLowerCase().includes(q));
    $('asig').innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><h2>Asignaciones</h2><span><a class="btn" href="/api/exportar.xlsx" download>⬇ Exportar a Excel</a> ${puede('admin') ? '<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">⬇ Respaldo JSON</a>' : ''}</span></div><div class="card tablewrap"><table><tr><th>ID</th><th>Segmento</th><th>Pool</th><th>Proyecto / VPC</th><th>VLAN</th><th>Direcciones</th><th>Solicitó</th><th>Origen</th><th>Ticket</th><th>Fecha</th><th></th></tr>
  ${a
    .map(
      (
        x,
      ) => `<tr><td><button type="button" class="enlace" data-ficha-asig="${esc(x.id)}"><code>${esc(x.codigo || x.id)}</code></button></td><td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${esc(x.vpc)}</td><td>${esc(textoVlan(x))}</td><td>${fmt(size(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${fecha(x.creado_en)}</td>
  <td>${puede('admin') ? `<button class="btn sec" data-del="${x.id}" data-c="${esc(x.cidr)}">Liberar</button>` : ''}</td></tr>`,
    )
    .join('')}</table></div>`;
    const buscador = h('input', {
      id: 'f-buscar',
      type: 'search',
      value: busquedaAsig,
      placeholder: 'ID, segmento, proyecto, VLAN, ticket…',
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
    const aviso = h('div', { id: 'asig-msg', 'aria-live': 'polite' });
    if (ASIG.aviso) {
      msg(aviso, ASIG.aviso, 'ok');
      ASIG.aviso = null;
    }
    $('asig').prepend(aviso);
    if (puede('admin')) $('asig').prepend(formularioNuevaAsignacion(todosPools, renderAsig));
    $('asig')
      .querySelectorAll('[data-ficha-asig]')
      .forEach((b) => (b.onclick = () => fichaAsignacion(b.dataset.fichaAsig)));
    $('asig')
      .querySelectorAll('[data-del]')
      .forEach((b) => (b.onclick = () => liberarAsignacion(b.dataset.del, b.dataset.c, renderAsig)));
  } catch (e) {
    fail('asig', e);
  }
}

/** Libera una asignación pidiendo el motivo (queda en el historial). Devuelve true si se liberó. */
async function liberarAsignacion(id, cidr, despues) {
  const motivo = prompt('¿Por qué se libera ' + cidr + '? (queda en el historial)');
  if (motivo === null) return false;
  if (!motivo.trim()) {
    alert('Indica el motivo: queda registrado en el historial.');
    return false;
  }
  const r = await api('/api/asignaciones/' + id, { method: 'DELETE', body: { motivo: motivo.trim() } });
  if (!r.ok) alert((r.data && (r.data.mensaje || r.data.error)) || 'No se pudo liberar');
  if (despues) await despues();
  return r.ok;
}

// VLAN opcional (número y nombre) en los formularios de asignación y reserva.
const camposVlan = (prefijo) => ({
  vlan: h('input', { id: prefijo + '-vlan', type: 'number', min: 1, max: 4094, step: 1, inputmode: 'numeric', placeholder: '1–4094' }),
  vlanNombre: h('input', { id: prefijo + '-vlan-nombre', maxlength: 80, placeholder: 'p. ej. Branch_Data' }),
});
const cuerpoVlan = ({ vlan, vlanNombre }) => ({
  ...(vlan.value.trim() ? { vlan: Number(vlan.value) } : {}),
  ...(vlanNombre.value.trim() ? { vlan_nombre: vlanNombre.value.trim() } : {}),
});

// Pool y máscara de los formularios: NINGÚN pool viene elegido; la máscara se habilita al elegirlo y solo ofrece las que caben en él.
function selectorPoolMascara(prefijo, pools) {
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

// Formulario «Nueva asignación» (solo admin): entrega definitiva e inmediata, sin reserva ni aprobación de otra persona.
function formularioNuevaAsignacion(pools, recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const { pool, mascara, disp } = selectorPoolMascara('na', pools);
  const vpc = h('input', { id: 'na-vpc', required: true, maxlength: 120, placeholder: 'vpc-mi-proyecto' });
  const cidr = h('input', { id: 'na-cidr', placeholder: 'opcional: vacío = el primer libre' });
  const vl = camposVlan('na');
  const boton = h('button', { class: 'btn', type: 'submit', id: 'na-go' }, 'Asignar');
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
      ASIG.aviso = `✔ Asignado ${d.cidr} (${d.codigo || 'sin ID'}) en ${d.pool_id} para ${d.vpc}. Ticket ${d.ticket}.`;
      ASIG.formAbierto = false;
      return recargar();
    }
    if (d.error === 'solapamiento' && d.conflicto) {
      const x = d.conflicto;
      return res.replaceChildren(
        h(
          'div',
          { class: 'alert', role: 'alert' },
          h('b', null, '⚠ Solapamiento detectado'),
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
    { class: 'filtros', style: 'margin-top:12px', 'aria-label': 'Nueva asignación', onsubmit: enviar },
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
    h('summary', { style: 'cursor:pointer;font-weight:600' }, '＋ Nueva asignación (directa, solo admin)'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'Entrega el segmento ',
      h('b', null, 'de inmediato y de forma definitiva'),
      ', sin reserva ni aprobación de otra persona; queda en el historial a tu nombre. Para el flujo normal (pedir, aprobar, asignar) usa Reservas → Nueva reserva.',
    ),
    form,
  );
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
    h('p', null, h('button', { type: 'button', class: 'btn sec', id: 'imp-volver', onclick: () => show('pools') }, '← Volver a Pools')),
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

function resultadoSimulacion(estado) {
  const sim = IMP.sim;
  const r = sim.resumen;
  const aplicables = r.ok + IMP.aprobadas.size;
  const chip = (clave) => h('span', { class: 'tag ' + ESTADO_IMP[clave][0], style: 'margin-right:8px' }, `${r[clave]} · ${ESTADO_IMP[clave][1]}`);
  const filas = sim.filas.filter((f) => !IMP.filtro || f.estado === IMP.filtro);
  const aplicar = async () => {
    if (
      !confirm(
        `¿Importar ${aplicables} segmento${aplicables === 1 ? '' : 's'}${sim.pools_a_crear.length ? ` y crear ${sim.pools_a_crear.length} pool${sim.pools_a_crear.length === 1 ? '' : 's'}` : ''}? Queda registrado a tu nombre.`,
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
// Rehace el selector de máscara con SOLO las que caben en el pool («/24 · 15 libres»; las agotadas, deshabilitadas). Un clic en una fila elige esa máscara.
async function cargarDisponibilidad(contenedor, poolId, selectMascara) {
  contenedor.dataset.pool = poolId;
  if (!poolId) {
    selectMascara.replaceChildren(h('option', { value: '' }, 'Elige primero un pool'));
    selectMascara.disabled = true;
    return contenedor.replaceChildren(h('p', { class: 'muted' }, 'Elige un pool para ver cuánto espacio libre tiene y de qué tamaños.'));
  }
  contenedor.replaceChildren(h('p', { class: 'muted' }, 'Calculando disponibilidad…'));
  const r = await api('/api/v1/pools/' + encodeURIComponent(poolId) + '/disponibilidad');
  if (contenedor.dataset.pool !== poolId) return; // se eligió otro pool mientras tanto
  if (!r.ok) return contenedor.replaceChildren(h('p', { class: 'muted' }, 'No se pudo calcular la disponibilidad.'));
  const d = r.data;
  const elegida = selectMascara.value;
  selectMascara.replaceChildren(
    h('option', { value: '' }, 'Elige una máscara…'),
    ...d.por_mascara.map((x) =>
      h(
        'option',
        { value: x.mascara, disabled: !x.bloques_libres },
        `/${x.mascara} · ${x.bloques_libres ? `${fmt(x.bloques_libres)} libre${x.bloques_libres === 1 ? '' : 's'}` : 'sin espacio'}`,
      ),
    ),
  );
  selectMascara.disabled = false;
  if (d.por_mascara.some((x) => String(x.mascara) === elegida && x.bloques_libres)) selectMascara.value = elegida;
  contenedor.replaceChildren(
    h(
      'p',
      { style: 'margin:0 0 8px' },
      h('b', null, d.pool),
      ` (${d.cidr}): ${fmt(d.libres)} de ${fmt(d.total)} direcciones libres · ${pct(d.total ? d.ocupadas / d.total : 0)} ocupado (asignado + reservado).`,
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
              style: x.bloques_libres ? 'cursor:pointer' : '',
              title: x.bloques_libres ? 'Elegir esta máscara' : 'No queda espacio de este tamaño',
              onclick: () => {
                if (!x.bloques_libres) return;
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
  const { pool, mascara, disp } = selectorPoolMascara('nr', pools);
  const vpc = h('input', { id: 'nr-vpc', required: true, maxlength: 120, placeholder: 'vpc-mi-proyecto' });
  const ticket = h('input', { id: 'nr-ticket', maxlength: 60, placeholder: 'opcional (si no, se genera NET-xxx)' });
  const cidr = h('input', { id: 'nr-cidr', placeholder: 'opcional: vacío = el primer rango libre' });
  const vl = camposVlan('nr');
  const ttl = h('input', { id: 'nr-ttl', type: 'number', min: 1, max: 72, value: 24 });
  const boton = h('button', { class: 'btn', type: 'submit', id: 'nr-go' }, 'Reservar');
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
    h('summary', { style: 'cursor:pointer;font-weight:600' }, '＋ Nueva reserva'),
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

/* ===== Pools: alta (admin) ===== */
const PROVEEDORES = ['GCP', 'On-prem', 'AWS', 'Azure'];
function formularioNuevoPool(recargar) {
  const campo = (etiqueta, control) => h('label', null, etiqueta, control);
  const id = h('input', { id: 'np-id', required: true, maxlength: 63, placeholder: 'lan-sucursal-prod', pattern: '[a-z0-9][a-z0-9-]{1,62}' });
  const tipo = h('input', { id: 'np-tipo', required: true, maxlength: 40, placeholder: 'Nodos, Pods, LAN, Gestión…' });
  const ambiente = h(
    'select',
    { id: 'np-ambiente', required: true },
    h('option', { value: '' }, 'Elige…'),
    ['dev', 'qa', 'pre', 'prod'].map((v) => h('option', { value: v }, v)),
  );
  const proveedor = h('input', { id: 'np-proveedor', required: true, maxlength: 40, list: 'np-provs', placeholder: 'GCP, On-prem…' });
  const provs = h(
    'datalist',
    { id: 'np-provs' },
    PROVEEDORES.map((v) => h('option', { value: v })),
  );
  const cidr = h('input', { id: 'np-cidr', required: true, placeholder: '10.40.0.0/16' });
  const estado = h('div', { id: 'np-msg', 'aria-live': 'polite', style: 'flex:1 1 100%' });
  const boton = h('button', { class: 'btn', type: 'submit', id: 'np-go' }, 'Crear pool');
  const enviar = async (e) => {
    e.preventDefault();
    boton.disabled = true;
    const r = await api('/api/v1/pools', {
      body: { id: id.value.trim(), tipo: tipo.value.trim(), ambiente: ambiente.value, proveedor: proveedor.value.trim(), cidr: cidr.value.trim() },
    });
    boton.disabled = false;
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    POOLS_AVISO = `✔ Pool ${r.data.id} (${r.data.cidr}) creado.`;
    recargar();
  };
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 14px' },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, '＋ Nuevo pool (bloque base)'),
    h(
      'p',
      { class: 'muted', style: 'max-width:760px' },
      'CIDR alineado de /8 a /30. No puede solaparse con otro pool del mismo proveedor y ambiente; en otro ambiente o proveedor el mismo rango sí se permite.',
    ),
    h(
      'form',
      { class: 'filtros', 'aria-label': 'Nuevo pool', onsubmit: enviar },
      campo('Nombre del pool', id),
      campo('Tipo', tipo),
      campo('Ambiente', ambiente),
      campo('Proveedor', proveedor),
      provs,
      campo('CIDR', cidr),
      boton,
      estado,
    ),
  );
}
let POOLS_AVISO = null;

/** Acciones de admin en la ficha del pool: editar tipo y proveedor, o eliminarlo si está vacío. */
function accionesPool(p, cerrar) {
  const estado = h('div', { 'aria-live': 'polite' });
  const tipo = h('input', { id: 'ep-tipo', maxlength: 40, value: p.tipo });
  const proveedor = h('input', { id: 'ep-proveedor', maxlength: 40, value: p.proveedor, list: 'np-provs-ficha' });
  const guardar = async (e) => {
    e.preventDefault();
    const r = await api('/api/v1/pools/' + encodeURIComponent(p.id), { method: 'PATCH', body: { tipo: tipo.value.trim(), proveedor: proveedor.value.trim() } });
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    cerrar();
    show(VISTA);
    fichaPool(p.id);
  };
  const eliminar = async () => {
    if (!confirm(`¿Eliminar el pool ${p.id} (${p.cidr})? Solo se puede si no tiene segmentos, reservas vigentes ni IPs.`)) return;
    const r = await api('/api/v1/pools/' + encodeURIComponent(p.id), { method: 'DELETE' });
    if (!r.ok) return msg(estado, errorApi(r), 'error');
    POOLS_AVISO = `Pool ${p.id} eliminado.`;
    cerrar();
    show('pools');
  };
  return h(
    'details',
    { class: 'acciones-ficha' },
    h('summary', null, 'Editar o eliminar este pool'),
    h(
      'form',
      { class: 'filtros', style: 'margin-top:10px', 'aria-label': 'Editar pool', onsubmit: guardar },
      h('label', null, 'Tipo', tipo),
      h('label', null, 'Proveedor', proveedor),
      h(
        'datalist',
        { id: 'np-provs-ficha' },
        PROVEEDORES.map((v) => h('option', { value: v })),
      ),
      h('button', { class: 'btn', type: 'submit' }, 'Guardar'),
      h('button', { class: 'btn peligro', type: 'button', onclick: eliminar }, 'Eliminar pool'),
    ),
    h('p', { class: 'muted' }, 'El CIDR y el ambiente no se editan: dejarían segmentos fuera de su pool.'),
    estado,
  );
}

/* ===== Direcciones IP fijas (interfaces de router, switch, firewall…) ===== */
const ROLES_IP = [
  ['interfaz', 'Interfaz'],
  ['gateway', 'Gateway'],
  ['gestion', 'Gestión'],
  ['loopback', 'Loopback'],
  ['vip', 'VIP / HSRP'],
  ['servidor', 'Servidor'],
  ['otro', 'Otro'],
];
const nombreRol = (r) => (ROLES_IP.find(([v]) => v === r) || [r, r])[1];
const selectorRol = (id, valor) =>
  h(
    'select',
    { id },
    ROLES_IP.map(([v, t]) => h('option', { value: v, selected: v === (valor || 'interfaz') }, t)),
  );
const camposIp = (pre, d = {}) => ({
  dispositivo: h('input', { id: pre + '-dispositivo', maxlength: 80, placeholder: 'rtr-core-01', value: d.dispositivo || '' }),
  interfaz: h('input', { id: pre + '-interfaz', maxlength: 80, placeholder: 'Gi0/1', value: d.interfaz || '' }),
  rol: selectorRol(pre + '-rol', d.rol),
  dns: h('input', { id: pre + '-dns', maxlength: 253, placeholder: 'gw.sitio.interno', value: d.dns || '' }),
  descripcion: h('input', { id: pre + '-descripcion', maxlength: 200, value: d.descripcion || '' }),
  excepcion: h('input', { id: pre + '-excepcion', maxlength: 200, placeholder: 'solo si está fuera de un segmento', value: d.excepcion || '' }),
});
const valoresIp = (c) => Object.fromEntries(Object.entries(c).map(([k, el]) => [k, el.value.trim()]));

/**
 * Formulario para registrar una IP fija. `pool` fijo (fichas) o elegible (pestaña Direcciones IP).
 * @param {{prefijo: string, pool?: string, pools?: any[], alGuardar: Function}} o
 */
function formularioDireccion({ prefijo, pool, pools, alGuardar }) {
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
    alGuardar(`✔ ${d.ip} registrada${d.segmento ? ` en ${d.segmento_codigo || d.segmento}` : ' como excepción'}.${d.aviso ? ' ⚠ ' + d.aviso : ''}`);
  };
  const campo = (t, el) => h('label', null, t, el);
  return h(
    'details',
    { class: 'card', style: 'margin:0 0 12px' },
    h('summary', { style: 'cursor:pointer;font-weight:600' }, '＋ Registrar IP fija'),
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
function editarDireccion(d, recargar) {
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
function tablaDirecciones(lista, recargar, { conSegmento = true } = {}) {
  const eliminar = async (d) => {
    if (!confirm(`¿Eliminar ${d.ip}${d.dispositivo ? ` (${d.dispositivo} ${d.interfaz || ''})` : ''}?`)) return;
    const r = await api('/api/v1/direcciones/' + d.id, { method: 'DELETE' });
    if (!r.ok) alert(errorApi(r));
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
async function panelDirecciones({ filtro, pool, resumen }) {
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
const IPS = { q: '', aviso: null };
async function renderIps() {
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
const ip2n = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const n2ip = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
function rango(cidr) {
  const [ip, l] = String(cidr).split('/');
  const len = Number(l);
  const total = 2 ** (32 - len);
  const ini = Math.floor(ip2n(ip) / total) * total;
  return { primera: n2ip(ini), ultima: n2ip(ini + total - 1), total, utilizables: len >= 31 ? total : total - 2, len };
}
const datos = (pares) =>
  h(
    'dl',
    { class: 'datos' },
    pares.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v)]),
  );
const ACCIONES = {
  asignar: 'asignó',
  liberar: 'liberó',
  reservar: 'reservó',
  confirmar_reserva: 'aprobó la reserva de',
  liberar_reserva: 'liberó la reserva de',
  jira_reserva_creada: 'Jira reservó',
  jira_reserva_aprobada: 'Jira registró la aprobación de',
  registrar_ip: 'registró la IP',
  editar_ip: 'editó la IP',
  eliminar_ip: 'eliminó la IP',
  crear_pool: 'creó el pool',
  editar_pool: 'editó el pool',
  eliminar_pool: 'eliminó el pool',
};
const describir = (d = {}) =>
  [
    d.ip || d.cidr,
    d.ip && d.cidr && `en ${d.cidr}`,
    (d.dispositivo || d.interfaz) && [d.dispositivo, d.interfaz].filter(Boolean).join(' '),
    d.excepcion && `excepción: «${d.excepcion}»`,
    d.tipo && d.proveedor && `${d.tipo} · ${d.proveedor}`,
    d.vpc && `para ${d.vpc}`,
    d.vlan && `VLAN ${d.vlan}`,
    d.ticket && `ticket ${d.ticket}`,
    d.motivo && `motivo: «${d.motivo}»`,
  ]
    .filter(Boolean)
    .join(' · ');

/** Historial de un pool o de un segmento (solo admin: sale de la bitácora de auditoría). */
async function historial(filtro) {
  const filas = await get('/api/v1/auditoria?' + new URLSearchParams(filtro));
  if (!filas.length)
    return h('p', { class: 'muted' }, 'Sin acciones registradas. Los segmentos importados o de la semilla muestran su origen y fecha en Detalle.');
  return h(
    'ol',
    { class: 'historial', 'aria-label': 'Historial' },
    filas.map((f) =>
      h(
        'li',
        null,
        h('time', { datetime: f.ts }, fechaHora(f.ts)),
        ' · ',
        h('b', null, f.usuario),
        ` ${ACCIONES[f.accion] || f.accion} `,
        describir(f.detalle),
      ),
    ),
  );
}

/** Abre el panel lateral con pestañas. Cada pestaña se construye al elegirla: construir(cerrar) → Node. */
function abrirPanel(titulo, subtitulo, pestanas) {
  abrirDialogo((dlg, cerrar) => {
    dlg.classList.add('ficha');
    dlg.setAttribute('aria-labelledby', 'ficha-titulo');
    const cuerpo = h('div', { class: 'ficha-cuerpo', role: 'tabpanel', id: 'ficha-panel' });
    const botones = pestanas.map((p, i) =>
      h('button', { type: 'button', role: 'tab', id: 'ficha-tab-' + i, 'aria-controls': 'ficha-panel', onclick: () => elegir(i) }, p.nombre),
    );
    const elegir = async (i) => {
      botones.forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
      cuerpo.setAttribute('aria-labelledby', 'ficha-tab-' + i);
      cuerpo.replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
      try {
        cuerpo.replaceChildren(await pestanas[i].construir(cerrar));
      } catch (e) {
        cuerpo.replaceChildren(h('div', { class: 'alert' }, 'No se pudo cargar: ' + e.message));
      }
    };
    dlg.append(
      h(
        'div',
        { class: 'ficha-cab' },
        h('div', null, h('h2', { id: 'ficha-titulo' }, titulo), h('p', { class: 'muted' }, subtitulo)),
        h('button', { type: 'button', class: 'btn sec', onclick: cerrar }, 'Cerrar'),
      ),
      h('div', { class: 'ficha-tabs', role: 'tablist', 'aria-label': 'Secciones de la ficha' }, botones),
      cuerpo,
    );
    elegir(0);
  });
}

async function fichaPool(id) {
  const pools = await get('/api/v1/pools');
  const p = pools.find((x) => x.id === id);
  if (!p) return alert('Ese pool ya no existe.');
  const r = rango(p.cidr);
  const res = p.uso_reservado || 0;
  abrirPanel(
    p.cidr,
    `Pool ${p.id} · ${p.tipo} · ${p.ambiente} · ${p.proveedor}`,
    [
      {
        nombre: 'Detalle',
        construir: async (cerrar) => {
          const d = await get('/api/v1/pools/' + encodeURIComponent(id) + '/disponibilidad');
          const mayor = d.por_mascara.find((x) => x.bloques_libres > 0);
          return h(
            'div',
            null,
            h('p', { class: 'ficha-uso' }, barraUso(p.uso, res), ` ocupado (asignado ${pct(p.uso)} · reservado ${pct(res)})`),
            datos([
              ['Pool', p.id],
              ['CIDR base', h('code', null, p.cidr)],
              ['Primera dirección', r.primera],
              ['Última dirección', r.ultima],
              ['Tipo', p.tipo],
              ['Ambiente', h('span', { class: 'tag ' + p.ambiente }, p.ambiente)],
              ['Proveedor', p.proveedor],
              ['Direcciones', fmt(r.total)],
              ['Utilizables', fmt(r.utilizables)],
              ['Libres', `${fmt(d.libres)} (${pct(d.total ? d.libres / d.total : 0)})`],
              ['Bloque libre más grande', mayor ? `/${mayor.mascara} (${fmt(mayor.direcciones)} direcciones)` : 'sin espacio'],
              ['Asignaciones', fmt(p.asignaciones)],
              ['Reservas vigentes', fmt(p.reservas_vigentes || 0)],
            ]),
            puede('admin') ? accionesPool(p, cerrar) : null,
          );
        },
      },
      {
        nombre: 'Segmentos',
        construir: async (cerrar) => {
          const [asig, reservas] = await Promise.all([
            get('/api/asignaciones'),
            get('/api/v1/reservas?' + new URLSearchParams({ pool: id, estado: 'reservada' })),
          ]);
          const filas = [
            ...asig.filter((a) => a.pool_id === id).map((a) => ({ ...a, estado: 'asignada' })),
            ...reservas.map((x) => ({ ...x, estado: 'reservada' })),
          ].sort((a, b) => ip2n(a.cidr.split('/')[0]) - ip2n(b.cidr.split('/')[0]));
          if (!filas.length) return h('p', { class: 'muted' }, 'Este pool todavía no tiene segmentos asignados ni reservados.');
          return tabla(
            'Segmentos del pool',
            ['Segmento', 'Estado', 'Proyecto / VPC', 'VLAN', 'Direcciones'],
            filas.map((x) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  x.estado === 'asignada'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'enlace',
                          onclick: () => {
                            cerrar();
                            fichaAsignacion(x.id);
                          },
                        },
                        h('code', null, x.cidr),
                      )
                    : h('code', null, x.cidr),
                ),
                h('td', null, h('span', { class: 'tag ' + (x.estado === 'asignada' ? 'confirmada' : 'reservada') }, x.estado)),
                h('td', null, x.vpc),
                h('td', null, textoVlan(x)),
                h('td', null, fmt(size(x.cidr))),
              ),
            ),
            '',
          );
        },
      },
      {
        nombre: 'Direcciones IP',
        construir: () =>
          panelDirecciones({
            filtro: { pool: id },
            pool: id,
            resumen: (l) => `${fmt(l.length)} IPs fijas registradas en el pool (incluidas las excepciones).`,
          }),
      },
      puede('admin') && { nombre: 'Historial', construir: () => historial({ pool: id }) },
    ].filter(Boolean),
  );
}

async function fichaAsignacion(id) {
  const [todas, pools] = await Promise.all([get('/api/asignaciones'), get('/api/v1/pools')]);
  const a = todas.find((x) => String(x.id) === String(id));
  if (!a) return alert('Esa asignación ya no existe (¿se liberó?).');
  const p = pools.find((x) => x.id === a.pool_id);
  const r = rango(a.cidr);
  abrirPanel(
    a.cidr,
    `${a.codigo || 'Asignación'} · ${a.vpc}`,
    [
      {
        nombre: 'Detalle',
        construir: async (cerrar) =>
          h(
            'div',
            null,
            datos([
              ['ID', h('code', null, a.codigo || String(a.id))],
              ['Segmento', h('code', null, a.cidr)],
              ['Primera dirección', r.primera],
              ['Última dirección', r.ultima],
              ['Máscara', '/' + r.len],
              ['Direcciones', fmt(r.total)],
              ['Utilizables', fmt(r.utilizables)],
              [
                'Pool',
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'enlace',
                    onclick: () => {
                      cerrar();
                      fichaPool(a.pool_id);
                    },
                  },
                  p ? `${a.pool_id} (${p.cidr})` : a.pool_id,
                ),
              ],
              p && ['Ambiente', h('span', { class: 'tag ' + p.ambiente }, p.ambiente)],
              p && ['Proveedor', p.proveedor],
              ['Proyecto / VPC', a.vpc],
              ['VLAN', a.vlan],
              ['Nombre VLAN / subred', a.vlan_nombre],
              ['Ticket', a.ticket],
              ['Origen', a.origen],
              ['Solicitó', a.solicitante],
              ['Creada', fechaHora(a.creado_en)],
            ]),
            puede('admin')
              ? h(
                  'p',
                  { style: 'margin-top:18px' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn peligro',
                      onclick: async () => {
                        if (await liberarAsignacion(a.id, a.cidr)) {
                          cerrar();
                          show(VISTA);
                        }
                      },
                    },
                    'Liberar segmento',
                  ),
                )
              : null,
          ),
      },
      {
        nombre: 'Direcciones IP',
        construir: () =>
          panelDirecciones({
            filtro: { asignacion: a.id },
            pool: a.pool_id,
            resumen: (l) => `${fmt(l.length)} de ${fmt(r.utilizables)} direcciones utilizables registradas como IP fija (${r.primera} – ${r.ultima}).`,
          }),
      },
      puede('admin') && { nombre: 'Historial', construir: () => historial({ pool: a.pool_id, cidr: a.cidr }) },
    ].filter(Boolean),
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
    jira: renderJira,
    tokens: renderTokens,
    usuarios: renderUsuarios,
    importar: renderImportar,
    ips: renderIps,
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
  nav.querySelector('[data-t="tokens"]').hidden = !puede('admin');
  nav.querySelector('[data-t="usuarios"]').hidden = !(puede('admin') && (YO.modo === 'oidc' || YO.cuentas_locales));
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
