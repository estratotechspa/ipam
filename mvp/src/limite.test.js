// Límite de peticiones por HTTP contra PostgreSQL, con DOS instancias que comparten contadores.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');
const { construirOpenApi } = require('./openapi');
const { crearValidador } = require('./adaptadores/http/validacion');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const bearer = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
let b, s1, s2;

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  const env = { DATABASE_URL: b.url, RATE_LIMIT_POR_MINUTO: '10', RATE_LIMIT_ESCRITURA_POR_MINUTO: '4', RATE_LIMIT_IP_POR_MINUTO: '1000', RATE_LIMIT_AUTH_FALLOS_POR_MINUTO: '4', TRUST_PROXY: '1' };
  [s1, s2] = await Promise.all([lanzarServicio(env), lanzarServicio(env)]);
});
test.after(async () => { if (!hayBase) return; await Promise.all([s1.parar(), s2.parar()]); await b.borrar(); });
const reiniciar = () => b.sql('delete from limite_contador');
const get = (s, ruta = '/api/pools', h = {}) => fetch(s.url + ruta, { headers: { ...ADM, ...h } });

test('429 con Retry-After, cuerpo claro en español y cabeceras RateLimit; cumple el contrato', opts, async () => {
  await reiniciar();
  const rs = [];
  for (let i = 0; i < 12; i++) rs.push(await get(s1, '/api/pools', { 'X-Forwarded-For': '198.51.100.1' }));
  const estados = rs.map((r) => r.status);
  assert.deepEqual(estados, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429, 429], 'lectura: 10 por minuto por actor');
  assert.equal(rs[0].headers.get('ratelimit-limit'), '10');
  assert.equal(rs[0].headers.get('ratelimit-remaining'), '9');
  assert.equal(rs[9].headers.get('ratelimit-remaining'), '0');
  const r = rs[10];
  const espera = Number(r.headers.get('retry-after'));
  assert.ok(espera >= 1 && espera <= 60);
  const c = await r.json();
  assert.equal(c.error, 'rate_limit');
  assert.match(c.mensaje, /^Demasiadas peticiones\. Reintenta en \d+ segundos?\.$/);
  assert.equal(c.retry_after, espera);
  assert.ok(c.request_id);
  const op = construirOpenApi().paths['/api/v1/pools'].get.responses['429'];
  assert.ok(op, 'el contrato documenta el 429');
  const validar = crearValidador(construirOpenApi()).ajv.compile({ $ref: 'openapi#/components/schemas/ErrorRateLimit' });
  assert.equal(validar(c), true, JSON.stringify(validar.errors));
  assert.equal((await get(s1, '/healthz')).status, 200, 'las sondas no cuentan');
  assert.equal((await get(s1, '/readyz')).status, 200);
});

test('contadores consistentes entre instancias: 30 peticiones en paralelo repartidas en 2 réplicas → exactamente 10 pasan', opts, async () => {
  await reiniciar();
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => get(i % 2 ? s1 : s2)));
  const ok = rs.filter((r) => r.status === 200).length;
  assert.deepEqual({ ok, limitadas: rs.filter((r) => r.status === 429).length }, { ok: 10, limitadas: 20 });
});

test('escrituras: límite propio (4 por minuto); los excesos repetidos se auditan una sola vez', opts, async () => {
  await reiniciar();
  const antes = (await b.sql("select count(*)::int as n from auditoria where accion = 'rate_limit_excedido'")).rows[0].n;
  const post = (i) => fetch(s1.url + '/api/solicitudes', { method: 'POST', headers: ADM, body: JSON.stringify({ pool: 'gke-nodos-qa', vpc: `lim-${i}`, mascara: 28 }) });
  const rs = [];
  for (let i = 0; i < 12; i++) rs.push((await post(i)).status);
  assert.deepEqual(rs, [201, 201, 201, 201, 429, 429, 429, 429, 429, 429, 429, 429]);
  const aud = (await b.sql("select usuario, ip, detalle from auditoria where accion = 'rate_limit_excedido' order by id desc")).rows;
  assert.equal(aud.length - antes, 1, 'una sola auditoría por minuto y actor');
  assert.deepEqual({ usuario: aud[0].usuario, tipo: aud[0].detalle.tipo, excesos: aud[0].detalle.excesos_en_el_minuto }, { usuario: 'anonimo', tipo: 'escritura', excesos: 5 });
  assert.equal((await get(s2)).status, 200, 'las lecturas tienen su propio cupo');
});

