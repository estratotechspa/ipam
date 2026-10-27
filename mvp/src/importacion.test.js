// Importación masiva de segmentos (Excel/CSV) contra PostgreSQL real, por HTTP. Datos FICTICIOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
let b, s;
const post = async (ruta, cuerpo) => {
  const r = await fetch(s.url + ruta, { method: 'POST', headers: H, body: JSON.stringify(cuerpo) });
  return { estado: r.status, cuerpo: await r.json() };
};
const csv = (texto) => ({ formato: 'csv', contenido_base64: Buffer.from(texto).toString('base64') });
async function xlsx(filas) {
  const wb = new ExcelJS.Workbook();
  const h = wb.addWorksheet('Segmentos');
  for (const f of filas) h.addRow(f);
  return { formato: 'xlsx', contenido_base64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
}

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada(); // con los datos de ejemplo históricos
  s = await lanzarServicio({ DATABASE_URL: b.url });
});
test.after(async () => {
  if (!hayBase) return;
  await s.parar();
  await b.borrar();
});

test('simular lee un CSV, reconoce encabezados en español y NO escribe nada', opts, async () => {
  const antes = (await b.sql('select count(*)::int as n from asignaciones')).rows[0].n;
  const r = await post(
    '/api/v1/importaciones/simular',
    csv(
      'Segmento;Proyecto;Proveedor;Ambiente;Ticket\n10.201.0.0/24;vpc-a;GCP;prod;T-1\n10.201.1.0/24;vpc-b;GCP;prod;T-2\n10.201.1.0/25;vpc-c;GCP;prod;T-3\nhola;vpc-d;GCP;prod;\n',
    ),
  );
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo.resumen, { ok: 2, ya_existe: 0, solapa_otro_pool: 0, choca_mismo_pool: 1, invalida: 1 });
  assert.deepEqual(
    r.cuerpo.pools_a_crear.map((p) => p.id),
    ['imp-gcp-prod-10'],
  );
  assert.equal(r.cuerpo.columnas.cidr, 'Segmento');
  assert.equal(r.cuerpo.filas[0].n, 2, 'el número de fila es el del archivo (con encabezado en la 1)');
  assert.equal((await b.sql('select count(*)::int as n from asignaciones')).rows[0].n, antes, 'simular no escribe');
  assert.equal((await b.sql("select count(*)::int as n from pools where id like 'imp-%'")).rows[0].n, 0);
});

test('aplicar un Excel: crea el pool automático, importa lo válido con origen «importado», es idempotente y queda auditado', opts, async () => {
  const archivo = await xlsx([
    ['CIDR', 'VPC', 'Proveedor', 'Ambiente', 'Tipo'],
    ['10.202.0.0/24', 'oficina-a', 'On-prem', 'prod', 'LAN'],
    ['10.202.1.0/26', 'oficina-b', 'On-prem', 'prod', 'LAN'],
    ['10.202.0.128/25', 'duplicado', 'On-prem', 'prod', 'LAN'], // choca con la fila 2 (mismo pool): no importable
  ]);
  const r = await post('/api/v1/importaciones/aplicar', { ...archivo, nombre: 'oficinas.xlsx' });
  assert.equal(r.estado, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.importadas, r.cuerpo.pools_creados, r.cuerpo.no_importables], [2, 1, 1]);
  const filas = (await b.sql("select cidr::text, vpc, origen, pool_id, solicitante from asignaciones where vpc like 'oficina-%' order by cidr")).rows;
  assert.deepEqual(
    filas.map((f) => [f.cidr, f.origen, f.pool_id]),
    [
      ['10.202.0.0/24', 'importado', 'imp-on-prem-prod-10'],
      ['10.202.1.0/26', 'importado', 'imp-on-prem-prod-10'],
    ],
  );
  const pool = (await b.sql("select cidr::text, proveedor, tipo from pools where id='imp-on-prem-prod-10'")).rows[0];
  assert.deepEqual([pool.cidr, pool.proveedor], ['10.0.0.0/8', 'On-prem']);
  // Importar otra vez lo mismo no duplica.
  const otra = await post('/api/v1/importaciones/aplicar', archivo);
  assert.deepEqual([otra.cuerpo.importadas, otra.cuerpo.omitidas], [0, 2]);
  // Auditoría: sin contenido del archivo.
  const aud = (await (await fetch(s.url + '/api/v1/auditoria', { headers: H })).json()).find((f) => f.accion === 'importar_segmentos');
  assert.ok(aud && typeof aud.detalle.importadas === 'number' && aud.detalle.archivo !== undefined);
  assert.ok(!JSON.stringify(aud).includes('contenido_base64'), 'la auditoría no guarda el contenido del archivo');
  // La disponibilidad ya refleja lo importado.
  const d = await (await fetch(s.url + '/api/v1/pools/imp-on-prem-prod-10/disponibilidad', { headers: H })).json();
  assert.equal(d.ocupadas, 256 + 64);
});

