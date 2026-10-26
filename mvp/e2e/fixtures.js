// Datos de prueba propios de cada archivo e2e, con ids únicos: se crean por SQL (DATABASE_URL, la misma base de la app)
// y se borran al terminar, para no depender de la semilla ni dejar residuos.
const { Pool } = require('pg');

const conectar = () => new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

// asignaciones: [{cidr, vpc, ticket?}]
async function crearPool(db, { id, cidr, ambiente = 'dev', tipo = 'Nodos', proveedor = 'GCP', asignaciones = [] }) {
  await db.query('insert into pools (id,tipo,ambiente,proveedor,cidr) values ($1,$2,$3,$4,$5) on conflict (id) do nothing', [id, tipo, ambiente, proveedor, cidr]);
  for (const [i, a] of asignaciones.entries()) {
    await db.query(
      "insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen) values ($1,$2,$3,'e2e',$4,'panel')",
      [id, a.cidr, a.vpc, a.ticket || `E2E-${id}-${i}`]);
  }
}
async function borrarPools(db, ids) {
  await db.query('delete from asignaciones where pool_id = any($1)', [ids]);
  await db.query('delete from pools where id = any($1)', [ids]);
}

module.exports = { conectar, crearPool, borrarPools };
