// Invariante central del IPAM: NUNCA se solapan dos rangos (asignaciones + reservas vigentes de un mismo pool),
// sin importar en qué orden se reserve, confirme, libere, asigne o pase el tiempo. Se prueba con secuencias aleatorias (fast-check)
// sobre los casos de uso reales y el repositorio en memoria.
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { crearRepositorioMemoria } = require('../adaptadores/persistencia/memoria/repositorio');
const { crearReservas } = require('./reservas');
const { crearAsignaciones } = require('./asignaciones');
const { parse, overlap } = require('../dominio/cidr');

const POOLS = [
  { id: 'a', tipo: 'Nodos', ambiente: 'dev', proveedor: 'GCP', cidr: '10.210.0.0/24' },
  { id: 'b', tipo: 'Nodos', ambiente: 'qa', proveedor: 'GCP', cidr: '10.220.0.0/24' },
];
const ACTORES = [
  { nombre: 'svc:uno', rol: 'agente', tipo: 'token' },
  { nombre: 'svc:dos', rol: 'agente', tipo: 'token', cuota: 3 },
  { nombre: 'jefe@empresa.example', rol: 'admin', tipo: 'oidc' },
];
const APROBACION = { aprobado_por: 'ana', referencia: 'mr' };

function entorno() {
  const reloj = {
    t: new Date('2026-10-21T12:00:00Z'),
    ahora() {
      return this.t;
    },
  };
  const repo = crearRepositorioMemoria({ reloj, pools: POOLS });
  const eventos = { publicar: async () => {} };
  const config = { reservas: { ttlHoras: 24, ttlMaxHoras: 72, exigeAprobador: true }, limite: { cuotaReservasPorToken: 5 } };
  return {
    reloj,
    repo,
    reservas: crearReservas({ repo, eventos, config }),
    asignaciones: crearAsignaciones({ repo, eventos, tickets: { activo: () => false, faltantes: () => [] } }),
  };
}

/** Todos los rangos que «cuentan» ahora, por pool. */
async function ocupados(e) {
  const out = new Map();
  for (const p of POOLS) out.set(p.id, await e.repo.ocupados(p.id));
  return out;
}
async function sinSolapes(e) {
  for (const [pool, lista] of await ocupados(e)) {
    const c = lista.map(parse);
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) if (overlap(c[i], c[j])) return `${pool}: ${lista[i]} se solapa con ${lista[j]}`;
  }
  return null;
}

const operacion = fc.oneof(
  fc.record({
    t: fc.constant('reservar'),
    actor: fc.nat(2),
    pool: fc.constantFrom('a', 'b'),
    mascara: fc.integer({ min: 25, max: 30 }),
    ttl: fc.integer({ min: 1, max: 72 }),
    clave: fc.option(fc.constantFrom('k1', 'k2', 'k3'), { nil: undefined }),
  }),
  fc.record({
    t: fc.constant('reservar-cidr'),
    actor: fc.nat(2),
    pool: fc.constantFrom('a', 'b'),
    mascara: fc.integer({ min: 26, max: 30 }),
    indice: fc.nat(63),
  }),
  fc.record({ t: fc.constant('confirmar'), actor: fc.nat(2), cual: fc.nat(40) }),
  fc.record({ t: fc.constant('liberar'), actor: fc.nat(2), cual: fc.nat(40) }),
  fc.record({ t: fc.constant('asignar'), pool: fc.constantFrom('a', 'b'), mascara: fc.integer({ min: 26, max: 30 }) }),
  fc.record({ t: fc.constant('tiempo'), horas: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ t: fc.constant('liberar-asignacion'), cual: fc.nat(40) }),
);

async function aplicar(e, op, creadas) {
  const actor = ACTORES[op.actor % ACTORES.length];
  switch (op.t) {
    case 'reservar': {
      const r = await e.reservas.reservar(actor, { pool: op.pool, mascara: op.mascara, vpc: 'v', ttl_horas: op.ttl }, op.clave);
      if (r.ok && !r.repetida) creadas.push(r.reserva.id);
      return;
    }
    case 'reservar-cidr': {
      const base = op.pool === 'a' ? 0xd2000000 : 0xdc000000; // 10.210.0.0 / 10.220.0.0 (reales calculados abajo)
      const tam = 2 ** (32 - op.mascara);
      const ip = (op.pool === 'a' ? 168230912 : 169279488) + ((op.indice * tam) % 256);
      void base;
      const cidr = `${[ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.')}/${op.mascara}`;
      const r = await e.reservas.reservar(actor, { pool: op.pool, cidr, vpc: 'v' });
      if (r.ok && !r.repetida) creadas.push(r.reserva.id);
      return;
    }
    case 'confirmar':
      if (creadas.length) await e.reservas.confirmar(actor, creadas[op.cual % creadas.length], APROBACION);
      return;
    case 'liberar':
      if (creadas.length) await e.reservas.liberar(actor, creadas[op.cual % creadas.length]);
      return;
    case 'asignar':
      await e.asignaciones.asignar({ pool: op.pool, vpc: 'panel', mascara: op.mascara, solicitante: 'ana', origen: 'panel' });
      return;
    case 'liberar-asignacion': {
      const a = e.repo.datos.asignaciones[op.cual % Math.max(1, e.repo.datos.asignaciones.length)];
      if (a) await e.asignaciones.liberar(a.id);
      return;
    }
    default:
      e.reloj.t = new Date(e.reloj.t.getTime() + op.horas * 3600_000);
  }
}

test('invariante: tras CUALQUIER secuencia de operaciones no hay dos rangos solapados (asignaciones + reservas vigentes)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(operacion, { minLength: 1, maxLength: 60 }), async (ops) => {
      const e = entorno();
      const creadas = [];
      for (const op of ops) {
        await aplicar(e, op, creadas);
        const malo = await sinSolapes(e);
        assert.equal(malo, null, `se solaparon rangos tras ${JSON.stringify(op)}: ${malo}`);
      }
      // Y cada rango ocupado cae dentro de su pool.
      for (const a of e.repo.datos.asignaciones) assert.ok(parse(a.cidr).start >= parse(POOLS.find((p) => p.id === a.pool_id).cidr).start);
    }),
    { numRuns: 300 },
  );
});

test('propiedad: una asignación confirmada desde una reserva conserva exactamente el rango reservado (y liberar la reserva lo devuelve)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 25, max: 30 }), async (mascara) => {
      const e = entorno();
      const r = await e.reservas.reservar(ACTORES[0], { pool: 'a', mascara, vpc: 'v' });
      const c = await e.reservas.confirmar(ACTORES[0], r.reserva.id, APROBACION);
      assert.equal(c.asignacion.cidr, r.reserva.cidr);
      const l = await e.reservas.liberar(ACTORES[0], r.reserva.id);
      assert.equal(l.asignacionBorrada, true);
      const otra = await e.reservas.reservar(ACTORES[1], { pool: 'a', mascara, vpc: 'v' });
      assert.equal(otra.reserva.cidr, r.reserva.cidr, 'el rango liberado vuelve a estar disponible');
    }),
    { numRuns: 30 },
  );
});
