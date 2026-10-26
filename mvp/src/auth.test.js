// Pruebas del inicio de sesión OIDC contra un proveedor real (oidc-provider) y de los roles.
// Requieren PostgreSQL (DATABASE_URL) con db/schema.sql y db/seed.sql aplicados.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

process.env.RATE_LIMIT_AUTH_MAX = '1000'; // las pruebas hacen muchos inicios de sesión desde la misma IP
const hay = !!process.env.DATABASE_URL;
const opts = { skip: hay ? false : 'sin DATABASE_URL' };
const GRUPOS = { 'ana@empresa.cl': ['ipam-solicitantes'], 'jefe@empresa.cl': ['ipam-admins'] };
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };

let app, base, idp, db, auth;

// Navegador mínimo: mantiene cookies por origen y sigue redirecciones a mano.
class Navegador {
  constructor() { this.jar = new Map(); }
  cookies(url) { return [...(this.jar.get(new URL(url).origin) || new Map())].map(([k, v]) => `${k}=${v}`).join('; '); }
  guardar(url, res) {
    const o = new URL(url).origin;
    const m = this.jar.get(o) || new Map();
    for (const c of res.headers.getSetCookie()) {
      const [par, ...attrs] = c.split(';');
      const i = par.indexOf('=');
      const nombre = par.slice(0, i).trim(), valor = par.slice(i + 1).trim();
      if (!valor || /max-age=0/i.test(attrs.join(';'))) m.delete(nombre); else m.set(nombre, valor);
    }
    this.jar.set(o, m);
  }
  async pedir(url, init = {}) {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), cookie: this.cookies(url) } });
    this.guardar(url, res);
    return res;
  }
  async seguir(url, init) {
    let res = await this.pedir(url, init);
    for (let i = 0; i < 15 && [301, 302, 303, 307].includes(res.status); i++) {
      const siguiente = new URL(res.headers.get('location'), url).href;
      if (siguiente.startsWith(base + '/auth/callback')) return { res, url: siguiente, callback: true };
      url = siguiente;
      res = await this.pedir(url);
    }
    return { res, url };
  }
  // Inicia sesión como `email` contra el IdP de pruebas; devuelve la respuesta final del callback.
  async entrar(email, next = '/') {
    let { res, url } = await this.seguir(`${base}/auth/login?next=${encodeURIComponent(next)}`);
    const formulario = async (extra) => {
      const html = await res.text();
      const accion = new URL(html.match(/<form[^>]*action="([^"]*)"/)[1], url).href;
      const campos = { ...extra };
      for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) campos[m[1]] = m[2];
      return this.seguir(accion, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(campos).toString() });
    };
    ({ res, url } = await formulario({ login: email, password: 'x' }));
    if (res.status === 200) ({ res, url } = await formulario({}));
    // `url` es ahora la URL de retorno hacia /auth/callback
    return this.pedir(url);
  }
  api(ruta, init = {}) { return this.pedir(base + ruta, { ...init, headers: { ...H, ...(init.headers || {}) } }); }
}

test.before(async () => {
  if (!hay) return;
  Object.assign(process.env, {
    OIDC_CLIENT_ID: 'ipam', OIDC_CLIENT_SECRET: 's3cret', PUBLIC_URL: 'http://127.0.0.1:1', SESSION_SECRET: 'x'.repeat(40),
    OIDC_ALLOW_INSECURE: 'true', OIDC_SCOPES: 'openid email profile groups', OIDC_ADMIN_EMAILS: 'root@empresa.cl',
    OIDC_ADMIN_GROUPS: 'ipam-admins', OIDC_REQUESTER_GROUPS: 'ipam-solicitantes', OIDC_ALLOWED_DOMAINS: 'empresa.cl',
  });
  // 1) La app escucha primero para conocer su URL; 2) el IdP registra ese retorno; 3) se activa OIDC_ISSUER.
  process.env.OIDC_ISSUER = 'http://127.0.0.1:1';
  auth = require('./auth');
  ({ app, db } = require('./server'));
  const srvApp = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${srvApp.address().port}`;
  process.env.PUBLIC_URL = base;
  app = srvApp;

  const { default: Provider } = await import('oidc-provider');
  const srvIdp = http.createServer();
  await new Promise((ok) => srvIdp.listen(0, '127.0.0.1', ok));
  const emisor = `http://127.0.0.1:${srvIdp.address().port}`;
  const provider = new Provider(emisor, {
    clients: [{ client_id: 'ipam', client_secret: 's3cret', redirect_uris: [`${base}/auth/callback`], grant_types: ['authorization_code'], response_types: ['code'] }],
    findAccount: async (_c, id) => ({ accountId: id, claims: async () => ({ sub: id, email: id, email_verified: true, name: id.split('@')[0], groups: GRUPOS[id] || [] }) }),
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
    conformIdTokenClaims: false,
    features: { devInteractions: { enabled: true } },
  });
  srvIdp.on('request', provider.callback());
  idp = srvIdp;
  process.env.OIDC_ISSUER = emisor;
});
test.after(async () => { if (hay) { app.close(); idp.close(); await db.query("delete from usuarios where email like '%@empresa.cl' or email like '%@gmail.com'"); await db.end(); } });

