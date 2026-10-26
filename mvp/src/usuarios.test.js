// Cuentas de usuario contra PostgreSQL real, por HTTP.
//  Camino A (SSO): el admin pre-registra por correo y da de baja.  Camino B (AUTH_LOCAL, modo Basic): cuentas locales con clave temporal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');
const { hashear } = require('./adaptadores/auth/contrasena');
const { resolverRol } = require('./dominio/roles');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const CLAVE_ROOT = 'clave-root-de-prueba-1';
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const basic = (u, p) => ({ ...H, Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });

let b, local, abierto;
const pedir = (srv, metodo, ruta, cuerpo, headers) =>
  fetch(srv.url + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const json = async (r) => ({ estado: r.status, cuerpo: await r.json().catch(() => null) });
const root = (metodo, ruta, cuerpo) => pedir(local, metodo, ruta, cuerpo, basic('root', CLAVE_ROOT));
const como = (usuario, clave, metodo, ruta, cuerpo) => pedir(local, metodo, ruta, cuerpo, basic(usuario, clave));
const temporales = [];

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  local = await lanzarServicio({
    DATABASE_URL: b.url,
    NODE_ENV: 'production',
    APP_USER: 'root',
    APP_PASS: await hashear(CLAVE_ROOT),
    SESSION_SECRET: 'x'.repeat(40),
    AUTH_LOCAL: 'true',
  });
  abierto = await lanzarServicio({ DATABASE_URL: b.url }); // modo abierto de pruebas (sin AUTH_LOCAL)
});
test.after(async () => {
  if (!hayBase) return;
  await abierto.parar();
  await local.parar();
  await b.borrar();
});

