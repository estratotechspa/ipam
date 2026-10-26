// Autenticación y autorización.
//   modo oidc  (OIDC_ISSUER definido): inicio de sesión con cualquier proveedor OpenID Connect (Google Workspace,
//                                      Microsoft Entra, Okta, Keycloak…). Flujo de código con PKCE, state y nonce.
//   modo basic (APP_USER y APP_PASS):  un solo usuario con Basic Auth; rol admin. Solo para demos.
//   modo none:                         sin autenticación (demostración local); rol admin.
// El modo sale de AUTH_MODE (oidc | basic | none) o, si no se define, de lo configurado (OIDC_ISSUER, APP_USER y APP_PASS).
// En producción (NODE_ENV=production) NO se arranca sin autenticación salvo que se pida con AUTH_MODE=none.
// La sesión es una cookie firmada (HMAC); el rol y la existencia del usuario se revalidan contra la base cada pocos
// minutos (SESSION_REVALIDAR_SEG), así que un cambio de rol o una baja rigen sin esperar a que expire la cookie.
const crypto = require('crypto');
const path = require('path');
const limites = require('./limites');
const paginas = require('./paginas');
const env = process.env;

const ROLES = ['lector', 'solicitante', 'admin'];
const tiene = (rol, minimo) => ROLES.indexOf(rol) >= ROLES.indexOf(minimo);
const lista = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const MODOS = ['oidc', 'basic', 'none'];
const modoExplicito = () => String(env.AUTH_MODE || '').trim().toLowerCase();
const modo = () => {
  const e = modoExplicito();
  if (MODOS.includes(e)) return e;
  return env.OIDC_ISSUER ? 'oidc' : env.APP_USER && env.APP_PASS ? 'basic' : 'none';
};

const PUBLICO = path.join(__dirname, '..', 'public');
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
const CSRF = 'X-Requested-With: ipam';
// Defensa CSRF: los cambios desde el navegador exigen una cabecera que un sitio externo no puede enviar sin permiso CORS.
const csrfValido = (req) => req.headers['x-requested-with'] === 'ipam';
const csrfRechazo = (res) => res.status(403).json({ error: `falta la cabecera ${CSRF}` });
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
  const explicito = modoExplicito();
  if (explicito && !MODOS.includes(explicito)) throw new Error(`AUTH_MODE inválido «${env.AUTH_MODE}»: usa oidc, basic o none`);
  if (explicito === 'oidc' && !env.OIDC_ISSUER) throw new Error('AUTH_MODE=oidc requiere OIDC_ISSUER');
  if (explicito === 'basic' && !(env.APP_USER && env.APP_PASS)) throw new Error('AUTH_MODE=basic requiere APP_USER y APP_PASS');
  if (explicito === 'none' && (env.OIDC_ISSUER || env.APP_USER || env.APP_PASS)) {
    throw new Error('AUTH_MODE=none contradice la configuración de acceso (OIDC_ISSUER / APP_USER / APP_PASS): quita una de las dos');
  }
  if (modo() === 'none') {
    if (env.NODE_ENV === 'production' && explicito !== 'none') {
      throw new Error('En producción la app no arranca sin autenticación: define OIDC_ISSUER (+ OIDC_*), APP_USER y APP_PASS, '
        + 'o pide el modo abierto de forma explícita con AUTH_MODE=none');
    }
    console.warn('⚠ IPAM sin autenticación (modo none): cualquiera que llegue al servicio es administrador.');
  }
  if (modo() !== 'oidc') return;
  const falta = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL', 'SESSION_SECRET'].filter((k) => !env[k]);
  if (falta.length) throw new Error(`Modo OIDC: faltan variables ${falta.join(', ')}`);
  if (secreto().length < 32) throw new Error('SESSION_SECRET debe tener al menos 32 caracteres');
}

// Ejecuta middlewares de Express en serie y devuelve una promesa. Si uno responde sin llamar a next (p. ej. un
// limitador con 429), la promesa se resuelve cuando se cierra la respuesta.
const correr = (mws, req, res) => new Promise((ok, mal) => {
  res.once('close', ok);
  let i = 0;
  const sig = (e) => { if (e) return mal(e); if (i >= mws.length) return ok(); mws[i++](req, res, sig); };
  sig();
});