test('sin sesión: la página redirige al login y la API responde 401; salud abierta', opts, async () => {
  const n = new Navegador();
  const r = await n.pedir(base + '/');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/auth\/login\?next=/);
  const a = await n.api('/api/pools');
  assert.equal(a.status, 401);
  assert.equal((await n.api('/api/health')).status, 200);
});

test('login OIDC como administrador (correo de la configuración) y auditoría', opts, async () => {
  const n = new Navegador();
  const cb = await n.entrar('root@empresa.cl');
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/');
  const me = await (await n.api('/api/me')).json();
  assert.equal(me.rol, 'admin');
  assert.equal(me.usuario, 'root@empresa.cl');
  assert.equal((await n.api('/api/pools')).status, 200);
  const aud = await (await n.api('/api/auditoria')).json();
  assert.ok(aud.some((x) => x.accion === 'login' && x.usuario === 'root@empresa.cl'));
});

test('roles por grupo: solicitante puede asignar pero no liberar; lector solo lee', opts, async () => {
  const ana = new Navegador();
  await ana.entrar('ana@empresa.cl');
  assert.equal((await (await ana.api('/api/me')).json()).rol, 'solicitante');
  const r = await ana.api('/api/solicitudes', { method: 'POST', body: JSON.stringify({ pool: 'onprem-lan-dev', vpc: 'rbac', cidr: '192.168.70.0/24' }) });
  assert.equal(r.status, 201);
  const asig = await r.json();
  assert.equal(asig.solicitante, 'ana@empresa.cl');
  const del = await ana.api('/api/asignaciones/' + asig.id, { method: 'DELETE' });
  assert.equal(del.status, 403);
  assert.equal((await ana.api('/api/auditoria')).status, 403);

  const lector = new Navegador();
  await lector.entrar('lector@empresa.cl');
  assert.equal((await (await lector.api('/api/me')).json()).rol, 'lector');
  assert.equal((await lector.api('/api/solicitudes', { method: 'POST', body: JSON.stringify({ pool: 'onprem-lan-dev', vpc: 'x', mascara: 24 }) })).status, 403);
  assert.equal((await lector.api('/api/exportar.xlsx')).status, 200);

  const jefe = new Navegador();
  await jefe.entrar('jefe@empresa.cl');
  assert.equal((await jefe.api('/api/asignaciones/' + asig.id, { method: 'DELETE' })).status, 200);
});

test('un administrador cambia el rol de otra persona y rige en su próximo login', opts, async () => {
  const root = new Navegador();
  await root.entrar('root@empresa.cl');
  const put = await root.api('/api/usuarios/lector@empresa.cl', { method: 'PUT', body: JSON.stringify({ rol: 'solicitante' }) });
  assert.equal(put.status, 200);
  assert.equal((await root.api('/api/usuarios/lector@empresa.cl', { method: 'PUT', body: JSON.stringify({ rol: 'dios' }) })).status, 400);
  const n = new Navegador();
  await n.entrar('lector@empresa.cl');
  assert.equal((await (await n.api('/api/me')).json()).rol, 'solicitante');
  await root.api('/api/usuarios/lector@empresa.cl', { method: 'PUT', body: JSON.stringify({ rol: null }) });
  const aud = await (await root.api('/api/auditoria')).json();
  assert.ok(aud.some((x) => x.accion === 'cambiar_rol' && x.usuario === 'root@empresa.cl'));
});