test('un segmento que solapa con OTRO pool exige aprobación del admin: sin aprobar no entra; aprobado, entra en su pool', opts, async () => {
  // El pool automático de On-prem ya tiene 10.202.0.0/24; el mismo rango de GCP está en otro pool (otro espacio de direcciones).
  const archivo = csv('cidr,vpc,proveedor,ambiente\n10.202.0.0/24,gcp-mismo-rango,GCP,prod\n');
  const sim = await post('/api/v1/importaciones/simular', archivo);
  assert.equal(sim.cuerpo.filas[0].estado, 'solapa_otro_pool');
  assert.equal(sim.cuerpo.filas[0].choca_con.pool_id, 'imp-on-prem-prod-10');
  const sin = await post('/api/v1/importaciones/aplicar', archivo);
  assert.deepEqual([sin.cuerpo.importadas, sin.cuerpo.rechazadas_por_solapamiento], [0, 1]);
  assert.equal((await b.sql("select count(*)::int as n from asignaciones where vpc='gcp-mismo-rango'")).rows[0].n, 0);
  // Aprobar una fila que no existe o que no solapa no habilita nada; la 2 sí.
  const con = await post('/api/v1/importaciones/aplicar', { ...archivo, aprobar: [2, 99] });
  assert.deepEqual([con.cuerpo.importadas, con.cuerpo.aprobadas], [1, 1]);
  const f = (await b.sql("select pool_id from asignaciones where vpc='gcp-mismo-rango'")).rows[0];
  assert.equal(f.pool_id, 'imp-gcp-prod-10');
});

test('validaciones: archivo vacío o ilegible, sin columna de CIDR, valores por defecto, y solo admin', opts, async () => {
  assert.equal((await post('/api/v1/importaciones/simular', { formato: 'csv', contenido_base64: '' })).estado, 400);
  assert.equal(
    (await post('/api/v1/importaciones/simular', { formato: 'xlsx', contenido_base64: Buffer.from('no soy un excel').toString('base64') })).estado,
    400,
  );
  const sinCol = await post('/api/v1/importaciones/simular', csv('a,b\n1,2\n'));
  assert.equal(sinCol.estado, 400);
  assert.equal(sinCol.cuerpo.error, 'sin_columna_cidr');
  assert.equal((await post('/api/v1/importaciones/simular', { formato: 'pdf', contenido_base64: 'AAAA' })).estado, 400);
  // Sin proveedor ni ambiente en el archivo: se completan con los valores por defecto del formulario.
  const def = await post('/api/v1/importaciones/simular', { ...csv('cidr\n172.20.0.0/24\n'), proveedor: 'AWS', ambiente: 'dev' });
  assert.equal(def.cuerpo.filas[0].estado, 'ok');
  assert.deepEqual(
    def.cuerpo.pools_a_crear.map((p) => p.id),
    ['imp-aws-dev-172'],
  );
  // Sin los valores por defecto, la fila es inválida con el motivo claro.
  const sin = await post('/api/v1/importaciones/simular', csv('cidr\n172.20.0.0/24\n'));
  assert.equal(sin.cuerpo.filas[0].estado, 'invalida');
  // Dirección con máscara (como en una lista de IP): se sugiere la red.
  const ip = await post('/api/v1/importaciones/simular', { ...csv('prefijo\n10.0.0.10/26\n'), proveedor: 'GCP', ambiente: 'prod' });
  assert.equal(ip.cuerpo.filas[0].sugerido, '10.0.0.0/26');
});

test('un rol que no es admin no puede importar', opts, async () => {
  const sb = await lanzarServicio({
    DATABASE_URL: b.url,
    NODE_ENV: 'production',
    APP_USER: 'root',
    APP_PASS: 'clave-root-de-prueba-1',
    SESSION_SECRET: 'x'.repeat(40),
    AUTH_LOCAL: 'true',
  });
  try {
    const root = { ...H, Authorization: 'Basic ' + Buffer.from('root:clave-root-de-prueba-1').toString('base64') };
    const c = await (
      await fetch(sb.url + '/api/v1/usuarios', { method: 'POST', headers: root, body: JSON.stringify({ email: 'lecto', rol: 'solicitante', local: true }) })
    ).json();
    const lect = { ...H, Authorization: 'Basic ' + Buffer.from(`lecto:${c.clave_temporal}`).toString('base64') };
    // Con clave temporal la API está bloqueada (403) y, aun cambiada, solicitante no importa: ambos casos son 403.
    const r = await fetch(sb.url + '/api/v1/importaciones/simular', { method: 'POST', headers: lect, body: JSON.stringify(csv('cidr\n10.0.0.0/24\n')) });
    assert.equal(r.status, 403);
    const comoAdmin = await fetch(sb.url + '/api/v1/importaciones/simular', {
      method: 'POST',
      headers: root,
      body: JSON.stringify(csv('cidr\n10.250.0.0/24\n')),
    });
    assert.equal(comoAdmin.status, 200, 'el admin sí puede simular (la fila sale inválida: falta proveedor y ambiente)');
    assert.equal((await comoAdmin.json()).filas[0].estado, 'invalida');
  } finally {
    await sb.parar();
  }
});
