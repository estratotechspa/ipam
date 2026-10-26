// Pestaña «Solicitar»: formulario con validación del CIDR mientras se escribe; el servidor sigue siendo quien decide.
import { $, esc, fmt, fecha, I } from './util.js';
import { api, get } from './api.js';
import { validarCidr } from './calculos.js';
import { toast } from './ui.js';

const MASCARAS = [16, 18, 19, 20, 21, 22, 23, 24, 26, 28];
let panel = null;
let pools = [];
let jiraActiva = false;
let demo = false;

// El formulario se dibuja una sola vez: al volver a la pestaña solo se refrescan los datos y se conserva lo escrito.
export async function mostrar(destino, poolPedido) {
  panel = destino;
  try {
    [pools, demo, jiraActiva] = await Promise.all([get('/api/pools'), configDemo(), estadoJira()]);
  } catch (e) {
    panel.innerHTML = `<div class="alert" role="alert">${I('error')} No se pudo cargar: ${esc(e.message)}</div>`;
    delete panel.dataset.listo;
    return;
  }
  if (!panel.dataset.listo) construir();
  opcionesDePools(poolPedido);
  revisarCidr();
}

const configDemo = async () => { try { return (await (await fetch('/api/config')).json()).demo === true; } catch { return false; } };
const estadoJira = async () => { try { return (await get('/api/jira/estado')).activa === true; } catch { return false; } };

function construir() {
  panel.dataset.listo = 'si';
  panel.innerHTML = `<h2 tabindex="-1">Solicitar segmento</h2>
    <div class="row">
      <form class="card form-solicitud" id="s-form" novalidate>
        <label for="s-pool">Pool</label><select id="s-pool"></select>
        <p class="muted" id="s-pool-info"></p>
        <label for="s-vpc">Proyecto / VPC</label>
        <input id="s-vpc" maxlength="100" autocomplete="off" required aria-required="true" placeholder="Nombre del proyecto o de la VPC">
        <label for="s-cidr">CIDR manual (opcional; vacío = asignar el primer libre)</label>
        <input id="s-cidr" autocomplete="off" inputmode="decimal" placeholder="10.64.16.0/22" aria-describedby="s-cidr-msg">
        <p class="campo-msg" id="s-cidr-msg" aria-live="polite"></p>
        <label for="s-len">Máscara (si no hay CIDR manual)</label>
        <select id="s-len">${MASCARAS.map((n) => `<option value="${n}">/${n}</option>`).join('')}</select>
        <p class="acciones-form"><button type="submit" class="btn" id="s-go">${I('mas')}Solicitar</button></p>
      </form>
      <div class="card" id="s-res" aria-live="polite">${demo ? ayudaDemo : ''}</div>
    </div>`;
  $('s-len').value = '22';
  $('s-form').addEventListener('submit', (e) => { e.preventDefault(); enviar(); });
  $('s-cidr').addEventListener('input', revisarCidr);
  $('s-pool').addEventListener('change', () => { infoPool(); revisarCidr(); });
}

const ayudaDemo = '<p class="muted">Demo: prueba un CIDR que choque con uno existente (por ejemplo 10.64.8.0/22 en gke-pods-prod): la base de datos lo rechaza y se sugieren segmentos libres.</p>';

function opcionesDePools(pedido) {
  const sel = $('s-pool');
  const actual = pedido || sel.value;
  sel.innerHTML = pools.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} (${esc(p.cidr)})</option>`).join('');
  if (actual && pools.some((p) => p.id === actual)) sel.value = actual;
  infoPool();
}

function infoPool() {
  const p = pools.find((x) => x.id === $('s-pool').value);
  $('s-pool-info').textContent = p ? `${p.tipo} · ${p.proveedor} · ${fmt(p.libres)} direcciones libres de ${fmt(p.total)}` : '';
}

// Valida mientras se escribe (formato, alineación y que quede dentro del pool) y deshabilita el envío si hay un error.
function revisarCidr() {
  const input = $('s-cidr');
  const p = pools.find((x) => x.id === $('s-pool').value);
  const v = validarCidr(input.value, p && p.cidr);
  const msg = $('s-cidr-msg');
  msg.className = `campo-msg${v.estado === 'error' ? ' campo-error' : v.estado === 'ok' ? ' campo-ok' : ''}`;
  msg.innerHTML = v.estado === 'vacio' ? '' : `${I(v.estado === 'error' ? 'error' : 'ok')} ${esc(v.mensaje)}`;
  if (v.estado === 'error') input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  $('s-go').disabled = v.estado === 'error';
}

async function enviar() {
  const vpc = $('s-vpc').value.trim();
  if (!vpc) { $('s-res').innerHTML = `<div class="alert" role="alert">${I('error')} Indica el proyecto o la VPC.</div>`; $('s-vpc').focus(); return; }
  const cuerpo = { pool: $('s-pool').value, vpc, cidr: $('s-cidr').value.trim() || undefined, mascara: Number($('s-len').value) };
  const res = $('s-res');
  $('s-go').disabled = true;
  const r = await api('/api/solicitudes', { body: cuerpo });
  revisarCidr();
  const d = r.data || {};
  if (r.ok) {
    const jira = jiraActiva ? ' El ticket de Jira se crea en segundo plano; el resultado queda en la pestaña Jira.' : '';
    res.innerHTML = `<div class="ok" role="status">${I('ok')} Asignado <code>${esc(d.cidr)}</code> en ${esc(d.pool_id)} para ${esc(d.vpc)}. Ticket <b>${esc(d.ticket)}</b> generado.${jira}</div>
      <p class="muted">Míralo en la pestaña Asignaciones.</p>`;
    toast(`Segmento ${d.cidr} asignado (${d.ticket}).`);
    $('s-cidr').value = '';
    revisarCidr();
    try { pools = await get('/api/pools'); infoPool(); } catch { /* la información de espacio libre se actualizará la próxima vez */ }
    return;
  }
  if (d.error === 'solapamiento') return mostrarSolapamiento(res, cuerpo, d);
  res.innerHTML = `<div class="alert" role="alert">${I('error')} ${esc(d.error || `Error ${r.status}`)}</div>`;
}

function mostrarSolapamiento(res, cuerpo, d) {
  const x = d.conflicto;
  const len = (cuerpo.cidr || '').split('/')[1] || cuerpo.mascara;
  res.innerHTML = `<div class="alert" role="alert"><b>${I('alerta')} Solapamiento detectado</b><br>
      ${cuerpo.cidr ? `<code>${esc(cuerpo.cidr)}</code> se cruza` : 'El segmento pedido se cruza'} con <code>${esc(x.cidr)}</code> asignado a <b>${esc(x.vpc)}</b>
      por <b>${esc(x.solicitante)}</b> el ${fecha(x.creado_en)} (ticket ${esc(x.ticket)}).</div>
    <b>Segmentos libres sugeridos (/${esc(len)})</b><br><br>
    ${d.sugeridos.length
    ? d.sugeridos.map((s) => `<div class="sug"><code>${esc(s)}</code><button type="button" class="btn" data-use="${esc(s)}">Usar</button></div>`).join('')
    : '<p class="muted">No hay segmentos libres de ese tamaño.</p>'}`;
  res.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => { $('s-cidr').value = b.dataset.use; revisarCidr(); enviar(); }; });
}