test('dominio de correo no permitido → 403 y sin sesión', opts, async () => {
  const n = new Navegador();
  const cb = await n.entrar('intruso@gmail.com');
  assert.equal(cb.status, 403);
  assert.equal((await n.api('/api/pools')).status, 401);
});

test('CSRF, cookie manipulada y cierre de sesión', opts, async () => {
  const n = new Navegador();
  await n.entrar('root@empresa.cl');
  const sinCab = await n.pedir(base + '/api/solicitudes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(sinCab.status, 403);

  const falso = new Navegador();
  falso.jar.set(base, new Map([['ipam_sesion', n.jar.get(base).get('ipam_sesion').replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))]]));
  assert.equal((await falso.api('/api/me')).status, 401);

  const out = await n.api('/auth/logout', { method: 'POST', body: '{}' });
  assert.equal(out.status, 200);
  assert.equal((await n.api('/api/me')).status, 401);
});

test('el parámetro next no permite redirigir a otros sitios', opts, async () => {
  const n = new Navegador();
  const cb = await new Navegador().entrar('root@empresa.cl', '//evil.example.com');
  assert.equal(cb.headers.get('location'), '/');
  void n;
});

// ---------- Fase 2 · seguridad ----------
// Ejecuta `fn` con variables de entorno cambiadas (undefined = borrar) y las restaura al terminar.
async function conEnv(vars, fn) {
  const antes = { ...process.env };
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
  }
}
const SIN_ACCESO = { OIDC_ISSUER: undefined, APP_USER: undefined, APP_PASS: undefined, AUTH_MODE: undefined, NODE_ENV: undefined };

test('AUTH_MODE: el modo explícito manda y las combinaciones contradictorias no arrancan', opts, async () => {
  await conEnv({ ...SIN_ACCESO }, () => { assert.equal(auth.modo(), 'none'); });
  await conEnv({ ...SIN_ACCESO, APP_USER: 'u', APP_PASS: 'p' }, () => { assert.equal(auth.modo(), 'basic'); });
  await conEnv({ ...SIN_ACCESO, AUTH_MODE: 'NONE' }, () => { assert.equal(auth.modo(), 'none'); assert.doesNotThrow(() => auth.validarConfiguracion()); });
  await conEnv({ ...SIN_ACCESO, AUTH_MODE: 'oidc' }, () => assert.throws(() => auth.validarConfiguracion(), /AUTH_MODE=oidc requiere OIDC_ISSUER/));
  await conEnv({ ...SIN_ACCESO, AUTH_MODE: 'basic', APP_USER: 'u' }, () => assert.throws(() => auth.validarConfiguracion(), /APP_USER y APP_PASS/));
  await conEnv({ ...SIN_ACCESO, AUTH_MODE: 'google' }, () => assert.throws(() => auth.validarConfiguracion(), /AUTH_MODE inválido/));
  await conEnv({ ...SIN_ACCESO, AUTH_MODE: 'none', APP_USER: 'u', APP_PASS: 'p' }, () => assert.throws(() => auth.validarConfiguracion(), /contradice/));
  await conEnv({ ...SIN_ACCESO, AUTH_MODE: 'none', OIDC_ISSUER: 'http://x' }, () => assert.throws(() => auth.validarConfiguracion(), /contradice/));
});

test('producción sin autenticación: falla cerrado salvo AUTH_MODE=none explícito', opts, async () => {
  const prod = { ...SIN_ACCESO, NODE_ENV: 'production' };
  await conEnv(prod, () => assert.throws(() => auth.validarConfiguracion(), /no arranca sin autenticación/));
  // credenciales a medias (falta la clave): tampoco queda abierta por accidente
  await conEnv({ ...prod, APP_USER: 'u' }, () => assert.throws(() => auth.validarConfiguracion(), /no arranca sin autenticación/));
  await conEnv({ ...prod, AUTH_MODE: 'none' }, () => assert.doesNotThrow(() => auth.validarConfiguracion()));
  await conEnv({ ...prod, APP_USER: 'u', APP_PASS: 'p' }, () => assert.doesNotThrow(() => auth.validarConfiguracion()));
  await conEnv({ ...prod, OIDC_ISSUER: 'http://x', OIDC_CLIENT_ID: 'i', OIDC_CLIENT_SECRET: 's', PUBLIC_URL: 'http://x', SESSION_SECRET: 'x'.repeat(40) },
    () => assert.doesNotThrow(() => auth.validarConfiguracion()));
  // fuera de producción (desarrollo, pruebas) el modo abierto sigue siendo posible sin pedirlo
  await conEnv({ ...SIN_ACCESO }, () => assert.doesNotThrow(() => auth.validarConfiguracion()));
});

