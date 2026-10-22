const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { crearAlmacenMemoria } = require('../adaptadores/limite/memoria');
const { crearLimite, ponderado, segundosDeEspera } = require('./limite');

function entorno({ lectura = 3, escritura = 2, ip = 100, fallos = 3 } = {}) {
  const reloj = { ms: Date.parse('2026-10-21T12:00:00Z'), avanzar(s) { this.ms += s * 1000; } };
  const almacen = crearAlmacenMemoria({ ahoraMs: () => reloj.ms });
  const auditados = [], avisos = [];
  let excedidos = 0;
  const config = { limite: { lecturaPorMinuto: lectura, escrituraPorMinuto: escritura, ipPorMinuto: ip, authFallosPorMinuto: fallos } };
  const limite = crearLimite({ almacen, config, auditor: { registrar: async (r) => { auditados.push(r); } }, log: { warn: (m) => avisos.push(m) }, metricas: { rateLimitExcedido: () => { excedidos++; } } });
  return { reloj, almacen, limite, auditados, avisos, excedidos: () => excedidos };
}
const pegar = (e, n, args) => Promise.all(Array.from({ length: n }, () => e.limite.evaluar(args)));

test('permite hasta el límite exacto y rechaza el resto; el rechazo no consume cupo', async () => {
  const e = entorno({ lectura: 3 });
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await e.limite.evaluar({ actor: 'svc:a', ip: '10.0.0.1', escritura: false }));
  assert.deepEqual(rs.map((r) => r.permitido), [true, true, true, false, false]);
  assert.equal(rs[0].limite, 3);
  assert.deepEqual(rs.slice(0, 3).map((r) => r.restantes), [2, 1, 0]);
  assert.ok(rs[3].retryAfter >= 1 && rs[3].retryAfter <= 60);
  assert.equal(rs[3].motivo, 'actor');
  assert.equal(e.excedidos(), 2);
  // Los rechazados no cuentan: al pasar el minuto vuelve a haber cupo completo (no hay «deuda» por haber insistido).
  e.reloj.advance = undefined;
  e.reloj.avanzar(120);
  assert.equal((await e.limite.evaluar({ actor: 'svc:a', ip: '10.0.0.1', escritura: false })).permitido, true);
});

test('lecturas y escrituras tienen límites separados; cada actor tiene el suyo; la IP suma a todos los actores', async () => {
  const e = entorno({ lectura: 3, escritura: 2, ip: 5 });
  const w = await pegar(e, 3, { actor: 'a', ip: '1.1.1.1', escritura: true });
  assert.deepEqual(w.map((r) => r.permitido).sort(), [false, true, true], 'escritura: 2 por minuto');
  assert.equal((await e.limite.evaluar({ actor: 'a', ip: '1.1.1.1', escritura: false })).permitido, true, 'las lecturas tienen su propio cupo');
  assert.equal((await e.limite.evaluar({ actor: 'b', ip: '2.2.2.2', escritura: true })).permitido, true, 'otro actor, otro cupo');
  // Tres actores detrás de la misma IP agotan el límite por IP (5), aunque ninguno agote el suyo.
  const e2 = entorno({ lectura: 100, ip: 5 });
  const rs = [];
  for (const actor of ['x', 'y', 'z', 'x', 'y', 'z', 'x']) rs.push(await e2.limite.evaluar({ actor, ip: '9.9.9.9', escritura: false }));
  assert.deepEqual(rs.map((r) => r.permitido), [true, true, true, true, true, false, false]);
  assert.equal(rs[5].motivo, 'ip');
});

test('ventana deslizante: lo del minuto anterior pesa según lo que falta del minuto actual', async () => {
  const e = entorno({ lectura: 10 });
  e.reloj.ms = Date.parse('2026-10-21T12:00:00Z');           // inicio exacto de un minuto
  for (let i = 0; i < 10; i++) assert.equal((await e.limite.evaluar({ actor: 'a', ip: 'i', escritura: false })).permitido, true);
  e.reloj.avanzar(60);                                          // minuto siguiente, avance 0: el anterior pesa 100 %
  assert.equal((await e.limite.evaluar({ actor: 'a', ip: 'i', escritura: false })).permitido, false, 'recién cambió el minuto: sigue lleno');
  e.reloj.avanzar(30);                                          // a mitad del minuto el anterior pesa 50 % → caben 5 más
  const medio = await pegar(e, 7, { actor: 'a', ip: 'i', escritura: false });
  assert.equal(medio.filter((r) => r.permitido).length, 5);
  e.reloj.avanzar(31);                                          // un minuto después del último: libre otra vez
  e.reloj.avanzar(60);
  assert.equal((await e.limite.evaluar({ actor: 'a', ip: 'i', escritura: false })).permitido, true);
});

