// Pruebas de integración contra PostgreSQL real. Se omiten si no hay DATABASE_URL.
// Preparación: aplicar db/schema.sql y db/seed.sql en la base de pruebas.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const SECRET = 'secreto-de-pruebas';
process.env.JIRA_WEBHOOK_SECRET = SECRET;
const hay = !!process.env.DATABASE_URL;
const opts = { skip: hay ? false : 'sin DATABASE_URL' };

let server, base, db;
const post = (ruta, cuerpo, h = {}) => fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ipam', ...h }, body: JSON.stringify(cuerpo) });
const firma = (txt) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(txt).digest('hex');

test.before(async () => {
  if (!hay) return;
  ({ app: server, db } = require('./server'));
  server = await new Promise((ok) => { const s = server.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (hay) { server.close(); await db.end(); } });

test('salud y estado de Jira (desactivada por defecto)', opts, async () => {
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { ok: true });
  assert.equal((await (await fetch(base + '/api/jira/estado')).json()).activa, false);
});

test('solapamiento: 409 con el conflicto y segmentos sugeridos', opts, async () => {
  const r = await post('/api/solicitudes', { pool: 'gke-pods-prod', vpc: 'vpc-x', cidr: '10.64.8.0/22' });
  assert.equal(r.status, 409);
  const d = await r.json();
  assert.equal(d.error, 'solapamiento');
  assert.equal(d.conflicto.ticket, 'NET-142');
  assert.ok(d.sugeridos.length > 0);
});

test('validaciones: CIDR inválido, desalineado y fuera del pool', opts, async () => {
  for (const cidr of ['hola', '10.64.9.0/22', '11.0.0.0/22']) {
    assert.equal((await post('/api/solicitudes', { pool: 'gke-pods-prod', vpc: 'v', cidr })).status, 400, cidr);
  }
  assert.equal((await post('/api/solicitudes', { pool: 'no-existe', vpc: 'v', mascara: 24 })).status, 404);
});

test('concurrencia: 20 solicitudes simultáneas → 20 segmentos distintos', opts, async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/api/solicitudes', { pool: 'gke-nodos-qa', vpc: `conc-${i}`, mascara: 24 })));
  assert.ok(rs.every((r) => r.status === 201));
  const cidrs = (await Promise.all(rs.map((r) => r.json()))).map((x) => x.cidr);
  assert.equal(new Set(cidrs).size, 20);
  for (const a of await (await fetch(base + '/api/asignaciones')).json()) {
    if (a.vpc.startsWith('conc-')) assert.equal((await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } })).status, 200);
  }
});

test('asignar y liberar devuelve el espacio', opts, async () => {
  const a = await (await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'ciclo', cidr: '192.168.50.0/24' })).json();
  assert.equal((await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'ciclo2', cidr: '192.168.50.0/24' })).status, 409);
  assert.equal((await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } })).status, 200);
  assert.equal((await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } })).status, 404);
  const b = await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'ciclo3', cidr: '192.168.50.0/24' });
  assert.equal(b.status, 201);
  await fetch(`${base}/api/asignaciones/${(await b.json()).id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } });
});

test('webhook de Jira: firma inválida → 401; firma válida → asigna', opts, async () => {
  const cuerpo = JSON.stringify({ ticket: 'NET-9001', ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'vpc-webhook' });
  const mal = await fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: cuerpo });
  assert.equal(mal.status, 401);
  const bien = await fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma(cuerpo) }, body: cuerpo });
  assert.equal(bien.status, 200);
  const d = await bien.json();
  assert.equal(d.ticket, 'NET-9001');
  const a = (await (await fetch(base + '/api/asignaciones')).json()).find((x) => x.ticket === 'NET-9001');
  assert.equal(a.origen, 'jira');
  await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } });
});

test('exportación a Excel: archivo .xlsx válido', opts, async () => {
  const r = await fetch(base + '/api/exportar.xlsx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});
