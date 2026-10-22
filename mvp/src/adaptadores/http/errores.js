'use strict';
// Traducción de resultados de la aplicación a respuestas HTTP y manejo de errores SIN detalles internos:
// al cliente solo le llega un código estable y el request_id; la causa queda en el log del servidor.
const contexto = require('./contexto');

const ESTADO = { validacion: 400, no_autenticado: 401, prohibido: 403, no_encontrado: 404, conflicto: 409, ambiguo: 422, cuota: 429, no_disponible: 503 };

/** Responde un `fallo(...)` de un caso de uso. Formato: {error, mensaje?, request_id, …extras}. */
function enviarFallo(res, r, { legado = false } = {}) {
  const estado = ESTADO[r.tipo] || 500;
  const { ok: _ok, tipo: _tipo, ...resto } = r;
  const cuerpo = legado ? { ok: false, status: estado, ...resto } : { ...resto };
  cuerpo.request_id = contexto.actual().request_id;
  if (r.retryAfter) res.set('Retry-After', String(r.retryAfter));
  return res.status(estado).json(cuerpo);
}

/** Respuesta de error genérica con request_id. */
const error = (res, estado, codigo, mensaje, extra = {}) =>
  res.status(estado).json({ error: codigo, mensaje, ...extra, request_id: contexto.actual().request_id });

/** @param {{error: Function, warn: Function}} log */
function manejadorDeErrores(log) {
  return (err, req, res, _next) => {
    if (res.headersSent) return req.socket.destroy();
    const id = contexto.actual().request_id;
    if (err && err.type === 'entity.too.large') return error(res, 413, 'cuerpo_demasiado_grande', 'El cuerpo de la petición supera el tamaño permitido.');
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) return error(res, 400, 'cuerpo_invalido', 'El cuerpo no es un JSON válido.');
    if (err && err.type === 'encoding.unsupported') return error(res, 415, 'codificacion_no_soportada', 'Codificación no soportada.');
    log.error('Error no controlado', { error: err, ruta: req.path, metodo: req.method });
    return res.status(500).json({ error: 'interno', mensaje: 'Error interno. Si persiste, indica este request_id al equipo de soporte.', request_id: id });
  };
}

/** 404 JSON para rutas /api desconocidas. */
const noEncontrada = (req, res, next) => (req.path.startsWith('/api/') ? error(res, 404, 'no_encontrado', 'La ruta no existe.') : next());

module.exports = { enviarFallo, error, manejadorDeErrores, noEncontrada, ESTADO };
