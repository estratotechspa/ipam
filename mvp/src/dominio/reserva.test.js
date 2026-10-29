const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const R = require('./reserva');

const ahora = new Date('2026-10-21T12:00:00Z');
const en = (horas) => new Date(ahora.getTime() + horas * 3600_000);

test('estado efectivo: una reservada vencida cuenta como expirada, sin importar el barredor', () => {
  assert.equal(R.estadoEfectivo({ estado: 'reservada', expira_en: en(1) }, ahora), 'reservada');
  assert.equal(R.estadoEfectivo({ estado: 'reservada', expira_en: en(0) }, ahora), 'expirada', 'vence justo en este instante');
  assert.equal(R.estadoEfectivo({ estado: 'reservada', expira_en: en(-5) }, ahora), 'expirada');
  for (const e of ['confirmada', 'liberada', 'expirada']) assert.equal(R.estadoEfectivo({ estado: e, expira_en: en(-99) }, ahora), e);
});

test('TTL: por defecto, dentro del máximo; se rechaza (no se recorta) lo que lo supera', () => {
  const lim = { defecto: 24, max: 72 };
  assert.deepEqual(R.validarTtl(undefined, lim), { ok: true, horas: 24 });
  assert.deepEqual(R.validarTtl(72, lim), { ok: true, horas: 72 });
  assert.equal(R.validarTtl(73, lim).error, 'ttl_excede_maximo');
  for (const malo of [0, -1, 1.5, 'abc', NaN]) assert.equal(R.validarTtl(malo, lim).ok, false, String(malo));
  assert.deepEqual(R.validarTtl('48', lim), { ok: true, horas: 48 });
});

test('propiedad: un TTL válido siempre queda entre 1 y el máximo', () => {
  fc.assert(
    fc.property(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 1, max: 720 }), (n, max) => {
      const r = R.validarTtl(n, { defecto: 1, max });
      return r.ok ? r.horas >= 1 && r.horas <= max : n < 1 || n > max;
    }),
  );
});

test('idempotencia: reserva viva se repite; liberada o expirada se rechaza (nunca 200)', () => {
  assert.equal(R.decidirIdempotencia('reservada'), 'repetir');
  assert.equal(R.decidirIdempotencia('confirmada'), 'repetir');
  assert.equal(R.decidirIdempotencia('liberada'), 'rechazar');
  assert.equal(R.decidirIdempotencia('expirada'), 'rechazar');
});

test('misma petición: solo compara lo que el agente indicó', () => {
  const ex = { pool_id: 'p1', cidr: '10.0.0.0/24', vpc: 'v' };
  assert.equal(R.mismaPeticion(ex, { vpc: 'v' }), true);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', pool: 'p1', cidr: '10.0.0.0/24' }), true);
  assert.equal(R.mismaPeticion(ex, { vpc: 'otra' }), false);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', pool: 'p2' }), false);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', cidr: '10.0.1.0/24' }), false);
});

test('misma petición: el tamaño pedido por máscara, la VLAN y el ticket también cuentan', () => {
  const ex = { pool_id: 'p1', cidr: '10.0.0.0/26', vpc: 'v', vlan: 10, vlan_nombre: 'Datos', ticket: 'NET-1' };
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', mascara: 26 }), true);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', mascara: 27 }), false);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', mascara: 26, vlan: 10, vlan_nombre: 'Datos', ticket: 'NET-1' }), true);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', vlan: 11 }), false);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', vlan_nombre: 'Otra' }), false);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', ticket: 'NET-2' }), false);
  assert.equal(R.mismaPeticion(ex, { vpc: 'v', vlan: null, vlan_nombre: null, ticket: null }), true); // lo que no indicó no cuenta
});

test('máquina de estados: confirmar y liberar son idempotentes y coherentes', () => {
  assert.deepEqual(R.decidirConfirmacion('reservada'), { accion: 'confirmar' });
  assert.deepEqual(R.decidirConfirmacion('confirmada'), { accion: 'repetida' });
  assert.deepEqual(R.decidirConfirmacion('liberada'), { accion: 'rechazar', estado: 'liberada' });
  assert.deepEqual(R.decidirConfirmacion('expirada'), { accion: 'rechazar', estado: 'expirada' });
  assert.deepEqual(R.decidirLiberacion('reservada'), { accion: 'liberar' });
  assert.deepEqual(R.decidirLiberacion('confirmada'), { accion: 'borrar_asignacion' });
  assert.deepEqual(R.decidirLiberacion('liberada'), { accion: 'repetida' });
  assert.deepEqual(R.decidirLiberacion('expirada'), { accion: 'repetida' });
});

test('solo el dueño o un admin opera sobre una reserva', () => {
  assert.equal(R.puedeOperar({ nombre: 'svc:a', rol: 'agente' }, { solicitante: 'svc:a' }), true);
  assert.equal(R.puedeOperar({ nombre: 'svc:b', rol: 'agente' }, { solicitante: 'svc:a' }), false);
  assert.equal(R.puedeOperar({ nombre: 'jefe@x.cl', rol: 'admin' }, { solicitante: 'svc:a' }), true);
  assert.equal(R.puedeOperar({ nombre: 'ana@x.cl', rol: 'solicitante' }, { solicitante: 'svc:a' }), false);
});

test('pool por ambiente y tipo: único, ninguno o ambiguo con opciones', () => {
  assert.deepEqual(R.resolverPool([{ id: 'a' }]), { tipo: 'unico', pool: { id: 'a' } });
  assert.deepEqual(R.resolverPool([]), { tipo: 'ninguno' });
  assert.deepEqual(R.resolverPool([{ id: 'a' }, { id: 'b' }]), { tipo: 'ambiguo', opciones: [{ id: 'a' }, { id: 'b' }] });
});

test('validaciones de clave, ticket y aprobación humana', () => {
  assert.deepEqual(R.validarClaveIdem(undefined), { ok: true, clave: null });
  assert.equal(R.validarClaveIdem('mr-1234:job_9').ok, true);
  for (const m of ['', ' x', 'a b', 'x'.repeat(129), 'a;b']) if (m !== '') assert.equal(R.validarClaveIdem(m).ok, false, m);
  assert.equal(R.validarTicket('NET-123').ticket, 'NET-123');
  assert.equal(R.validarTicket('x y').ok, false);
  assert.equal(R.validarAprobacion({}, true).error, 'falta_aprobacion');
  assert.equal(R.validarAprobacion({ aprobado_por: 'ana' }, true).error, 'falta_aprobacion');
  assert.deepEqual(R.validarAprobacion({ aprobado_por: 'ana', referencia: 'https://gitlab.example/mr/1' }, true), {
    ok: true,
    aprobadoPor: 'ana',
    referencia: 'https://gitlab.example/mr/1',
  });
  assert.equal(R.validarAprobacion({}, false).ok, true, 'una persona desde la interfaz no necesita declararlo');
  assert.equal(R.validarAprobacion({ referencia: 'x'.repeat(301) }, false).ok, false);
});
