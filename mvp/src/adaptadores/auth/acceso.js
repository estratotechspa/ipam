'use strict';
// Middleware de acceso. Modos: oidc (sesión por cookie), basic (un usuario) o anónimo (solo demos).
// Deja en la petición: req.actor = {nombre, rol, tipo} (y por compatibilidad req.usuario / req.rol / req.nombre).
const { config } = require('../../config');
const { tiene } = require('../../dominio/roles');
const S = require('./sesion');
const contexto = require('../http/contexto');
const { igualConstante, verificar } = require('./contrasena');

// Rutas que no exigen sesión: salud, webhook (va firmado), /auth y la marca.
const PUBLICAS = new Set(['/healthz', '/readyz', '/api/health', '/webhook/jira', '/api/config', '/brand.css', '/brand/logo', '/metrics']);
const esPublica = (p) => PUBLICAS.has(p) || p.startsWith('/auth/');

// Caché local (solo rendimiento) de contraseñas ya verificadas: evita repetir scrypt en cada petición Basic.
const verificadas = new Map();
const TTL_CACHE_MS = 60_000;
const recordar = (clave) => {
  if (verificadas.size > 100) verificadas.clear();
  verificadas.set(clave, Date.now() + TTL_CACHE_MS);
};
// Hash de relleno: cuando el usuario no existe se verifica igual, para que el tiempo no delate si la cuenta existe.
const HASH_RELLENO = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Basic: primero el administrador de emergencia (APP_USER/APP_PASS); si AUTH_LOCAL está activo, después las cuentas locales de la base.
 * Devuelve {nombre, rol, local, debeCambiar} o null. El estado «activo» de una cuenta local se consulta en cada petición (la baja rige al instante).
 */
async function basicValido(cabecera, usuariosLocales) {
  const h = String(cabecera || '');
  if (!h.startsWith('Basic ')) return null;
  const [u, ...resto] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const pass = resto.join(':');
  const a = config.auth;
  const claveRoot = `${a.appUser}|${a.appPass.slice(0, 20)}|${h}`;
  const hit = verificadas.get(claveRoot);
  if (hit && hit > Date.now()) return { nombre: u, rol: 'admin', local: false, debeCambiar: false };
  const userOk = igualConstante(u || '', a.appUser);
  const passOk = await verificar(pass, a.appPass); // se evalúan ambas siempre (sin atajos por tiempo)
  if (userOk && passOk) {
    recordar(claveRoot);
    return { nombre: u, rol: 'admin', local: false, debeCambiar: false };
  }
  if (!a.cuentasLocales || !usuariosLocales || userOk) return null;
  const fila = await usuariosLocales.buscar(String(u || '').toLowerCase());
  const hashOk = await verificar(pass, fila && fila.clave_hash ? fila.clave_hash : HASH_RELLENO);
  if (!fila || !fila.clave_hash || !hashOk || fila.activo === false || !fila.rol) return null;
  await usuariosLocales.marcarAcceso(fila.email).catch(() => {});
  return { nombre: fila.email, rol: fila.rol, local: true, debeCambiar: Boolean(fila.debe_cambiar_clave) };
}

/**
 * Sesión OIDC por cookie, con el rol revalidado en la base. Si no vale (sin cookie, formato anterior, persona dada de baja o
 * eliminada) responde 401 o redirige al login y devuelve null. Sin revalidador (pruebas unitarias) se confía en el rol base.
 */
async function sesionOidc(req, res, { revalidador, rechazo }) {
  const s = S.abrir(S.cookies(req)[S.SESION]);
  // Las cookies anteriores a la revalidación (sin `v: 2`) obligan a entrar de nuevo.
  const rol = s && s.v === 2 ? (revalidador ? await revalidador.rol(s) : s.rolBase) : null;
  if (rol) return { sesion: s, rol };
  rechazo(s ? 'sesion_revocada' : 'sesion_invalida', req);
  if (s) S.borrarCookie(req, res, S.SESION);
  if (req.path.startsWith('/api/')) res.status(401).json({ error: s ? 'sesion_revocada' : 'no autenticado', login: '/auth/login' });
  else res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
  return null;
}

// Mientras la clave sea temporal, la cuenta solo puede ver quién es y cambiarla.
const SIN_CAMBIO_DE_CLAVE = new Set(['/api/me', '/api/v1/me', '/api/yo/clave', '/api/v1/yo/clave', '/api/config']);

/**
 * @param {{rechazo?: (motivo: string, req: any) => unknown, autenticarToken?: (token: string) => Promise<any>, auditar?: Function}} [deps]
 * @returns {import('express').RequestHandler}
 */
