// Tokens de servicio contra PostgreSQL real, por HTTP: creación, uso, rol, revocación, vencimiento, Bearer primero en cualquier modo.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');
const { hashear } = require('./adaptadores/auth/contrasena');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' }; // el admin entra «abierto» (modo anónimo del servicio de pruebas)
const creados = []; // todos los tokens creados: al final no deben aparecer en ningún log

let b, s, url;
const llamar = (metodo, ruta, cuerpo, h = {}, base = url) => fetch(base + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const json = async (r) => ({ estado: r.status, cuerpo: await r.json() });
const admin = (metodo, ruta, cuerpo) => llamar(metodo, ruta, cuerpo, ADM);
const bearer = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }); // SIN X-Requested-With
async function crearToken(nombre, rol, extra = {}) {
  const r = await json(await admin('POST', '/api/tokens', { nombre, rol, ...extra }));
  assert.equal(r.estado, 201, JSON.stringify(r.cuerpo));
  creados.push(r.cuerpo.token);
  return r.cuerpo;
}
const reservar = (token, cuerpo = {}, clave) => llamar('POST', '/api/reservas', { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'vpc-prueba', ...cuerpo }, bearer(token, clave ? { 'Idempotency-Key': clave } : {}));

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  s = await lanzarServicio({ DATABASE_URL: b.url, CUOTA_RESERVAS_POR_TOKEN: '3' });
  url = s.url;
});
test.after(async () => { if (!hayBase) return; await s.parar(); await b.borrar(); });

test('crear: formato ipam_+43, se muestra una vez, la base solo guarda el hash y el listado no lo revela', opts, async () => {
  const t = await crearToken('agente-redes', 'agente');
  assert.match(t.token, /^ipam_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ nombre: t.nombre, rol: t.rol, estado: t.estado, creado_por: t.creado_por, prefijo: t.prefijo }, { nombre: 'agente-redes', rol: 'agente', estado: 'activo', creado_por: 'anonimo', prefijo: t.token.slice(0, 9) });
  const fila = (await b.sql('select hash, prefijo, (tokens_servicio::text like $1) as filtra, expira_en > now() + interval \'89 days\' and expira_en < now() + interval \'91 days\' as noventa from tokens_servicio', [`%${t.token}%`])).rows[0];
  assert.equal(fila.hash, crypto.createHash('sha256').update(t.token).digest('hex'));
  assert.equal(fila.filtra, false, 'el token en claro no está en la base');
  assert.equal(fila.noventa, true, 'vigencia por defecto: 90 días');
  const lista = await (await admin('GET', '/api/tokens')).text();
  assert.ok(!lista.includes(t.token) && !lista.includes(fila.hash), 'el listado no incluye ni el token ni el hash');
  assert.ok(JSON.parse(lista).every((x) => !('token' in x) && !('hash' in x)));
  const r = await admin('POST', '/api/v1/tokens', { nombre: 'agente-redes', rol: 'agente' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'nombre_en_uso');
  for (const malo of [{ nombre: 'Mal Nombre', rol: 'agente' }, { nombre: 'ok', rol: 'admin' }, { nombre: 'ok', rol: 'agente', expira_dias: 0 }, { nombre: 'ok', rol: 'agente', expira_dias: 366 }]) {
    assert.equal((await admin('POST', '/api/tokens', malo)).status, 400, JSON.stringify(malo));
  }
  assert.equal((await json(await admin('POST', '/api/tokens', { nombre: 'un-anio', rol: 'lector', expira_dias: 365 }))).estado, 201);
  assert.equal((await b.sql("select expira_en > now() + interval '364 days' as ok from tokens_servicio where nombre = 'un-anio'")).rows[0].ok, true);
});

