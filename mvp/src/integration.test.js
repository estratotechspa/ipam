// Pruebas de integración contra PostgreSQL real. Se omiten si no hay DATABASE_URL.
// Preparación: aplicar db/schema.sql y db/seed.sql en la base de pruebas.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const ExcelJS = require('exceljs');

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
// La firma cubre «<timestamp>.<cuerpo>» (cabecera x-ipam-timestamp).
const ahora = () => String(Math.floor(Date.now() / 1000));
const firma = (txt, ts) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${txt}`).digest('hex');
const cabecerasWebhook = (txt, ts = ahora()) => ({ 'Content-Type': 'application/json', 'x-ipam-timestamp': ts, 'x-hub-signature-256': firma(txt, ts) });

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
    headers: { 'Content-Type': 'application/json', 'x-ipam-timestamp': ahora(), 'x-hub-signature-256': 'sha256=00' },
    body: cuerpo,
  });
  assert.equal(mal.status, 401);
  const enviar = () => fetch(base + '/webhook/jira', { method: 'POST', headers: cabecerasWebhook(cuerpo), body: cuerpo });
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
  const sufijo = Date.now().toString(36);
  const id = `lan-prueba-${sufijo}`;
  const nuevo = { id, tipo: 'LAN', ambiente: 'prod', proveedor: 'On-prem', cidr: '10.250.0.0/16' };
  assert.equal((await post('/api/v1/pools', nuevo)).status, 201);
  assert.equal((await (await post('/api/v1/pools', nuevo)).json()).error, 'pool_existe');
  const solapa = await post('/api/v1/pools', { ...nuevo, id: `lan-prueba-2-${sufijo}`, proveedor: 'on-prem', cidr: '10.250.128.0/17' });
  assert.deepEqual([solapa.status, (await solapa.json()).error], [409, 'pool_solapado']);
  // Otro ambiente: el mismo rango sí se permite.
  assert.equal((await post('/api/v1/pools', { ...nuevo, id: `lan-prueba-dev-${sufijo}`, ambiente: 'dev' })).status, 201);
  assert.equal((await post('/api/v1/pools', { ...nuevo, id: 'mal', cidr: '10.250.0.0/31' })).status, 400);

  const e = await llamar('PATCH', `/api/v1/pools/${id}`, { tipo: 'LAN sucursal', proveedor: 'On-prem' });
  assert.equal((await e.json()).tipo, 'LAN sucursal');
  assert.equal((await llamar('PATCH', '/api/v1/pools/no-existe', { tipo: 'x', proveedor: 'y' })).status, 404);

  const a = await (await post('/api/v1/solicitudes', { pool: id, vpc: 'sucursal-1', mascara: 24 })).json();
  const enUso = await llamar('DELETE', `/api/v1/pools/${id}`);
  assert.deepEqual([enUso.status, (await enUso.json()).error], [409, 'pool_en_uso']);
  await llamar('DELETE', `/api/v1/asignaciones/${a.id}`, { motivo: 'prueba' });
  assert.equal((await llamar('DELETE', `/api/v1/pools/${id}`)).status, 200);
  assert.equal((await llamar('DELETE', `/api/v1/pools/lan-prueba-dev-${sufijo}`)).status, 200);
  const hist = await (await fetch(`${base}/api/v1/auditoria?pool=${id}`)).json();
  assert.deepEqual(
    hist.map((f) => f.accion).filter((x) => x.endsWith('_pool')),
    ['eliminar_pool', 'editar_pool', 'crear_pool'],
  );
});

test('direcciones IP fijas: dentro del segmento, excepciones, repetidas, ambiguas, edición y liberar con IPs', opts, async () => {
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'ipam' };
  const llamar = (metodo, ruta, cuerpo) => fetch(base + ruta, { method: metodo, headers: H, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const json = async (r) => ({ estado: r.status, ...(await r.json()) });
  const a = await (await post('/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'vpc-con-ips', mascara: 28 })).json();
  const [red] = a.cidr.split('/');
  const n = red.split('.').map(Number);
  const ip1 = `${n[0]}.${n[1]}.${n[2]}.${n[3] + 1}`;

  const gw = await json(await post('/api/v1/direcciones', { ip: ip1, dispositivo: 'rtr-test-01', interfaz: 'Gi0/1', rol: 'gateway' }));
  assert.deepEqual([gw.estado, gw.segmento, gw.asignacion_id, gw.pool_id, gw.aviso], [201, a.cidr, String(a.id), 'gke-nodos-qa', null]);
  assert.equal((await json(await post('/api/v1/direcciones', { ip: ip1 }))).error, 'ip_repetida');
  const deRed = await json(await post('/api/v1/direcciones', { ip: red, dispositivo: 'sw-test', interfaz: 'Vlan10' }));
  assert.match(deRed.aviso, /de red/);

  // Fuera de un segmento: exige motivo. Dentro de un pool o fuera de todo pool.
  assert.equal((await json(await post('/api/v1/direcciones', { ip: '10.20.250.250' }))).error, 'fuera_de_segmento');
  const exc = await json(await post('/api/v1/direcciones', { ip: '10.20.250.250', dispositivo: 'fw-test', excepcion: 'IP de gestión heredada' }));
  assert.deepEqual([exc.estado, exc.pool_id, exc.asignacion_id], [201, 'gke-nodos-qa', null]);
  const publica = await json(
    await post('/api/v1/direcciones', { ip: '203.0.113.10', dispositivo: 'fw-test', interfaz: 'ethernet1/1', excepcion: 'IP pública del firewall' }),
  );
  assert.deepEqual([publica.estado, publica.pool_id], [201, null]);

  // El mismo rango privado en dos ambientes: hay que indicar el pool.
  for (const [id, ambiente] of [
    ['lan-ips-dev', 'dev'],
    ['lan-ips-qa', 'qa'],
  ])
    await post('/api/v1/pools', { id, tipo: 'LAN', ambiente, proveedor: 'On-prem', cidr: '10.251.0.0/16' });
  const amb = await json(await post('/api/v1/direcciones', { ip: '10.251.0.5', excepcion: 'prueba' }));
  assert.deepEqual([amb.estado, amb.error, amb.opciones.length], [422, 'ip_ambigua', 2]);
  const conPool = await json(await post('/api/v1/direcciones', { ip: '10.251.0.5', pool: 'lan-ips-qa', excepcion: 'prueba' }));
  assert.equal(conPool.pool_id, 'lan-ips-qa');

  // Editar: lo que no viene se conserva; una excepción no puede quedar sin motivo.
  const ed = await json(await llamar('PATCH', `/api/v1/direcciones/${gw.id}`, { interfaz: 'Gi0/2' }));
  assert.deepEqual([ed.interfaz, ed.dispositivo, ed.rol], ['Gi0/2', 'rtr-test-01', 'gateway']);
  assert.equal((await json(await llamar('PATCH', `/api/v1/direcciones/${exc.id}`, { excepcion: null }))).error, 'falta_excepcion');

  // Búsqueda e historial del segmento.
  const lista = await (await fetch(`${base}/api/v1/direcciones?q=rtr-test`)).json();
  assert.deepEqual(
    lista.map((d) => d.ip),
    [ip1],
  );
  assert.equal((await (await fetch(`${base}/api/v1/direcciones?asignacion=${a.id}`)).json()).length, 2);
  const hist = await (await fetch(`${base}/api/v1/auditoria?pool=gke-nodos-qa&cidr=${encodeURIComponent(a.cidr)}`)).json();
  assert.ok(hist.some((f) => f.accion === 'registrar_ip' && f.detalle.ip === ip1));

  // No se libera un segmento con IPs registradas; tampoco se borra un pool con IPs.
  assert.equal((await json(await llamar('DELETE', `/api/v1/asignaciones/${a.id}`, { motivo: 'x' }))).error, 'tiene_direcciones');
  assert.equal((await json(await llamar('DELETE', '/api/v1/pools/lan-ips-qa'))).error, 'pool_en_uso');
  for (const d of [gw, deRed, exc, publica, conPool]) assert.equal((await llamar('DELETE', `/api/v1/direcciones/${d.id}`)).status, 200);
  assert.equal((await llamar('DELETE', `/api/v1/asignaciones/${a.id}`, { motivo: 'x' })).status, 200);
  for (const id of ['lan-ips-dev', 'lan-ips-qa']) assert.equal((await llamar('DELETE', `/api/v1/pools/${id}`)).status, 200);
});

test('respaldo JSON: incluye las direcciones IP fijas y las restaura sin duplicar', opts, async () => {
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'ipam' };
  const d = await (await post('/api/v1/direcciones', { ip: '203.0.113.77', dispositivo: 'fw-respaldo', excepcion: 'prueba de respaldo' })).json();
  const respaldo = await (await fetch(`${base}/api/v1/exportar.json`)).json();
  assert.ok(respaldo.direcciones.some((x) => x.ip === '203.0.113.77' && x.dispositivo === 'fw-respaldo'));
  await fetch(`${base}/api/v1/direcciones/${d.id}`, { method: 'DELETE', headers: H });
  const r = await (await post('/api/v1/importar', respaldo)).json();
  assert.ok(r.direcciones >= 1);
  const vuelta = (await (await fetch(`${base}/api/v1/direcciones?q=fw-respaldo`)).json())[0];
  assert.deepEqual([vuelta.ip, vuelta.excepcion], ['203.0.113.77', 'prueba de respaldo']);
  assert.equal((await (await post('/api/v1/importar', respaldo)).json()).direcciones, 0); // no duplica
  await fetch(`${base}/api/v1/direcciones/${vuelta.id}`, { method: 'DELETE', headers: H });
});

// ---------- Bloque 2 · seguridad ----------
const H = { 'X-Requested-With': 'ipam' };
const getJson = async (ruta) => (await fetch(base + ruta)).json();
const conEntorno = async (vars, fn) => {
  const previo = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previo))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};
const liberarReserva = (id) =>
  fetch(`${base}/api/reservas/${id}/liberar`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });

test(
  'webhook con timestamp: exige la cabecera, la ventana de ±5 min y que la firma lo cubra; un reenvío dentro de la ventana es idempotente',
  opts,
  async () => {
    const cuerpo = (ticket) => JSON.stringify({ ticket, ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'vpc-ts' });
    const enviar = (txt, headers) => fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: txt });
    const ts = Number(ahora());
    // sin timestamp, aunque la firma antigua (solo del cuerpo) sea «correcta»
    const viejo = cuerpo('NET-9201');
    const sinTs = await enviar(viejo, { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(viejo).digest('hex') });
    assert.equal(sinTs.status, 401);
    assert.match((await sinTs.json()).motivo, /x-ipam-timestamp/);
    // la firma debe cubrir ESE timestamp
    const t2 = cuerpo('NET-9202');
    const otro = await enviar(t2, { 'x-ipam-timestamp': String(ts), 'x-hub-signature-256': firma(t2, String(ts - 1)) });
    assert.equal(otro.status, 401);
    assert.equal((await otro.json()).motivo, 'firma inválida');
    // fuera de la ventana (6 min atrás y 6 min adelante), bien firmado
    for (const desfase of [-360, 360]) {
      const txt = cuerpo('NET-9203');
      const r = await enviar(txt, cabecerasWebhook(txt, String(ts + desfase)));
      assert.equal(r.status, 401, `desfase ${desfase}`);
      assert.match((await r.json()).motivo, /ventana/);
    }
    // dentro de la ventana (4 min atrás): vale; el reenvío exacto devuelve la misma reserva, sin duplicarla
    const txt = cuerpo('NET-9205');
    const h = cabecerasWebhook(txt, String(ts - 240));
    const a = await enviar(txt, h);
    assert.equal(a.status, 200);
    const dA = await a.json();
    const b = await (await enviar(txt, h)).json();
    assert.equal(b.reserva, dA.reserva, 'reenvío idempotente por ticket');
    await liberarReserva(dA.reserva);
    const rechazos = (await getJson('/api/eventos')).filter((e) => e.tipo === 'jira_firma_invalida');
    assert.ok(
      rechazos.some((e) => /ventana/.test(e.detalle.motivo)),
      'el motivo queda en los eventos',
    );
  },
);

test('simulador de Jira: disponible fuera de producción (firma con timestamp); en producción solo con ENABLE_SIMULADOR=true', opts, async () => {
  const simular = () => post('/api/jira/simular', { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'vpc-sim' });
  assert.equal((await getJson('/api/jira/estado')).simulador, true);
  const r = await simular();
  assert.equal(r.status, 200);
  const d = await r.json();
  await liberarReserva(d.reserva);
  const ev = (await getJson('/api/eventos')).find((e) => e.tipo === 'jira_webhook_recibido' && e.detalle.ticket === d.ticket);
  assert.match(ev.detalle.timestamp, /^\d{10}$/, 'el simulador firma con timestamp');

  await conEntorno({ NODE_ENV: 'production' }, async () => {
    assert.equal((await getJson('/api/jira/estado')).simulador, false);
    const bloqueado = await simular();
    assert.equal(bloqueado.status, 404);
    assert.equal((await bloqueado.json()).error, 'simulador_deshabilitado');
    await conEntorno({ ENABLE_SIMULADOR: 'true' }, async () => {
      assert.equal((await getJson('/api/jira/estado')).simulador, true);
      const ok = await simular();
      assert.equal(ok.status, 200);
      await liberarReserva((await ok.json()).reserva);
    });
  });
});

// Jira falso: crea tickets (clave JIRA-77), con fallos y demoras configurables.
function jiraFalso({ fallos = 0, demoraMs = 0 } = {}) {
  const f = { llamadas: [], n: 0 };
  f.srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      f.llamadas.push(`${req.method} ${req.url}`);
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/rest/api/3/issue') {
          if (f.n++ < fallos) {
            res.statusCode = 500;
            return res.end('{"error":"boom"}');
          }
          return res.end('{"key":"JIRA-77"}');
        }
        res.end('{}');
      }, demoraMs);
    });
  });
  f.entorno = () => ({
    JIRA_ENABLED: 'true',
    JIRA_BASE_URL: `http://127.0.0.1:${f.srv.address().port}`,
    JIRA_EMAIL: 'a@b.cl',
    JIRA_API_TOKEN: 't',
    JIRA_PROJECT: 'NET',
    JIRA_REINTENTO_MS: '20',
  });
  f.listen = () => new Promise((ok) => f.srv.listen(0, '127.0.0.1', () => ok(f)));
  return f;
}
const esperarEvento = async (tipo, filtro = () => true) => {
  for (let i = 0; i < 100; i++) {
    const e = (await getJson('/api/eventos')).find((x) => x.tipo === tipo && filtro(x));
    if (e) return e;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error(`no apareció el evento ${tipo}`);
};

test('Jira fuera del camino crítico: la respuesta no espera a Jira y el resultado queda en eventos', opts, async () => {
  const j = await jiraFalso({ demoraMs: 1500 }).listen();
  try {
    await conEntorno(j.entorno(), async () => {
      const t0 = Date.now();
      const r = await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'jira-bg', cidr: '192.168.91.0/24' });
      const ms = Date.now() - t0;
      assert.equal(r.status, 201);
      assert.ok(ms < 1000, `respondió en ${ms} ms, no debe esperar a Jira (1,5 s)`);
      const a = await r.json();
      assert.match(a.ticket, /^NET-\d+$/, 'la respuesta trae el ticket interno');
      const ev = await esperarEvento('jira_ticket_creado', (e) => e.detalle.rango === '192.168.91.0/24');
      assert.equal(ev.detalle.ticket, 'JIRA-77');
      const guardada = (await getJson('/api/asignaciones')).find((x) => x.id === a.id);
      assert.equal(guardada.ticket, 'JIRA-77', 'la clave real reemplaza al ticket interno');
      await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: H });
    });
  } finally {
    j.srv.close();
  }
});

