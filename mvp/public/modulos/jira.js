// Pestaña Jira: estado de la integración, eventos y simulador.
import { $, ESTADO, I, MASCARAS, api, esc, get } from './base.js';

// tipo de evento → [texto para personas, tono]. Los errores son lo que conviene revisar.
export const EVENTOS_JIRA = {
  jira_ticket_creado: ['Ticket creado en Jira', 'ok'],
  jira_ticket_actualizado: ['Ticket de Jira actualizado', 'ok'],
  jira_actualiza_ticket: ['Ticket actualizado (simulado)', 'ok'],
  jira_pendiente_aprobacion: ['Reserva pendiente de aprobación', 'info'],
  jira_webhook_recibido: ['Webhook recibido (simulado)', 'info'],
  jira_rechazo: ['Solicitud de Jira rechazada', 'error'],
  jira_firma_invalida: ['Webhook con firma inválida', 'error'],
  jira_error: ['Error al hablar con Jira', 'error'],
};

export const ICONO_TONO = { ok: 'ok', info: 'info', error: 'alerta' };

export const filaEventoJira = (e) => {
  const [texto, tono] = EVENTOS_JIRA[e.tipo] || [e.tipo, 'info'];
  const d = e.detalle || {};
  const detalle = d.motivo || d.rango || [d.ambiente, d.tipo, d.mascara && `/${d.mascara}`, d.vpc].filter(Boolean).join(' · ') || '';
  return `<tr><td class="num">${new Date(e.ts).toLocaleTimeString('es-CL')}</td><td><span class="evento evento-${tono}">${I(ICONO_TONO[tono])} ${esc(texto)}</span></td><td>${esc(d.ticket || '')}</td><td>${esc(detalle)}</td></tr>`;
};

export const cajaJira = (texto, clase = '') => `<div class="box ${clase}">${texto}</div>`;

export const flujoJira = (pasos) => `<div class="flow">${pasos.map(([t, c]) => cajaJira(t, c)).join(`<span class="arrow">${I('flecha', 20)}</span>`)}</div>`;

