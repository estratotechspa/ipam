// Pestaña «Jira»: primero el estado real de la integración y sus últimos eventos; el diagrama y el simulador, plegados.
import { $, esc, hora, I, cargando, falla } from './util.js';
import { api, get } from './api.js';
import { toast } from './ui.js';

const VARIABLES = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT'];

// tipo de evento → texto para personas y tono (error = algo que revisar)
const EVENTOS = {
  jira_ticket_creado: ['Ticket creado en Jira', 'ok'],
  jira_ticket_actualizado: ['Ticket de Jira actualizado', 'ok'],
  jira_actualiza_ticket: ['Ticket actualizado (simulado)', 'ok'],
  jira_webhook_recibido: ['Webhook recibido (simulado)', 'info'],
  jira_rechazo: ['Solicitud de Jira rechazada', 'error'],
  jira_firma_invalida: ['Webhook con firma inválida', 'error'],
  jira_error: ['Error al hablar con Jira', 'error'],
};
const ICONO_TONO = { ok: 'ok', info: 'info', error: 'alerta' };

let panel = null;

export async function mostrar(destino) {
  panel = destino;
  cargando(panel);
  try {
    const [estado, eventos] = await Promise.all([get('/api/jira/estado'), get('/api/eventos')]);
    pintar(estado, eventos.filter((e) => e.tipo.startsWith('jira')).slice(0, 15));
  } catch (e) { falla(panel, e, () => mostrar(panel)); }
}

function pintar(estado, eventos) {
  panel.removeAttribute('aria-busy');
  const incompleta = estado.activa && estado.faltantes.length > 0;
  panel.innerHTML = `
    <div class="cabecera"><h2 tabindex="-1">Integración con Jira</h2>
      <button type="button" class="btn sec" id="j-actualizar">${I('reintentar')}Actualizar</button></div>
    <div class="card">
      <h3 style="margin-top:0">Estado ${insignia(estado, incompleta)}</h3>
      ${textoEstado(estado, incompleta)}
    </div>
    <div class="card tablewrap" style="margin-top:var(--sp-4)" tabindex="0" role="region" aria-label="Últimos eventos de Jira">
      <h3 style="margin-top:0">Últimos eventos</h3>
      ${eventos.length ? `<table><thead><tr><th scope="col">Hora</th><th scope="col">Evento</th><th scope="col">Ticket</th><th scope="col">Detalle</th></tr></thead>
        <tbody>${eventos.map(fila).join('')}</tbody></table>`
    : '<p class="muted">Todavía no hay eventos de Jira. Aparecerán aquí cuando se cree un ticket o llegue un webhook.</p>'}
    </div>
    <details class="plegable" id="j-como">
      <summary>${I('ayuda')} Cómo funciona</summary>
      ${explicacion()}
      ${estado.simulador ? simulador() : `<p class="muted">${I('info')} El simulador de tickets está deshabilitado en este entorno (se habilita con ENABLE_SIMULADOR=true).</p>`}
    </details>`;
  $('j-actualizar').onclick = () => mostrar(panel);
  const go = $('j-go');
  if (go) go.onclick = simular;
}

function insignia(estado, incompleta) {
  if (!estado.activa) return `<span class="tag qa">${I('info')} Desactivada</span>`;
  return incompleta ? `<span class="tag prod">${I('alerta')} Activa, incompleta</span>` : `<span class="tag dev">${I('ok')} Activa</span>`;
}

function textoEstado(estado, incompleta) {
  if (!estado.activa) {
    return `<p>La integración saliente está <b>desactivada</b>: el número de ticket (<code>NET-xxx</code>) lo genera el propio IPAM y no se llama a Jira.
      Para activarla define <code>JIRA_ENABLED=true</code> y las variables de conexión.</p>
      <p class="muted">El webhook de entrada (de Jira al IPAM) funciona igual, con o sin esta integración.</p>`;
  }
  if (incompleta) {
    return `<div class="alert" role="alert">${I('alerta')} La integración está activada pero faltan variables, así que no se crean tickets en Jira:
      <ul>${estado.faltantes.map((v) => `<li><code>${esc(v)}</code></li>`).join('')}</ul></div>`;
  }
  return `<p>La integración está <b>activa</b>: cada solicitud hecha desde el panel crea un ticket en Jira en segundo plano, y los tickets que llegan por webhook se comentan y se cierran.
    Variables configuradas: ${VARIABLES.map((v) => `<code>${v}</code>`).join(', ')}.</p>`;
}

