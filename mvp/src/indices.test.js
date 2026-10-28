// Índices de apoyo (db/schema.sql): cada consulta real de la aplicación debe poder resolverse con su índice.
// Se captura el SQL que ejecuta el repositorio (no se copia aquí) y se le pide el plan con los recorridos secuenciales
// desactivados: si alguien cambia la expresión de la consulta y el índice deja de servirle, este plan vuelve a recorrer la tabla.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { hayBase, crearBaseAislada } = require('./pruebas/ayudas');
const { crearRepositorio } = require('./adaptadores/persistencia/postgres/repositorio');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
let b;
let cliente;
const registro = [];

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  cliente = new Client({ connectionString: b.url });
  await cliente.connect();
  // Volumen suficiente para que las estadísticas existan; con los recorridos secuenciales desactivados el plan no depende del tamaño.
  await b.sql(
    "insert into auditoria (usuario, accion, detalle) select 'u', 'asignar', jsonb_build_object('pool', case when g % 50 = 0 then 'gke-nodos-qa' else 'otro-' || (g % 50) end, 'cidr', '10.20.' || (g % 200) || '.0/28') from generate_series(1, 2000) g",
  );
  await b.sql('analyze');
  await cliente.query('set enable_seqscan = off');
});
test.after(async () => {
  await cliente?.end();
  await b?.borrar();
});

const repo = () =>
  crearRepositorio({
    query: (texto, params) => {
      registro.push([texto, params]);
      return cliente.query(texto, params);
    },
  });
const plan = async (texto, params) => {
  const explicar = 'explain ' + texto; // el texto sale del repositorio (no de un cliente) y los valores van como parámetros
  return (await cliente.query(explicar, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
};

const CASOS = [
  ['historial de un pool', (r) => r.listarAuditoria({ pool: 'gke-nodos-qa' }), 'auditoria_pool_idx'],
  ['historial de un segmento', (r) => r.listarAuditoria({ cidr: '10.20.7.0/28' }), 'auditoria_cidr_idx'],
  ['asignaciones de un pool, por fecha', (r) => r.listarAsignaciones({ pool: 'gke-nodos-qa', limit: 25 }), 'asignaciones_pool_id_idx'],
  ['IPs de un pool', (r) => r.listarDirecciones({ pool: 'gke-nodos-qa' }), 'direcciones_ip_pool_ip'],
];
for (const [nombre, ejecutar, indice] of CASOS)
  test(`plan: ${nombre} usa ${indice}`, opts, async () => {
    registro.length = 0;
    await ejecutar(repo());
    // listarAsignaciones ejecuta primero el conteo y después la página: interesa la última consulta con el filtro.
    const sqls = registro.filter(([t]) => /\bfrom\b/i.test(t));
    const textos = await Promise.all(sqls.map(([t, p]) => plan(t, p)));
    assert.ok(
      textos.some((t) => t.includes(indice)),
      `ninguna consulta usó ${indice}:\n${textos.join('\n---\n')}`,
    );
  });

test('plan: borrar una asignación no recorre todas las reservas (clave foránea con índice)', opts, async () => {
  const t = await plan('select 1 from reservas where asignacion_id = $1', [1]);
  assert.match(t, /reservas_asignacion_idx/, t);
});

test('el esquema se puede aplicar dos veces (los índices son idempotentes)', opts, async () => {
  await b.aplicarEsquema();
  const n = (
    await b.sql(
      "select count(*)::int as n from pg_indexes where indexname in ('auditoria_pool_idx','auditoria_cidr_idx','reservas_asignacion_idx','asignaciones_pool_id_idx','direcciones_ip_pool_ip')",
    )
  ).rows[0].n;
  assert.equal(n, 5);
});