test('Jira con un fallo transitorio se reintenta; con Jira caído la asignación se conserva y queda jira_error tras los reintentos', opts, async () => {
  const transitorio = await jiraFalso({ fallos: 1 }).listen();
  try {
    await conEntorno(transitorio.entorno(), async () => {
      const a = await (await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'jira-reint', cidr: '192.168.92.0/24' })).json();
      await esperarEvento('jira_ticket_creado', (e) => e.detalle.rango === '192.168.92.0/24');
      assert.equal(transitorio.llamadas.filter((l) => l === 'POST /rest/api/3/issue').length, 2, 'un intento fallido y uno bueno');
      await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: H });
    });
  } finally {
    transitorio.srv.close();
  }
  const caido = await jiraFalso({ fallos: 99 }).listen();
  try {
    await conEntorno({ ...caido.entorno(), JIRA_REINTENTOS: '3' }, async () => {
      const r = await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'jira-caido', cidr: '192.168.93.0/24' });
      assert.equal(r.status, 201);
      const a = await r.json();
      const ev = await esperarEvento('jira_error', (e) => e.detalle.ticket === a.ticket);
      assert.equal(ev.detalle.intentos, 3);
      assert.match(ev.detalle.motivo, /500/);
      assert.equal(caido.llamadas.length, 3);
      assert.equal((await getJson('/api/asignaciones')).find((x) => x.id === a.id).ticket, a.ticket, 'sigue con su ticket interno');
      await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: H });
    });
  } finally {
    caido.srv.close();
  }
});

