'use strict';
// Inicio de sesión con OpenID Connect genérico (cualquier emisor: Google Workspace, Entra, Okta, Keycloak…).
// Flujo de código con PKCE, state y nonce. Nada está ligado a un proveedor.
const { config } = require('../../config');
const { resolverRol, dominioPermitido } = require('../../dominio/roles');
const S = require('./sesion');

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
    oidc.catch(() => { oidc = null; }); // reintentar en la siguiente petición si el proveedor no respondió
  }
  return oidc;
}

/** @param {import('express').Express} app @param {{repo: any, auditar: Function, ruta: Function}} deps */
function montarOidc(app, { repo, auditar, ruta }) {
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
        code_challenge_method: 'S256', state, nonce,
      };
      const dominios = config.auth.oidc.dominios;
      if (dominios.length === 1) params.hd = dominios[0]; // pista para Google Workspace; igual se valida al volver
      S.ponerCookie(req, res, S.LOGIN, S.sellar({ state, nonce, verificador, next: S.rutaSegura(req.query.next), exp: Date.now() / 1000 + 600 }), 600);
      res.redirect(lib.buildAuthorizationUrl(c, params).href);
    } catch (e) { next(e); }
  });

  ruta(app, 'get', '/auth/callback', async (req, res, next) => {
    try {
      if (!modoOidc()) return res.redirect('/');
      const previo = S.abrir(S.cookies(req)[S.LOGIN]);
      S.borrarCookie(req, res, S.LOGIN);
      if (!previo) return res.status(400).send('La solicitud de inicio de sesión expiró. <a href="/auth/login">Reintentar</a>');
      const { lib, config: c } = await cliente();
      const tokens = await lib.authorizationCodeGrant(c, new URL(config.http.publicUrl + req.originalUrl), {
        pkceCodeVerifier: previo.verificador, expectedState: previo.state, expectedNonce: previo.nonce,
      });
      const claims = tokens.claims();
      const email = String(claims.email || '').toLowerCase();
      if (!email || claims.email_verified === false) return res.status(403).send('El proveedor no entregó un correo verificado.');
      const o = config.auth.oidc;
      if (!dominioPermitido(claims, o.dominios)) {
        await auditar('login_rechazado', email, null, { motivo: 'dominio no permitido' }, req.ip);
        return res.status(403).send('Tu dominio de correo no tiene acceso a este IPAM.');
      }
      const fila = await repo.registrarLogin({ email, nombre: claims.name || email });
      const rol = resolverRol({ ...claims, email }, fila, o);
      if (!rol) {
        await auditar('login_rechazado', email, null, { motivo: 'sin rol asignado' }, req.ip);
        return res.status(403).send('Tu cuenta no tiene un rol asignado. Pide acceso a un administrador.');
      }
      const horas = config.auth.sesionHoras;
      S.ponerCookie(req, res, S.SESION, S.sellar({ email, nombre: claims.name || email, rol, exp: Date.now() / 1000 + horas * 3600 }), horas * 3600);
      await auditar('login', email, rol, {}, req.ip);
      res.redirect(S.rutaSegura(previo.next));
    } catch (e) { next(e); }
  });

  ruta(app, 'post', '/auth/logout', async (req, res) => {
    const s = S.abrir(S.cookies(req)[S.SESION]);
    S.borrarCookie(req, res, S.SESION);
    if (s) await auditar('logout', s.email, s.rol, {}, req.ip);
    res.json({ ok: true, redirect: '/auth/sesion-cerrada' });
  });
  ruta(app, 'get', '/auth/sesion-cerrada', (_q, res) => {
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Sesión cerrada</title><link rel="stylesheet" href="/brand.css"><body style="font:16px system-ui;margin:3rem"><h2>Sesión cerrada</h2><p><a href="/auth/login">Volver a entrar</a></p>');
  });
}

module.exports = { montarOidc };