test('Retry-After: acotado entre 1 y 60 s y coherente con lo que falta para que quepa otra petición', () => {
  assert.equal(segundosDeEspera({ actual: 10, previa: 0, avance: 0 }, 10), 60, 'sin historial previo hay que esperar a que acabe el minuto');
  assert.equal(segundosDeEspera({ actual: 10, previa: 0, avance: 0.5 }, 10), 30);
  assert.equal(segundosDeEspera({ actual: 0, previa: 10, avance: 0 }, 10), 6, 'el minuto anterior se «apaga» de a poco');
  assert.equal(ponderado({ actual: 4, previa: 10, avance: 0.5 }), 9);
  fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), fc.double({ min: 0, max: 0.999, noNaN: true }), fc.integer({ min: 1, max: 500 }), (actual, previa, avance, limite) => {
    const s = segundosDeEspera({ actual, previa, avance }, limite);
    return Number.isInteger(s) && s >= 1 && s <= 60;
  }));
});

test('los excesos repetidos se auditan UNA vez por minuto y actor', async () => {
  const e = entorno({ lectura: 1 });
  await e.limite.evaluar({ actor: 'svc:insistente', ip: '5.5.5.5', escritura: false });
  for (let i = 0; i < 12; i++) await e.limite.evaluar({ actor: 'svc:insistente', ip: '5.5.5.5', escritura: false });
  assert.equal(e.auditados.length, 1);
  assert.deepEqual({ accion: e.auditados[0].accion, usuario: e.auditados[0].usuario, ip: e.auditados[0].ip, motivo: e.auditados[0].detalle.motivo }, { accion: 'rate_limit_excedido', usuario: 'svc:insistente', ip: '5.5.5.5', motivo: 'actor' });
  assert.equal(e.auditados[0].detalle.excesos_en_el_minuto, 5);
});

test('freno a la fuerza bruta: tras N fallos la IP queda bloqueada y se libera con el tiempo', async () => {
  const e = entorno({ fallos: 3 });
  assert.deepEqual(await e.limite.bloqueadaPorFallos('7.7.7.7'), { bloqueada: false });
  for (let i = 0; i < 2; i++) await e.limite.registrarFallo('7.7.7.7');
  assert.equal((await e.limite.bloqueadaPorFallos('7.7.7.7')).bloqueada, false);
  await e.limite.registrarFallo('7.7.7.7');
  const b = await e.limite.bloqueadaPorFallos('7.7.7.7');
  assert.equal(b.bloqueada, true);
  assert.ok(b.retryAfter >= 1 && b.retryAfter <= 60);
  assert.equal((await e.limite.bloqueadaPorFallos('8.8.8.8')).bloqueada, false, 'otra IP no se ve afectada');
  e.reloj.avanzar(130);
  assert.equal((await e.limite.bloqueadaPorFallos('7.7.7.7')).bloqueada, false);
});

test('si el almacén falla se deja pasar (con aviso en el log): el límite es una protección, no un requisito de corrección', async () => {
  const log = []; const caido = { incrementar: async () => { throw new Error('bd caída'); }, consultar: async () => { throw new Error('bd caída'); }, devolver: async () => {} };
  const limite = crearLimite({ almacen: caido, config: { limite: { lecturaPorMinuto: 1, escrituraPorMinuto: 1, ipPorMinuto: 1, authFallosPorMinuto: 1 } }, auditor: { registrar: async () => {} }, log: { warn: (m) => log.push(m) } });
  assert.equal((await limite.evaluar({ actor: 'a', ip: 'i', escritura: false })).permitido, true);
  assert.equal((await limite.bloqueadaPorFallos('i')).bloqueada, false);
  await limite.registrarFallo('i');
  assert.equal(log.length, 3);
});
