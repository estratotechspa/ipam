// Pruebas del inicio de sesión OIDC contra un proveedor real (oidc-provider) y de los roles.
// Requieren PostgreSQL (DATABASE_URL) con db/schema.sql y db/seed.sql aplicados.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Estas pruebas hacen muchas escrituras seguidas con un solo actor: se sube el límite de peticiones (la lógica del límite se prueba en limite.test.js).
Object.assign(process.env, {
  RATE_LIMIT_POR_MINUTO: '100000',
  RATE_LIMIT_ESCRITURA_POR_MINUTO: '100000',
  RATE_LIMIT_IP_POR_MINUTO: '100000',
  RATE_LIMIT_AUTH_FALLOS_POR_MINUTO: '100000',
});
const hay = !!process.env.DATABASE_URL;
const opts = { skip: hay ? false : 'sin DATABASE_URL' };
const GRUPOS = { 'ana@empresa.cl': ['ipam-solicitantes'], 'jefe@empresa.cl': ['ipam-admins'] };
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };

let app, base, idp, db, revalidador;

// Navegador mínimo: mantiene cookies por origen y sigue redirecciones a mano.
class Navegador {
  constructor() {
    this.jar = new Map();
  }
  cookies(url) {
    return [...(this.jar.get(new URL(url).origin) || new Map())].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  guardar(url, res) {
    const o = new URL(url).origin;
    const m = this.jar.get(o) || new Map();
    for (const c of res.headers.getSetCookie()) {
      const [par, ...attrs] = c.split(';');
      const i = par.indexOf('=');
      const nombre = par.slice(0, i).trim(),
        valor = par.slice(i + 1).trim();
      if (!valor || /max-age=0/i.test(attrs.join(';'))) m.delete(nombre);
      else m.set(nombre, valor);
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
  async entrar(email, next = '/', modificar = (u) => u) {
    let { res, url } = await this.seguir(`${base}/auth/login?next=${encodeURIComponent(next)}`);
    const formulario = async (extra) => {
      const html = await res.text();
      const accion = new URL(html.match(/<form[^>]*action="([^"]*)"/)[1], url).href;
      const campos = { ...extra };
      for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) campos[m[1]] = m[2];
      return this.seguir(accion, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(campos).toString(),
      });
    };
    ({ res, url } = await formulario({ login: email, password: 'x' }));
    if (res.status === 200) ({ res, url } = await formulario({}));
    // `url` es ahora la URL de retorno hacia /auth/callback
    return this.pedir(modificar(url));
  }
  api(ruta, init = {}) {
    return this.pedir(base + ruta, { ...init, headers: { ...H, ...(init.headers || {}) } });
  }
}

test.before(async () => {
  if (!hay) return;
  Object.assign(process.env, {
    OIDC_CLIENT_ID: 'ipam',
    OIDC_CLIENT_SECRET: 's3cret',
    PUBLIC_URL: 'http://127.0.0.1:1',
    SESSION_SECRET: 'x'.repeat(40),
    OIDC_ALLOW_INSECURE: 'true',
    OIDC_SCOPES: 'openid email profile groups',
    OIDC_ADMIN_EMAILS: 'root@empresa.cl',
    OIDC_ADMIN_GROUPS: 'ipam-admins',
    OIDC_REQUESTER_GROUPS: 'ipam-solicitantes',
    OIDC_ALLOWED_DOMAINS: 'empresa.cl',
  });
  // 1) La app escucha primero para conocer su URL; 2) el IdP registra ese retorno; 3) se activa OIDC_ISSUER.
  process.env.OIDC_ISSUER = 'http://127.0.0.1:1';
  ({ app, db } = require('./server'));
  revalidador = app.locals.revalidador;
  const srvApp = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  base = `http://127.0.0.1:${srvApp.address().port}`;
  process.env.PUBLIC_URL = base;
  app = srvApp;

  const { default: Provider } = await import('oidc-provider');
  const srvIdp = http.createServer();
  await new Promise((ok) => srvIdp.listen(0, '127.0.0.1', ok));
  const emisor = `http://127.0.0.1:${srvIdp.address().port}`;
  const provider = new Provider(emisor, {
    clients: [
      { client_id: 'ipam', client_secret: 's3cret', redirect_uris: [`${base}/auth/callback`], grant_types: ['authorization_code'], response_types: ['code'] },
    ],
    findAccount: async (_c, id) => ({
      accountId: id,
      claims: async () => ({ sub: id, email: id, email_verified: !id.startsWith('noverif'), name: id.split('@')[0], groups: GRUPOS[id] || [] }),
    }),
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
    conformIdTokenClaims: false,
    features: { devInteractions: { enabled: true } },
  });
  srvIdp.on('request', provider.callback());
  idp = srvIdp;
  process.env.OIDC_ISSUER = emisor;
});
test.after(async () => {
  if (hay) {
    app.close();
    idp.close();
    await db.query("delete from usuarios where email like '%@empresa.cl' or email like '%@gmail.com'");
    await db.end();
  }
});

test('sin sesión: la página redirige al login y la API responde 401; salud abierta', opts, async () => {
  const n = new Navegador();
  const r = await n.pedir(base + '/');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/login\?next=/, 'sin sesión se va a la pantalla de acceso, no directo al proveedor');
  const a = await n.api('/api/pools');
  assert.equal(a.status, 401);
  assert.equal((await a.json()).login, '/login');
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

test('roles por grupo: solicitante reserva pero no asigna directo ni libera; el admin aprueba; lector solo lee', opts, async () => {
  const ana = new Navegador();
  await ana.entrar('ana@empresa.cl');
  assert.equal((await (await ana.api('/api/me')).json()).rol, 'solicitante');
  // Asignar directo es solo de admin: el solicitante pasa por una reserva que otra persona (admin) aprueba.
  const directo = await ana.api('/api/solicitudes', { method: 'POST', body: JSON.stringify({ pool: 'onprem-lan-dev', vpc: 'rbac', cidr: '192.168.70.0/24' }) });
  assert.equal(directo.status, 403);
  const r = await ana.api('/api/reservas', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'rbac-ana-1' },
    body: JSON.stringify({ pool: 'onprem-lan-dev', vpc: 'rbac', cidr: '192.168.70.0/24' }),
  });
  assert.equal(r.status, 201);
  const reserva = await r.json();
  assert.equal(reserva.solicitante, 'ana@empresa.cl');
  assert.equal((await ana.api('/api/auditoria')).status, 403);

  const lector = new Navegador();
  await lector.entrar('lector@empresa.cl');
  assert.equal((await (await lector.api('/api/me')).json()).rol, 'lector');
  assert.equal((await lector.api('/api/solicitudes', { method: 'POST', body: JSON.stringify({ pool: 'onprem-lan-dev', vpc: 'x', mascara: 24 }) })).status, 403);
  assert.equal((await lector.api('/api/exportar.xlsx')).status, 200);

  // El admin aprueba la reserva (confirmar) y puede liberar la asignación; el solicitante no.
  const jefe = new Navegador();
  await jefe.entrar('jefe@empresa.cl');
  const conf = await jefe.api(`/api/reservas/${reserva.id}/confirmar`, { method: 'POST', body: '{}' });
  assert.equal(conf.status, 200);
  const asig = (await conf.json()).asignacion;
  assert.equal((await ana.api('/api/asignaciones/' + asig.id, { method: 'DELETE' })).status, 403);
  assert.equal((await jefe.api('/api/asignaciones/' + asig.id, { method: 'DELETE' })).status, 200);
});

