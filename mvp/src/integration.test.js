// Pruebas de integración contra PostgreSQL real. Se omiten si no hay DATABASE_URL.
// Preparación: aplicar db/schema.sql y db/seed.sql en la base de pruebas.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ExcelJS = require('exceljs');

const SECRET = 'secreto-de-pruebas';
process.env.JIRA_WEBHOOK_SECRET = SECRET;
process.env.RATE_LIMIT_WEBHOOK_MAX = '40'; // por minuto; la prueba del limitador va al final del archivo
const hay = !!process.env.DATABASE_URL;
const opts = { skip: hay ? false : 'sin DATABASE_URL' };

let server, base, db, mod;
const post = (ruta, cuerpo, h = {}) => fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ipam', ...h }, body: JSON.stringify(cuerpo) });
let webhook; // se define abajo: POST firmado a /webhook/jira
// La firma cubre «<timestamp>.<cuerpo>» (cabecera x-ipam-timestamp).
const ahora = () => String(Math.floor(Date.now() / 1000));
const firma = (txt, ts) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${txt}`).digest('hex');
const cabecerasWebhook = (txt, ts = ahora()) => ({ 'Content-Type': 'application/json', 'x-ipam-timestamp': ts, 'x-hub-signature-256': firma(txt, ts) });

test.before(async () => {
  if (!hay) return;
  mod = require('./server');
  ({ app: server, db } = mod);
  server = await new Promise((ok) => { const s = server.listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (hay) { server.close(); await db.end(); } });

webhook = (cuerpo, ts) => {
  const txt = JSON.stringify(cuerpo);
  return fetch(base + '/webhook/jira', { method: 'POST', headers: cabecerasWebhook(txt, ts), body: txt });
};

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
  for (const a of await (await fetch(base + '/api/asignaciones?q=conc-&limit=200')).json()) {
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
  const mal = await fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ipam-timestamp': ahora(), 'x-hub-signature-256': 'sha256=00' }, body: cuerpo });
  assert.equal(mal.status, 401);
  const bien = await fetch(base + '/webhook/jira', { method: 'POST', headers: cabecerasWebhook(cuerpo), body: cuerpo });
  assert.equal(bien.status, 200);
  const d = await bien.json();
  assert.equal(d.ticket, 'NET-9001');
  const a = (await (await fetch(base + '/api/asignaciones?q=NET-9001')).json()).find((x) => x.ticket === 'NET-9001');
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

test('respaldo JSON: exporta, restaura lo borrado y rechaza solapamientos sin importar nada', opts, async () => {
  const H = { 'X-Requested-With': 'ipam' };
  const r = await fetch(base + '/api/exportar.json');
  assert.equal(r.status, 200);
  const completo = await r.json();
  assert.equal(completo.formato, 'ipam-respaldo');
  assert.ok(completo.pools.length >= 6 && completo.asignaciones.length >= 12);
  // Se restaura solo la semilla: otros archivos de prueba corren en paralelo sobre la misma base y sus filas
  // transitorias (que ya habrán borrado) no deben volver a entrar con el respaldo.
  const resp = { ...completo, asignaciones: completo.asignaciones.filter((a) => a.origen === 'semilla') };
  assert.equal(resp.asignaciones.length, 12);

  // Importar lo mismo no duplica nada.
  const igual = await (await post('/api/importar', resp)).json();
  assert.equal(igual.asignaciones, 0);
  assert.equal(igual.omitidas, resp.asignaciones.length);

  // Se borra una asignación y el respaldo la devuelve.
  const lista = await (await fetch(base + '/api/asignaciones?q=NET-101')).json();
  const a = lista.find((x) => x.ticket === 'NET-101');
  await fetch(`${base}/api/asignaciones/${a.id}`, { method: 'DELETE', headers: H });
  const rest = await (await post('/api/importar', resp)).json();
  assert.equal(rest.asignaciones, 1);
  assert.ok((await (await fetch(base + '/api/asignaciones?q=NET-101')).json()).some((x) => x.ticket === 'NET-101'));

  // Un respaldo con un segmento que se solapa con otro existente se rechaza completo.
  const malo = { ...resp, asignaciones: [{ pool_id: 'gke-pods-prod', cidr: '10.64.8.0/22', vpc: 'choque', solicitante: 'x', ticket: 'NET-7777', origen: 'panel' }] };
  const res = await post('/api/importar', malo);
  assert.equal(res.status, 409);
  assert.ok(!(await (await fetch(base + '/api/asignaciones?q=NET-7777')).json()).some((x) => x.ticket === 'NET-7777'));

  assert.equal((await post('/api/importar', { hola: 1 })).status, 400);
});

test('favicon por defecto y páginas con icono', opts, async () => {
  const r = await fetch(base + '/favicon.svg');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await r.text(), /<svg/);
});

test('marca por API y logo inexistente', opts, async () => {
  assert.equal((await (await fetch(base + '/api/config')).json()).nombre, 'IPAM');
  assert.match(await (await fetch(base + '/brand.css')).text(), /--top:/);
  assert.equal((await fetch(base + '/brand/logo')).status, 404);
});

// ---------- Fase 1 · robustez ----------
const H = { 'X-Requested-With': 'ipam' };
const borrar = (id) => fetch(`${base}/api/asignaciones/${id}`, { method: 'DELETE', headers: H });
const eventos = async () => (await fetch(base + '/api/eventos')).json();

test('evento() captura el error y no lo propaga (como auditar)', opts, async () => {
  // `detalle` es NOT NULL: undefined hace fallar el insert.
  await assert.doesNotReject(mod.evento('prueba_fallida', undefined));
});

test('pool de pg: manejador de error, tiempos y statement_timeout', opts, async () => {
  assert.ok(db.listenerCount('error') >= 1);
  assert.equal(db.options.connectionTimeoutMillis, 5000);
  assert.equal((await db.query('show statement_timeout')).rows[0].statement_timeout, '15s');
});

test('un error interno responde {error, id} sin exponer el detalle, y lo deja en el log', opts, async () => {
  const log = [];
  const err = console.error;
  console.error = (...a) => log.push(a.map(String).join(' '));
  db.query = async () => { throw new Error('secreto-interno-xyz'); };
  let r, texto;
  try { r = await fetch(base + '/api/health'); texto = await r.text(); } finally { delete db.query; console.error = err; }
  assert.equal(r.status, 500);
  const d = JSON.parse(texto);
  assert.deepEqual(Object.keys(d).sort(), ['error', 'id']);
  assert.equal(d.error, 'interno');
  assert.match(d.id, /^[0-9a-f]{8}$/);
  assert.ok(!texto.includes('secreto-interno-xyz'));
  assert.ok(log.some((l) => l.includes(d.id) && l.includes('secreto-interno-xyz')), 'el detalle completo queda en el servidor');
});

test('límites de cuerpo: 100 KB en general, 5 MB solo en /api/importar; JSON roto → 400', opts, async () => {
  const grande = { pool: 'onprem-lan-dev', vpc: 'x'.repeat(200 * 1024), mascara: 24 };
  assert.equal((await post('/api/solicitudes', grande)).status, 413);
  const roto = await fetch(base + '/api/solicitudes', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: '{' });
  assert.equal(roto.status, 400);
  assert.equal((await roto.json()).error, 'JSON inválido.');
  // un respaldo de ~300 KB (vacío pero con relleno) sí entra por /api/importar
  const r = await post('/api/importar', { formato: 'ipam-respaldo', version: 1, pools: [], asignaciones: [], relleno: 'x'.repeat(300 * 1024) });
  assert.equal(r.status, 200);
  // y por encima de 5 MB se rechaza
  assert.equal((await post('/api/importar', { formato: 'ipam-respaldo', version: 1, pools: [], asignaciones: [], relleno: 'x'.repeat(5.5 * 1024 * 1024) })).status, 413);
});

test('textos con largo máximo: vpc, pool, CIDR y campos del webhook', opts, async () => {
  const largo = 'v'.repeat(101);
  assert.equal((await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: largo, mascara: 24 })).status, 400);
  assert.equal((await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: { a: 1 }, mascara: 24 })).status, 400);
  assert.equal((await post('/api/solicitudes', { pool: 'p'.repeat(101), vpc: 'v', mascara: 24 })).status, 400);
  assert.equal((await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'v', cidr: '1'.repeat(60) })).status, 400);
  const ok = await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'v'.repeat(100), cidr: '192.168.90.0/24' });
  assert.equal(ok.status, 201);
  await borrar((await ok.json()).id);
  for (const malo of [{ vpc: largo }, { ticket: 'NET 1; drop' }, { ticket: 'T'.repeat(51) }, { tipo: 'x'.repeat(51) }, { mascara: 'abc' }]) {
    const r = await webhook({ ticket: 'NET-9100', ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'v', ...malo });
    assert.equal(r.status, 400, JSON.stringify(malo));
  }
});

test('GET /api/asignaciones: paginación, filtros, orden y total', opts, async () => {
  const get = (q) => fetch(`${base}/api/asignaciones?${q}`);
  let r = await get('limit=5');
  const total = Number(r.headers.get('x-total-count'));
  assert.ok(total >= 12);
  assert.equal((await r.json()).length, 5);
  assert.equal((await (await get('limit=2&offset=2')).json()).length, 2);
  r = await get('limit=2&offset=1000000');
  assert.deepEqual(await r.json(), []);
  assert.equal(Number(r.headers.get('x-total-count')), total, 'el total no depende de la página');
  assert.ok((await (await get('limit=1000')).json()).length <= 200);

  r = await get('pool=gke-nodos-prod&orden=cidr&dir=asc');
  assert.deepEqual((await r.json()).map((x) => x.cidr), ['10.10.0.0/20', '10.10.16.0/20', '10.10.32.0/21']);
  assert.equal(Number(r.headers.get('x-total-count')), 3);
  assert.deepEqual((await (await get('pool=gke-nodos-prod&orden=cidr&dir=desc')).json()).map((x) => x.cidr), ['10.10.32.0/21', '10.10.16.0/20', '10.10.0.0/20']);
  assert.deepEqual((await (await get('pool=gke-nodos-prod&orden=direcciones&dir=desc')).json()).map((x) => x.cidr).slice(-1), ['10.10.32.0/21']);

  const porTexto = await (await get('q=NET-142')).json();
  assert.equal(porTexto.length, 1);
  assert.equal(porTexto[0].vpc, 'vpc-clientes');
  assert.ok((await (await get('q=10.64.8')).json()).some((x) => x.ticket === 'NET-142'), 'busca por CIDR');
  assert.ok((await (await get('q=MLOPEZ')).json()).length >= 4, 'sin distinguir mayúsculas, por solicitante');
  assert.deepEqual(await (await get('q=%25')).json(), [], '% se busca literal, no como comodín');
  const prod = await (await get('ambiente=prod&limit=200')).json();
  assert.ok(prod.length >= 9 && prod.every((x) => x.ambiente === 'prod'));
  assert.equal((await (await get('ambiente=qa&pool=gke-nodos-prod')).json()).length, 0);

  for (const q of ['limit=0', 'limit=abc', 'offset=-1', 'orden=hack', 'orden=constructor', 'dir=up', 'ambiente=xx', 'q=' + 'a'.repeat(101), 'pool=a&pool=b']) {
    assert.equal((await get(q)).status, 400, q);
  }
});

test('pools y resumen salen de una sola consulta de uso (con libres)', opts, async () => {
  const pools = await (await fetch(base + '/api/pools')).json();
  const p = pools.find((x) => x.id === 'gke-nodos-prod');
  assert.equal(p.total, 65536);
  assert.equal(p.usadas, 4096 + 4096 + 2048);
  assert.equal(p.libres, p.total - p.usadas);
  assert.ok(Math.abs(p.uso - p.usadas / p.total) < 1e-12);
  const r = await (await fetch(base + '/api/resumen')).json();
  assert.equal(r.pools, pools.length);
  assert.equal(r.asignaciones, pools.reduce((n, x) => n + x.asignaciones, 0));
  assert.equal(r.libres, pools.reduce((n, x) => n + x.libres, 0));
  assert.equal(r.solapamientos, 0);
});

test('Excel por streaming: hojas, estilos y más filas que un lote', opts, async () => {
  const y = 2600;
  await db.query(
    `insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen)
     select 'onprem-lan-dev', set_masklen(inet '192.168.128.0' + i*4, 30)::cidr, 'bulk-xlsx', 'prueba', 'BULK-' || i, 'panel' from generate_series(0, $1::int - 1) i`, [y]);
  try {
    const r = await fetch(base + '/api/exportar.xlsx');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /ipam-segmentos-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const seg = wb.getWorksheet('Segmentos');
    assert.ok(seg.rowCount >= y + 13, `filas: ${seg.rowCount}`);
    assert.equal(seg.getCell('A1').value, 'Segmento (CIDR)');
    assert.equal(seg.getCell('A1').font.bold, true);
    assert.equal(seg.views[0].state, 'frozen');
    const bulk = seg.getRows(2, seg.rowCount - 1).filter((f) => f.getCell('I').value === 'bulk-xlsx');
    assert.equal(bulk.length, y, 'todas las filas, también las posteriores al primer lote');
    assert.equal(bulk[0].getCell('C').numFmt, '#,##0');
    assert.equal(bulk[0].getCell('C').value, 4);
    const pools = wb.getWorksheet('Pools');
    assert.equal(pools.getCell('A1').value, 'Pool');
    assert.ok(pools.rowCount >= 7);
    assert.equal(pools.getRow(2).getCell('G').numFmt, '0.0%');
  } finally {
    await db.query("delete from asignaciones where vpc = 'bulk-xlsx'");
  }
});

test('retención: purga eventos y auditoría antiguos y deja los recientes; existe el índice', opts, async () => {
  await db.query("insert into eventos (tipo, ts) values ('test_viejo', now() - interval '400 days'), ('test_reciente', now())");
  await db.query("insert into auditoria (usuario, accion, ts) values ('t-ret', 'test_viejo', now() - interval '400 days'), ('t-ret', 'test_reciente', now())");
  assert.equal((await mod.purgar(0)).omitida, true, 'RETENCION_DIAS=0 conserva todo');
  const r = await mod.purgar(365);
  assert.ok(r.eventos >= 1 && r.auditoria >= 1);
  const tipos = (await db.query("select tipo from eventos where tipo like 'test_%'")).rows.map((x) => x.tipo);
  assert.deepEqual(tipos, ['test_reciente']);
  assert.deepEqual((await db.query("select accion from auditoria where usuario = 't-ret'")).rows.map((x) => x.accion), ['test_reciente']);
  assert.equal((await db.query("select 1 from pg_indexes where indexname = 'eventos_ts_idx'")).rowCount, 1);
  await db.query("delete from eventos where tipo like 'test_%'");
  await db.query("delete from auditoria where usuario = 't-ret'");
});

// Jira falso: crea tickets (clave JIRA-77), con fallos y demoras configurables.
function jiraFalso({ fallos = 0, demoraMs = 0 } = {}) {
  const f = { llamadas: [], n: 0 };
  f.srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => {
      f.llamadas.push(`${req.method} ${req.url}`);
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/rest/api/3/issue') {
          if (f.n++ < fallos) { res.statusCode = 500; return res.end('{"error":"boom"}'); }
          return res.end('{"key":"JIRA-77"}');
        }
        res.end('{}');
      }, demoraMs);
    });
  });
  f.listen = () => new Promise((ok) => f.srv.listen(0, '127.0.0.1', () => {
    Object.assign(process.env, { JIRA_ENABLED: 'true', JIRA_BASE_URL: `http://127.0.0.1:${f.srv.address().port}`, JIRA_EMAIL: 'a@b.cl', JIRA_API_TOKEN: 't', JIRA_PROJECT: 'NET', JIRA_REINTENTO_MS: '20' });
    ok(f);
  }));
  f.cerrar = () => { for (const k of ['JIRA_ENABLED', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT', 'JIRA_REINTENTO_MS']) delete process.env[k]; f.srv.close(); };
  return f;
}
const ultimoEvento = async (tipo) => (await eventos()).find((e) => e.tipo === tipo);

test('Jira fuera del camino crítico: la respuesta no espera a Jira y el resultado queda en eventos', opts, async () => {
  const j = await jiraFalso({ demoraMs: 1500 }).listen();
  try {
    const t0 = Date.now();
    const r = await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'jira-bg', cidr: '192.168.91.0/24' });
    const ms = Date.now() - t0;
    assert.equal(r.status, 201);
    assert.ok(ms < 1000, `respondió en ${ms} ms, no debe esperar a Jira (1,5 s)`);
    const a = await r.json();
    assert.match(a.ticket, /^NET-\d+$/, 'la respuesta trae el ticket interno');
    await mod.esperarSegundoPlano();
    const ev = await ultimoEvento('jira_ticket_creado');
    assert.equal(ev.detalle.ticket, 'JIRA-77');
    assert.equal((await (await fetch(base + '/api/asignaciones?q=jira-bg')).json())[0].ticket, 'JIRA-77', 'la clave real reemplaza al ticket interno');
    await borrar(a.id);
  } finally { j.cerrar(); }
});

