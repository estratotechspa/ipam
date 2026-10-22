'use strict';
// Repositorio EN MEMORIA: implementa el mismo puerto que el de PostgreSQL, pero solo para pruebas de los casos de uso
// (rápidas, sin base de datos) y para demostrar que la aplicación no depende de PostgreSQL. NO es para producción:
// no hay persistencia ni aislamiento real entre transacciones.
const crypto = require('node:crypto');
const { parse, overlap } = require('../../../dominio/cidr');
const { ConflictoDeDatos } = require('../../../aplicacion/resultado');

/** @param {{reloj?: {ahora: () => Date}, pools?: any[]}} [o] */
function crearRepositorioMemoria({ reloj = { ahora: () => new Date() }, pools = [] } = {}) {
  const datos = { pools: new Map(pools.map((p) => [p.id, p])), asignaciones: [], reservas: [], ticket: 142, idAsignacion: 0, barredor: null };
  const ahora = () => reloj.ahora();
  const efectivo = (r) => (r.estado === 'reservada' && r.expira_en.getTime() <= ahora().getTime() ? 'expirada' : r.estado);
  const vigente = (r) => r.estado === 'reservada' && r.expira_en.getTime() > ahora().getTime();
  const vista = (r) => r && ({ ...r, estado: efectivo(r), estado_registrado: r.estado, segundos_restantes: vigente(r) ? Math.floor((r.expira_en.getTime() - ahora().getTime()) / 1000) : 0 });
  const cruza = (a, b) => overlap(/** @type {any} */ (parse(a)), /** @type {any} */ (parse(b)));

  const metodos = {
    async bloquear() {},
    async obtenerPool(id) { return datos.pools.get(id); },
    async buscarPools({ ambiente, tipo }) { return [...datos.pools.values()].filter((p) => p.ambiente === ambiente && p.tipo === tipo).sort((a, b) => a.id.localeCompare(b.id)); },
    async ocupados(poolId) {
      return [...datos.asignaciones.filter((a) => a.pool_id === poolId), ...datos.reservas.filter((r) => r.pool_id === poolId && vigente(r))].map((x) => x.cidr);
    },
    async conflicto(poolId, cidr) {
      const a = datos.asignaciones.find((x) => x.pool_id === poolId && cruza(x.cidr, cidr));
      if (a) return { fuente: 'asignacion', cidr: a.cidr, vpc: a.vpc, solicitante: a.solicitante, ticket: a.ticket, creado_en: a.creado_en };
      const r = datos.reservas.find((x) => x.pool_id === poolId && vigente(x) && cruza(x.cidr, cidr));
      return r ? { fuente: 'reserva', cidr: r.cidr, vpc: r.vpc, solicitante: r.solicitante, ticket: r.ticket, creado_en: r.creado_en, expira_en: r.expira_en } : null;
    },
    async siguienteTicket() { datos.ticket += 1; return `NET-${datos.ticket}`; },
    async insertarAsignacion({ pool, cidr, vpc, solicitante, ticket, origen }) {
      if (datos.asignaciones.some((x) => x.pool_id === pool && cruza(x.cidr, cidr))) throw new ConflictoDeDatos('solapamiento', '23P01');
      const a = { id: ++datos.idAsignacion, pool_id: pool, cidr, vpc, solicitante, ticket, origen, creado_en: ahora() };
      datos.asignaciones.push(a);
      return { ...a };
    },
    async asignacionPorId(id) { return datos.asignaciones.find((a) => String(a.id) === String(id)) || null; },
    async reservaPorClave(solicitante, clave) { return vista(datos.reservas.find((r) => r.solicitante === solicitante && r.clave_idem === clave)) || null; },
    async reservaPorId(id) { return vista(datos.reservas.find((r) => r.id === id)) || null; },
    async listarReservas({ estado, pool, solicitante, limite }) {
      return datos.reservas.map(vista).filter((r) => (!estado || r.estado === estado) && (!pool || r.pool_id === pool) && (!solicitante || r.solicitante === solicitante))
        .sort((a, b) => b.creado_en - a.creado_en).slice(0, limite);
    },
    async contarVigentesDe(solicitante) { return datos.reservas.filter((r) => r.solicitante === solicitante && vigente(r)).length; },
    async insertarReserva({ pool, cidr, vpc, solicitante, ticket, ttlHoras, clave }) {
      if (clave && datos.reservas.some((r) => r.solicitante === solicitante && r.clave_idem === clave)) throw new ConflictoDeDatos('clave repetida', '23505');
      if (datos.reservas.some((r) => r.pool_id === pool && vigente(r) && cruza(r.cidr, cidr)) || datos.asignaciones.some((a) => a.pool_id === pool && cruza(a.cidr, cidr))) throw new ConflictoDeDatos('solapamiento', '23P01');
      const r = { id: crypto.randomUUID(), pool_id: pool, cidr, vpc, solicitante, ticket, estado: 'reservada', clave_idem: clave, creado_en: ahora(), expira_en: new Date(ahora().getTime() + ttlHoras * 3600_000), resuelto_en: null, asignacion_id: null };
      datos.reservas.push(r);
      return vista(r);
    },
    async expirarVencidas(poolId) {
      const out = [];
      for (const r of datos.reservas) {
        if (r.estado === 'reservada' && r.expira_en.getTime() <= ahora().getTime() && (!poolId || r.pool_id === poolId)) { r.estado = 'expirada'; r.resuelto_en = ahora(); out.push({ id: r.id, cidr: r.cidr, pool_id: r.pool_id, solicitante: r.solicitante }); }
      }
      return out;
    },
    async marcarExpirada(id) {
      const r = datos.reservas.find((x) => x.id === id && x.estado === 'reservada');
      if (!r) return undefined;
      r.estado = 'expirada'; r.resuelto_en = ahora();
      return { id: r.id, cidr: r.cidr, pool_id: r.pool_id, solicitante: r.solicitante };
    },
    async marcarConfirmada(id, asignacionId) { const r = datos.reservas.find((x) => x.id === id); Object.assign(r, { estado: 'confirmada', resuelto_en: ahora(), asignacion_id: asignacionId }); return vista(r); },
    async marcarLiberada(id) { const r = datos.reservas.find((x) => x.id === id); Object.assign(r, { estado: 'liberada', resuelto_en: ahora() }); return vista(r); },
    async borrarAsignacion(id) { const n = datos.asignaciones.length; datos.asignaciones = datos.asignaciones.filter((a) => String(a.id) !== String(id)); return datos.asignaciones.length < n; },
    async insertarAsignacionDeReserva(r) { return metodos.insertarAsignacion({ pool: r.pool_id, cidr: r.cidr, vpc: r.vpc, solicitante: r.solicitante, ticket: r.ticket, origen: 'agente' }); },
    async purgarLimite() { return 0; },
  };
  return {
    ...metodos,
    datos,
    async transaccion(fn) { return fn(metodos); },
    async conBarredor({ minimoMs }, fn) {
      if (datos.barredor && ahora().getTime() - datos.barredor.getTime() < minimoMs) return { ejecutado: false, motivo: 'reciente' };
      const r = await fn(metodos);
      datos.barredor = ahora();
      return { ejecutado: true, ...r };
    },
  };
}

module.exports = { crearRepositorioMemoria };
