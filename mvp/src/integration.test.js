// Pruebas de integración contra PostgreSQL real. Se omiten si no hay DATABASE_URL.
// Preparación: aplicar db/schema.sql y db/seed.sql en la base de pruebas.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const SECRET = 'secreto-de-pruebas';
process.env.JIRA_WEBHOOK_SECRET = SECRET;
// Estas pruebas hacen muchas escrituras seguidas con un solo actor: se sube el límite de peticiones (la lógica del límite se prueba en limite.test.js).
Object.assign(process.env, {
  RATE_LIMIT_POR_MINUTO: '100000',
  RATE_LIMIT_ESCRITURA_POR_MINUTO: '100000',
  RATE_LIMIT_IP_POR_MINUTO: '100000',
  RATE_LIMIT_AUTH_FALLOS_POR_MINUTO: '100000',
});
const hay = !!process.env.DATABASE_URL;
const opts = { skip: hay ? false : 'sin DATABASE_URL' };

let server, base, db;
const post = (ruta, cuerpo, h = {}) =>
  fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ipam', ...h }, body: JSON.stringify(cuerpo) });
const firma = (txt) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(txt).digest('hex');

test.before(async () => {
  if (!hay) return;
  ({ app: server, db } = require('./server'));
  server = await new Promise((ok) => {
    const s = server.listen(0, () => ok(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (hay) {
    server.close();
    await db.end();
  }
});

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
    if (a.vpc.startsWith('conc-'))
      assert.equal((await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } })).status, 200);
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

test('webhook de Jira: firma inválida → 401; firma válida → RESERVA y solo la aprobación de un admin asigna', opts, async () => {
  const cuerpo = JSON.stringify({ ticket: 'NET-9001', ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'vpc-webhook' });
  const mal = await fetch(base + '/webhook/jira', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
    body: cuerpo,
  });
  assert.equal(mal.status, 401);
  const enviar = () =>
    fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': firma(cuerpo) }, body: cuerpo });
  const bien = await enviar();
  assert.equal(bien.status, 200);
  const d = await bien.json();
  assert.equal(d.ticket, 'NET-9001');
  assert.equal(d.estado, 'pendiente_de_aprobacion');
  assert.ok(d.reserva);

  // Sin aprobación NO hay asignación: el rango solo está apartado.
  const antes = (await (await fetch(base + '/api/asignaciones')).json()).find((x) => x.ticket === 'NET-9001');
  assert.equal(antes, undefined, 'el webhook no debe asignar sin aprobación');
  // Un reintento de Jira con el mismo ticket no duplica la reserva.
  const otra = await (await enviar()).json();
  assert.equal(otra.reserva, d.reserva);

  // Un admin aprueba (confirma la reserva): recién ahí nace la asignación, con origen «jira».
  const ok = await fetch(`${base}/api/reservas/${d.reserva}/confirmar`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(ok.status, 200);
  const a = (await (await fetch(base + '/api/asignaciones')).json()).find((x) => x.ticket === 'NET-9001');
  assert.equal(a.origen, 'jira');
  assert.match(a.codigo, /^ASG-\d{6,}$/, 'la asignación lleva su ID legible');
  assert.equal(a.codigo, `ASG-${String(a.id).padStart(6, '0')}`);
  await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'ipam' } });
});

test('exportación a Excel: archivo .xlsx válido', opts, async () => {
  const r = await fetch(base + '/api/exportar.xlsx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
});

test('respaldo JSON: exporta, restaura lo borrado y rechaza solapamientos sin importar nada', opts, async () => {
  const H = { 'X-Requested-With': 'ipam' };
  const r = await fetch(base + '/api/exportar.json');
  assert.equal(r.status, 200);
  const resp = await r.json();
  assert.equal(resp.formato, 'ipam-respaldo');
  assert.ok(resp.pools.length >= 6 && resp.asignaciones.length >= 12);

  // Importar lo mismo no duplica nada.
  const igual = await (await post('/api/importar', resp)).json();
  assert.equal(igual.asignaciones, 0);
  assert.equal(igual.omitidas, resp.asignaciones.length);

  // Se borra una asignación y el respaldo la devuelve.
  const lista = await (await fetch(base + '/api/asignaciones')).json();
  const a = lista.find((x) => x.ticket === 'NET-101');
  await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: H });
  const rest = await (await post('/api/importar', resp)).json();
  assert.equal(rest.asignaciones, 1);

  // Un respaldo con un segmento que se solapa con otro existente se rechaza completo.
  const malo = {
    ...resp,
    asignaciones: [{ pool_id: 'gke-pods-prod', cidr: '10.64.8.0/22', vpc: 'choque', solicitante: 'x', ticket: 'NET-7777', origen: 'panel' }],
  };
  const res = await post('/api/importar', malo);
  assert.equal(res.status, 409);
  assert.ok(!(await (await fetch(base + '/api/asignaciones')).json()).some((x) => x.ticket === 'NET-7777'));

  assert.equal((await post('/api/importar', { hola: 1 })).status, 400);
});

test('marca por API y logo inexistente', opts, async () => {
  assert.equal((await (await fetch(base + '/api/config')).json()).nombre, 'IPAM');
  assert.match(await (await fetch(base + '/brand.css')).text(), /--top:/);
  assert.equal((await fetch(base + '/brand/logo')).status, 404);
});