test('uso: actor svc:<nombre>, /api/me con modo token, sin X-Requested-With (no hay cookie, CSRF no aplica) y auditado como svc:', opts, async () => {
  const t = await crearToken('uso-basico', 'agente');
  const me = await json(await llamar('GET', '/api/me', undefined, bearer(t.token)));
  assert.deepEqual(me.cuerpo, { modo: 'token', usuario: 'svc:uso-basico', nombre: 'svc:uso-basico', rol: 'agente' });
  assert.equal((await llamar('GET', '/api/pools', undefined, bearer(t.token))).status, 200);
  const r = await json(await reservar(t.token, {}, 'uso-1'));
  assert.equal(r.estado, 201);
  assert.equal(r.cuerpo.solicitante, 'svc:uso-basico');
  assert.deepEqual((await b.sql("select usuario, rol from auditoria where accion = 'reservar' and detalle->>'reserva' = $1", [r.cuerpo.id])).rows[0], { usuario: 'svc:uso-basico', rol: 'agente' });
  await llamar('DELETE', `/api/reservas/${r.cuerpo.id}`, undefined, bearer(t.token));
});

test('roles: lector solo consulta; agente reserva pero no asigna directo, no administra usuarios ni tokens', opts, async () => {
  const lector = await crearToken('solo-lectura', 'lector');
  const agente = await crearToken('agente-roles', 'agente');
  assert.equal((await llamar('GET', '/api/reservas', undefined, bearer(lector.token))).status, 200);
  assert.equal((await llamar('GET', '/api/pools', undefined, bearer(lector.token))).status, 200);
  const sinPermiso = await json(await reservar(lector.token));
  assert.deepEqual({ e: sinPermiso.estado, requiere: sinPermiso.cuerpo.requiere }, { e: 403, requiere: 'agente' });
  for (const [m, ruta, cuerpo] of [['POST', '/api/solicitudes', { pool: 'gke-nodos-qa', vpc: 'v', mascara: 28 }], ['GET', '/api/usuarios'], ['GET', '/api/tokens'], ['POST', '/api/tokens', { nombre: 'x1', rol: 'agente' }], ['GET', '/api/auditoria'], ['DELETE', '/api/asignaciones/1'], ['GET', '/api/exportar.json']]) {
    const r = await llamar(m, ruta, cuerpo, bearer(agente.token));
    assert.equal(r.status, 403, `${m} ${ruta} debería ser 403 para un agente`);
  }
  assert.equal((await llamar('GET', '/api/exportar.xlsx', undefined, bearer(agente.token))).status, 200, 'un agente (≥ lector) sí puede exportar a Excel');
});

test('token inválido, vencido o revocado → 401 con mensaje genérico y auditoría token_rechazado (sin el token)', opts, async () => {
  const malo = `ipam_${'A'.repeat(43)}`;
  const r = await llamar('GET', '/api/pools', undefined, bearer(malo));
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="IPAM"');
  const cuerpo = await r.json();
  assert.deepEqual({ e: cuerpo.error, m: cuerpo.mensaje }, { e: 'token_invalido', m: 'Token inválido, vencido o revocado.' });
  assert.ok(cuerpo.request_id);
  assert.equal((await llamar('GET', '/api/pools', undefined, bearer('basura'))).status, 401);

  const v = await crearToken('para-vencer', 'agente', { expira_dias: 1 });
  await b.sql("update tokens_servicio set expira_en = now() - interval '1 second' where nombre = 'para-vencer'");
  assert.equal((await llamar('GET', '/api/pools', undefined, bearer(v.token))).status, 401);
  const rv = await crearToken('para-revocar', 'agente');
  assert.equal((await llamar('GET', '/api/pools', undefined, bearer(rv.token))).status, 200);
  const del = await json(await admin('DELETE', `/api/tokens/${rv.id}`));
  assert.deepEqual({ e: del.estado, est: del.cuerpo.estado }, { e: 200, est: 'revocado' });
  assert.equal((await llamar('GET', '/api/pools', undefined, bearer(rv.token))).status, 401, 'la revocación es inmediata');
  assert.equal((await admin('DELETE', `/api/tokens/${rv.id}`)).status, 200, 'revocar de nuevo es idempotente');
  assert.equal((await admin('DELETE', '/api/tokens/11111111-1111-4111-8111-111111111111')).status, 404);

  const aud = (await b.sql("select usuario, detalle->>'motivo' as motivo, detalle::text as d from auditoria where accion = 'token_rechazado' order by id")).rows;
  assert.deepEqual(aud.map((x) => x.motivo), ['desconocido', 'formato', 'vencido', 'revocado']);
  assert.deepEqual(aud.map((x) => x.usuario), ['desconocido', 'desconocido', 'svc:para-vencer', 'svc:para-revocar']);
  assert.ok(aud.every((x) => !x.d.includes('ipam_')), 'la auditoría no contiene el token');
});