test('cada token tiene su propio cupo; el límite por IP suma a todos', opts, async () => {
  await reiniciar();
  const crear = async (nombre) => (await (await fetch(s1.url + '/api/tokens', { method: 'POST', headers: ADM, body: JSON.stringify({ nombre, rol: 'lector' }) })).json()).token;
  const [a, c] = [await crear('limite-a'), await crear('limite-c')];
  await reiniciar();
  for (let i = 0; i < 10; i++) assert.equal((await fetch(s1.url + '/api/pools', { headers: bearer(a) })).status, 200);
  assert.equal((await fetch(s1.url + '/api/pools', { headers: bearer(a) })).status, 429, 'el token A agotó el suyo');
  assert.equal((await fetch(s2.url + '/api/pools', { headers: bearer(c) })).status, 200, 'el token C sigue con su cupo completo (aunque sea otra réplica)');
  await b.sql('delete from limite_contador');
  const sIp = await lanzarServicio({ DATABASE_URL: b.url, RATE_LIMIT_POR_MINUTO: '1000', RATE_LIMIT_IP_POR_MINUTO: '6', TRUST_PROXY: '1' });
  try {
    const rs = [];
    for (let i = 0; i < 8; i++) rs.push((await fetch(sIp.url + '/api/pools', { headers: { ...bearer(i % 2 ? a : c), 'X-Forwarded-For': '203.0.113.50' } })).status);
    assert.deepEqual(rs, [200, 200, 200, 200, 200, 200, 429, 429], 'dos tokens detrás de la misma IP comparten el límite por IP');
    const otraIp = await fetch(sIp.url + '/api/pools', { headers: { ...bearer(a), 'X-Forwarded-For': '203.0.113.51' } });
    assert.equal(otraIp.status, 200, 'otra IP no se ve afectada');
    assert.match((await (await fetch(sIp.url + '/api/pools', { headers: { ...bearer(a), 'X-Forwarded-For': '203.0.113.50' } })).json()).mensaje, /desde esta dirección/);
  } finally { await sIp.parar(); }
});

test('fuerza bruta: tras 4 intentos fallidos la IP queda bloqueada (incluso con un token bueno) y se registra', opts, async () => {
  await reiniciar();
  const bueno = (await (await fetch(s1.url + '/api/tokens', { method: 'POST', headers: ADM, body: JSON.stringify({ nombre: 'fb-bueno', rol: 'lector' }) })).json()).token;
  await reiniciar();
  const ip = { 'X-Forwarded-For': '192.0.2.99' };
  const malo = `ipam_${'D'.repeat(43)}`;
  for (let i = 0; i < 4; i++) assert.equal((await fetch(s1.url + '/api/pools', { headers: { ...bearer(malo), ...ip } })).status, 401, `intento ${i + 1}`);
  const bloqueado = await fetch(s2.url + '/api/pools', { headers: { ...bearer(bueno), ...ip } }); // otra réplica: el contador es compartido
  assert.equal(bloqueado.status, 429);
  const c = await bloqueado.json();
  assert.equal(c.error, 'rate_limit');
  assert.match(c.mensaje, /intentos fallidos de autenticación/);
  assert.ok(Number(bloqueado.headers.get('retry-after')) >= 1);
  const otraIp = await fetch(s1.url + '/api/pools', { headers: { ...bearer(bueno), 'X-Forwarded-For': '192.0.2.100' } });
  assert.equal(otraIp.status, 200, 'otra IP con el mismo token funciona');
  // Pasado el minuto (simulado vaciando los contadores) vuelve a entrar.
  await reiniciar();
  assert.equal((await fetch(s1.url + '/api/pools', { headers: { ...bearer(bueno), ...ip } })).status, 200);
  assert.equal((await b.sql("select count(*)::int as n from auditoria where accion = 'token_rechazado'")).rows[0].n >= 4, true);
});
