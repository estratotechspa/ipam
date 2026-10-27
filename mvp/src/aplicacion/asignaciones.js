// @ts-check
'use strict';
const { parse, libres, disponibilidad } = require('../dominio/cidr');
const { ok, fallo } = require('./resultado');
const { validarVlan } = require('../dominio/vlan');
const { crearTareas } = require('./tareas');

const dormir = (/** @type {number} */ ms) => new Promise((listo) => setTimeout(listo, ms));

/**
 * Casos de uso de asignaciones (segmentos definitivos).
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, tickets: import('./puertos').TicketsExternos,
 *          tareas?: ReturnType<typeof crearTareas>, config?: {jira: {reintentos: number, esperaMs: number}}}} deps
 */
function crearAsignaciones({ repo, eventos, tickets, tareas = crearTareas(), config = { jira: { reintentos: 1, esperaMs: 0 } } }) {
  /** Validaciones que no dependen del estado de la base. */
  function validar({ vpc, cidr, mascara }, base, pool) {
    if (!vpc || !String(vpc).trim()) return fallo('validacion', 'Indica el proyecto / VPC.');
    if (cidr) {
      const objetivo = String(cidr).trim();
      const c = parse(objetivo);
      if (!c) return fallo('validacion', 'CIDR inválido. Formato: 10.64.16.0/22.');
      if (!c.aligned) return fallo('validacion', `${objetivo} no está alineado: la dirección de red debe ser múltiplo de su tamaño.`);
      if (c.start < base.start || c.end > base.end) return fallo('validacion', `${objetivo} queda fuera del pool ${pool.cidr}.`);
    } else {
      const len = Number(mascara);
      if (!Number.isInteger(len) || len < base.len || len > 32) return fallo('validacion', 'Máscara inválida para este pool.');
    }
    return null;
  }

  /**
   * Asigna un segmento. Las asignaciones de un mismo pool se serializan con un bloqueo de transacción; la restricción de
   * exclusión de la base queda como respaldo (también cubre inserciones hechas fuera de la API).
   */
  async function asignar({ pool, vpc, cidr, mascara, solicitante, origen, ticket, vlan, vlan_nombre }) {
    const p = await repo.obtenerPool(pool);
    if (!p) return fallo('no_encontrado', `Pool «${pool}» no existe.`);
    const base = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(p.cidr));
    const invalido = validar({ vpc, cidr, mascara }, base, p);
    if (invalido) return invalido;
    const v = validarVlan({ vlan, vlan_nombre });
    if (!v.ok) return fallo('validacion', v.mensaje);

    const r = await repo.transaccion(async (tx) => {
      await tx.bloquear(`pool:${pool}`);
      const ocup = await tx.ocupados(pool);
      let objetivo = cidr ? String(cidr).trim() : null;
      if (!objetivo) {
        [objetivo] = libres(p.cidr, ocup, Number(mascara), 1);
        if (!objetivo) return fallo('conflicto', `No quedan segmentos /${mascara} libres en ${pool}.`);
      }
      const c = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(objetivo));
      const x = await tx.conflicto(pool, objetivo);
      if (x) return fallo('conflicto', 'solapamiento', { conflicto: x, sugeridos: libres(p.cidr, ocup, c.len, 3) });
      const t = ticket || (await tx.siguienteTicket());
      const asignacion = await tx.insertarAsignacion({
        pool,
        cidr: objetivo,
        vpc: String(vpc).trim(),
        solicitante,
        ticket: t,
        origen,
        vlan: v.vlan,
        vlan_nombre: v.vlan_nombre,
      });
      return ok({ asignacion });
    });
    if (!r.ok) return r;
    await eventos.publicar('asignacion', { cidr: r.asignacion.cidr, pool, vpc, ticket: r.asignacion.ticket, origen });
    programarSincronizacion(r.asignacion); // Jira queda fuera del camino crítico: la asignación ya está confirmada
    return r;
  }

  /**
   * Integración saliente con Jira (apagada por defecto). Se ejecuta en segundo plano, con hasta JIRA_REINTENTOS intentos
   * separados por JIRA_REINTENTO_MS × n. Un fallo del gestor de tickets nunca deshace la asignación: queda como evento
   * (jira_ticket_creado / jira_ticket_actualizado / jira_error). Un reintento tras un fallo parcial puede duplicar el comentario en Jira.
   */
  async function sincronizarTickets(a) {
    if (!tickets.activo()) return;
    const falta = tickets.faltantes();
    if (falta.length) return eventos.publicar('jira_error', { ticket: a.ticket, motivo: `Faltan variables: ${falta.join(', ')}` });
    const { reintentos, esperaMs } = config.jira;
    let clave = null;
    let ultimo = null;
    for (let i = 1; i <= Math.max(1, reintentos); i++) {
      try {
        if (a.origen === 'jira') await tickets.actualizar(a.ticket, a);
        else clave = await tickets.crear(a);
        ultimo = null;
        break;
      } catch (e) {
        ultimo = e;
        if (i < reintentos) await dormir(esperaMs * i);
      }
    }
    if (ultimo)
      return eventos.publicar('jira_error', { ticket: a.ticket, motivo: ultimo instanceof Error ? ultimo.message : String(ultimo), intentos: reintentos });
    if (a.origen === 'jira') return eventos.publicar('jira_ticket_actualizado', { ticket: a.ticket, rango: a.cidr });
    // El ticket ya existe en Jira: si guardar su clave falla NO se reintenta la creación (duplicaría el ticket).
    try {
      await repo.actualizarTicketAsignacion(a.id, clave);
    } catch (e) {
      return eventos.publicar('jira_error', {
        ticket: a.ticket,
        motivo: `Ticket ${clave} creado en Jira, pero no se pudo guardar: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return eventos.publicar('jira_ticket_creado', { ticket: clave, rango: a.cidr });
  }
  /** Programa la sincronización sin esperarla (no hace nada si Jira está apagado). */
  function programarSincronizacion(a) {
    if (tickets.activo()) tareas.lanzar(() => sincronizarTickets(a));
  }

  async function liberar(id) {
    const ips = repo.contarDireccionesDe ? await repo.contarDireccionesDe(id) : 0;
    if (ips)
      return fallo('conflicto', 'tiene_direcciones', {
        mensaje: `El segmento tiene ${ips} direcciones IP registradas (interfaces, gateways…). Elimínalas o regístralas como excepción antes de liberarlo.`,
      });
    const fila = await repo.liberarAsignacion(id);
    if (!fila) return fallo('no_encontrado', 'No existe');
    await eventos.publicar('liberacion', fila);
    return ok({ liberado: fila });
  }

  async function sugerirLibres(poolId, mascara) {
    const p = await repo.obtenerPool(poolId);
    if (!p) return fallo('no_encontrado', 'Pool no existe');
    const len = Number(mascara);
    if (!Number.isInteger(len) || len < 8 || len > 32) return fallo('validacion', 'mascara inválida');
    return ok({ libres: libres(p.cidr, await repo.ocupados(poolId), len, 3) });
  }

  /** Cuánto queda disponible en un pool, por tamaño de bloque (cuenta asignaciones y reservas vigentes). */
  async function disponibilidadDe(poolId) {
    const p = await repo.obtenerPool(poolId);
    if (!p) return fallo('no_encontrado', 'Pool no existe');
    return ok({ pool: p.id, cidr: p.cidr, ...disponibilidad(p.cidr, await repo.ocupados(poolId)) });
  }

  return { asignar, liberar, sugerirLibres, disponibilidadDe, programarSincronizacion };
}

module.exports = { crearAsignaciones };
