// Limitadores de tasa (express-rate-limit). Se crean al montar la aplicación leyendo el entorno en ese momento.
// La clave es la IP del cliente (req.ip): detrás de un ingress hay que definir TRUST_PROXY (nº de saltos) para que sea
// la real y no la del proxy; si no, todos los usuarios compartirían un mismo contador.
const { rateLimit } = require('express-rate-limit');
const paginas = require('./paginas');
const env = process.env;

const entero = (v, defecto) => (Number.isInteger(Number(v)) && Number(v) > 0 && String(v).trim() !== '' ? Number(v) : defecto);

function crear({ ventanaMs, max, mensaje, ...extra }) {
  return rateLimit({
    windowMs: ventanaMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, ...extra,
    handler: (req, res) => {
      const seg = Math.max(1, Math.ceil((req.rateLimit.resetTime ? req.rateLimit.resetTime - Date.now() : ventanaMs) / 1000));
      res.set('Retry-After', String(seg));
      // Una persona que navega (GET de una página) ve un aviso con el estilo de la app; las APIs reciben JSON.
      if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') return paginas.enviar(res, 'demasiados', { segundos: seg });
      res.status(429).json({ error: 'demasiados_intentos', mensaje, reintentar_en_segundos: seg });
    },
  });
}

// Inicio de sesión: /auth/login y /auth/callback comparten contador (por IP).
// RATE_LIMIT_AUTH_MAX (30) peticiones cada RATE_LIMIT_AUTH_VENTANA_MIN (15) minutos.
const limiteAuth = () => crear({
  ventanaMs: entero(env.RATE_LIMIT_AUTH_VENTANA_MIN, 15) * 60000, max: entero(env.RATE_LIMIT_AUTH_MAX, 30),
  mensaje: 'Demasiados intentos de inicio de sesión. Espera unos minutos e inténtalo de nuevo.',
});

// Webhook de Jira: RATE_LIMIT_WEBHOOK_MAX (120) peticiones por minuto y por IP.
const limiteWebhook = () => crear({
  ventanaMs: 60000, max: entero(env.RATE_LIMIT_WEBHOOK_MAX, 120),
  mensaje: 'Demasiadas peticiones al webhook. Reduce la frecuencia.',
});

// Modo basic: bloqueo progresivo por IP. Solo cuentan las peticiones que traen credenciales y fallan (401);
// las correctas no suman. Tres escalones, cada uno más largo: N fallos por minuto, 2N por 15 min y 4N por hora
// (N = RATE_LIMIT_BASIC_MAX, 5). Quien insiste queda bloqueado cada vez más tiempo: como máximo 4N intentos por hora.
function limitesBasic() {
  const n = entero(env.RATE_LIMIT_BASIC_MAX, 5);
  const escalon = (ventanaMs, max) => crear({
    ventanaMs, max, skipSuccessfulRequests: true, skip: (req) => !req.headers.authorization,
    mensaje: 'Demasiados intentos fallidos. Tu IP queda bloqueada temporalmente.',
  });
  return [escalon(60000, n), escalon(15 * 60000, 2 * n), escalon(60 * 60000, 4 * n)];
}

module.exports = { limiteAuth, limiteWebhook, limitesBasic };
