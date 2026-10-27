'use strict';
// Inicio de sesión con OpenID Connect genérico (cualquier emisor: Google Workspace, Entra, Okta, Keycloak…).
// Flujo de código con PKCE, state y nonce. Nada está ligado a un proveedor.
const { config } = require('../../config');
const { resolverRol, dominioPermitido } = require('../../dominio/roles');
const S = require('./sesion');
const paginas = require('../http/paginas');
const path = require('node:path');

const PUBLICO = path.join(__dirname, '..', '..', '..', 'public');

let oidc; // { lib, config }
async function cliente() {
  if (!oidc) {
    oidc = (async () => {
      const lib = await import('openid-client');
      const o = config.auth.oidc;
      const opciones = o.permitirInseguro ? { execute: [lib.allowInsecureRequests] } : undefined;
      const cfg = await lib.discovery(new URL(o.issuer), o.clientId, o.clientSecret, undefined, opciones);
      return { lib, config: cfg };
    })();
    oidc.catch(() => {
      oidc = null;
    }); // reintentar en la siguiente petición si el proveedor no respondió
  }
  return oidc;
}

/** @param {import('express').Express} app @param {{repo: any, auditar: Function, ruta: Function}} deps */
function montarOidc(app, { repo, auditar, ruta, log }) {
  const modoOidc = () => config.auth.modo === 'oidc';

  ruta(app, 'get', '/auth/login', async (req, res, next) => {
    try {
      if (!modoOidc()) return res.redirect('/');
      const { lib, config: c } = await cliente();
      const verificador = lib.randomPKCECodeVerifier();
      const state = lib.randomState();
      const nonce = lib.randomNonce();
      const params = {
        redirect_uri: `${config.http.publicUrl}/auth/callback`,
        scope: config.auth.oidc.scopes,
        code_challenge: await lib.calculatePKCECodeChallenge(verificador),
        code_challenge_method: 'S256',
        state,
        nonce,
      };
      const dominios = config.auth.oidc.dominios;
      if (dominios.length === 1) params.hd = dominios[0]; // pista para Google Workspace; igual se valida al volver
      S.ponerCookie(req, res, S.LOGIN, S.sellar({ state, nonce, verificador, next: S.rutaSegura(req.query.next), exp: Date.now() / 1000 + 600 }), 600);
      res.redirect(lib.buildAuthorizationUrl(c, params).href);
    } catch (e) {
      next(e);
    }
  });

  ruta(app, 'get', '/auth/callback', async (req, res) => {
    try {
      if (!modoOidc()) return res.redirect('/');
      const previo = S.abrir(S.cookies(req)[S.LOGIN]);
      S.borrarCookie(req, res, S.LOGIN);
      // El proveedor avisa de un rechazo (p. ej. la persona canceló) con ?error=…: se vuelve a la pantalla de acceso.
      if (req.query.error) return res.redirect('/login?error=denegado');
      if (!previo) return paginas.enviar(res, 'expirada');
      const { lib, config: c } = await cliente();
      const tokens = await lib.authorizationCodeGrant(c, new URL(config.http.publicUrl + req.originalUrl), {
        pkceCodeVerifier: previo.verificador,
        expectedState: previo.state,
        expectedNonce: previo.nonce,
      });
      const claims = tokens.claims();
      const email = String(claims.email || '').toLowerCase();
      if (!email || claims.email_verified === false) {
        await auditar('login_rechazado', email || 'desconocido', null, { motivo: 'correo no verificado' }, req.ip);
        return paginas.enviar(res, 'correo_no_verificado');
      }
      const o = config.auth.oidc;
      if (!dominioPermitido(claims, o.dominios)) {
        await auditar('login_rechazado', email, null, { motivo: 'dominio no permitido' }, req.ip);
        return paginas.enviar(res, 'dominio', { email });
      }
      const fila = await repo.registrarLogin({ email, nombre: claims.name || email });
      const rol = resolverRol({ ...claims, email }, fila, o);
      if (!rol) {
        await auditar('login_rechazado', email, null, { motivo: 'sin rol asignado' }, req.ip);
        return paginas.enviar(res, 'sin_rol', { email });
      }
      const horas = config.auth.sesionHoras;
      // La cookie guarda el rol «base» (proveedor y configuración, sin la asignación de la base): el rol de HOY se calcula al revalidar.
      const rolBase = resolverRol({ ...claims, email }, null, o);
      const sesion = { v: 2, email, nombre: claims.name || email, rolBase, exp: Date.now() / 1000 + horas * 3600 };
      S.ponerCookie(req, res, S.SESION, S.sellar(sesion), horas * 3600);
      await auditar('login', email, rol, {}, req.ip);
      res.redirect(S.rutaSegura(previo.next));
    } catch (e) {
      // Estado distinto, código ya usado, proveedor caído…: se registra y se invita a reintentar desde el acceso.
      log.warn('auth/callback: no se pudo completar el inicio de sesión', e);
      res.redirect('/login?error=fallo');
    }
  });

  ruta(app, 'post', '/auth/logout', async (req, res) => {
    // Cerrar la sesión también cambia estado: mismo control CSRF que la API (esta ruta está fuera del middleware de acceso).
    if (req.headers['x-requested-with'] !== 'ipam') return res.status(403).json({ error: 'falta la cabecera X-Requested-With: ipam' });
    const s = S.abrir(S.cookies(req)[S.SESION]);
    S.borrarCookie(req, res, S.SESION);
    if (s) await auditar('logout', s.email, s.rol, {}, req.ip);
    res.json({ ok: true, redirect: '/auth/sesion-cerrada' });
  });
  ruta(app, 'get', '/auth/sesion-cerrada', (_q, res) => paginas.enviar(res, 'sesion_cerrada'));

  // Pantalla de acceso propia: con SSO, quien no tiene sesión llega aquí en vez de saltar directo al proveedor.
  ruta(app, 'get', '/login', (req, res) => {
    if (!modoOidc()) return res.redirect('/');
    const s = S.abrir(S.cookies(req)[S.SESION]);
    // Ya tiene sesión: a la aplicación. Se ignora `next` a propósito (sin redirecciones hacia un valor que viene de la URL).
    if (s && s.v === 2 && !req.query.error) return res.redirect('/');
    res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLICO, 'login.html'));
  });
}

module.exports = { montarOidc };
