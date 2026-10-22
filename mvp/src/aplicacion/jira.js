// @ts-check
'use strict';
const { ok, fallo } = require('./resultado');
const { SOLICITANTE_JIRA } = require('../dominio/reserva');

/**
 * Jira → IPAM: un ticket entrante pide un segmento por ambiente y tipo. NO asigna: crea una RESERVA tentativa y espera la
 * aprobación manual de un admin (human-in-the-loop). Al aprobar (confirmar la reserva) nace la asignación y se avisa a Jira.
 * Sin aprobación, la reserva expira sola.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, auditor: import('./puertos').Auditor, tickets: import('./puertos').TicketsExternos, asignaciones: any, reservas: any}} deps
 */
function crearJira({ repo, eventos, auditor, tickets, asignaciones, reservas }) {
  const actorJira = { nombre: SOLICITANTE_JIRA, tipo: 'sistema', rol: 'agente' };

  async function procesarTicket({ ticket, ambiente, tipo, mascara, vpc }) {
    const p = (await repo.buscarPools({ ambiente, tipo }))[0];
    if (!p) {
      await eventos.publicar('jira_rechazo', { ticket, motivo: `sin pool ${tipo}/${ambiente}` });
      return fallo('ambiguo', `No hay pool ${tipo}/${ambiente}`, { ticket });
    }
    // La clave de idempotencia evita duplicar la reserva si Jira reintenta el mismo ticket.
    const r = await reservas.reservar(actorJira, { pool: p.id, vpc, mascara, ticket }, `jira-${ticket}`);
    if (!r.ok) {
      await eventos.publicar('jira_rechazo', { ticket, motivo: r.error });
      return { ...r, ticket };
    }
    await auditor.registrar({
      accion: 'reservar_jira',
      usuario: SOLICITANTE_JIRA,
      rol: null,
      detalle: { ticket, cidr: r.reserva.cidr, pool: p.id, vpc, reserva: r.reserva.id },
    });
    await eventos.publicar('jira_pendiente_aprobacion', { ticket, rango: r.reserva.cidr, reserva: r.reserva.id, expira_en: r.reserva.expira_en });
    return ok({
      ticket,
      pool: p.id,
      cidr: r.reserva.cidr,
      estado: 'pendiente_de_aprobacion',
      reserva: r.reserva.id,
      expira_en: r.reserva.expira_en,
    });
  }

  /** Gancho de la confirmación: si la reserva vino de Jira, avisa al ticket (o lo deja como evento simulado si la integración está apagada). */
  async function alAprobar(actor, reserva, asignacion, aprobacion) {
    if (reserva.solicitante !== SOLICITANTE_JIRA) return;
    await auditor.registrar({
      accion: 'asignar_jira',
      usuario: actor.nombre,
      rol: actor.rol || null,
      detalle: { ticket: reserva.ticket, cidr: reserva.cidr, pool: reserva.pool_id, vpc: reserva.vpc, aprobado_por: aprobacion.aprobado_por },
    });
    if (tickets.activo()) await asignaciones.sincronizarTickets(asignacion);
    else await eventos.publicar('jira_actualiza_ticket', { ticket: reserva.ticket, rango: reserva.cidr, estado: 'Hecho', simulado: true });
  }

  /** Simulador para la demo: arma el ticket y lo procesa por el mismo camino del webhook. */
  async function simular({ ambiente, tipo, mascara, vpc }, firma) {
    const ticket = await repo.siguienteTicket();
    await eventos.publicar('jira_webhook_recibido', { ticket, ambiente, tipo, mascara, vpc, firma });
    return procesarTicket({ ticket, ambiente, tipo, mascara, vpc });
  }

  return { procesarTicket, simular, alAprobar };
}

module.exports = { crearJira };
