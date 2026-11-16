'use strict';
// Pantalla de acceso: autenticación local de administrador y cuentas locales.
const { config } = require('../../config');
const S = require('./sesion');
const { igualConstante, verificar } = require('./contrasena');

const HORAS_SESION = 8;
const MAX_CAMPO = 200;

const esGoogle = (issuer) => /^https:\/\/accounts\.google\.com\/?$/.test(String(issuer || ''));

async function validarCredencialesAdmin(usuario, clave) {
  const a = config.auth;
  const adminUser = a.appUser || 'admin';
  const esAdmin = igualConstante(usuario.toLowerCase(), adminUser.toLowerCase());
  if (!esAdmin) return null;
  const passOk = a.appPass ? await verificar(clave, a.appPass) : clave === 'admin';
  if (!passOk) return null;
  return {
    email: adminUser,
    nombre: `${adminUser} (admin)`,
    rol: 'admin',
    emergencia: S.huellaEmergencia(),
  };
}

async function validarCredencialesLocal(usuario, clave, usuariosLocales) {
  if (!usuariosLocales) return null;
  const fila = await usuariosLocales.buscar(String(usuario).toLowerCase());
  if (!fila || fila.activo === false || !fila.clave_hash || !fila.rol) return null;
  const passOk = await verificar(clave, fila.clave_hash);
  if (!passOk) return null;
  await usuariosLocales.marcarAcceso(fila.email).catch(() => {});
  return {
    email: fila.email,
    nombre: fila.nombre || fila.email,
    rol: fila.rol,
    debeCambiar: Boolean(fila.debe_cambiar_clave),
  };
}

/** @param {import('express').Express} app @param {{auditar: Function, ruta: Function, frenoFuerzaBruta?: any, usuariosLocales?: any}} deps */
function montarEmergencia(app, { auditar, ruta, frenoFuerzaBruta, usuariosLocales }) {
  // Lo que la pantalla de acceso necesita saber para dibujarse (pública, sin datos sensibles).
  ruta(app, 'get', '/auth/opciones', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      sso: false, // Google SSO en off de momento
      proveedor: null,
      emergencia: true,
      cuentas_locales: true,
    });
  });

  ruta(app, 'post', '/auth/local', async (req, res) => {
    // Cambia estado y está fuera del middleware de acceso: mismo control CSRF que la API.
    if (req.headers['x-requested-with'] !== 'ipam') return res.status(403).json({ error: 'falta la cabecera X-Requested-With: ipam' });
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
    const u = formaOk ? usuario.trim() : '';
    const p = formaOk ? clave : '';

    if (!formaOk || !u || !p) {
      return res.status(400).json({ error: 'datos_invalidos', mensaje: 'Indica usuario y contraseña válidos.' });
    }

    const admin = await validarCredencialesAdmin(u, p);
    const local = !admin ? await validarCredencialesLocal(u, p, usuariosLocales) : null;
    const cuenta = admin || local;

    if (!cuenta) {
      if (frenoFuerzaBruta) await frenoFuerzaBruta.fallo(req.ip);
      await auditar('login_rechazado', u.slice(0, 64), null, { motivo: 'credenciales locales' }, req.ip);
      return res.status(401).json({ error: 'credenciales_invalidas', mensaje: 'Usuario o contraseña incorrectos.' });
    }

    const sesion = {
      v: 2,
      email: cuenta.email,
      nombre: cuenta.nombre,
      rolBase: cuenta.rol,
      emergencia: cuenta.emergencia || undefined,
      local: true,
      debeCambiar: Boolean(cuenta.debeCambiar),
      exp: Date.now() / 1000 + HORAS_SESION * 3600,
    };
    S.ponerCookie(req, res, S.SESION, S.sellar(sesion), HORAS_SESION * 3600);
    await auditar('login', cuenta.email, cuenta.rol, { metodo: admin ? 'admin_local' : 'cuenta_local' }, req.ip);
    return res.json({ ok: true, redirect: S.rutaSegura(next) });
  });
}

module.exports = { montarEmergencia, esGoogle, HORAS_SESION, HORAS_EMERGENCIA: HORAS_SESION };