test('la sesión dura 4 horas por defecto y la cookie guarda el rol base, no el efectivo', opts, async () => {
  const n = new Navegador();
  const cb = await n.entrar('horas@empresa.cl');
  const c = cb.headers.getSetCookie().find((x) => x.startsWith('ipam_sesion='));
  assert.match(c, /Max-Age=14400/);
  const payload = JSON.parse(Buffer.from(decodeURIComponent(c.split('=')[1].split(';')[0]).split('.')[0], 'base64url').toString());
  assert.equal(payload.v, 2);
  assert.equal(payload.rolBase, 'lector');
  assert.equal(payload.rol, undefined);
});

test('revocación: un usuario dado de baja pierde el acceso (con caché de 5 min, hasta olvidarla)', opts, async () => {
  const n = new Navegador();
  await n.entrar('baja@empresa.cl');
  assert.equal((await n.api('/api/pools')).status, 200);
  await db.query("delete from usuarios where email = 'baja@empresa.cl'");
  assert.equal((await n.api('/api/pools')).status, 200, 'dentro de la caché sigue valiendo');
  auth.olvidarTodos(); // equivale a que venza la caché
  const r = await n.api('/api/pools');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'sesión revocada');
  assert.ok(r.headers.getSetCookie().some((c) => /^ipam_sesion=;/.test(c) || /Max-Age=0/.test(c)), 'se borra la cookie');
  // una página (no la API) redirige al login
  assert.equal((await n.pedir(base + '/')).status, 302);
});

test('revocación sin caché (SESSION_REVALIDAR_SEG=0): la baja rige en la petición siguiente', opts, async () => {
  const n = new Navegador();
  await n.entrar('baja2@empresa.cl');
  await conEnv({ SESSION_REVALIDAR_SEG: '0' }, async () => {
    assert.equal((await n.api('/api/pools')).status, 200);
    await db.query("delete from usuarios where email = 'baja2@empresa.cl'");
    assert.equal((await n.api('/api/pools')).status, 401);
  });
});

test('un cambio de rol rige sin volver a entrar: ascenso, degradación y «heredar»', opts, async () => {
  const root = new Navegador();
  await root.entrar('root@empresa.cl');
  const ana = new Navegador();
  await ana.entrar('ana@empresa.cl'); // solicitante por su grupo
  const rol = async () => (await (await ana.api('/api/me')).json()).rol;
  const poner = (email, r) => root.api('/api/usuarios/' + email, { method: 'PUT', body: JSON.stringify({ rol: r }) });
  assert.equal(await rol(), 'solicitante');
  assert.equal((await ana.api('/api/auditoria')).status, 403);

  await poner('ana@empresa.cl', 'admin');
  assert.equal(await rol(), 'admin');
  assert.equal((await ana.api('/api/auditoria')).status, 200);

  await poner('ana@empresa.cl', 'lector'); // degradada por debajo de lo que le dan sus grupos
  assert.equal(await rol(), 'lector');
  assert.equal((await ana.api('/api/auditoria')).status, 403);
  assert.equal((await ana.api('/api/solicitudes', { method: 'POST', body: JSON.stringify({ pool: 'onprem-lan-dev', vpc: 'x', mascara: 24 }) })).status, 403);

  await poner('ana@empresa.cl', null); // «heredar»: vuelve al rol base de la sesión (el de sus grupos)
  assert.equal(await rol(), 'solicitante');

  // un administrador de la configuración no se puede degradar desde la base
  await poner('root@empresa.cl', 'lector');
  assert.equal((await (await root.api('/api/me')).json()).rol, 'admin');
  await poner('root@empresa.cl', null);
});

