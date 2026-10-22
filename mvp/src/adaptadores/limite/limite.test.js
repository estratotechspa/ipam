// Contrato del puerto AlmacenLimite: las dos implementaciones (memoria y PostgreSQL) se comportan igual; PostgreSQL además es
// atómico entre réplicas y se purga con el barredor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { crearAlmacenMemoria } = require('./memoria');
const { crearAlmacenPostgres } = require('./postgres');
const { crearRepositorio } = require('../persistencia/postgres/repositorio');
const { hayBase, crearBaseAislada } = require('../../pruebas/ayudas');

const almacenes = { memoria: async () => ({ almacen: crearAlmacenMemoria(), cerrar: async () => {} }) };
if (hayBase) {
  almacenes.postgres = async () => {
    const b = await crearBaseAislada({ semilla: false });
    const pool = new Pool({ connectionString: b.url, max: 10 });
    return {
      almacen: crearAlmacenPostgres(pool),
      pool,
      b,
      cerrar: async () => {
        await pool.end();
        await b.borrar();
      },
    };
  };
}

for (const [nombre, fabrica] of Object.entries(almacenes)) {
  test(`[${nombre}] incrementar suma 1 por clave, estado no suma y devolver resta (sin bajar de 0)`, async () => {
    const { almacen, cerrar } = await fabrica();
    try {
      const [uno, dos] = await almacen.incrementar(['uno', 'dos']);
      assert.deepEqual([uno.actual, dos.actual], [1, 1]);
      const [otraVez] = await almacen.incrementar(['uno']);
      assert.equal(otraVez.actual, 2);
      assert.equal((await almacen.estado('uno')).actual, 2, 'estado no cuenta');
      assert.equal((await almacen.estado('uno')).actual, 2);
      assert.equal((await almacen.estado('nunca-visto')).actual, 0);
      await almacen.devolver(['uno', 'dos']);
      assert.equal((await almacen.estado('uno')).actual, 1);
      await almacen.devolver(['dos', 'dos']);
      assert.equal((await almacen.estado('dos')).actual, 0, 'no baja de cero');
      const [rep] = await almacen.incrementar(['x', 'x', 'x']);
      assert.equal(rep.actual, 1, 'claves repetidas en una misma llamada cuentan una vez');
      const e = await almacen.estado('uno');
      assert.ok(e.avance >= 0 && e.avance < 1 && e.previa === 0);
    } finally {
      await cerrar();
    }
  });
}

test(
  '[postgres] 100 incrementos simultáneos desde DOS «réplicas» (dos pools) suman exactamente 100',
  { skip: hayBase ? false : 'sin DATABASE_URL' },
  async () => {
    const b = await crearBaseAislada({ semilla: false });
    const p1 = new Pool({ connectionString: b.url, max: 10 }),
      p2 = new Pool({ connectionString: b.url, max: 10 });
    try {
      const a1 = crearAlmacenPostgres(p1),
        a2 = crearAlmacenPostgres(p2);
      await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a1 : a2).incrementar(['compartida'])));
      // Si la ráfaga cruza un cambio de minuto (reloj de la base), parte queda en la ventana «previa»: la suma debe seguir siendo 100.
      for (const a of [a1, a2]) {
        const e = await a.estado('compartida');
        assert.equal(e.actual + e.previa, 100);
      }
    } finally {
      await p1.end();
      await p2.end();
      await b.borrar();
    }
  },
);

test(
  '[postgres] el minuto anterior se lee como «previa» y el barredor purga los contadores viejos',
  { skip: hayBase ? false : 'sin DATABASE_URL' },
  async () => {
    const b = await crearBaseAislada({ semilla: false });
    const pool = new Pool({ connectionString: b.url, max: 5 });
    try {
      const almacen = crearAlmacenPostgres(pool);
      const actual = Number((await pool.query('select (extract(epoch from now())::bigint / 60) as v')).rows[0].v);
      await pool.query('insert into limite_contador (clave, ventana, cuenta) values ($1,$2,7), ($1,$3,9), ($1,$4,3)', [
        'k',
        actual - 1,
        actual - 10,
        actual - 4,
      ]);
      const [e] = await almacen.incrementar(['k']);
      assert.deepEqual({ actual: e.actual, previa: e.previa }, { actual: 1, previa: 7 });
      const repo = crearRepositorio(pool);
      const borrados = await repo.transaccion((tx) => tx.purgarLimite());
      assert.equal(borrados, 2, 'se purgan los de hace más de 3 minutos');
      assert.equal((await pool.query('select count(*)::int as n from limite_contador')).rows[0].n, 2, 'quedan el minuto actual y el anterior');
    } finally {
      await pool.end();
      await b.borrar();
    }
  },
);