test('Bearer se evalúa PRIMERO en cualquier modo: un token inválido es 401 aunque el servicio sea abierto o haya credenciales Basic válidas', opts, async () => {
  const malo = `ipam_${'B'.repeat(43)}`;
  assert.equal((await llamar('GET', '/api/pools', undefined, { Authorization: `Bearer ${malo}`, 'X-Requested-With': 'ipam' })).status, 401, 'modo abierto + token inválido');

  const clave = 'una-clave-de-prueba-larga';
  const sb = await lanzarServicio({ DATABASE_URL: b.url, APP_USER: 'admin', APP_PASS: await hashear(clave) });
  try {
    const basic = `Basic ${Buffer.from(`admin:${clave}`).toString('base64')}`;
    assert.equal((await llamar('GET', '/api/pools', undefined, { Authorization: basic }, sb.url)).status, 200);
    assert.equal((await llamar('GET', '/api/pools', undefined, { Authorization: `Basic ${Buffer.from('admin:mala').toString('base64')}` }, sb.url)).status, 401);
    // Basic en escritura sigue exigiendo X-Requested-With…
    const sinCab = await llamar('POST', '/api/tokens', { nombre: 'desde-basic', rol: 'lector' }, { Authorization: basic, 'Content-Type': 'application/json' }, sb.url);
    assert.equal(sinCab.status, 403);
    const conCab = await json(await llamar('POST', '/api/tokens', { nombre: 'desde-basic', rol: 'lector' }, { Authorization: basic, 'Content-Type': 'application/json', 'X-Requested-With': 'ipam' }, sb.url));
    assert.equal(conCab.estado, 201);
    creados.push(conCab.cuerpo.token);
    // …y el token que se creó funciona en ese servicio SIN la cabecera.
    const uso = await json(await llamar('GET', '/api/me', undefined, bearer(conCab.cuerpo.token), sb.url));
    assert.equal(uso.cuerpo.modo, 'token');
    // Token inválido junto a Basic válido: gana el Bearer → 401.
    assert.equal((await llamar('GET', '/api/pools', undefined, { Authorization: `Bearer ${malo}` }, sb.url)).status, 401);
    // Sin credenciales en modo Basic → 401 con desafío.
    const sin = await llamar('GET', '/api/pools', undefined, {}, sb.url);
    assert.equal(sin.status, 401);
    assert.match(sin.headers.get('www-authenticate'), /Basic/);
    assert.ok(!sb.crudo().includes(clave), 'la clave no aparece en los logs');
  } finally { await sb.parar(); }
});

test('dueño vs admin por HTTP: otro token no opera sobre mi reserva; un admin sí; el agente confirma con aprobación humana', opts, async () => {
  const a = await crearToken('agente-a', 'agente');
  const bb = await crearToken('agente-b', 'agente');
  const r = await json(await reservar(a.token, {}, 'dueno-1'));
  assert.equal(r.estado, 201);
  const id = r.cuerpo.id;
  for (const [m, ruta, cuerpo] of [['POST', `/api/reservas/${id}/confirmar`, { aprobado_por: 'x', referencia: 'y' }], ['DELETE', `/api/reservas/${id}`]]) {
    const x = await json(await llamar(m, ruta, cuerpo, bearer(bb.token)));
    assert.deepEqual({ e: x.estado, c: x.cuerpo.error }, { e: 403, c: 'no_es_dueno' }, `${m} por otro token`);
  }
  const sin = await json(await llamar('POST', `/api/reservas/${id}/confirmar`, {}, bearer(a.token)));
  assert.deepEqual({ e: sin.estado, c: sin.cuerpo.error }, { e: 400, c: 'falta_aprobacion' }, 'sin aprobación humana no se vuelve definitiva');
  assert.equal((await json(await fetch(`${url}/api/reservas/${id}`, { headers: ADM }))).cuerpo.estado, 'reservada');
  const ok = await json(await llamar('POST', `/api/reservas/${id}/confirmar`, { aprobado_por: 'ana@empresa.example', referencia: 'https://gitlab.example/redes/-/merge_requests/7' }, bearer(a.token)));
  assert.equal(ok.estado, 200);
  assert.equal(ok.cuerpo.asignacion.origen, 'agente');
  const aud = (await b.sql("select usuario, detalle from auditoria where accion = 'confirmar_reserva' and detalle->>'reserva' = $1", [id])).rows[0];
  assert.deepEqual({ u: aud.usuario, ap: aud.detalle.aprobado_por, ref: aud.detalle.referencia }, { u: 'svc:agente-a', ap: 'ana@empresa.example', ref: 'https://gitlab.example/redes/-/merge_requests/7' });
  // Un admin (sesión abierta de pruebas) sí puede liberar la de otro; borra la asignación.
  const adm = await json(await admin('DELETE', `/api/reservas/${id}`));
  assert.deepEqual({ e: adm.estado, borrada: adm.cuerpo.asignacion_borrada }, { e: 200, borrada: true });
});

