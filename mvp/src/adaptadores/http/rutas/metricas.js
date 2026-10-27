'use strict';
// GET /metrics (formato Prometheus). Protegido con METRICS_TOKEN (Authorization: Bearer) y/o restringido por red (METRICS_ALLOW_CIDRS).
// Sin ninguno de los dos queda DESHABILITADO (404): las métricas revelan datos de operación y no deben quedar abiertas por descuido.
const { ruta } = require('../registro');
const { parse, ip2n } = require('../../../dominio/cidr');
const { igualConstante } = require('../../auth/contrasena');
const { config } = require('../../../config');
const contexto = require('../contexto');

/** ¿Esta IPv4 (o IPv6 «mapeada» a IPv4) cae en alguna de las redes? IPv6 puro: no. */
function ipEnRedes(ip, redes) {
  const v4 = String(ip || '').replace(/^::ffff:/i, '');
  const n = ip2n(v4);
  if (n === null) return false;
  return redes.some((r) => {
    const c = parse(r.includes('/') ? r : `${r}/32`);
    return !!c && n >= c.start && n <= c.end;
  });
}

/** @param {import('express').Express} app @param {{metricas: any}} deps */
function montar(app, { metricas }) {
  ruta(app, 'get', '/metrics', async (req, res) => {
    const m = config.metricas;
    const id = contexto.actual().request_id;
    if (!m.token && !m.redesPermitidas.length)
      return res
        .status(404)
        .json({ error: 'no_encontrado', mensaje: 'Las métricas están deshabilitadas (configura METRICS_TOKEN o METRICS_ALLOW_CIDRS).', request_id: id });
    if (m.redesPermitidas.length && !ipEnRedes(req.ip, m.redesPermitidas)) {
      metricas.authRechazo('metrics_red');
      return res.status(403).json({ error: 'prohibido', mensaje: 'Esta dirección no puede leer las métricas.', request_id: id });
    }
    if (m.token) {
      const cab = String(req.headers.authorization || '');
      const dado = /^Bearer\s/i.test(cab) ? cab.replace(/^Bearer\s+/i, '').trim() : '';
      if (!dado || !igualConstante(dado, m.token)) {
        metricas.authRechazo('metrics_token');
        return res
          .set('WWW-Authenticate', 'Bearer realm="IPAM métricas"')
          .status(401)
          .json({ error: 'no_autenticado', mensaje: 'Token de métricas inválido.', request_id: id });
      }
    }
    res
      .set('Cache-Control', 'no-store')
      .type(metricas.contentType)
      .send(await metricas.generar());
  });
}

module.exports = { montar, ipEnRedes };