// ---------- Revalidación de sesiones ----------
// La cookie es válida mientras no caduque, pero el rol puede cambiar o la persona darse de baja. Cada
// SESSION_REVALIDAR_SEG (300; 0 = en cada petición) se consulta la fila del usuario y se calcula el rol vigente:
// correos admin de la configuración > rol asignado en la base > rol base de la sesión (grupos/configuración al entrar).
// La caché es por proceso: con varias réplicas, un cambio puede tardar hasta ese tiempo en llegar a todas.
const cacheUsuarios = new Map(); // email → { fila, hasta }
const olvidar = (email) => cacheUsuarios.delete(String(email || '').toLowerCase());
const olvidarTodos = () => cacheUsuarios.clear();
async function filaUsuario(db, email) {
  const ttl = Math.max(0, Number(env.SESSION_REVALIDAR_SEG === undefined || env.SESSION_REVALIDAR_SEG === '' ? 300 : env.SESSION_REVALIDAR_SEG)) * 1000;
  const c = cacheUsuarios.get(email);
  if (c && c.hasta > Date.now()) return c.fila;
  const fila = (await db.query('select rol from usuarios where email = $1', [email])).rows[0] || null;
  if (ttl) {
    if (cacheUsuarios.size > 5000) for (const [k, v] of cacheUsuarios) if (v.hasta <= Date.now()) cacheUsuarios.delete(k);
    cacheUsuarios.set(email, { fila, hasta: Date.now() + ttl });
  }
  return fila;
}
async function rolVigente(db, sesion) {
  const fila = await filaUsuario(db, sesion.email);
  if (!fila) return null; // dado de baja
  if (lista(env.OIDC_ADMIN_EMAILS).includes(sesion.email)) return 'admin';
  const rol = fila.rol || sesion.rolBase;
  return ROLES.includes(rol) ? rol : null;
}

// Rutas que no exigen sesión: salud, webhook (va firmado), marca, y la pantalla de acceso con sus recursos.
const PUBLICAS = new Set(['/api/health', '/webhook/jira', '/api/config', '/brand.css', '/brand/logo',
  '/login', '/login.html', '/login.js', '/app.css', '/iconos.js', '/favicon.svg']);

