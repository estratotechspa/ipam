'use strict';
// Sesión = cookie firmada (HMAC-SHA256) sin estado en el servidor: sirve igual con varias réplicas.
const crypto = require('node:crypto');
const { config } = require('../../config');

const SESION = 'ipam_sesion';
const LOGIN = 'ipam_login';
const b64 = (b) => Buffer.from(b).toString('base64url');
const firmar = (txt) => crypto.createHmac('sha256', config.auth.sesionSecreto).update(txt).digest('base64url');

function sellar(objeto) {
  const p = b64(JSON.stringify(objeto));
  return `${p}.${firmar(p)}`;
}
function abrir(valor) {
  const [p, s] = String(valor || '').split('.');
  if (!p || !s) return null;
  const esperada = firmar(p);
  if (s.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(esperada))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    return o.exp && o.exp > Date.now() / 1000 ? o : null;
  } catch {
    return null;
  }
}
function cookies(req) {
  const out = {};
  for (const par of String(req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) {
      try {
        out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
      } catch {
        /* cookie mal codificada: se ignora */
      }
    }
  }
  return out;
}

/** Secure: «auto» = si la URL pública es https o la petición llegó por HTTPS (con TRUST_PROXY, según el proxy). */
function esSegura(req) {
  const modo = config.auth.cookieSecure;
  if (modo === 'true') return true;
  if (modo === 'false') return false;
  return config.http.publicUrl.startsWith('https://') || !!(req && req.secure);
}
function ponerCookie(req, res, nombre, valor, segundos) {
  const c = `${nombre}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${segundos}${esSegura(req) ? '; Secure' : ''}`;
  res.append('Set-Cookie', c);
}
const borrarCookie = (req, res, nombre) => ponerCookie(req, res, nombre, '', 0);
const rutaSegura = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

module.exports = { SESION, LOGIN, sellar, abrir, cookies, ponerCookie, borrarCookie, rutaSegura, esSegura };