export async function renderJira() {
  let ev = [],
    je = { activa: false, faltantes: [] };
  try {
    ev = await get('/api/eventos');
    je = await get('/api/jira/estado');
  } catch (e) {}
  const incompleta = je.activa && je.faltantes.length > 0;
  const insignia = !je.activa
    ? `<span class="tag qa">${I('info')} Desactivada</span>`
    : incompleta
      ? `<span class="tag prod">${I('alerta')} Activa, incompleta</span>`
      : `<span class="tag dev">${I('ok')} Activa</span>`;
  const textoEstado = !je.activa
    ? `<p>La integración saliente está <b>desactivada</b>: el número de ticket (<code>NET-xxx</code>) lo genera el propio IPAM y no se llama a Jira. Para activarla define <code>JIRA_ENABLED=true</code> y las variables de conexión.</p><p class="muted">El webhook de entrada (de Jira al IPAM) funciona igual, con o sin esta integración.</p>`
    : incompleta
      ? `<div class="alert" role="alert">${I('alerta')} La integración está activada pero faltan variables, así que no se crean tickets en Jira:<ul>${je.faltantes.map((v) => `<li><code>${esc(v)}</code></li>`).join('')}</ul></div>`
      : '<p>La integración está <b>activa</b>: cada asignación crea su ticket en Jira en segundo plano (con reintentos), y los tickets que llegan por webhook se comentan y se cierran al aprobar la reserva.</p>';
  const eventos = ev.filter((e) => e.tipo.startsWith('jira')).slice(0, 15);
  const simulador =
    je.simulador === false
      ? `<h3>Simular un ticket entrante</h3><p class="muted">${I('info')} El simulador está deshabilitado en este entorno (producción). Se habilita con ENABLE_SIMULADOR=true.</p>`
      : `<h3>Simular un ticket entrante</h3><p class="muted">Arma un ticket, lo firma como lo haría Jira y lo procesa por el mismo camino del webhook. Crea una reserva real que un admin debe aprobar.</p>
   <div class="row"><div><label for="j-amb">Ambiente</label><select id="j-amb"><option>prod</option><option>qa</option><option>dev</option></select></div>
   <div><label for="j-tipo">Tipo</label><select id="j-tipo"><option>Nodos</option><option selected>Pods</option><option>Servicios</option><option>Control plane</option></select></div>
   <div><label for="j-len">Máscara</label><select id="j-len">${MASCARAS.map((n) => `<option ${n === 22 ? 'selected' : ''} value="${n}">/${n}</option>`).join('')}</select></div>
   <div><label for="j-vpc">VPC</label><input id="j-vpc" value="vpc-nueva" maxlength="100"></div></div>
   <p><button type="button" class="btn" id="j-go">${I('flujo')}Enviar webhook</button></p><div id="j-res" role="status"></div>`;
  $('jira').innerHTML =
    `<div class="cabecera"><h2 tabindex="-1">Integración con Jira</h2><button type="button" class="btn sec" id="j-actualizar">${I('reintentar')}Actualizar</button></div>
  <div class="card"><h3 style="margin-top:0">Estado ${insignia}</h3>${textoEstado}</div>
  <div class="card tablewrap" style="margin-top:var(--sp-4)" tabindex="0" role="region" aria-label="Últimos eventos de Jira"><h3 style="margin-top:0">Últimos eventos</h3>${
    eventos.length
      ? `<table><thead><tr><th scope="col">Hora</th><th scope="col">Evento</th><th scope="col">Ticket</th><th scope="col">Detalle</th></tr></thead><tbody>${eventos.map(filaEventoJira).join('')}</tbody></table>`
      : '<p class="muted">Todavía no hay eventos de Jira. Aparecerán aquí cuando se cree un ticket o llegue un webhook.</p>'
  }</div>
  <details class="plegable" id="j-como"><summary>${I('ayuda')} Cómo funciona</summary>
    <h3>Sentido 1 · IPAM ${I('flecha')} Jira</h3>${flujoJira([['Panel / API<br>asigna un segmento'], ['IPAM<br>valida y asigna'], ['Jira crea el ticket<br>(en segundo plano)', 'jira'], ['Guarda la clave<br>del ticket']])}
    <p class="muted">Con la integración desactivada, el número de ticket lo genera el IPAM (secuencia NET-xxx). Al activarla (JIRA_ENABLED=true) se crea el ticket real en Jira, con reintentos.</p>
    <h3>Sentido 2 · Jira ${I('flecha')} IPAM</h3>${flujoJira([['Ticket «Solicitud de Segmento IPAM»<br>ambiente, tipo, máscara, VPC', 'jira'], ['Webhook<br>(firmado con HMAC y hora)'], ['IPAM calcula<br>y reserva'], ['Aprobación manual<br>de un admin (Segmentos)', 'aprob'], ['Se asigna y se<br>actualiza el ticket', 'jira']])}
    ${simulador}</details>`;
  $('j-actualizar').onclick = renderJira;
  if (je.simulador === false) return;
  if (ESTADO.ultimoJira) {
    $('j-como').open = true;
    $('j-res').className = ESTADO.ultimoJira.ok ? 'ok' : 'alert';
    $('j-res').textContent = ESTADO.ultimoJira.texto;
  }
  $('j-go').onclick = async () => {
    $('j-go').disabled = true;
    const r = await api('/api/jira/simular', {
      body: { ambiente: $('j-amb').value, tipo: $('j-tipo').value, mascara: +$('j-len').value, vpc: $('j-vpc').value.trim() || 'vpc-sin-nombre' },
    });
    ESTADO.ultimoJira = r.ok
      ? {
          ok: true,
          texto: `Ticket ${r.data.ticket}: se reservó ${r.data.cidr} en ${r.data.pool}. Falta la aprobación manual de un admin en la pestaña Segmentos; si no se aprueba, expira sola.`,
        }
      : { ok: false, texto: (r.data && (r.data.mensaje || r.data.error)) || 'Error ' + r.status };
    renderJira();
  };
}