// ---------- Rutas /auth y middleware ----------
// db: pool de pg; auditar(accion, usuario, rol, detalle, ip)
function montar(app, { db, auditar }) {
  const horas = Number(env.SESSION_HORAS) || 4;
  app.use(['/auth/login', '/auth/callback'], limites.limiteAuth());
  const lim = limites.limitesBasic();

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
      // El proveedor avisa de un rechazo (p. ej. la persona canceló) con ?error=…: se vuelve a la pantalla de acceso.
      if (req.query.error) return res.redirect('/login?error=denegado');
      if (!previo) return paginas.enviar(res, 'expirada');
      const { lib, config } = await cliente();
      const tokens = await lib.authorizationCodeGrant(config, new URL(publicUrl() + req.originalUrl), {
        pkceCodeVerifier: previo.verificador, expectedState: previo.state, expectedNonce: previo.nonce,
      });
      const claims = tokens.claims();
      const email = String(claims.email || '').toLowerCase();
      if (!email || claims.email_verified === false) {
        await auditar('login_rechazado', email || 'desconocido', null, { motivo: 'correo no verificado' }, req.ip);
        return paginas.enviar(res, 'correo_no_verificado');
      }
      if (!dominioPermitido(claims)) {
        await auditar('login_rechazado', email, null, { motivo: 'dominio no permitido' }, req.ip);
        return paginas.enviar(res, 'dominio', { email });
      }
      const fila = (await db.query(
        `insert into usuarios (email, nombre, ultimo_acceso) values ($1,$2,now())
         on conflict (email) do update set nombre = excluded.nombre, ultimo_acceso = now() returning rol`,
        [email, claims.name || email])).rows[0];
      const rol = resolverRol({ ...claims, email }, fila);
      if (!rol) {
        await auditar('login_rechazado', email, null, { motivo: 'sin rol asignado' }, req.ip);
        return paginas.enviar(res, 'sin_rol', { email });
      }
      // La cookie no guarda el rol efectivo sino el que dan el proveedor y la configuración (sin la asignación de la base):
      // el rol vigente se calcula en cada revalidación, con el cambio que haya hecho un administrador.
      const rolBase = resolverRol({ ...claims, email }, null);
      ponerCookie(res, SESION, sellar({ v: 2, email, nombre: claims.name || email, rolBase, exp: Date.now() / 1000 + horas * 3600 }), horas * 3600);
      await auditar('login', email, rol, {}, req.ip);
      res.redirect(rutaSegura(previo.next));
    } catch (e) {
      // Estado distinto, código ya usado, proveedor caído…: se registra y se invita a reintentar desde el acceso.
      console.error('auth/callback:', e.message);
      res.redirect('/login?error=fallo');
    }
  });

  app.post('/auth/logout', async (req, res) => {
    if (!csrfValido(req)) return csrfRechazo(res); // cerrar la sesión también es un cambio de estado: mismo control que la API
    const s = abrir(cookies(req)[SESION]);
    borrarCookie(res, SESION);
    if (s) await auditar('logout', s.email, s.rol, {}, req.ip);
    res.json({ ok: true, redirect: '/auth/sesion-cerrada' });
  });
  app.get('/auth/sesion-cerrada', (_q, res) => paginas.enviar(res, 'sesion_cerrada'));

  // Pantalla de acceso propia: con OIDC, quien no tiene sesión llega aquí en vez de saltar directo al proveedor.
  app.get('/login', (req, res) => {
    if (modo() !== 'oidc') return res.redirect('/');
    const s = abrir(cookies(req)[SESION]);
    // Ya tiene sesión: a la aplicación. Se ignora `next` a propósito (sin redirecciones hacia un valor que viene de la URL).
    if (s && s.v === 2 && !req.query.error) return res.redirect('/');
    res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLICO, 'login.html'));
  });

  // Middleware de acceso: todo exige sesión salvo salud, webhook (firmado) y /auth.
  app.use(async (req, res, next) => {
    try {
      if (PUBLICAS.has(req.path) || req.path.startsWith('/auth/')) return next();
      const m = modo();
      if (m === 'none') { req.usuario = 'anonimo'; req.rol = 'admin'; }
      else if (m === 'basic') {
        // Los intentos fallidos con credenciales se limitan por IP (bloqueo progresivo, ver limites.js).
        await correr(lim, req, res);
        if (res.headersSent) return; // el limitador ya respondió 429
        const h = req.headers.authorization || '';
        const [u, ...rest] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
        const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
        if (!(h.startsWith('Basic ') && igual(u || '', env.APP_USER) && igual(rest.join(':'), env.APP_PASS))) {
          return res.set('WWW-Authenticate', 'Basic realm="IPAM"').status(401).send('Autenticación requerida');
        }
        req.usuario = u; req.rol = 'admin';
      } else {
        const s = abrir(cookies(req)[SESION]);
        const rol = s && s.v === 2 ? await rolVigente(db, s) : null; // cookies anteriores a la revalidación obligan a entrar de nuevo
        if (!rol) {
          if (s) borrarCookie(res, SESION); // sesión revocada: usuario dado de baja o sin rol
          if (req.path.startsWith('/api/')) return res.status(401).json({ error: s ? 'sesión revocada' : 'no autenticado', login: '/login' });
          return res.redirect('/login?' + (s ? 'error=revocada&' : '') + 'next=' + encodeURIComponent(req.originalUrl));
        }
        req.usuario = s.email; req.nombre = s.nombre; req.rol = rol;
      }
      if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfValido(req)) return csrfRechazo(res);
      next();
    } catch (e) { next(e); }
  });

  app.get('/api/me', (req, res) => res.json({ modo: modo(), usuario: req.usuario, nombre: req.nombre || req.usuario, rol: req.rol }));
}

const requiere = (minimo) => (req, res, next) =>
  tiene(req.rol, minimo) ? next() : res.status(403).json({ error: 'permiso insuficiente', requiere: minimo, rol: req.rol });

module.exports = { ROLES, tiene, modo, montar, requiere, resolverRol, dominioPermitido, validarConfiguracion, sellar, abrir, olvidar, olvidarTodos };
