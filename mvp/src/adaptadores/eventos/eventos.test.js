const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { esDireccionBloqueada, validarDestino } = require('./ssrf');
const { crearWebhook, firmar } = require('./webhook');
const { crearPublicador } = require('./index');

test('SSRF: bloquea direcciones privadas, de loopback, de enlace local y de metadatos de nube', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.5.5', '172.31.255.255', '192.168.0.10', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'no-es-ip']) {
    assert.equal(esDireccionBloqueada(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '172.32.0.1', '::ffff:8.8.8.8']) assert.equal(esDireccionBloqueada(ip), false, ip);
});

test('SSRF: validarDestino rechaza esquemas raros, credenciales, localhost y metadatos; la lista permitida los habilita', () => {
  for (const u of ['ftp://x.example/a', 'file:///etc/passwd', 'https://u:p@x.example/', 'http://localhost/x', 'http://127.0.0.1:8080/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/computeMetadata/v1/', 'no es url']) {
    assert.throws(() => validarDestino(u, []), undefined, u);
  }
  assert.doesNotThrow(() => validarDestino('https://eventos.example/ipam', []));
  assert.doesNotThrow(() => validarDestino('http://127.0.0.1:9000/x', ['127.0.0.1']));
  assert.doesNotThrow(() => validarDestino('http://localhost/x', ['localhost']));
});

/** Servidor receptor: cuenta peticiones y responde según el guion. */
function receptor(guion) {
  const recibidas = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => {
      recibidas.push({ cabeceras: req.headers, cuerpo, url: req.url });
      const paso = guion[Math.min(recibidas.length - 1, guion.length - 1)];
      if (paso.demora) return setTimeout(() => { res.statusCode = 200; res.end(); }, paso.demora);
      res.statusCode = paso.estado;
      if (paso.ubicacion) res.setHeader('Location', paso.ubicacion);
      res.end('ok');
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, recibidas, url: `http://127.0.0.1:${srv.address().port}/hook`, cerrar: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) })));
}
const logFalso = () => { const l = []; return { warn: (m, c) => l.push({ m, c }), info() {}, l }; };
const cfg = (url, extra = {}) => ({ url, secreto: 'clave-de-prueba', permitirHosts: ['127.0.0.1'], timeoutMs: 400, reintentos: 3, ...extra });
const sinEspera = { espera: async () => {} };

test('webhook: entrega firmada con HMAC (timestamp + cuerpo) que el receptor puede verificar', async () => {
  const r = await receptor([{ estado: 200 }]);
  const wh = crearWebhook(cfg(r.url), logFalso(), sinEspera);
  assert.equal(await wh.entregar('reserva_creada', { cidr: '10.210.0.0/24' }), true);
  const { cabeceras, cuerpo } = r.recibidas[0];
  assert.equal(cabeceras['x-ipam-event'], 'reserva_creada');
  const esperada = `sha256=${crypto.createHmac('sha256', 'clave-de-prueba').update(`${cabeceras['x-ipam-timestamp']}.${cuerpo}`).digest('hex')}`;
  assert.equal(cabeceras['x-ipam-signature'], esperada);
  assert.equal(JSON.parse(cuerpo).detalle.cidr, '10.210.0.0/24');
  assert.equal(firmar('a', '1', 'x'), firmar('a', '1', 'x'));
  await r.cerrar();
});

test('webhook: reintenta ante 5xx (acotado) pero no ante 4xx; no sigue redirecciones', async () => {
  let r = await receptor([{ estado: 503 }, { estado: 503 }, { estado: 200 }]);
  assert.equal(await crearWebhook(cfg(r.url), logFalso(), sinEspera).entregar('x', {}), true);
  assert.equal(r.recibidas.length, 3);
  await r.cerrar();

  r = await receptor([{ estado: 500 }]);
  const log = logFalso();
  assert.equal(await crearWebhook(cfg(r.url, { reintentos: 2 }), log, sinEspera).entregar('x', {}), false);
  assert.equal(r.recibidas.length, 2, 'se detiene en el máximo de reintentos');
  assert.equal(log.l.length, 1);
  await r.cerrar();

  r = await receptor([{ estado: 400 }]);
  assert.equal(await crearWebhook(cfg(r.url), logFalso(), sinEspera).entregar('x', {}), false);
  assert.equal(r.recibidas.length, 1, 'un 4xx no se reintenta');
  await r.cerrar();

  r = await receptor([{ estado: 302, ubicacion: 'http://169.254.169.254/latest/meta-data' }]);
  assert.equal(await crearWebhook(cfg(r.url), logFalso(), sinEspera).entregar('x', {}), false);
  assert.equal(r.recibidas.length, 1, 'la redirección no se sigue');
  await r.cerrar();
});

