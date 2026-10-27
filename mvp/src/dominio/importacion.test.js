// Reglas de la importación masiva: ejemplos con datos FICTICIOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analizar, seleccionar } = require('./importacion');

const fila = (n, cidr, extra = {}) => ({ n, cidr, vpc: `red-${n}`, proveedor: 'GCP', ambiente: 'prod', ...extra });
const vacio = { pools: [], ocupados: [] };
const estado = (r, n) => r.filas.find((f) => f.n === n).estado;

test('crea un pool automático por proveedor, ambiente y familia cuando no hay pools', () => {
  const r = analizar({ ...vacio, filas: [fila(2, '10.210.0.0/24'), fila(3, '10.210.1.0/24'), fila(4, '192.168.5.0/24', { proveedor: 'On-prem' })] });
  assert.deepEqual(r.resumen, { ok: 3, ya_existe: 0, solapa_otro_pool: 0, choca_mismo_pool: 0, invalida: 0 });
  assert.deepEqual(r.pools_a_crear.map((p) => [p.id, p.cidr]).sort(), [
    ['imp-gcp-prod-10', '10.0.0.0/8'],
    ['imp-on-prem-prod-192', '192.168.0.0/16'],
  ]);
});

test('usa un pool existente del mismo proveedor y ambiente que contiene al segmento', () => {
  const pools = [{ id: 'dev-nodos', tipo: 'Nodos', ambiente: 'dev', proveedor: 'GCP', cidr: '10.210.0.0/20' }];
  const r = analizar({ pools, ocupados: [], filas: [fila(2, '10.210.1.0/24', { ambiente: 'dev' }), fila(3, '10.230.1.0/24', { ambiente: 'dev' })] });
  assert.equal(r.filas[0].pool, 'dev-nodos');
  assert.equal(r.filas[1].pool, 'imp-gcp-dev-10', 'fuera del pool existente → pool automático');
  assert.deepEqual(
    r.pools_a_crear.map((p) => p.id),
    ['imp-gcp-dev-10'],
  );
});

test('invalida: CIDR mal escrito, desalineado (con sugerencia), máscara demasiado grande, proveedor o ambiente ausentes', () => {
  const r = analizar({
    ...vacio,
    filas: [
      fila(2, 'hola'),
      fila(3, '10.0.0.10/26'),
      fila(4, '10.0.0.0/4'),
      fila(5, '10.1.0.0/24', { proveedor: '' }),
      fila(6, '10.2.0.0/24', { ambiente: 'staging' }),
    ],
  });
  assert.deepEqual(
    r.filas.map((f) => f.estado),
    ['invalida', 'invalida', 'invalida', 'invalida', 'invalida'],
  );
  assert.equal(r.filas[1].sugerido, '10.0.0.0/26');
  assert.match(r.filas[1].detalle, /10\.0\.0\.0\/26/);
});

test('los valores por defecto completan proveedor, ambiente y tipo', () => {
  const r = analizar({ ...vacio, defectos: { proveedor: 'On-prem', ambiente: 'qa', tipo: 'LAN' }, filas: [{ n: 2, cidr: '172.16.5.0/24' }] });
  assert.equal(r.filas[0].estado, 'ok');
  assert.deepEqual([r.filas[0].proveedor, r.filas[0].ambiente, r.filas[0].tipo, r.filas[0].vpc], ['On-prem', 'qa', 'LAN', 'sin-nombre']);
});

test('solapa con un pool distinto → requiere aprobación; con el mismo pool → no importable; repetido → se omite', () => {
  const pools = [
    { id: 'gcp-prod', tipo: 'Importado', ambiente: 'prod', proveedor: 'GCP', cidr: '10.0.0.0/8' },
    { id: 'onprem-prod', tipo: 'Importado', ambiente: 'prod', proveedor: 'On-prem', cidr: '10.0.0.0/8' },
  ];
  const ocupados = [
    { pool_id: 'gcp-prod', cidr: '10.1.0.0/24', vpc: 'a' },
    { pool_id: 'onprem-prod', cidr: '10.2.0.0/24', vpc: 'b' },
  ];
  const r = analizar({
    pools,
    ocupados,
    filas: [
      fila(2, '10.1.0.0/24', { proveedor: 'On-prem' }), // solapa con GCP (otro pool)
      fila(3, '10.2.0.0/25', { proveedor: 'On-prem' }), // dentro de uno del mismo pool
      fila(4, '10.1.0.0/24'), // ya registrado en el mismo pool
      fila(5, '10.9.0.0/24'), // libre
    ],
  });
  assert.deepEqual(
    [2, 3, 4, 5].map((n) => estado(r, n)),
    ['solapa_otro_pool', 'choca_mismo_pool', 'ya_existe', 'ok'],
  );
  assert.equal(r.filas[0].choca_con.pool_id, 'gcp-prod');
});

test('entre filas del mismo archivo: la primera entra y las siguientes que chocan se marcan', () => {
  const r = analizar({ ...vacio, filas: [fila(2, '10.5.0.0/24'), fila(3, '10.5.0.0/24'), fila(4, '10.5.0.0/25', { proveedor: 'On-prem' })] });
  assert.deepEqual(
    [2, 3, 4].map((n) => estado(r, n)),
    ['ok', 'choca_mismo_pool', 'solapa_otro_pool'],
  );
  assert.match(r.filas[1].detalle, /otra fila del archivo/);
});

test('seleccionar: las ok siempre; las que solapan con otro pool solo si un admin las aprobó', () => {
  const filas = [
    { n: 2, estado: 'ok' },
    { n: 3, estado: 'solapa_otro_pool' },
    { n: 4, estado: 'solapa_otro_pool' },
    { n: 5, estado: 'choca_mismo_pool' },
    { n: 6, estado: 'ya_existe' },
    { n: 7, estado: 'invalida' },
  ];
  assert.deepEqual(
    seleccionar(filas, []).map((f) => f.n),
    [2],
  );
  assert.deepEqual(
    seleccionar(filas, [3, 5, 7]).map((f) => f.n),
    [2, 3],
    'aprobar una fila que no es «solapa_otro_pool» no la habilita',
  );
});
