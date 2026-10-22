const test = require('node:test');
const assert = require('node:assert/strict');
const { crearLogger, redactar, redactarTexto } = require('./logger');

const captura = () => { const l = []; return { salida: { write: (s) => l.push(JSON.parse(s)) }, l }; };

test('una línea JSON por evento con nivel, mensaje y contexto', () => {
  const { salida, l } = captura();
  const log = crearLogger({ salida, base: { servicio: 'ipam' }, contexto: () => ({ request_id: 'r-1', trace_id: 't-1' }) });
  log.info('hola', { ruta: '/api/x', duracion_ms: 3 });
  assert.equal(l.length, 1);
  assert.deepEqual({ nivel: l[0].nivel, mensaje: l[0].mensaje, servicio: l[0].servicio, request_id: l[0].request_id, trace_id: l[0].trace_id, ruta: l[0].ruta }, { nivel: 'info', mensaje: 'hola', servicio: 'ipam', request_id: 'r-1', trace_id: 't-1', ruta: '/api/x' });
  assert.ok(!Number.isNaN(Date.parse(l[0].ts)));
});

test('respeta el nivel mínimo', () => {
  const { salida, l } = captura();
  const log = crearLogger({ nivel: 'warn', salida });
  log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
  assert.deepEqual(l.map((x) => x.mensaje), ['c', 'd']);
});

test('redacta tokens, contraseñas, cadenas de conexión y cabeceras', () => {
  const token = `ipam_${'A'.repeat(43)}`;
  const { salida, l } = captura();
  const log = crearLogger({ salida });
  log.error(`falló con ${token} en postgres://ipam_app:Clave123@db:5432/ipam`, {
    authorization: `Bearer ${token}`, password: 'x', cookie: 'ipam_sesion=abc', anidado: { client_secret: 's', ok: 1 },
    texto: 'DATABASE_URL=postgres://u:p4ss@h/d y Basic YWJjZGVmZ2hpams=', error: new Error(`boom ${token}`),
  });
  const s = JSON.stringify(l[0]);
  for (const prohibido of [token, 'Clave123', 'p4ss', 'YWJjZGVmZ2hpams', 'ipam_sesion=abc']) assert.ok(!s.includes(prohibido), `se coló: ${prohibido}`);
  assert.equal(l[0].authorization, '[REDACTADO]');
  assert.equal(l[0].anidado.ok, 1);
  assert.match(l[0].mensaje, /postgres:\/\/ipam_app:\*\*\*@db/);
});

test('redactar no muta el original y soporta ciclos de profundidad', () => {
  const o = { password: 'x', a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  const r = redactar(o);
  assert.equal(o.password, 'x');
  assert.equal(r.password, '[REDACTADO]');
  assert.ok(JSON.stringify(r).includes('profundidad'));
  assert.equal(redactarTexto('token=abc123'), 'token=[REDACTADO]');
});