function crearAcceso({ rechazo = () => {}, autenticarToken, auditar = async () => {}, frenoFuerzaBruta, usuariosLocales, revalidador } = {}) {
  return async (req, res, next) => {
    if (esPublica(req.path)) return next();
    const modo = config.auth.modo;
    const fijar = (nombre, rol, tipo, mostrar, extra = {}) => {
      req.actor = { nombre, rol, tipo, ...extra };
      req.usuario = nombre;
      req.rol = rol;
      req.nombre = mostrar || nombre;
    };

    // 1) Token de servicio: se evalúa PRIMERO, en cualquier modo (oidc, basic o abierto). Un token inválido es 401 aunque el modo sea abierto.
    //    Sin cookie no hay CSRF: no se exige X-Requested-With.
    const cab = String(req.headers.authorization || '');
    const trae = /^(Bearer|Basic)\s/i.test(cab);
    // Freno a la fuerza bruta: una IP con demasiados intentos fallidos en el último minuto queda bloqueada un rato (incluso con credenciales buenas).
    if (frenoFuerzaBruta && trae) {
      const b = await frenoFuerzaBruta.bloqueada(req.ip);
      if (b.bloqueada) {
        rechazo('fuerza_bruta', req);
        return res
          .set('Retry-After', String(b.retryAfter))
          .status(429)
          .json({
            error: 'rate_limit',
            mensaje: `Demasiados intentos fallidos de autenticación desde esta dirección. Reintenta en ${b.retryAfter} segundo${b.retryAfter === 1 ? '' : 's'}.`,
            retry_after: b.retryAfter,
            request_id: contexto.actual().request_id,
          });
      }
    }
    if (autenticarToken && /^Bearer\s/i.test(cab)) {
      const r = await autenticarToken(cab.replace(/^Bearer\s+/i, '').trim());
      if (!r.ok) {
        rechazo(`token_${r.motivo}`, req);
        if (frenoFuerzaBruta) await frenoFuerzaBruta.fallo(req.ip);
        await auditar('token_rechazado', r.nombre ? `svc:${r.nombre}` : 'desconocido', null, { motivo: r.motivo }, req.ip); // nunca el token presentado
        return res
          .set('WWW-Authenticate', 'Bearer realm="IPAM"')
          .status(401)
          .json({ error: 'token_invalido', mensaje: 'Token inválido, vencido o revocado.', request_id: contexto.actual().request_id });
      }
      fijar(r.actor.nombre, r.actor.rol, 'token', r.actor.nombre, { tokenId: r.actor.tokenId, cuota: r.actor.cuota });
      return next();
    }
    if (modo === 'none') fijar('anonimo', 'admin', 'anonimo');
    else if (modo === 'basic') {
      const u = await basicValido(req.headers.authorization, usuariosLocales);
      if (u === null) {
        rechazo('credenciales_basic', req);
        if (frenoFuerzaBruta && trae) await frenoFuerzaBruta.fallo(req.ip);
        return res.set('WWW-Authenticate', 'Basic realm="IPAM"').status(401).send('Autenticación requerida');
      }
      fijar(u.nombre, u.rol, 'basic', u.nombre, { local: u.local, debeCambiar: u.debeCambiar });
      if (u.debeCambiar && req.path.startsWith('/api/') && !SIN_CAMBIO_DE_CLAVE.has(req.path)) {
        return res.status(403).json({
          error: 'cambio_de_clave_requerido',
          mensaje: 'Tu contraseña es temporal: cámbiala antes de seguir (POST /api/v1/yo/clave).',
          request_id: contexto.actual().request_id,
        });
      }
    } else {
      const o = await sesionOidc(req, res, { revalidador, rechazo });
      if (!o) return; // sesión inválida o revocada: ya se respondió
      fijar(o.sesion.email, o.rol, 'oidc', o.sesion.nombre);
    }
    // Defensa CSRF: los cambios desde el navegador exigen una cabecera que un sitio externo no puede enviar sin permiso CORS.
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'ipam') {
      rechazo('csrf', req);
      return res.status(403).json({ error: 'falta la cabecera X-Requested-With: ipam' });
    }
    next();
  };
}

/** Exige un rol mínimo. */
const requiere = (minimo) => (req, res, next) =>
  tiene(req.rol, minimo) ? next() : res.status(403).json({ error: 'permiso insuficiente', requiere: minimo, rol: req.rol });

module.exports = { crearAcceso, requiere, esPublica, basicValido };
