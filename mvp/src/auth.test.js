// Pruebas del inicio de sesión OIDC contra un proveedor real (oidc-provider) y de los roles.
// Requieren PostgreSQL (DATABASE_URL) con db/schema.sql y db/seed.sql aplicados.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const hay = !!process.env.DATABASE_URL;
const opts = { skip: hay ? false : 'sin DATABASE_URL' };
const GRUPOS = { 'ana@empresa.cl': ['ipam-solicitantes'], 'jefe@empresa.cl': ['ipam-admins'] };
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };

let app, base, idp, db;

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