test('disponibilidad por máscara: totales, bloques libres y utilizables de un pool real', opts, async () => {
  const d = await (await fetch(base + '/api/pools/gke-nodos-qa/disponibilidad')).json();
  assert.equal(d.pool, 'gke-nodos-qa');
  assert.equal(d.ocupadas + d.libres, d.total);
  const m24 = d.por_mascara.find((x) => x.mascara === 24);
  assert.deepEqual([m24.direcciones, m24.utilizables], [256, 254]);
  assert.ok(m24.bloques_libres > 0 && m24.direcciones_libres === m24.bloques_libres * 256);
  assert.equal((await fetch(base + '/api/pools/no-existe/disponibilidad')).status, 404);
});

test('VLAN opcional: se guarda al asignar, pasa de la reserva a la asignación y se valida', opts, async () => {
  const r = await post('/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'vpc-vlan-directa', mascara: 28, vlan: 210, vlan_nombre: 'qa-nodos' });
  assert.equal(r.status, 201);
  const a = await r.json();
  assert.deepEqual({ vlan: a.vlan, nombre: a.vlan_nombre }, { vlan: 210, nombre: 'qa-nodos' });

  const sin = await (await post('/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'vpc-sin-vlan', mascara: 28 })).json();
  assert.deepEqual({ vlan: sin.vlan, nombre: sin.vlan_nombre }, { vlan: null, nombre: null });

  for (const vlan of [0, 4095, 'abc'])
    assert.equal((await post('/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'v', mascara: 28, vlan })).status, 400, String(vlan));

  const res = await post(
    '/api/v1/reservas',
    { pool: 'gke-nodos-qa', vpc: 'vpc-vlan-reserva', mascara: 28, vlan: '300', vlan_nombre: 'Branch_Data' },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
  assert.equal(res.status, 201);
  const reserva = await res.json();
  assert.equal(reserva.vlan, 300);
  const c = await (await post(`/api/v1/reservas/${reserva.id}/confirmar`, {})).json();
  assert.deepEqual({ vlan: c.asignacion.vlan, nombre: c.asignacion.vlan_nombre }, { vlan: 300, nombre: 'Branch_Data' });
});

test('historial: la auditoría se puede filtrar por pool y por segmento', opts, async () => {
  const a = await (await post('/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'vpc-historial', mascara: 28 })).json();
  const delSegmento = await (await fetch(`${base}/api/v1/auditoria?pool=gke-nodos-qa&cidr=${encodeURIComponent(a.cidr)}`)).json();
  assert.ok(delSegmento.length >= 1);
  assert.ok(delSegmento.every((f) => f.detalle.cidr === a.cidr));
  assert.equal(delSegmento[0].accion, 'asignar');
  const delPool = await (await fetch(`${base}/api/v1/auditoria?pool=gke-nodos-qa`)).json();
  assert.ok(delPool.every((f) => (f.detalle.pool || f.detalle.pool_id) === 'gke-nodos-qa'));
  assert.equal((await (await fetch(`${base}/api/v1/auditoria?pool=no-existe`)).json()).length, 0);
});

test('pools: crear, no duplicar ni solapar (mismo proveedor y ambiente), editar y eliminar solo si está vacío', opts, async () => {
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'ipam' };
  const llamar = (metodo, ruta, cuerpo) => fetch(base + ruta, { method: metodo, headers: H, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const nuevo = { id: 'lan-prueba-prod', tipo: 'LAN', ambiente: 'prod', proveedor: 'On-prem', cidr: '10.250.0.0/16' };
  assert.equal((await post('/api/v1/pools', nuevo)).status, 201);
  assert.equal((await (await post('/api/v1/pools', nuevo)).json()).error, 'pool_existe');
  const solapa = await post('/api/v1/pools', { ...nuevo, id: 'lan-prueba-2', proveedor: 'on-prem', cidr: '10.250.128.0/17' });
  assert.deepEqual([solapa.status, (await solapa.json()).error], [409, 'pool_solapado']);
  // Otro ambiente: el mismo rango sí se permite.
  assert.equal((await post('/api/v1/pools', { ...nuevo, id: 'lan-prueba-dev', ambiente: 'dev' })).status, 201);
  assert.equal((await post('/api/v1/pools', { ...nuevo, id: 'mal', cidr: '10.250.0.0/31' })).status, 400);

  const e = await llamar('PATCH', '/api/v1/pools/lan-prueba-prod', { tipo: 'LAN sucursal', proveedor: 'On-prem' });
  assert.equal((await e.json()).tipo, 'LAN sucursal');
  assert.equal((await llamar('PATCH', '/api/v1/pools/no-existe', { tipo: 'x', proveedor: 'y' })).status, 404);

  const a = await (await post('/api/v1/solicitudes', { pool: 'lan-prueba-prod', vpc: 'sucursal-1', mascara: 24 })).json();
  const enUso = await llamar('DELETE', '/api/v1/pools/lan-prueba-prod');
  assert.deepEqual([enUso.status, (await enUso.json()).error], [409, 'pool_en_uso']);
  await llamar('DELETE', `/api/v1/asignaciones/${a.id}`, { motivo: 'prueba' });
  assert.equal((await llamar('DELETE', '/api/v1/pools/lan-prueba-prod')).status, 200);
  assert.equal((await llamar('DELETE', '/api/v1/pools/lan-prueba-dev')).status, 200);
  const hist = await (await fetch(`${base}/api/v1/auditoria?pool=lan-prueba-prod`)).json();
  assert.deepEqual(
    hist.map((f) => f.accion).filter((x) => x.endsWith('_pool')),
    ['eliminar_pool', 'editar_pool', 'crear_pool'],
  );
});