test('un cambio directo en la base se ve al vencer la caché de revalidación', opts, async () => {
  const n = new Navegador();
  await n.entrar('directo@empresa.cl');
  assert.equal((await (await n.api('/api/me')).json()).rol, 'lector');
  await db.query("update usuarios set rol = 'solicitante' where email = 'directo@empresa.cl'");
  assert.equal((await (await n.api('/api/me')).json()).rol, 'lector', 'aún en caché');
  auth.olvidarTodos();
  assert.equal((await (await n.api('/api/me')).json()).rol, 'solicitante');
  await db.query("delete from usuarios where email = 'directo@empresa.cl'");
});

test('una cookie de sesión con el formato anterior (sin revalidación) obliga a entrar de nuevo', opts, async () => {
  const vieja = auth.sellar({ email: 'root@empresa.cl', nombre: 'x', rol: 'admin', exp: Date.now() / 1000 + 3600 });
  const n = new Navegador();
  n.jar.set(base, new Map([['ipam_sesion', vieja]]));
  assert.equal((await n.api('/api/me')).status, 401);
});

test('/auth/logout exige X-Requested-With (defensa CSRF) y sin él no cierra la sesión', opts, async () => {
  const n = new Navegador();
  await n.entrar('root@empresa.cl');
  const sin = await n.pedir(base + '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(sin.status, 403);
  assert.match((await sin.json()).error, /X-Requested-With/);
  assert.equal((await n.api('/api/me')).status, 200, 'la sesión sigue activa');
  assert.equal((await n.api('/auth/logout', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await n.api('/api/me')).status, 401);
});

// Aplicación mínima con el módulo de autenticación real, para probar los limitadores con su propia configuración.
async function appPrueba(vars, fn) {
  return conEnv({ ...SIN_ACCESO, ...vars }, async () => {
    const mini = express();
    auth.montar(mini, { db: { query: async () => ({ rows: [] }) }, auditar: async () => {} });
    mini.get('/api/prueba', (_q, res) => res.json({ ok: true }));
    const srv = await new Promise((ok) => { const s = mini.listen(0, '127.0.0.1', () => ok(s)); });
    try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
  });
}

test('limitador de /auth/login y /auth/callback: comparten contador y responden 429 con Retry-After', opts, async () => {
  await appPrueba({ RATE_LIMIT_AUTH_MAX: '3' }, async (url) => {
    const g = (ruta) => fetch(url + ruta, { redirect: 'manual' });
    assert.equal((await g('/auth/login')).status, 302);
    assert.equal((await g('/auth/login')).status, 302);
    assert.equal((await g('/auth/callback')).status, 302);
    const r = await g('/auth/login');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.ok(r.headers.get('ratelimit') || r.headers.get('ratelimit-policy'), 'cabeceras estándar RateLimit');
    const d = await r.json();
    assert.equal(d.error, 'demasiados_intentos');
    assert.equal((await g('/auth/callback')).status, 429);
    assert.equal((await g('/api/prueba')).status, 200, 'el resto de la app no se ve afectada');
  });
});

test('modo basic: bloqueo por IP tras intentos fallidos; los correctos y los sin credenciales no cuentan', opts, async () => {
  const cred = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  await appPrueba({ APP_USER: 'admin', APP_PASS: 'buena', RATE_LIMIT_BASIC_MAX: '2' }, async (url) => {
    const g = (h) => fetch(url + '/api/prueba', { headers: h });
    // el desafío inicial del navegador (sin cabecera) y los accesos correctos no suman
    for (let i = 0; i < 6; i++) assert.equal((await g({})).status, 401);
    for (let i = 0; i < 6; i++) assert.equal((await g(cred('admin', 'buena'))).status, 200);
    // fallos con credenciales: 2 permitidos, el 3.º ya está bloqueado
    assert.equal((await g(cred('admin', 'mala'))).status, 401);
    assert.equal((await g(cred('admin', 'mala'))).status, 401);
    const bloqueado = await g(cred('admin', 'mala'));
    assert.equal(bloqueado.status, 429);
    assert.ok(Number(bloqueado.headers.get('retry-after')) >= 1);
    // bloqueada la IP, ni siquiera las credenciales correctas entran durante el bloqueo
    assert.equal((await g(cred('admin', 'buena'))).status, 429);
  });
});