test('Excel por streaming: hojas, estilos y más filas que un lote (segmentos e IPs)', opts, async () => {
  const y = 2600;
  try {
    await db.query(
      `insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen)
     select 'onprem-lan-dev', set_masklen(inet '192.168.128.0' + i*4, 30)::cidr, 'bulk-xlsx', 'prueba', 'BULK-' || i, 'panel' from generate_series(0, $1::int - 1) i`,
      [y],
    );
    await db.query(
      `insert into direcciones_ip (ip, pool_id, rol, dispositivo, excepcion, creado_por)
     select inet '192.168.200.0' + i, 'onprem-lan-dev', 'otro', 'bulk-ip-' || i, 'prueba de exportación', 'prueba' from generate_series(0, 1199) i`,
    );
    const r = await fetch(base + '/api/exportar.xlsx');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /ipam-segmentos-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const seg = wb.getWorksheet('Segmentos');
    assert.equal(seg.getCell('A1').value, 'ID');
    assert.equal(seg.getCell('A1').font.bold, true);
    assert.equal(seg.views[0].state, 'frozen');
    const bulk = seg.getRows(2, seg.rowCount - 1).filter((f) => f.getCell('J').value === 'bulk-xlsx');
    assert.equal(bulk.length, y, 'todas las filas, también las posteriores al primer lote');
    assert.equal(bulk[0].getCell('D').numFmt, '#,##0');
    assert.equal(bulk[0].getCell('D').value, 4);
    assert.equal(wb.getWorksheet('Pools').getCell('A1').value, 'Pool');
    assert.equal(wb.getWorksheet('Pools').getRow(2).getCell('G').numFmt, '0.0%');
    const ips = wb.getWorksheet('Direcciones IP');
    const delBulk = ips.getRows(2, ips.rowCount - 1).filter((f) => String(f.getCell('B').value).startsWith('bulk-ip-'));
    assert.equal(delBulk.length, 1200, 'las IPs fijas también se exportan completas (antes se cortaban en 2.000)');
  } finally {
    await db.query("delete from direcciones_ip where dispositivo like 'bulk-ip-%'");
    await db.query("delete from asignaciones where vpc = 'bulk-xlsx'");
  }
});