test('Jira con un fallo transitorio: se reintenta y termina creando el ticket', opts, async () => {
  const j = await jiraFalso({ fallos: 1 }).listen();
  const err = console.error;
  console.error = () => {};
  try {
    const a = await (await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'jira-reint', cidr: '192.168.92.0/24' })).json();
    await mod.esperarSegundoPlano();
    assert.equal(j.llamadas.filter((l) => l === 'POST /rest/api/3/issue').length, 2);
    assert.equal((await ultimoEvento('jira_ticket_creado')).detalle.rango, '192.168.92.0/24');
    await borrar(a.id);
  } finally { console.error = err; j.cerrar(); }
});

test('Jira caído: la asignación se conserva y queda jira_error tras los reintentos', opts, async () => {
  const j = await jiraFalso({ fallos: 99 }).listen();
  const err = console.error;
  console.error = () => {};
  try {
    const r = await post('/api/solicitudes', { pool: 'onprem-lan-dev', vpc: 'jira-caido', cidr: '192.168.93.0/24' });
    assert.equal(r.status, 201);
    const a = await r.json();
    await mod.esperarSegundoPlano();
    assert.equal(j.llamadas.length, 3);
    const ev = await ultimoEvento('jira_error');
    assert.equal(ev.detalle.ticket, a.ticket);
    assert.equal(ev.detalle.intentos, 3);
    assert.match(ev.detalle.motivo, /500/);
    assert.equal((await (await fetch(base + '/api/asignaciones?q=jira-caido')).json())[0].ticket, a.ticket, 'sigue con su ticket interno');
    await borrar(a.id);
  } finally { console.error = err; j.cerrar(); }
});

