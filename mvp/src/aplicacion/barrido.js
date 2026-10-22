// @ts-check
'use strict';

/**
 * Barredor: limpieza periódica (reservas vencidas, contadores viejos). La CORRECCIÓN no depende de él: las reservas
 * vencidas ya se ignoran al consultar (expiración perezosa). El barredor solo ordena la casa.
 * Con varias réplicas, un advisory lock hace que solo una lo ejecute a la vez.
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos, reloj: import('./puertos').Reloj, intervaloMs: number, instancia: string}} deps
 */
function crearBarrido({ repo, eventos, reloj, intervaloMs, instancia }) {
  async function barrer() {
    const r = await repo.conBarredor({ ahora: reloj.ahora(), minimoMs: Math.floor(intervaloMs * 0.8), instancia }, async (tx, ahora) => {
      const expiradas = await tx.expirarReservasVencidas(ahora);
      const contadoresBorrados = await tx.purgarLimite(ahora);
      return { expiradas, contadoresBorrados };
    });
    if (r.ejecutado) for (const e of r.expiradas) await eventos.publicar('reserva_expirada', { reserva: e.id, cidr: e.cidr, pool: e.pool_id, solicitante: e.solicitante });
    return r;
  }
  return { barrer };
}

module.exports = { crearBarrido };