test('B · cuenta local: clave temporal de un solo uso, solo el hash en la base, cambio obligatorio y luego uso normal con su rol', opts, async () => {
  const c = await json(await root('POST', '/api/v1/usuarios', { email: 'ana', nombre: 'Ana', rol: 'solicitante', local: true }));
  assert.equal(c.estado, 201, JSON.stringify(c.cuerpo));
  const temp = c.cuerpo.clave_temporal;
  temporales.push(temp);
  assert.match(temp, /^[A-Za-z0-9_-]{16}$/);
  const fila = (await b.sql("select clave_hash, debe_cambiar_clave from usuarios where email='ana'")).rows[0];
  assert.ok(fila.clave_hash.startsWith('scrypt$') && !fila.clave_hash.includes(temp), 'solo el hash, nunca la clave');
  assert.equal(fila.debe_cambiar_clave, true);
  // Con la clave temporal solo puede ver quién es y cambiarla.
  assert.equal((await como('ana', temp, 'GET', '/api/v1/pools')).status, 403);
  const yo = await json(await como('ana', temp, 'GET', '/api/v1/me'));
  assert.equal(yo.estado, 200);
  assert.deepEqual([yo.cuerpo.local, yo.cuerpo.debe_cambiar_clave, yo.cuerpo.rol], [true, true, 'solicitante']);
  // Cambio: la actual debe coincidir, la nueva ser larga y distinta.
  assert.equal((await como('ana', temp, 'POST', '/api/v1/yo/clave', { actual: 'otra-cosa-xx', nueva: 'una-clave-larga-123' })).status, 403);
  assert.equal((await como('ana', temp, 'POST', '/api/v1/yo/clave', { actual: temp, nueva: 'corta' })).status, 400);
  assert.equal((await como('ana', temp, 'POST', '/api/v1/yo/clave', { actual: temp, nueva: temp })).status, 400);
  const nueva = 'una-clave-larga-123';
  assert.equal((await como('ana', temp, 'POST', '/api/v1/yo/clave', { actual: temp, nueva })).status, 200);
  // La temporal ya no sirve; la nueva sí, con el rol «solicitante»: reserva, pero no asigna directo ni administra.
  assert.equal((await como('ana', temp, 'GET', '/api/v1/pools')).status, 401);
  assert.equal((await como('ana', nueva, 'GET', '/api/v1/pools')).status, 200);
  assert.equal((await como('ana', nueva, 'POST', '/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'x', mascara: 28 })).status, 403);
  assert.equal((await como('ana', nueva, 'GET', '/api/v1/tokens')).status, 403);
  assert.equal((await como('ana', nueva, 'GET', '/api/v1/usuarios')).status, 403);
  assert.equal((await como('ana', nueva, 'POST', '/api/v1/reservas', { pool: 'gke-nodos-qa', vpc: 'vpc-ana', mascara: 28 })).status, 201);
  // La clave de un usuario inexistente o errónea es 401 igual (sin pistas).
  assert.equal((await como('nadie', 'cualquiera-123456', 'GET', '/api/v1/pools')).status, 401);
  assert.equal((await como('ana', 'incorrecta-123456', 'GET', '/api/v1/pools')).status, 401);
});

test('B · desactivar rige al instante, activar lo revierte, restablecer da otra clave temporal y obliga a cambiarla', opts, async () => {
  const c = await json(await root('POST', '/api/v1/usuarios', { email: 'luis', rol: 'lector', local: true }));
  const t1 = c.cuerpo.clave_temporal;
  temporales.push(t1);
  assert.equal((await como('luis', t1, 'GET', '/api/v1/me')).status, 200);
  assert.equal((await root('POST', '/api/v1/usuarios/luis/desactivar')).status, 200);
  assert.equal((await como('luis', t1, 'GET', '/api/v1/me')).status, 401, 'la baja rige al instante');
  assert.equal((await root('POST', '/api/v1/usuarios/luis/activar')).status, 200);
  assert.equal((await como('luis', t1, 'GET', '/api/v1/me')).status, 200);
  const r = await json(await root('POST', '/api/v1/usuarios/luis/restablecer-clave'));
  assert.equal(r.estado, 200);
  const t2 = r.cuerpo.clave_temporal;
  temporales.push(t2);
  assert.notEqual(t1, t2);
  assert.equal((await como('luis', t1, 'GET', '/api/v1/me')).status, 401);
  const yo = await json(await como('luis', t2, 'GET', '/api/v1/me'));
  assert.equal(yo.cuerpo.debe_cambiar_clave, true);
  // Eliminar: la cuenta deja de existir.
  assert.equal((await root('DELETE', '/api/v1/usuarios/luis')).status, 200);
  assert.equal((await como('luis', t2, 'GET', '/api/v1/me')).status, 401);
  assert.equal((await root('DELETE', '/api/v1/usuarios/luis')).status, 404);
});

test(
  'B · validaciones: duplicados, rol inválido, nombre inválido, nadie actúa sobre sí mismo, el administrador de emergencia entra siempre',
  opts,
  async () => {
    assert.equal((await root('POST', '/api/v1/usuarios', { email: 'ana', rol: 'lector', local: true })).status, 409);
    assert.equal((await root('POST', '/api/v1/usuarios', { email: 'pepe', rol: 'dios', local: true })).status, 400);
    assert.equal((await root('POST', '/api/v1/usuarios', { email: 'con espacio', rol: 'lector', local: true })).status, 400);
    // El admin local no puede desactivarse ni eliminarse a sí mismo.
    const a = await json(await root('POST', '/api/v1/usuarios', { email: 'jefa', rol: 'admin', local: true }));
    const temp = a.cuerpo.clave_temporal;
    temporales.push(temp);
    const nueva = 'clave-de-la-jefa-123';
    await como('jefa', temp, 'POST', '/api/v1/yo/clave', { actual: temp, nueva });
    assert.equal((await como('jefa', nueva, 'POST', '/api/v1/usuarios/jefa/desactivar')).status, 409);
    assert.equal((await como('jefa', nueva, 'DELETE', '/api/v1/usuarios/jefa')).status, 409);
    // Una admin local sí administra a otras cuentas.
    assert.equal((await como('jefa', nueva, 'GET', '/api/v1/usuarios')).status, 200);
    // El administrador de emergencia (APP_USER) sigue entrando aunque se borre toda la tabla.
    await b.sql('delete from usuarios');
    assert.equal((await root('GET', '/api/v1/usuarios')).status, 200);
    // Los usuarios aparecen en el listado con su tipo y estado.
    await root('POST', '/api/v1/usuarios', { email: 'lista', rol: 'lector', local: true });
    const l = (await json(await root('GET', '/api/v1/usuarios'))).cuerpo.find((u) => u.email === 'lista');
    assert.deepEqual([l.activo, l.local, l.debe_cambiar_clave, l.rol], [true, true, true, 'lector']);
    assert.equal(l.clave_hash, undefined, 'el listado nunca devuelve el hash');
  },
);

test('B · sin AUTH_LOCAL no se pueden crear cuentas locales; con pre-registro SSO (camino A) sí', opts, async () => {
  const p = await json(await pedir(abierto, 'POST', '/api/v1/usuarios', { email: 'xy', rol: 'lector', local: true }, H));
  assert.equal(p.estado, 400);
  assert.equal(p.cuerpo.error, 'cuentas_locales_deshabilitadas');
});

test('A · pre-registro por correo con su rol, baja y reactivación (SSO: sin contraseña en el IPAM)', opts, async () => {
  const c = await json(await pedir(abierto, 'POST', '/api/v1/usuarios', { email: 'Luisa@Empresa.cl', nombre: 'Luisa', rol: 'solicitante' }, H));
  assert.equal(c.estado, 201, JSON.stringify(c.cuerpo));
  assert.equal(c.cuerpo.email, 'luisa@empresa.cl');
  assert.equal(c.cuerpo.clave_temporal, undefined, 'una cuenta SSO no tiene contraseña en el IPAM');
  const lista = async () => (await json(await pedir(abierto, 'GET', '/api/v1/usuarios', undefined, H))).cuerpo.find((u) => u.email === 'luisa@empresa.cl');
  assert.deepEqual([(await lista()).rol, (await lista()).local, (await lista()).activo], ['solicitante', false, true]);
  assert.equal(
    (await pedir(abierto, 'POST', '/api/v1/usuarios/luisa@empresa.cl/restablecer-clave', undefined, H)).status,
    400,
    'solo las locales tienen clave',
  );
  await pedir(abierto, 'POST', '/api/v1/usuarios/luisa@empresa.cl/desactivar', undefined, H);
  assert.equal((await lista()).activo, false);
  await pedir(abierto, 'POST', '/api/v1/usuarios/luisa@empresa.cl/activar', undefined, H);
  assert.equal((await lista()).activo, true);
  assert.equal((await pedir(abierto, 'POST', '/api/v1/usuarios/nadie@x.cl/desactivar', undefined, H)).status, 404);
});

test('A · un usuario dado de baja no obtiene rol al iniciar sesión con SSO (salvo los correos admin de la configuración)', () => {
  const cfg = {
    correosAdmin: ['jefe@x.cl'],
    correosSolicitante: [],
    correosLector: [],
    claimGrupos: 'groups',
    gruposAdmin: [],
    gruposSolicitante: [],
    gruposLector: [],
    rolPorDefecto: 'lector',
  };
  assert.equal(resolverRol({ email: 'a@x.cl' }, { rol: 'solicitante', activo: true }, cfg), 'solicitante');
  assert.equal(resolverRol({ email: 'a@x.cl' }, { rol: 'solicitante', activo: false }, cfg), null);
  assert.equal(resolverRol({ email: 'jefe@x.cl' }, { rol: 'lector', activo: false }, cfg), 'admin', 'salida de emergencia por configuración');
});

test('la auditoría registra las altas y bajas sin guardar ninguna clave, y las claves temporales no aparecen en los logs', opts, async () => {
  const aud = (await json(await root('GET', '/api/v1/auditoria'))).cuerpo;
  for (const accion of ['crear_usuario', 'desactivar_usuario', 'restablecer_clave', 'eliminar_usuario', 'cambiar_clave'])
    assert.ok(
      aud.some((f) => f.accion === accion),
      accion,
    );
  const texto = JSON.stringify(aud);
  for (const t of temporales) assert.ok(!texto.includes(t), 'una clave temporal se coló en la auditoría');
  const logs = local.crudo();
  for (const t of temporales) assert.ok(!logs.includes(t), 'una clave temporal se coló en los logs');
  assert.ok(!logs.includes('una-clave-larga-123'), 'una clave elegida por el usuario se coló en los logs');
});

test('Basic · /auth/salir responde 401 con el desafío para que el navegador olvide las credenciales; en otros modos redirige', opts, async () => {
  // Es pública (no pide credenciales) y siempre 401 en modo Basic.
  const r = await fetch(local.url + '/auth/salir');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Basic realm="IPAM"/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /Sesión cerrada/);
  assert.match(html, /cierra también la ventana/);
  assert.ok(!/<script/i.test(html), 'sin scripts (CSP)');
  // Con credenciales falsas (lo que hace la interfaz) tampoco es un error de autenticación nuevo: sigue siendo el mismo 401.
  assert.equal((await fetch(local.url + '/auth/salir', { headers: basic('salir', 'salir') })).status, 401);
  // El administrador sigue pudiendo entrar con sus credenciales después (no hay estado en el servidor).
  assert.equal((await root('GET', '/api/v1/me')).status, 200);
  // Sin Basic (acceso abierto) no hay nada que cerrar: vuelve a la aplicación.
  const abierta = await fetch(abierto.url + '/auth/salir', { redirect: 'manual' });
  assert.equal(abierta.status, 302);
  assert.equal(abierta.headers.get('location'), '/');
});

test('Basic · /api/me informa el modo, el rol y si hay cuentas locales (la interfaz decide Salir y Usuarios con eso)', opts, async () => {
  const me = (await json(await root('GET', '/api/v1/me'))).cuerpo;
  assert.equal(me.modo, 'basic');
  assert.equal(me.rol, 'admin');
  assert.equal(me.usuario, 'root');
  assert.equal(me.cuentas_locales, true);
  assert.equal(me.local, false, 'el administrador de emergencia no es una cuenta local (su clave vive en la configuración)');
  const sin = (await json(await pedir(abierto, 'GET', '/api/v1/me', undefined, H))).cuerpo;
  assert.equal(sin.modo, 'none');
  assert.equal(sin.cuentas_locales, false);
});