test('SSO (camino A): el admin pre-registra por correo con su rol y puede dar de baja; la baja impide iniciar sesión', opts, async () => {
  const root = new Navegador();
  await root.entrar('root@empresa.cl');
  const alta = await root.api('/api/usuarios', {
    method: 'POST',
    body: JSON.stringify({ email: 'preregistrada@empresa.cl', nombre: 'Pre', rol: 'solicitante' }),
  });
  assert.equal(alta.status, 201);
  const n = new Navegador();
  await n.entrar('preregistrada@empresa.cl');
  assert.equal((await (await n.api('/api/me')).json()).rol, 'solicitante', 'entra con el rol pre-asignado');
  // Baja: no puede iniciar sesión de nuevo (aunque el proveedor la autentique).
  assert.equal((await root.api('/api/usuarios/preregistrada@empresa.cl/desactivar', { method: 'POST' })).status, 200);
  const baja = new Navegador();
  const r = await baja.entrar('preregistrada@empresa.cl');
  assert.equal(r.status, 403);
  // Reactivada, vuelve a entrar.
  assert.equal((await root.api('/api/usuarios/preregistrada@empresa.cl/activar', { method: 'POST' })).status, 200);
  const otra = new Navegador();
  await otra.entrar('preregistrada@empresa.cl');
  assert.equal((await (await otra.api('/api/me')).json()).rol, 'solicitante');
  // Un admin no puede desactivarse a sí mismo.
  assert.equal((await root.api('/api/usuarios/root@empresa.cl/desactivar', { method: 'POST' })).status, 409);
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
  falso.jar.set(
    base,
    new Map([
      [
        'ipam_sesion',
        n.jar
          .get(base)
          .get('ipam_sesion')
          .replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')),
      ],
    ]),
  );
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

test('modo OIDC: un token de servicio entra por Bearer sin cookie ni X-Requested-With; uno inválido es 401 JSON (no redirige al login)', opts, async () => {
  const root = new Navegador();
  await root.entrar('root@empresa.cl');
  const nombre = `oidc-${Date.now().toString(36)}`;
  const creado = await (await root.api('/api/tokens', { method: 'POST', body: JSON.stringify({ nombre, rol: 'lector' }) })).json();
  assert.match(creado.token, /^ipam_/);
  const me = await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${creado.token}` } });
  assert.deepEqual(await me.json(), {
    modo: 'token',
    usuario: `svc:${nombre}`,
    nombre: `svc:${nombre}`,
    rol: 'lector',
    local: false,
    debe_cambiar_clave: false,
    cuentas_locales: false,
  });
  const malo = await fetch(base + '/api/pools', { headers: { Authorization: `Bearer ipam_${'C'.repeat(43)}` }, redirect: 'manual' });
  assert.equal(malo.status, 401);
  assert.equal((await malo.json()).error, 'token_invalido');
  assert.equal((await root.api(`/api/tokens/${creado.id}`, { method: 'DELETE' })).status, 200);
});

// ---------- Sesiones revalidadas (cambio de rol, baja, formato de la cookie, CSRF en logout) ----------
const conEntorno = async (vars, fn) => {
  const previo = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previo))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};
const admin = async () => {
  const n = new Navegador();
  await n.entrar('root@empresa.cl');
  return n;
};
const poner = (root, email, rol) => root.api('/api/usuarios/' + email, { method: 'PUT', body: JSON.stringify({ rol }) });

test('la sesión dura 4 h por defecto y la cookie guarda el rol base (v:2), no el efectivo', opts, async () => {
  const cb = await new Navegador().entrar('horas@empresa.cl');
  const c = cb.headers.getSetCookie().find((x) => x.startsWith('ipam_sesion='));
  assert.match(c, /Max-Age=14400/);
  const carga = JSON.parse(Buffer.from(decodeURIComponent(c.split('=')[1].split(';')[0]).split('.')[0], 'base64url').toString());
  assert.equal(carga.v, 2);
  assert.equal(carga.rolBase, 'lector');
  assert.equal(carga.rol, undefined);
});

test('un cambio de rol rige sin volver a entrar: ascenso, degradación y «heredar» (vuelve al rol de sus grupos)', opts, async () => {
  const root = await admin();
  const ana = new Navegador();
  await ana.entrar('ana@empresa.cl'); // solicitante por su grupo
  const rol = async () => (await (await ana.api('/api/me')).json()).rol;
  assert.equal(await rol(), 'solicitante');
  assert.equal((await ana.api('/api/auditoria')).status, 403);
  assert.equal((await poner(root, 'ana@empresa.cl', 'admin')).status, 200);
  assert.equal(await rol(), 'admin');
  assert.equal((await ana.api('/api/auditoria')).status, 200);
  await poner(root, 'ana@empresa.cl', 'lector');
  assert.equal(await rol(), 'lector');
  assert.equal((await ana.api('/api/auditoria')).status, 403);
  await poner(root, 'ana@empresa.cl', null);
  assert.equal(await rol(), 'solicitante');
  // un administrador de la configuración no se degrada desde la base
  await poner(root, 'root@empresa.cl', 'lector');
  assert.equal((await (await root.api('/api/me')).json()).rol, 'admin');
  await poner(root, 'root@empresa.cl', null);
});

test('baja y reactivación rigen de inmediato en esta réplica; la sesión revocada recibe 401 «sesion_revocada» y se borra la cookie', opts, async () => {
  const root = await admin();
  const web = new Navegador();
  const api = new Navegador();
  await web.entrar('baja@empresa.cl');
  await api.entrar('baja@empresa.cl');
  assert.equal((await api.api('/api/pools')).status, 200);
  assert.equal((await root.api('/api/usuarios/baja@empresa.cl/desactivar', { method: 'POST', body: '{}' })).status, 200);
  const r = await api.api('/api/pools');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'sesion_revocada');
  assert.ok(
    r.headers.getSetCookie().some((c) => /^ipam_sesion=;/.test(c) || /Max-Age=0/.test(c)),
    'se borra la cookie',
  );
  const pagina = await web.pedir(base + '/');
  assert.equal(pagina.status, 302);
  assert.match(pagina.headers.get('location'), /^\/login\?error=revocada&next=/);
  await root.api('/api/usuarios/baja@empresa.cl/activar', { method: 'POST', body: '{}' });
  const otra = new Navegador();
  await otra.entrar('baja@empresa.cl');
  assert.equal((await otra.api('/api/pools')).status, 200, 'reactivada: vuelve a entrar');
});

test(
  'una baja o eliminación hecha directo en la base se nota al vencer la caché (5 min); con SESSION_REVALIDAR_SEG=0, en la petición siguiente',
  opts,
  async () => {
    const n = new Navegador();
    await n.entrar('directo@empresa.cl');
    assert.equal((await n.api('/api/pools')).status, 200);
    await db.query("update usuarios set activo = false where email = 'directo@empresa.cl'");
    assert.equal((await n.api('/api/pools')).status, 200, 'dentro de la caché sigue valiendo');
    revalidador.olvidarTodos(); // equivale a que venza la caché
    assert.equal((await n.api('/api/pools')).status, 401);

    const m = new Navegador();
    await m.entrar('directo2@empresa.cl');
    await conEntorno({ SESSION_REVALIDAR_SEG: '0' }, async () => {
      assert.equal((await m.api('/api/pools')).status, 200);
      await db.query("delete from usuarios where email = 'directo2@empresa.cl'");
      assert.equal((await m.api('/api/pools')).status, 401, 'eliminado: sin caché rige al instante');
    });
  },
);

test('una cookie con el formato anterior (sin revalidación) obliga a entrar de nuevo', opts, async () => {
  const S = require('./adaptadores/auth/sesion');
  const vieja = S.sellar({ email: 'root@empresa.cl', nombre: 'x', rol: 'admin', exp: Date.now() / 1000 + 3600 });
  const n = new Navegador();
  n.jar.set(base, new Map([['ipam_sesion', vieja]]));
  assert.equal((await n.api('/api/me')).status, 401);
});

test('/auth/logout exige X-Requested-With (defensa CSRF): sin él no cierra la sesión', opts, async () => {
  const n = await admin();
  const sin = await n.pedir(base + '/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(sin.status, 403);
  assert.match((await sin.json()).error, /X-Requested-With/);
  assert.equal((await n.api('/api/me')).status, 200, 'la sesión sigue activa');
  assert.equal((await n.api('/auth/logout', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await n.api('/api/me')).status, 401);
});

// ---------- Pantalla de acceso y páginas de error (solo con SSO) ----------
const sinScriptsEnLinea = (html) => assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html) && !/\son[a-z]+\s*=/i.test(html), 'sin scripts ni manejadores en línea');
const esPaginaDeAviso = async (res, { status, titulo, contiene = [] }) => {
  assert.equal(res.status, status);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, new RegExp(`<h1>${titulo}</h1>`));
  assert.match(html, /<a class="btn" href="\/login">/, 'botón para volver al acceso');
  assert.match(html, /href="\/app\.css"/, 'con el estilo de la app');
  assert.match(html, /Qué puedes hacer|Cerraste la sesión/);
  sinScriptsEnLinea(html);
  for (const c of contiene) assert.ok(html.includes(c), c);
  return html;
};

test('/login es pública, sin scripts en línea, y el resto sigue exigiendo sesión', opts, async () => {
  const n = new Navegador();
  const r = await n.pedir(base + '/login');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await r.text();
  assert.match(html, /Entrar con tu cuenta corporativa/);
  assert.match(html, /href="\/auth\/login"/);
  sinScriptsEnLinea(html);
  for (const publico of ['/login.js', '/app.css', '/brand.css', '/api/config', '/iconos.js', '/favicon.svg'])
    assert.equal((await n.pedir(base + publico)).status, 200, publico);
  for (const privado of ['/', '/index.html', '/app.js', '/calculos.js']) assert.equal((await n.pedir(base + privado)).status, 302, privado);
  assert.equal((await n.pedir(base + '/login?error=revocada&next=/x')).status, 200);
});

test('/login con sesión vigente devuelve a la aplicación, sin seguir el valor de next', opts, async () => {
  const n = new Navegador();
  await n.entrar('root@empresa.cl');
  for (const next of ['/pools', '//evil.example.com', 'https://evil.example.com']) {
    const r = await n.pedir(base + '/login?next=' + encodeURIComponent(next));
    assert.equal(r.status, 302, next);
    assert.equal(r.headers.get('location'), '/', next);
  }
});

test(
  'errores de acceso como páginas con qué pasó, qué hacer y botón: dominio (correo escapado), sin rol, correo sin verificar, expirada y sesión cerrada',
  opts,
  async () => {
    const dominio = await esPaginaDeAviso(await new Navegador().entrar('intruso@gmail.com'), {
      status: 403,
      titulo: 'Tu correo no tiene acceso',
      contiene: ['intruso@gmail.com', 'Pide acceso a un administrador'],
    });
    assert.match(dominio, /Entrar con otra cuenta/);
    const xss = await new Navegador().entrar('<b>x</b>@gmail.com');
    const h2 = await xss.text();
    assert.equal(xss.status, 403);
    assert.ok(!h2.includes('<b>x</b>') && h2.includes('&lt;b&gt;x&lt;/b&gt;@gmail.com'), 'el correo no entra como HTML');

    await conEntorno({ OIDC_DEFAULT_ROLE: 'ninguno' }, async () => {
      await esPaginaDeAviso(await new Navegador().entrar('sinrol@empresa.cl'), {
        status: 403,
        titulo: 'Tu cuenta aún no tiene un rol',
        contiene: ['sinrol@empresa.cl'],
      });
    });
    await esPaginaDeAviso(await new Navegador().entrar('noverif@empresa.cl'), { status: 403, titulo: 'Correo sin verificar' });
    const n = new Navegador();
    await esPaginaDeAviso(await n.pedir(base + '/auth/callback?code=x&state=y'), { status: 400, titulo: 'La solicitud de inicio de sesión expiró' });
    await esPaginaDeAviso(await n.pedir(base + '/auth/sesion-cerrada'), { status: 200, titulo: 'Sesión cerrada' });
    const aud = await (await (await admin()).api('/api/v1/auditoria')).json();
    for (const usuario of ['sinrol@empresa.cl', 'noverif@empresa.cl', 'intruso@gmail.com']) {
      assert.ok(
        aud.some((x) => x.accion === 'login_rechazado' && x.usuario === usuario),
        `auditoría de ${usuario}`,
      );
    }
  },
);

test('el proveedor rechaza o el intercambio falla: se vuelve a /login con ?error= (no un 500)', opts, async () => {
  const n = new Navegador();
  await n.pedir(base + '/auth/login'); // deja la cookie de inicio de sesión en curso
  const denegado = await n.pedir(base + '/auth/callback?error=access_denied&state=x');
  assert.equal(denegado.status, 302);
  assert.equal(denegado.headers.get('location'), '/login?error=denegado');
  const roto = await new Navegador().entrar('root@empresa.cl', '/', (u) => u.replace(/state=[^&]+/, 'state=manipulado'));
  assert.equal(roto.status, 302);
  assert.equal(roto.headers.get('location'), '/login?error=fallo');
});

test('favicon con el color de la marca, y el logo de la marca si existe', opts, async () => {
  const r = await fetch(base + '/favicon.svg');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await r.text(), /<svg[^>]*>.*fill="#2d6cdf"/s);
});

test('login.js en un navegador real: marca, enlace con next y aviso según ?error=', opts, async (t) => {
  const { chromium } = require('@playwright/test');
  let nav;
  try {
    nav = await chromium.launch();
  } catch {
    return t.skip('Chromium no está instalado (npx playwright install chromium)');
  }
  try {
    const page = await nav.newPage();
    await page.goto(`${base}/login?error=revocada&next=${encodeURIComponent('/asignaciones?x=1')}`);
    await page.waitForFunction('document.title.includes("·")');
    assert.equal(await page.getAttribute('#entrar', 'href'), '/auth/login?next=' + encodeURIComponent('/asignaciones?x=1'));
    assert.match(await page.textContent('#aviso'), /ya no está vigente/);
    assert.equal(await page.getAttribute('#aviso', 'role'), 'alert');
    await page.goto(`${base}/login?error=otracosa&next=//evil.example.com`);
    assert.match(await page.textContent('#aviso'), /No se pudo iniciar sesión/);
    assert.equal(await page.getAttribute('#entrar', 'href'), '/auth/login', 'un next externo se descarta');
    await page.goto(`${base}/login`);
    assert.equal(await page.isHidden('#aviso'), true);
  } finally {
    await nav.close();
  }
});