test('cabeceras: Permissions-Policy y Referrer-Policy', opts, async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const pp = r.headers.get('permissions-policy');
  for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) assert.ok(pp.includes(f), f);
});

// ---------- Bloque 3 · lista de asignaciones paginada ----------
test('GET /api/asignaciones: paginación, filtros, orden y X-Total-Count', opts, async () => {
  const get = (q) => fetch(`${base}/api/asignaciones?${q}`);
  let r = await get('limit=5');
  const total = Number(r.headers.get('x-total-count'));
  assert.ok(total >= 12);
  assert.equal((await r.json()).length, 5);
  assert.equal((await (await get('limit=2&offset=2')).json()).length, 2);
  r = await get('limit=2&offset=1000000');
  assert.deepEqual(await r.json(), []);
  assert.equal(Number(r.headers.get('x-total-count')), total, 'el total no depende de la página');
  assert.equal(Number((await get('')).headers.get('x-total-count')), total, 'sin parámetros: lo de siempre, con el total en la cabecera');

  r = await get('pool=gke-nodos-prod&orden=cidr&dir=asc');
  assert.deepEqual(
    (await r.json()).map((x) => x.cidr),
    ['10.10.0.0/20', '10.10.16.0/20', '10.10.32.0/21'],
  );
  assert.equal(Number(r.headers.get('x-total-count')), 3);
  assert.deepEqual(
    (await (await get('pool=gke-nodos-prod&orden=cidr&dir=desc')).json()).map((x) => x.cidr),
    ['10.10.32.0/21', '10.10.16.0/20', '10.10.0.0/20'],
  );
  assert.deepEqual((await (await get('pool=gke-nodos-prod&orden=direcciones&dir=desc')).json()).map((x) => x.cidr).slice(-1), ['10.10.32.0/21']);

  const porTexto = await (await get('q=NET-142')).json();
  assert.equal(porTexto.length, 1);
  assert.equal(porTexto[0].vpc, 'vpc-clientes');
  assert.equal(porTexto[0].ambiente, 'prod', 'cada fila trae el ambiente de su pool');
  assert.ok(
    (await (await get('q=10.64.8')).json()).some((x) => x.ticket === 'NET-142'),
    'busca por CIDR',
  );
  assert.ok((await (await get('q=MLOPEZ')).json()).length >= 4, 'sin distinguir mayúsculas, por solicitante');
  const unaConCodigo = porTexto[0];
  assert.deepEqual(
    (await (await get(`q=${unaConCodigo.codigo}`)).json()).map((x) => x.id),
    [unaConCodigo.id],
    'busca por el ID legible (ASG-…)',
  );
  assert.deepEqual(await (await get('q=%25')).json(), [], '% se busca literal, no como comodín');
  assert.deepEqual(await (await get('q=_')).json(), [], '_ se busca literal');
  const prod = await (await get('ambiente=prod')).json();
  assert.ok(prod.length >= 9 && prod.every((x) => x.ambiente === 'prod'));
  assert.equal((await (await get('ambiente=qa&pool=gke-nodos-prod')).json()).length, 0);

  for (const q of [
    'limit=0',
    'limit=1001',
    'limit=abc',
    'offset=-1',
    'orden=hack',
    'orden=constructor',
    'dir=up',
    'ambiente=xx',
    'q=' + 'a'.repeat(101),
    'pool=a&pool=b',
  ]) {
    const e = await get(q);
    assert.equal(e.status, 400, q);
    assert.equal((await e.json()).error, 'parametro_invalido', q);
  }
});
