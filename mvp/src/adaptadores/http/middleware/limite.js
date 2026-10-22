'use strict';
// Límite de peticiones: por actor (token o usuario) y por IP, con ventana deslizante. Va DESPUÉS del acceso (ya se sabe quién es).
// 429 con Retry-After y un cuerpo claro en español. Las sondas (/healthz, /readyz, /metrics), la marca y los estáticos no cuentan.
const contexto = require('../contexto');

const SIN_LIMITE = new Set(['/api/health', '/api/config']);
const LECTURAS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** @param {{limite: any, metricas?: any}} deps @returns {import('express').RequestHandler} */
function crearMiddlewareLimite({ limite }) {
  return async (req, res, next) => {
    const aplica = (req.path.startsWith('/api/') || req.path === '/webhook/jira') && !SIN_LIMITE.has(req.path);
    if (!aplica) return next();
    const r = await limite.evaluar({ actor: req.actor ? req.actor.nombre : null, ip: req.ip, escritura: !LECTURAS.has(req.method) });
    if (r.limite) {
      res.set({ 'RateLimit-Limit': String(r.limite), 'RateLimit-Remaining': String(r.restantes), 'RateLimit-Reset': String(r.reinicio) });
    }
    if (r.permitido) return next();
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({
      error: 'rate_limit',
      mensaje: `Demasiadas peticiones${r.motivo === 'ip' ? ' desde esta dirección' : ''}. Reintenta en ${r.retryAfter} segundo${r.retryAfter === 1 ? '' : 's'}.`,
      retry_after: r.retryAfter,
      limite_por_minuto: r.limite,
      request_id: contexto.actual().request_id,
    });
  };
}

module.exports = { crearMiddlewareLimite };
