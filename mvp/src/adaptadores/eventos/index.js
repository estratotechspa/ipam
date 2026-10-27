'use strict';
// Compone el puerto PublicadorEventos a partir de los adaptadores activos. Un adaptador que falla no afecta a los demás
// ni a la operación de negocio.
const { crearWebhook } = require('./webhook');

/** Adaptador «log»: cada evento queda como una línea JSON en stdout. */
const adaptadorLog = (log) => ({
  publicar: async (tipo, detalle = {}) => {
    log.info('evento', { evento: tipo, detalle });
  },
});

/** Guarda el evento en la tabla `eventos` (lo muestra la pestaña Jira). */
const adaptadorTabla = (repo) => ({ publicar: (tipo, detalle = {}) => repo.registrarEvento(tipo, detalle) });

/** @param {{repo: any, log: any, cfg: import('../../config').config['eventos'], extra?: Array<{publicar: Function}>}} o */
function crearPublicador({ repo, log, cfg, extra = [] }) {
  const adaptadores = [adaptadorTabla(repo), ...extra];
  if (cfg.publicadores.includes('log')) adaptadores.push(adaptadorLog(log));
  if (cfg.publicadores.includes('webhook')) adaptadores.push(crearWebhook(cfg.webhook, log));
  return {
    async publicar(tipo, detalle = {}) {
      const r = await Promise.allSettled(adaptadores.map((a) => a.publicar(tipo, detalle)));
      for (const x of r) if (x.status === 'rejected') log.warn('Un adaptador de eventos falló', { evento: tipo, error: x.reason });
    },
  };
}

module.exports = { crearPublicador, adaptadorLog, adaptadorTabla };
