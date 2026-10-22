// /metrics (formato Prometheus): protección, nombres esperados, valores reales y consistencia entre réplicas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio, dormir } = require('./pruebas/ayudas');
const { ipEnRedes } = require('./adaptadores/http/rutas/metricas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const TOKEN_METRICAS = 'token-de-metricas-solo-para-pruebas-0123456789';
const NOMBRES = [
  'ipam_http_requests_total',
  'ipam_http_request_duration_seconds',
  'ipam_reservas_activas',
  'ipam_reservas_total',
  'ipam_reservas_expiradas_total',
  'ipam_pool_utilizacion_ratio',
  'ipam_tokens_activos',
  'ipam_tokens_por_vencer',
  'ipam_auth_rechazos_total',
  'ipam_rate_limit_excedido_total',
  'ipam_barredor_ultima_ejecucion_timestamp',
  'ipam_db_up',
];

/** Lee una métrica del texto de Prometheus: devuelve el valor de la línea que coincide con nombre y etiquetas. */
function valor(texto, nombre, etiquetas = {}) {
  for (const l of texto.split('\n')) {
    if (!l.startsWith(nombre) || l.startsWith('#')) continue;
    const m = /^([a-z_:0-9]+)(\{(.*)\})?\s+(\S+)/.exec(l);
    if (!m || m[1] !== nombre) continue;
    const labels = Object.fromEntries([...(m[3] || '').matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (Object.entries(etiquetas).every(([k, v]) => labels[k] === v)) return Number(m[4]);
  }
  return undefined;
}
const metricas = async (s, h = { Authorization: `Bearer ${TOKEN_METRICAS}` }) => (await fetch(`${s.url}/metrics`, { headers: h })).text();

test('ipEnRedes: IPv4 y IPv4 «mapeada»; IPv6 puro y redes malas no pasan', () => {
  assert.equal(ipEnRedes('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipEnRedes('::ffff:10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipEnRedes('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(ipEnRedes('192.168.1.10', ['10.0.0.0/8', '192.168.1.10']), true, 'una IP suelta equivale a /32');
  assert.equal(ipEnRedes('2001:db8::1', ['10.0.0.0/8']), false);
  assert.equal(ipEnRedes(undefined, ['10.0.0.0/8']), false);
});

test('protección: sin METRICS_TOKEN ni redes queda deshabilitado (404); con token exige Bearer; con redes exige la red', opts, async () => {
  const b = await crearBaseAislada();
  const cerrar = [];
  try {
    const libre = await lanzarServicio({ DATABASE_URL: b.url });
    cerrar.push(libre);
    const r0 = await fetch(`${libre.url}/metrics`);
    assert.equal(r0.status, 404, 'sin configurar, deshabilitado');
    assert.equal((await fetch(`${libre.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN_METRICAS}` } })).status, 404);

    const conToken = await lanzarServicio({ DATABASE_URL: b.url, METRICS_TOKEN: TOKEN_METRICAS });
    cerrar.push(conToken);
    assert.equal((await fetch(`${conToken.url}/metrics`)).status, 401);
    const mal = await fetch(`${conToken.url}/metrics`, { headers: { Authorization: 'Bearer otro-token' } });
    assert.equal(mal.status, 401);
    assert.match(mal.headers.get('www-authenticate'), /Bearer/);
    const ok = await fetch(`${conToken.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN_METRICAS}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    // Un token de servicio del IPAM NO sirve para leer métricas (y viceversa).
    const svc = await (
      await fetch(`${conToken.url}/api/tokens`, { method: 'POST', headers: ADM, body: JSON.stringify({ nombre: 'otro-uso', rol: 'agente' }) })
    ).json();
    assert.equal((await fetch(`${conToken.url}/metrics`, { headers: { Authorization: `Bearer ${svc.token}` } })).status, 401);
    assert.equal((await fetch(`${conToken.url}/api/pools`, { headers: { Authorization: `Bearer ${TOKEN_METRICAS}` } })).status, 401);
    assert.ok(!conToken.crudo().includes(TOKEN_METRICAS), 'el token de métricas no sale en los logs');

    const porRed = await lanzarServicio({ DATABASE_URL: b.url, METRICS_ALLOW_CIDRS: '10.0.0.0/8', TRUST_PROXY: '1' });
    cerrar.push(porRed);
    assert.equal((await fetch(`${porRed.url}/metrics`)).status, 403, 'desde 127.0.0.1 no está permitido');
    assert.equal((await fetch(`${porRed.url}/metrics`, { headers: { 'X-Forwarded-For': '10.20.30.40' } })).status, 200, 'una IP de la red permitida sí');
    assert.equal((await fetch(`${porRed.url}/metrics`, { headers: { 'X-Forwarded-For': '11.20.30.40' } })).status, 403);

    const ambos = await lanzarServicio({ DATABASE_URL: b.url, METRICS_ALLOW_CIDRS: '127.0.0.0/8', METRICS_TOKEN: TOKEN_METRICAS });
    cerrar.push(ambos);
    assert.equal((await fetch(`${ambos.url}/metrics`)).status, 401, 'la red coincide pero falta el token');
    assert.equal((await fetch(`${ambos.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN_METRICAS}` } })).status, 200);
  } finally {
    await Promise.all(cerrar.map((s) => s.parar()));
    await b.borrar();
  }
});

test('expone las métricas acordadas, con valores reales y sin explosión de etiquetas ni secretos', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({
    DATABASE_URL: b.url,
    METRICS_TOKEN: TOKEN_METRICAS,
    BARREDOR_INTERVALO_SEGUNDOS: '5',
    RATE_LIMIT_POR_MINUTO: '8',
    RATE_LIMIT_IP_POR_MINUTO: '100000',
  });
  try {
    const t = await (
      await fetch(`${s.url}/api/tokens`, { method: 'POST', headers: ADM, body: JSON.stringify({ nombre: 'metricas-1', rol: 'agente', expira_dias: 3 }) })
    ).json();
    await fetch(`${s.url}/api/tokens`, { method: 'POST', headers: ADM, body: JSON.stringify({ nombre: 'metricas-2', rol: 'lector', expira_dias: 60 }) });
    const r = await (
      await fetch(`${s.url}/api/reservas`, {
        method: 'POST',
        headers: ADM,
        body: JSON.stringify({ ambiente: 'qa', tipo: 'Nodos', mascara: 22, vpc: 'metricas' }),
      })
    ).json();
    await fetch(`${s.url}/api/reservas/${r.id}`, { headers: ADM });
    await fetch(`${s.url}/api/pools`, { headers: { Authorization: `Bearer ipam_${'M'.repeat(43)}` } }); // token inválido → rechazo

    const txt = await metricas(s);
    for (const n of NOMBRES) assert.ok(txt.includes(`# TYPE ${n} `), `falta la métrica ${n}`);
    assert.equal(valor(txt, 'ipam_db_up'), 1);
    assert.equal(valor(txt, 'ipam_reservas_activas'), 1);
    assert.deepEqual(
      ['reservada', 'confirmada', 'liberada', 'expirada'].map((e) => valor(txt, 'ipam_reservas_total', { estado: e })),
      [1, 0, 0, 0],
    );
    assert.equal(valor(txt, 'ipam_tokens_activos'), 2);
    assert.equal(valor(txt, 'ipam_tokens_por_vencer'), 1, 'solo el token que vence en 3 días');
    const util = valor(txt, 'ipam_pool_utilizacion_ratio', { pool: 'gke-nodos-qa' });
    assert.ok(util > 0 && util < 1, `utilización fuera de rango: ${util}`);
    assert.ok(Math.abs(util - (4096 + 1024) / 65536) < 1e-9, 'asignación de la semilla (/20 = 4096) + reserva /22 (1024) sobre un /16 (65536)');
    assert.equal(valor(txt, 'ipam_auth_rechazos_total', { motivo: 'token_desconocido' }), 1);
    assert.ok(valor(txt, 'ipam_http_requests_total', { ruta: '/api/reservas', metodo: 'POST', codigo: '201' }) >= 1);
    assert.ok(valor(txt, 'ipam_http_request_duration_seconds_count', { ruta: '/api/reservas', metodo: 'POST' }) >= 1);
    assert.ok(valor(txt, 'ipam_http_request_duration_seconds_bucket', { ruta: '/api/reservas', metodo: 'POST', le: '+Inf' }) >= 1);
    // Las rutas salen como PLANTILLA (sin el id de la reserva): cardinalidad acotada y sin filtrar identificadores.
    assert.ok(valor(txt, 'ipam_http_requests_total', { ruta: '/api/reservas/:id', metodo: 'GET', codigo: '200' }) >= 1);
    assert.ok(!txt.includes(r.id), 'ningún id de reserva en las etiquetas');
    assert.ok(!txt.includes(t.token) && !txt.includes(TOKEN_METRICAS) && !/\bipam_[A-Za-z0-9_-]{43}\b/.test(txt), 'ningún secreto en las métricas');

    // Límite excedido: 8 lecturas por minuto → el contador sube.
    for (let i = 0; i < 12; i++) await fetch(`${s.url}/api/pools`, { headers: ADM });
    assert.ok(valor(await metricas(s), 'ipam_rate_limit_excedido_total') >= 1);

    // Barredor y expiración: tras vencer una reserva, el barredor la marca y los contadores lo reflejan.
    await b.sql("update reservas set expira_en = now() - interval '1 second' where id = $1", [r.id]);
    const fin = Date.now() + 20000;
    let ultima = 0,
      expiradas = 0,
      porEstado;
    while (Date.now() < fin) {
      await dormir(1500);
      const x = await metricas(s);
      ultima = valor(x, 'ipam_barredor_ultima_ejecucion_timestamp');
      expiradas = valor(x, 'ipam_reservas_expiradas_total');
      porEstado = valor(x, 'ipam_reservas_total', { estado: 'expirada' });
      if (expiradas >= 1 && ultima > 0) break;
    }
    assert.ok(ultima > Date.now() / 1000 - 60, 'el barredor corrió hace poco');
    assert.equal(expiradas, 1, 'una reserva expirada');
    assert.equal(porEstado, 1);
    assert.equal(valor(await metricas(s), 'ipam_reservas_activas'), 0);
  } finally {
    await s.parar();
    await b.borrar();
  }
});

test('los medidores salen de la base: dos réplicas ven lo mismo; y con la base caída /metrics sigue respondiendo con ipam_db_up 0', opts, async () => {
  const b = await crearBaseAislada();
  const env = { DATABASE_URL: b.url, METRICS_TOKEN: TOKEN_METRICAS };
  const [s1, s2] = await Promise.all([lanzarServicio(env), lanzarServicio(env)]);
  let caida;
  try {
    await fetch(`${s1.url}/api/reservas`, { method: 'POST', headers: ADM, body: JSON.stringify({ ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'm2' }) });
    const [a, c] = [await metricas(s1), await metricas(s2)];
    assert.equal(valor(a, 'ipam_reservas_activas'), 1);
    assert.equal(valor(c, 'ipam_reservas_activas'), 1, 'la otra réplica ve la misma reserva');
    assert.equal(valor(c, 'ipam_http_requests_total', { ruta: '/api/reservas', metodo: 'POST', codigo: '201' }), undefined, 'los contadores son por réplica');
    caida = await lanzarServicio({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', DB_CONNECT_TIMEOUT_MS: '300', METRICS_TOKEN: TOKEN_METRICAS });
    const r = await fetch(`${caida.url}/metrics`, { headers: { Authorization: `Bearer ${TOKEN_METRICAS}` } });
    assert.equal(r.status, 200);
    assert.equal(valor(await r.text(), 'ipam_db_up'), 0);
  } finally {
    await Promise.all([s1.parar(), s2.parar(), caida && caida.parar()]);
    await b.borrar();
  }
});

test('ROL=worker también expone /metrics', opts, async () => {
  const b = await crearBaseAislada();
  const w = await lanzarServicio({ DATABASE_URL: b.url, ROL: 'worker', METRICS_TOKEN: TOKEN_METRICAS });
  try {
    const txt = await metricas(w);
    assert.equal(valor(txt, 'ipam_db_up'), 1);
    assert.equal((await fetch(`${w.url}/api/pools`)).status, 404);
  } finally {
    await w.parar();
    await b.borrar();
  }
});
