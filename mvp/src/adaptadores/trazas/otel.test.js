const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { crearTrazas, parsearCabeceras } = require('./otel');
const nula = require('./nula');
const { hayBase, crearBaseAislada, lanzarServicio, dormir } = require('../../pruebas/ayudas');

const log = { info() {}, warn() {} };

test('apagadas por defecto: la implementación nula no hace nada', async () => {
  const datos = {};
  const s = nula.iniciarSolicitud({ method: 'GET', headers: {} }, datos);
  s.terminar(200, '/x');
  assert.equal(datos.trace_id, undefined);
  assert.equal(nula.activo, false);
});

test('parsea cabeceras del exportador', () => {
  assert.deepEqual(parsearCabeceras('a=1, b=dos%20tres'), { a: '1', b: 'dos tres' });
  assert.deepEqual(parsearCabeceras(''), {});
});

test('activadas: un span por petición, continúa traceparent y anota trace_id; sin query string ni cabeceras', async () => {
  Object.assign(process.env, { OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://colector:4318', OTEL_TRACES_SAMPLER_ARG: '1' });
  const vistos = [];
  const exportador = { export: (spans, cb) => { vistos.push(...spans); cb({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} };
  const t = crearTrazas({ log, exportador });
  await t.iniciar();
  const datos = {};
  const span = t.iniciarSolicitud({ method: 'GET', headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', authorization: 'Bearer secreto' }, url: '/api/pools?token=secreto' }, datos);
  assert.equal(datos.trace_id, '0af7651916cd43dd8448eb211c80319c');
  span.terminar(500, '/api/pools');
  await t.apagar();
  const [s] = vistos;
  assert.equal(s.name, 'GET /api/pools');
  assert.equal(s.attributes['http.response.status_code'], 500);
  assert.equal(s.status.code, 2);
  assert.ok(!JSON.stringify(s.attributes).includes('secreto'));
  for (const k of ['OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_TRACES_SAMPLER_ARG']) delete process.env[k];
});

test('servicio con OTEL_TRACES_EXPORTER=otlp: exporta a un colector OTLP/HTTP y los logs llevan trace_id', { skip: hayBase ? false : 'sin DATABASE_URL' }, async () => {
  const recibidas = [];
  const colector = http.createServer((req, res) => { let n = 0; req.on('data', (d) => { n += d.length; }); req.on('end', () => { recibidas.push({ url: req.url, bytes: n }); res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end('{}'); }); });
  await new Promise((ok) => colector.listen(0, '127.0.0.1', ok));
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url, OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${colector.address().port}`, OTEL_SERVICE_NAME: 'ipam-prueba' });
  try {
    await fetch(`${s.url}/api/pools`, { headers: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' } });
    const esperar = async (cond, ms = 8000) => { const fin = Date.now() + ms; while (Date.now() < fin && !cond()) await dormir(50); return cond(); };
    assert.ok(await esperar(() => s.logs().some((l) => l.mensaje === 'petición' && l.trace_id === '11111111111111111111111111111111')), 'el log lleva el trace_id');
    await s.parar(); // al apagarse vacía la cola de trazas
    assert.ok(await esperar(() => recibidas.some((r) => r.url === '/v1/traces' && r.bytes > 0)), `el colector no recibió trazas: ${JSON.stringify(recibidas)}`);
  } finally { await s.parar('SIGKILL'); await b.borrar(); colector.close(); }
});
