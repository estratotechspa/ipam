// Autenticación y autorización.
//   modo oidc  (OIDC_ISSUER definido): inicio de sesión con cualquier proveedor OpenID Connect (Google Workspace,
//                                      Microsoft Entra, Okta, Keycloak…). Flujo de código con PKCE, state y nonce.
//   modo basic (APP_USER y APP_PASS):  un solo usuario con Basic Auth; rol admin. Solo para demos.
//   modo none:                         sin autenticación (demostración local); rol admin.
// La sesión es una cookie firmada (HMAC) sin estado en el servidor: sirve con varias réplicas.
const crypto = require('crypto');
const env = process.env;

const ROLES = ['lector', 'solicitante', 'admin'];
const tiene = (rol, minimo) => ROLES.indexOf(rol) >= ROLES.indexOf(minimo);
const lista = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const modo = () => (env.OIDC_ISSUER ? 'oidc' : env.APP_USER && env.APP_PASS ? 'basic' : 'none');

const SESION = 'ipam_sesion';
const LOGIN = 'ipam_login';
const b64 = (b) => Buffer.from(b).toString('base64url');
const secreto = () => env.SESSION_SECRET || '';
const firmar = (txt) => crypto.createHmac('sha256', secreto()).update(txt).digest('base64url');

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
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  for (const par of String(req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}
const publicUrl = () => String(env.PUBLIC_URL || '').replace(/\/+$/, '');
function ponerCookie(res, nombre, valor, segundos) {
  const seguro = publicUrl().startsWith('https://');
  const c = `${nombre}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${segundos}${seguro ? '; Secure' : ''}`;
  res.append('Set-Cookie', c);
}
const borrarCookie = (res, nombre) => ponerCookie(res, nombre, '', 0);
const rutaSegura = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

// ---------- Roles ----------
// Prioridad: correos admin de la configuración (para no quedar fuera) > rol asignado en la base >
// grupos del proveedor > OIDC_DEFAULT_ROLE (por defecto «lector»; «ninguno» = solo entran los mapeados).
function resolverRol(claims, filaDb) {
  const email = String(claims.email || '').toLowerCase();
  if (lista(env.OIDC_ADMIN_EMAILS).includes(email)) return 'admin';
  if (filaDb && filaDb.rol) return filaDb.rol;
  const g = claims[env.OIDC_GROUPS_CLAIM || 'groups'];
  const grupos = (Array.isArray(g) ? g : typeof g === 'string' ? [g] : []).map((x) => String(x).toLowerCase());
  const en = (v) => lista(v).some((x) => grupos.includes(x));
  if (en(env.OIDC_ADMIN_GROUPS)) return 'admin';
  if (en(env.OIDC_REQUESTER_GROUPS) || lista(env.OIDC_REQUESTER_EMAILS).includes(email)) return 'solicitante';
  if (en(env.OIDC_READER_GROUPS) || lista(env.OIDC_READER_EMAILS).includes(email)) return 'lector';
  const d = (env.OIDC_DEFAULT_ROLE || 'lector').toLowerCase();
  return ROLES.includes(d) ? d : null;
}
function dominioPermitido(claims) {
  const dominios = lista(env.OIDC_ALLOWED_DOMAINS);
  if (!dominios.length) return true;
  const dom = String(claims.email || '').toLowerCase().split('@')[1];
  return dominios.includes(dom);
}

// ---------- OIDC ----------
let oidc; // { lib, config }
async function cliente() {
  if (!oidc) {
    oidc = (async () => {
      const lib = await import('openid-client');
      const opciones = env.OIDC_ALLOW_INSECURE === 'true' ? { execute: [lib.allowInsecureRequests] } : undefined;
      const config = await lib.discovery(new URL(env.OIDC_ISSUER), env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET, undefined, opciones);
      return { lib, config };
    })();
    oidc.catch(() => { oidc = null; }); // reintentar en la siguiente petición si el proveedor no respondió
  }
  return oidc;
}

function validarConfiguracion() {
  if (modo() !== 'oidc') return;
  const falta = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL', 'SESSION_SECRET'].filter((k) => !env[k]);
  if (falta.length) throw new Error(`Modo OIDC: faltan variables ${falta.join(', ')}`);
  if (secreto().length < 32) throw new Error('SESSION_SECRET debe tener al menos 32 caracteres');
}

// ---------- Rutas /auth y middleware ----------
// db: pool de pg; auditar(accion, usuario, rol, detalle, ip)
function montar(app, { db, auditar }) {
  const horas = Number(env.SESSION_HORAS) || 8;

  app.get('/auth/login', async (req, res, next) => {
    try {
      if (modo() !== 'oidc') return res.redirect('/');
      const { lib, config } = await cliente();
      const verificador = lib.randomPKCECodeVerifier();
      const state = lib.randomState();
      const nonce = lib.randomNonce();
      const params = {
        redirect_uri: `${publicUrl()}/auth/callback`,
        scope: env.OIDC_SCOPES || 'openid email profile',
        code_challenge: await lib.calculatePKCECodeChallenge(verificador),
        code_challenge_method: 'S256', state, nonce,
      };
      const dominios = lista(env.OIDC_ALLOWED_DOMAINS);
      if (dominios.length === 1) params.hd = dominios[0]; // pista para Google Workspace; igual se valida al volver
      ponerCookie(res, LOGIN, sellar({ state, nonce, verificador, next: rutaSegura(req.query.next), exp: Date.now() / 1000 + 600 }), 600);
      res.redirect(lib.buildAuthorizationUrl(config, params).href);
    } catch (e) { next(e); }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      if (modo() !== 'oidc') return res.redirect('/');
      const previo = abrir(cookies(req)[LOGIN]);
      borrarCookie(res, LOGIN);
      if (!previo) return res.status(400).send('La solicitud de inicio de sesión expiró. <a href="/auth/login">Reintentar</a>');
      const { lib, config } = await cliente();
      const tokens = await lib.authorizationCodeGrant(config, new URL(publicUrl() + req.originalUrl), {
        pkceCodeVerifier: previo.verificador, expectedState: previo.state, expectedNonce: previo.nonce,
      });
      const claims = tokens.claims();
      const email = String(claims.email || '').toLowerCase();
      if (!email || claims.email_verified === false) return res.status(403).send('El proveedor no entregó un correo verificado.');
      if (!dominioPermitido(claims)) {
        await auditar('login_rechazado', email, null, { motivo: 'dominio no permitido' }, req.ip);
        return res.status(403).send('Tu dominio de correo no tiene acceso a este IPAM.');
      }
      const fila = (await db.query(
        `insert into usuarios (email, nombre, ultimo_acceso) values ($1,$2,now())
         on conflict (email) do update set nombre = excluded.nombre, ultimo_acceso = now() returning rol`,
        [email, claims.name || email])).rows[0];
      const rol = resolverRol({ ...claims, email }, fila);
      if (!rol) {
        await auditar('login_rechazado', email, null, { motivo: 'sin rol asignado' }, req.ip);
        return res.status(403).send('Tu cuenta no tiene un rol asignado. Pide acceso a un administrador.');
      }
      ponerCookie(res, SESION, sellar({ email, nombre: claims.name || email, rol, exp: Date.now() / 1000 + horas * 3600 }), horas * 3600);
      await auditar('login', email, rol, {}, req.ip);
      res.redirect(rutaSegura(previo.next));
    } catch (e) { next(e); }
  });

  app.post('/auth/logout', async (req, res) => {
    const s = abrir(cookies(req)[SESION]);
    borrarCookie(res, SESION);
    if (s) await auditar('logout', s.email, s.rol, {}, req.ip);
    res.json({ ok: true, redirect: '/auth/sesion-cerrada' });
  });
  app.get('/auth/sesion-cerrada', (_q, res) => {
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Sesión cerrada</title><link rel="stylesheet" href="/brand.css"><body style="font:16px system-ui;margin:3rem"><h2>Sesión cerrada</h2><p><a href="/auth/login">Volver a entrar</a></p>');
  });

  // Middleware de acceso: todo exige sesión salvo salud, webhook (firmado) y /auth.
  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.path === '/webhook/jira' || req.path.startsWith('/auth/') || req.path === '/api/config' || req.path === '/brand.css' || req.path === '/brand/logo') return next();
    const m = modo();
    if (m === 'none') { req.usuario = 'anonimo'; req.rol = 'admin'; }
    else if (m === 'basic') {
      const h = req.headers.authorization || '';
      const [u, ...rest] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
      const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
      if (!(h.startsWith('Basic ') && igual(u || '', env.APP_USER) && igual(rest.join(':'), env.APP_PASS))) {
        return res.set('WWW-Authenticate', 'Basic realm="IPAM"').status(401).send('Autenticación requerida');
      }
      req.usuario = u; req.rol = 'admin';
    } else {
      const s = abrir(cookies(req)[SESION]);
      if (!s) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'no autenticado', login: '/auth/login' });
        return res.redirect('/auth/login?next=' + encodeURIComponent(req.originalUrl));
      }
      req.usuario = s.email; req.nombre = s.nombre; req.rol = s.rol;
    }
    // Defensa CSRF: los cambios desde el navegador exigen una cabecera que un sitio externo no puede enviar sin permiso CORS.
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'ipam') {
      return res.status(403).json({ error: 'falta la cabecera X-Requested-With: ipam' });
    }
    next();
  });

  app.get('/api/me', (req, res) => res.json({ modo: modo(), usuario: req.usuario, nombre: req.nombre || req.usuario, rol: req.rol }));
}

const requiere = (minimo) => (req, res, next) =>
  tiene(req.rol, minimo) ? next() : res.status(403).json({ error: 'permiso insuficiente', requiere: minimo, rol: req.rol });

module.exports = { ROLES, tiene, modo, montar, requiere, resolverRol, dominioPermitido, validarConfiguracion, sellar, abrir };