test('SIGTERM: el servidor deja de aceptar, termina y drena el pool (salida 0)', opts, async () => {
  const hijo = spawn(process.execPath, [require.resolve('./server')], {
    env: { ...process.env, PORT: '0', RETENCION_DIAS: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  hijo.stderr.on('data', (d) => { salida += d; });
  const puerto = await new Promise((ok, mal) => {
    const t = setTimeout(() => mal(new Error('no arrancó: ' + salida)), 8000);
    hijo.stdout.on('data', () => { const m = salida.match(/escuchando en :(\d+)/); if (m) { clearTimeout(t); ok(m[1]); } });
  });
  assert.equal((await fetch(`http://127.0.0.1:${puerto}/api/health`)).status, 200);
  const fin = new Promise((ok) => hijo.on('exit', (codigo, senal) => ok({ codigo, senal })));
  hijo.kill('SIGTERM');
  const { codigo, senal } = await fin;
  assert.equal(senal, null);
  assert.equal(codigo, 0, salida);
  assert.match(salida, /SIGTERM: cerrando/);
});

// ---------- Fase 2 · seguridad ----------
const jiraMod = require('./jira');

test('webhook con timestamp: exige la cabecera, la ventana de ±5 min y que la firma lo cubra', opts, async () => {
  const cuerpo = { ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'vpc-ts' };
  const nuevo = (ticket) => ({ ticket, ...cuerpo });
  const crudo = (c, h) => fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(c) });
  const ts = ahora();

  // sin timestamp, aunque la firma antigua (solo del cuerpo) sea «correcta»
  const viejo = JSON.stringify(nuevo('NET-9201'));
  const sinTs = await crudo(nuevo('NET-9201'), { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(viejo).digest('hex') });
  assert.equal(sinTs.status, 401);
  assert.match((await sinTs.json()).motivo, /x-ipam-timestamp/);

  // firma que no cubre el timestamp (se firmó con otro): inválida
  const otro = await crudo(nuevo('NET-9202'), { 'x-ipam-timestamp': ts, 'x-hub-signature-256': firma(JSON.stringify(nuevo('NET-9202')), String(Number(ts) - 1)) });
  assert.equal(otro.status, 401);
  assert.equal((await otro.json()).motivo, 'firma inválida');

  // fuera de la ventana: 6 minutos atrás y 6 minutos hacia adelante, bien firmados
  for (const desfase of [-360, 360]) {
    const t = String(Number(ts) + desfase);
    const r = await webhook(nuevo('NET-9203'), t);
    assert.equal(r.status, 401, `desfase ${desfase}`);
    assert.match((await r.json()).motivo, /ventana/);
  }
  assert.equal((await webhook({ ...nuevo('NET-9204') }, 'abc')).status, 401);

  // dentro de la ventana (4 min atrás): vale
  const ok = await webhook(nuevo('NET-9205'), String(Number(ts) - 240));
  assert.equal(ok.status, 200);
  const a = (await (await fetch(base + '/api/asignaciones?q=NET-9205')).json())[0];

  // repetición: la misma petición otra vez → 409 y no se asigna dos veces
  const rep = await webhook(nuevo('NET-9205'), String(Number(ts) - 240));
  assert.equal(rep.status, 409);
  assert.equal((await (await fetch(base + '/api/asignaciones?q=NET-9205')).json()).length, 1);
  await borrar(a.id);
});

test('verificarWebhook: ventana exacta, milisegundos y firmas distintas con otro timestamp', opts, async () => {
  const buf = Buffer.from('{"a":1}');
  const t = 1_800_000_000;
  const h = (ts) => ({ 'x-ipam-timestamp': String(ts), 'x-hub-signature-256': firma(buf.toString(), String(ts)) });
  assert.equal(mod.verificarWebhook(h(t), buf, t * 1000 + 299_000).ok, true);
  assert.equal(mod.verificarWebhook(h(t + 1), buf, (t + 1) * 1000 + 301_000).ok, false);
  assert.equal(mod.verificarWebhook(h(t + 2), buf, (t + 2) * 1000).ok, true);
  assert.equal(mod.verificarWebhook(h(t + 3), Buffer.from('otro'), (t + 3) * 1000).ok, false, 'firmado para otro cuerpo');
  assert.notEqual(mod.firmar(String(t), buf), mod.firmar(String(t + 1), buf));
});

test('simulador: disponible fuera de producción; en producción solo con ENABLE_SIMULADOR=true', opts, async () => {
  const simular = () => post('/api/jira/simular', { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'vpc-sim' });
  const limpiar = async () => { for (const a of await (await fetch(base + '/api/asignaciones?q=vpc-sim')).json()) await borrar(a.id); };
  assert.equal((await (await fetch(base + '/api/jira/estado')).json()).simulador, true);
  const r = await simular();
  assert.equal(r.status, 200);
  assert.match((await r.json()).ticket, /^NET-\d+$/);
  const ev = (await eventos()).find((e) => e.tipo === 'jira_webhook_recibido');
  assert.match(ev.detalle.timestamp, /^\d{10}$/, 'el simulador firma con timestamp');
  await limpiar();

  const antes = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await (await fetch(base + '/api/jira/estado')).json()).simulador, false);
    const bloqueado = await simular();
    assert.equal(bloqueado.status, 404);
    process.env.ENABLE_SIMULADOR = 'true';
    assert.equal((await (await fetch(base + '/api/jira/estado')).json()).simulador, true);
    assert.equal((await simular()).status, 200);
  } finally {
    delete process.env.ENABLE_SIMULADOR;
    if (antes === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = antes;
    await limpiar();
  }
});

