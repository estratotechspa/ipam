// @ts-check
'use strict';
const { ok, fallo } = require('./resultado');

/**
 * Jira → IPAM: un ticket entrante pide un segmento por ambiente y tipo.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, auditor: import('./puertos').Auditor, tickets: import('./puertos').TicketsExternos, asignaciones: any}} deps
 */
function crearJira({ repo, eventos, auditor, tickets, asignaciones }) {
  async function procesarTicket({ ticket, ambiente, tipo, mascara, vpc }) {
    const p = (await repo.buscarPools({ ambiente, tipo }))[0];
    if (!p) {
      await eventos.publicar('jira_rechazo', { ticket, motivo: `sin pool ${tipo}/${ambiente}` });
      return fallo('ambiguo', `No hay pool ${tipo}/${ambiente}`, { ticket });
    }
    const r = await asignaciones.asignar({ pool: p.id, vpc, mascara, solicitante: 'jira-webhook', origen: 'jira', ticket });
    if (!r.ok) {
      await eventos.publicar('jira_rechazo', { ticket, motivo: r.error });
      return { ...r, ticket };
    }
    await auditor.registrar({ accion: 'asignar_jira', usuario: 'jira-webhook', rol: null, detalle: { ticket, cidr: r.asignacion.cidr, pool: p.id, vpc } });
    // Retorno a Jira: con la integración activa ya lo hizo la asignación; apagada, solo queda el evento simulado.
    if (!tickets.activo()) await eventos.publicar('jira_actualiza_ticket', { ticket, rango: r.asignacion.cidr, estado: 'Hecho', simulado: true });
    return ok({ ticket, pool: p.id, cidr: r.asignacion.cidr });
  }

  /** Simulador para la demo: arma el ticket y lo procesa por el mismo camino del webhook. */
  async function simular({ ambiente, tipo, mascara, vpc }, firma) {
    const ticket = await repo.siguienteTicket();
    await eventos.publicar('jira_webhook_recibido', { ticket, ambiente, tipo, mascara, vpc, firma });
    return procesarTicket({ ticket, ambiente, tipo, mascara, vpc });
  }

  return { procesarTicket, simular };
}

module.exports = { crearJira };
