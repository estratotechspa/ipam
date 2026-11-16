'use strict';
// Pantalla de acceso con SSO: qué opciones mostrar y la puerta de emergencia.
// Con OIDC activo, el administrador de emergencia (APP_USER/APP_PASS) puede entrar desde la misma pantalla si el
// proveedor de identidad no responde. Recibe una sesión corta (1 h), siempre admin, auditada, con freno a la fuerza bruta.
const { config } = require('../../config');
const S = require('./sesion');
const { igualConstante, verificar } = require('./contrasena');

const HORAS_EMERGENCIA = 1;
const MAX_CAMPO = 200;

const esGoogle = (issuer) => /^https:\/\/accounts\.google\.com\/?$/.test(String(issuer || ''));
const emergenciaDisponible = () => config.auth.modo === 'oidc' && Boolean(config.auth.appUser && config.auth.appPass);

/** @param {import('express').Express} app @param {{auditar: Function, ruta: Function, frenoFuerzaBruta?: any}} deps */
function montarEmergencia(app, { auditar, ruta, frenoFuerzaBruta }) {
  // Lo que la pantalla de acceso necesita saber para dibujarse (pública, sin datos sensibles).
  ruta(app, 'get', '/auth/opciones', (_req, res) => {
    const a = config.auth;
    res.set('Cache-Control', 'no-store').json({
      sso: a.modo === 'oidc',
      proveedor: a.modo !== 'oidc' ? null : esGoogle(a.oidc.issuer) ? 'google' : 'oidc',
      emergencia: emergenciaDisponible(),
    });
  });

  ruta(app, 'post', '/auth/local', async (req, res) => {
    // Cambia estado y está fuera del middleware de acceso: mismo control CSRF que la API.
    if (req.headers['x-requested-with'] !== 'ipam') return res.status(403).json({ error: 'falta la cabecera X-Requested-With: ipam' });
    if (!emergenciaDisponible()) return res.status(404).json({ error: 'no_disponible', mensaje: 'El acceso de emergencia no está habilitado.' });
    if (frenoFuerzaBruta) {
      const b = await frenoFuerzaBruta.bloqueada(req.ip);
      if (b.bloqueada)
        return res
          .set('Retry-After', String(b.retryAfter))
          .status(429)
          .json({ error: 'rate_limit', mensaje: `Demasiados intentos fallidos. Reintenta en ${b.retryAfter} s.`, retry_after: b.retryAfter });
    }
    const { usuario, clave, next } = req.body || {};
    const formaOk = typeof usuario === 'string' && typeof clave === 'string' && usuario.length <= MAX_CAMPO && clave.length <= MAX_CAMPO;
    const a = config.auth;
    // Se evalúan usuario y clave siempre (sin atajos): el tiempo de respuesta no delata cuál falló.
    const userOk = igualConstante(formaOk ? usuario : '', a.appUser);
    const passOk = await verificar(formaOk ? clave : '', a.appPass);
    if (!formaOk || !userOk || !passOk) {
      if (frenoFuerzaBruta) await frenoFuerzaBruta.fallo(req.ip);
      await auditar('login_rechazado', formaOk ? usuario.slice(0, 64) : 'desconocido', null, { motivo: 'credenciales de emergencia' }, req.ip);
      return res.status(401).json({ error: 'credenciales_invalidas', mensaje: 'Usuario o contraseña incorrectos.' });
    }
    const sesion = {
      v: 2,
      email: a.appUser,
      nombre: `${a.appUser} (emergencia)`,
      rolBase: 'admin',
      emergencia: S.huellaEmergencia(),
      exp: Date.now() / 1000 + HORAS_EMERGENCIA * 3600,
    };
    S.ponerCookie(req, res, S.SESION, S.sellar(sesion), HORAS_EMERGENCIA * 3600);
    await auditar('login', a.appUser, 'admin', { metodo: 'emergencia' }, req.ip);
    return res.json({ ok: true, redirect: S.rutaSegura(next) });
  });
}

module.exports = { montarEmergencia, esGoogle, HORAS_EMERGENCIA };