test('JIRA_WEBHOOK_SECRET: en producción falta o es el valor de ejemplo → error; fuera de producción se tolera', opts, async () => {
  const prod = { NODE_ENV: 'production' };
  assert.throws(() => jiraMod.validarSecretoWebhook(prod), /JIRA_WEBHOOK_SECRET/);
  assert.throws(() => jiraMod.validarSecretoWebhook({ ...prod, JIRA_WEBHOOK_SECRET: 'dev-secret-cambiar' }), /valor de ejemplo/);
  assert.doesNotThrow(() => jiraMod.validarSecretoWebhook({ ...prod, JIRA_WEBHOOK_SECRET: 'un-secreto-largo-y-propio' }));
  assert.doesNotThrow(() => jiraMod.validarSecretoWebhook({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => jiraMod.validarSecretoWebhook({}));
});

// Arranca el servidor real como proceso y devuelve cómo terminó (para probar que se niega a arrancar).
const arrancar = (extra) => new Promise((ok) => {
  const hijo = spawn(process.execPath, [require.resolve('./server')], {
    env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, PORT: '0', RETENCION_DIAS: '0', ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; if (/escuchando/.test(salida)) hijo.kill('SIGTERM'); });
  hijo.stderr.on('data', (d) => { salida += d; });
  hijo.on('exit', (codigo) => ok({ codigo, salida }));
});

test('arranque en producción: sin secreto del webhook o sin autenticación explícita, no arranca', opts, async () => {
  const sinSecreto = await arrancar({ NODE_ENV: 'production', AUTH_MODE: 'none' });
  assert.notEqual(sinSecreto.codigo, 0);
  assert.match(sinSecreto.salida, /JIRA_WEBHOOK_SECRET es obligatorio/);

  const ejemplo = await arrancar({ NODE_ENV: 'production', AUTH_MODE: 'none', JIRA_WEBHOOK_SECRET: 'dev-secret-cambiar' });
  assert.notEqual(ejemplo.codigo, 0);
  assert.match(ejemplo.salida, /valor de ejemplo/);

  const sinAuth = await arrancar({ NODE_ENV: 'production', JIRA_WEBHOOK_SECRET: 'secreto-propio-de-pruebas' });
  assert.notEqual(sinAuth.codigo, 0);
  assert.match(sinAuth.salida, /no arranca sin autenticación/);

  const abierto = await arrancar({ NODE_ENV: 'production', AUTH_MODE: 'none', JIRA_WEBHOOK_SECRET: 'secreto-propio-de-pruebas' });
  assert.equal(abierto.codigo, 0, abierto.salida);
  assert.match(abierto.salida, /sin autenticación \(modo none\)/);

  const basic = await arrancar({ NODE_ENV: 'production', APP_USER: 'u', APP_PASS: 'p', JIRA_WEBHOOK_SECRET: 'secreto-propio-de-pruebas' });
  assert.equal(basic.codigo, 0, basic.salida);
});

test('cabeceras: Permissions-Policy y Referrer-Policy', opts, async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const pp = r.headers.get('permissions-policy');
  for (const f of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()']) assert.ok(pp.includes(f), f);
});

test('PUT /api/usuarios/:email valida el formato del correo', opts, async () => {
  const put = (email, rol = 'lector') => fetch(`${base}/api/usuarios/${encodeURIComponent(email)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ rol }) });
  for (const malo of ['sin-arroba', 'a@b', '@x.cl', 'a b@x.cl', 'a@@x.cl', 'x'.repeat(65) + '@x.cl', 'a@' + 'x'.repeat(250) + '.cl', '<script>@x.cl', "a'; drop table usuarios;--@x.cl"]) {
    assert.equal((await put(malo)).status, 400, malo);
  }
  const ok = await put('Persona.Prueba+1@Empresa-Test.cl');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).email, 'persona.prueba+1@empresa-test.cl');
  await db.query("delete from usuarios where email = 'persona.prueba+1@empresa-test.cl'");
});

test('limitador del webhook: pasado el máximo por minuto responde 429 con Retry-After', opts, async () => {
  const mal = () => fetch(base + '/webhook/jira', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  let r;
  for (let i = 0; i < 60; i++) { r = await mal(); if (r.status === 429) break; }
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).error, 'demasiados_intentos');
});