test('webhook: tiempo de espera agotado se trata como fallo transitorio', async () => {
  const r = await receptor([{ demora: 1500 }]);
  assert.equal(await crearWebhook(cfg(r.url, { timeoutMs: 100, reintentos: 2 }), logFalso(), sinEspera).entregar('x', {}), false);
  assert.equal(r.recibidas.length, 2);
  await r.cerrar();
});

test('webhook: un destino privado que NO está en la lista permitida ni siquiera se contacta', async () => {
  const r = await receptor([{ estado: 200 }]);
  const log = logFalso();
  const ok = await crearWebhook(cfg(r.url, { permitirHosts: [] }), log, sinEspera).entregar('x', {});
  assert.equal(ok, false);
  assert.equal(r.recibidas.length, 0);
  assert.match(log.l[0].c.motivo, /bloqueado/i);
  assert.ok(!JSON.stringify(log.l).includes('clave-de-prueba'), 'el secreto no aparece en los logs');
  await r.cerrar();
});

test('SSRF: un nombre que resuelve a una IP privada se bloquea al conectar (anti DNS rebinding)', async () => {
  const dns = require('node:dns');
  const { lookupSeguro } = require('./ssrf');
  const original = dns.lookup;
  const respuestas = { 'rebind.example': [{ address: '10.0.0.5', family: 4 }], 'mixto.example': [{ address: '169.254.169.254', family: 4 }, { address: '93.184.216.34', family: 4 }] };
  dns.lookup = (host, _o, cb) => cb(null, respuestas[host]);
  try {
    const resolver = (host, permitidos = [], opciones = { all: false }) => new Promise((ok) => lookupSeguro(permitidos)(host, opciones, (err, dir, fam) => ok({ err, dir, fam })));
    assert.match((await resolver('rebind.example')).err.message, /bloqueado/i);
    assert.equal((await resolver('rebind.example', ['rebind.example'])).dir, '10.0.0.5', 'la lista permitida lo habilita');
    const m = await resolver('mixto.example');
    assert.equal(m.dir, '93.184.216.34', 'descarta la dirección de metadatos y usa solo la pública');
    const todas = await resolver('mixto.example', [], { all: true });
    assert.deepEqual(todas.dir.map((d) => d.address), ['93.184.216.34']);
  } finally { dns.lookup = original; }
});

test('publicador: un adaptador que falla no afecta a los demás ni a la operación', async () => {
  const llamadas = [];
  const repo = { registrarEvento: async (t) => { llamadas.push(['tabla', t]); throw new Error('bd caída'); } };
  const log = { info: (m, c) => llamadas.push(['log', c.evento]), warn: (m) => llamadas.push(['warn', m]) };
  const p = crearPublicador({ repo, log, cfg: { publicadores: ['log'], webhook: {} } });
  await assert.doesNotReject(p.publicar('asignacion', { a: 1 }));
  assert.deepEqual(llamadas.map((x) => x[0]).sort(), ['log', 'tabla', 'warn']);
});

test('webhook: la cola es acotada y publicar() vuelve de inmediato', async () => {
  const r = await receptor([{ demora: 300 }]);
  const wh = crearWebhook(cfg(r.url, { timeoutMs: 1000 }), logFalso(), sinEspera);
  const t0 = Date.now();
  await wh.publicar('x', {});
  assert.ok(Date.now() - t0 < 100, 'no espera la respuesta del destino');
  assert.equal(wh.pendientes(), 1);
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(wh.pendientes(), 0);
  await r.cerrar();
});