function fila(e) {
  const [texto, tono] = EVENTOS[e.tipo] || [e.tipo, 'info'];
  const d = e.detalle || {};
  const detalle = d.motivo || d.rango || [d.ambiente, d.tipo, d.mascara && `/${d.mascara}`, d.vpc].filter(Boolean).join(' · ') || '';
  return `<tr><td class="num">${hora(e.ts)}</td>
    <td><span class="evento evento-${tono}">${I(ICONO_TONO[tono])} ${esc(texto)}</span></td>
    <td>${esc(d.ticket || '')}</td><td>${esc(detalle)}</td></tr>`;
}

const caja = (texto, jira = false) => `<div class="box${jira ? ' jira' : ''}">${texto}</div>`;
const flecha = `<span class="arrow">${I('flecha', 20)}</span>`;

// Cada flujo es una lista de pasos [texto, ¿lo hace Jira?] unidos por flechas.
const flujo = (pasos) => `<div class="flow">${pasos.map(([texto, esJira]) => caja(texto, esJira)).join(flecha)}</div>`;

function explicacion() {
  return `
    <h3>Sentido 1 · IPAM ${I('flecha')} Jira</h3>
    ${flujo([
    ['Panel / API<br>solicita segmento'], ['IPAM<br>valida y asigna'],
    ['Jira crea el ticket<br>(en segundo plano)', true], ['Guarda la clave<br>del ticket'],
  ])}
    <p class="muted">Con la integración desactivada, el número de ticket lo genera el IPAM (secuencia NET-xxx). Al activarla se crea el ticket real en Jira, con reintentos.</p>
    <h3>Sentido 2 · Jira ${I('flecha')} IPAM</h3>
    ${flujo([
    ['Ticket «Solicitud de Segmento IPAM»<br>ambiente, tipo, máscara, VPC', true], ['Webhook<br>(firmado con HMAC y hora)'],
    ['IPAM calcula<br>y asigna'], ['Actualiza el ticket<br>con el rango', true],
  ])}`;
}

function simulador() {
  return `<h3>Simular un ticket entrante</h3>
    <p class="muted">Arma un ticket, lo firma como lo haría Jira y lo procesa por el mismo camino del webhook. Crea una asignación real.</p>
    <div class="row">
      <div><label for="j-amb">Ambiente</label><select id="j-amb"><option>prod</option><option>qa</option><option>dev</option></select></div>
      <div><label for="j-tipo">Tipo</label><select id="j-tipo"><option>Nodos</option><option selected>Pods</option><option>Servicios</option><option>Control plane</option></select></div>
      <div><label for="j-len">Máscara</label><select id="j-len">${[16, 20, 22, 24, 28].map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select></div>
      <div><label for="j-vpc">VPC</label><input id="j-vpc" maxlength="100" placeholder="vpc-nueva"></div>
    </div>
    <p><button type="button" class="btn" id="j-go">${I('flujo')}Enviar webhook</button></p>`;
}

async function simular() {
  const boton = $('j-go');
  boton.disabled = true;
  const cuerpo = { ambiente: $('j-amb').value, tipo: $('j-tipo').value, mascara: Number($('j-len').value), vpc: $('j-vpc').value.trim() || 'vpc-sin-nombre' };
  const r = await api('/api/jira/simular', { body: cuerpo });
  if (r.ok) toast(`Webhook procesado: ${r.data.cidr} en ${r.data.pool} (${r.data.ticket}).`);
  else toast((r.data && (r.data.error || r.data.mensaje)) || `No se pudo simular (error ${r.status}).`, 'error');
  const abierto = $('j-como').open;
  await mostrar(panel);
  if (abierto) $('j-como').open = true;
}