test('ultimo_uso se actualiza como máximo una vez por minuto', opts, async () => {
  const t = await crearToken('uso-minuto', 'lector');
  const ultimo = async () => (await b.sql("select ultimo_uso from tokens_servicio where nombre = 'uso-minuto'")).rows[0].ultimo_uso;
  assert.equal(await ultimo(), null);
  await llamar('GET', '/api/pools', undefined, bearer(t.token));
  const primero = await ultimo();
  assert.ok(primero);
  await llamar('GET', '/api/pools', undefined, bearer(t.token));
  assert.equal(String(await ultimo()), String(primero), 'dentro del minuto no cambia');
  await b.sql("update tokens_servicio set ultimo_uso = now() - interval '2 minutes' where nombre = 'uso-minuto'");
  await llamar('GET', '/api/pools', undefined, bearer(t.token));
  assert.ok((await ultimo()) > new Date(Date.now() - 30_000), 'pasado el minuto se actualiza');
});

test('cuota por token: general (CUOTA_RESERVAS_POR_TOKEN) o propia al crear; 429 con cuántas tiene vigentes', opts, async () => {
  const normal = await crearToken('cuota-normal', 'agente');
  const vip = await crearToken('cuota-vip', 'agente', { cuota_reservas: 5 });
  const ids = [];
  for (let i = 0; i < 3; i++) { const r = await json(await reservar(normal.token, { mascara: 29 })); assert.equal(r.estado, 201); ids.push(r.cuerpo.id); }
  const cuarta = await llamar('POST', '/api/reservas', { ambiente: 'qa', tipo: 'Nodos', mascara: 29, vpc: 'v' }, bearer(normal.token));
  assert.equal(cuarta.status, 429);
  const c = await cuarta.json();
  assert.deepEqual({ e: c.error, v: c.vigentes, l: c.limite }, { e: 'cuota_excedida', v: 3, l: 3 });
  assert.match(c.mensaje, /Tienes 3 reservas vigentes de 3 permitidas/);
  for (let i = 0; i < 5; i++) assert.equal((await reservar(vip.token, { mascara: 30 })).status, 201, `vip #${i + 1}`);
  assert.equal((await reservar(vip.token, { mascara: 30 })).status, 429);
  await llamar('DELETE', `/api/reservas/${ids[0]}`, undefined, bearer(normal.token));
  assert.equal((await reservar(normal.token, { mascara: 29 })).status, 201, 'al liberar queda cupo');
  await b.sql("update reservas set estado = 'liberada' where estado = 'reservada'");
});

test('los tokens nunca aparecen en los logs del servicio', opts, async () => {
  const log = s.crudo();
  assert.ok(creados.length >= 8);
  for (const t of creados) assert.ok(!log.includes(t), 'un token se coló en los logs');
  assert.ok(!/ipam_[A-Za-z0-9_-]{30,}/.test(log), 'ningún texto con forma de token en los logs');
});
