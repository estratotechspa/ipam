'use strict';
// Correlación y registro de cada petición: acepta o genera X-Request-Id, lo devuelve, abre el contexto y escribe
// una línea de log al terminar (ruta, método, estado, duración, actor). Nunca registra cuerpos, cabeceras ni la query string.
const crypto = require('node:crypto');
const contexto = require('../contexto');

const ID_VALIDO = /^[A-Za-z0-9._:-]{8,128}$/;
const SILENCIOSAS = new Set(['/healthz', '/readyz', '/api/health', '/metrics']);

/** @param {{log: any, metricas: any, trazas: any}} deps @returns {import('express').RequestHandler} */
function crearSolicitud({ log, metricas, trazas }) {
  return (req, res, next) => {
    const entrante = req.get('x-request-id');
    const id = entrante && ID_VALIDO.test(entrante) ? entrante : crypto.randomUUID();
    req.id = id;
    res.set('X-Request-Id', id);
    const inicio = process.hrtime.bigint();
    const datos = { request_id: id };
    contexto.correr(datos, () => {
      const span = trazas.iniciarSolicitud(req, datos);
      res.on('finish', () => {
        const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
        // Ruta «de plantilla» (/api/v1/reservas/:id), no la real: evita explosión de etiquetas y no filtra identificadores.
        const plantilla = req.route && req.route.path ? req.route.path : (res.statusCode === 404 ? 'no_encontrada' : 'estatico');
        metricas.solicitud(plantilla, req.method, res.statusCode, segundos);
        span.terminar(res.statusCode, plantilla);
        const nivel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : (SILENCIOSAS.has(req.path) ? 'debug' : 'info');
        log[nivel]('petición', { metodo: req.method, ruta: plantilla === 'estatico' || plantilla === 'no_encontrada' ? req.path : plantilla, estado: res.statusCode, duracion_ms: Math.round(segundos * 1000 * 100) / 100, ip: req.ip });
      });
      next();
    });
  };
}

module.exports = { crearSolicitud, ID_VALIDO };
