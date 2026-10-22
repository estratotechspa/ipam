// Integración del servicio completo contra PostgreSQL real (cada prueba usa su propia base temporal).
// Cubre: sondas, correlación (X-Request-Id), arranque seguro, esquema fuera del arranque, apagado ordenado, barredor con varias réplicas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { hayBase, crearBaseAislada, lanzarServicio, dormir, RAIZ, SQL } = require('./pruebas/ayudas');
const { crearRepositorio } = require('./adaptadores/persistencia/postgres/repositorio');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const PROD_ANON = { NODE_ENV: 'production', ALLOW_ANONYMOUS: 'true' };
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const tablas = async (b) => (await b.sql("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map((r) => r.table_name);
const migrar = (b, extra = {}) => spawnSync(process.execPath, [path.join(RAIZ, 'src', 'cli', 'migrar.js')], { env: { PATH: process.env.PATH, DATABASE_URL: b.url, ...extra }, encoding: 'utf8' });

test('/healthz no toca la base; /readyz da 503 si la base no responde', opts, async () => {
  const s = await lanzarServicio({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', DB_CONNECT_TIMEOUT_MS: '300' });
  try {
    assert.deepEqual(await (await fetch(`${s.url}/healthz`)).json(), { ok: true });
    const r = await fetch(`${s.url}/readyz`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).motivo, 'bd_inalcanzable');
    assert.equal((await fetch(`${s.url}/api/health`)).status, 503);
  } finally { await s.parar(); }
});

test('/readyz: listo con el esquema al día, con la versión', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url });
  try {
    const r = await fetch(`${s.url}/readyz`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.ok(d.esquema.version >= d.esquema.minima);
  } finally { await s.parar(); await b.borrar(); }
});

test('correlación: X-Request-Id se acepta, se genera si falta, se reemplaza si es inválido y llega a errores, logs y auditoría', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url });
  try {
    const dado = 'prueba-correlacion-123';
    const r1 = await fetch(`${s.url}/api/pools`, { headers: { 'X-Request-Id': dado } });
    assert.equal(r1.headers.get('x-request-id'), dado);
    const r2 = await fetch(`${s.url}/api/pools`);
    assert.match(r2.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    const r3 = await fetch(`${s.url}/api/pools`, { headers: { 'X-Request-Id': 'x; DROP TABLE auditoria' } });
    assert.match(r3.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);

    const nf = await fetch(`${s.url}/api/no-existe`, { headers: { 'X-Request-Id': dado } });
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).request_id, dado);

    const idAuditoria = 'auditoria-trace-0001';
    const a = await fetch(`${s.url}/api/solicitudes`, { method: 'POST', headers: { ...H, 'X-Request-Id': idAuditoria }, body: JSON.stringify({ pool: 'gke-nodos-qa', vpc: 'corr', mascara: 24 }) });
    assert.equal(a.status, 201);
    const fila = (await b.sql("select request_id from auditoria where accion='asignar'")).rows[0];
    assert.equal(fila.request_id, idAuditoria);
    assert.ok(s.logs().some((l) => l.request_id === idAuditoria && l.mensaje === 'petición' && l.estado === 201 && l.duracion_ms >= 0 && l.actor === 'anonimo'));
  } finally { await s.parar(); await b.borrar(); }
});

test('errores: nunca devuelven trazas ni detalles internos, solo el request_id; los cuerpos inválidos o enormes se rechazan', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url });
  try {
    await b.sql('drop table asignaciones cascade'); // fuerza un fallo interno real
    const r = await fetch(`${s.url}/api/asignaciones`, { headers: { 'X-Request-Id': 'falla-interna-001' } });
    assert.equal(r.status, 500);
    const txt = await r.text();
    assert.ok(!/relation|asignaciones|stack|at |pg_|syntax/i.test(txt), `filtró detalles: ${txt}`);
    assert.equal(JSON.parse(txt).request_id, 'falla-interna-001');
    assert.ok(s.logs().some((l) => l.nivel === 'error' && l.request_id === 'falla-interna-001'), 'la causa sí queda en el log del servidor');

    const malo = await fetch(`${s.url}/api/solicitudes`, { method: 'POST', headers: H, body: '{no es json' });
    assert.equal(malo.status, 400);
    assert.equal((await malo.json()).error, 'cuerpo_invalido');
    const grande = await fetch(`${s.url}/api/solicitudes`, { method: 'POST', headers: H, body: JSON.stringify({ vpc: 'x'.repeat(200 * 1024) }) });
    assert.equal(grande.status, 413);
  } finally { await s.parar(); await b.borrar(); }
});

test('arranque seguro: en producción sin autenticación NO arranca; con ALLOW_ANONYMOUS=true arranca; con Basic avisa', opts, async () => {
  const b = await crearBaseAislada();
  try {
    const sin = await lanzarServicio({ NODE_ENV: 'production', DATABASE_URL: b.url }, { esperar: false });
    const fin = await sin.salida;
    assert.equal(fin.codigo, 1);
    assert.ok(sin.logs().some((l) => /no arranca/.test(l.mensaje) && /sin autenticación/.test(JSON.stringify(l.problemas))));

    const anon = await lanzarServicio({ ...PROD_ANON, DATABASE_URL: b.url });
    assert.ok(anon.logs().some((l) => l.nivel === 'warn' && /ALLOW_ANONYMOUS/.test(l.mensaje)));
    await anon.parar();

    const basic = await lanzarServicio({ NODE_ENV: 'production', DATABASE_URL: b.url, APP_USER: 'admin', APP_PASS: 'x' });
    assert.ok(basic.logs().some((l) => l.nivel === 'warn' && /Modo Basic/.test(l.mensaje)), 'el modo Basic avisa al arrancar');
    assert.equal((await fetch(`${basic.url}/api/pools`)).status, 401);
    await basic.parar();
  } finally { await b.borrar(); }
});

test('la app NO modifica el esquema al arrancar en producción (salvo MIGRAR_AL_ARRANCAR=true)', opts, async () => {
  const b = await crearBaseAislada({ esquema: false });
  try {
    const antes = await tablas(b);
    const s = await lanzarServicio({ ...PROD_ANON, DATABASE_URL: b.url });
    const r = await fetch(`${s.url}/readyz`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).motivo, 'esquema_desactualizado');
    assert.deepEqual(await tablas(b), antes, 'no creó ni una tabla');
    await s.parar();

    const m = await lanzarServicio({ ...PROD_ANON, DATABASE_URL: b.url, MIGRAR_AL_ARRANCAR: 'true' });
    assert.ok(m.logs().some((l) => /MIGRAR_AL_ARRANCAR=true/.test(l.mensaje)));
    assert.equal((await fetch(`${m.url}/readyz`)).status, 200);
    assert.ok((await tablas(b)).includes('asignaciones'));
    await m.parar();
  } finally { await b.borrar(); }
});

test('`npm run migrar`: se puede aplicar dos veces y migra desde el esquema viejo sin perder datos', opts, async () => {
  const viejo = await crearBaseAislada({ esquema: false });
  try {
    await viejo.aplicar(fs.readFileSync(path.join(__dirname, 'pruebas', 'esquema-v1.sql'), 'utf8'));
    await viejo.aplicarSemilla();
    const n = (await viejo.sql('select count(*)::int as n from asignaciones')).rows[0].n;
    assert.equal(n, 12);
    for (let i = 0; i < 2; i++) {
      const r = migrar(viejo);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    assert.equal((await viejo.sql('select count(*)::int as n from asignaciones')).rows[0].n, 12, 'los datos siguen ahí');
    assert.ok((await viejo.sql('select max(version) as v from esquema_version')).rows[0].v >= 2);
    // El origen «agente» ya es válido en la base migrada, y la tabla de reservas existe con sus garantías.
    await viejo.sql("insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen) values ('gke-nodos-qa','10.20.250.0/24','v','x','NET-A','agente')");
    await viejo.sql("insert into reservas (pool_id, cidr, vpc, solicitante, ticket, expira_en) values ('gke-nodos-qa','10.20.251.0/24','v','x','NET-B', now() + interval '1 hour')");
    await assert.rejects(viejo.sql("insert into reservas (pool_id, cidr, vpc, solicitante, ticket, expira_en) values ('gke-nodos-qa','10.20.251.0/25','v','x','NET-C', now() + interval '1 hour')"), (e) => e.code === '23P01');
    // La auditoría quedó de solo inserción.
    await viejo.sql("insert into auditoria (usuario, accion) values ('t','x')");
    await assert.rejects(viejo.sql("update auditoria set accion='y'"), /solo inserción/);
    await assert.rejects(viejo.sql('delete from auditoria'), /solo inserción/);
    await assert.rejects(viejo.sql('truncate auditoria'), /solo inserción/);
  } finally { await viejo.borrar(); }
});

test('el esquema se puede aplicar dos veces seguidas con psql-equivalente (sin errores)', opts, async () => {
  const b = await crearBaseAislada();
  try {
    await b.aplicarEsquema();
    await b.aplicarEsquema();
    assert.equal((await b.sql('select count(*)::int as n from esquema_version')).rows[0].n >= 1, true);
  } finally { await b.borrar(); }
});

test('esquema dedicado (DATABASE_SCHEMA=ipam): migrar y servicio trabajan solo en ese esquema, sin tocar public', opts, async () => {
  const b = await crearBaseAislada({ esquema: false });
  try {
    const m = migrar(b, { DATABASE_SCHEMA: 'ipam' });
    assert.equal(m.status, 0, m.stdout + m.stderr);
    assert.deepEqual(await tablas(b), [], 'public sigue vacío');
    const enIpam = (await b.sql("select table_name from information_schema.tables where table_schema='ipam'")).rows.map((r) => r.table_name);
    assert.ok(enIpam.includes('asignaciones') && enIpam.includes('esquema_version'));
    await b.sql("set search_path to ipam"); await b.aplicarSemilla();
    const s = await lanzarServicio({ DATABASE_URL: b.url, DATABASE_SCHEMA: 'ipam' });
    try {
      assert.equal((await fetch(`${s.url}/readyz`)).status, 200);
      assert.equal((await (await fetch(`${s.url}/api/resumen`)).json()).pools, 6);
      const a = await fetch(`${s.url}/api/solicitudes`, { method: 'POST', headers: H, body: JSON.stringify({ pool: 'gke-nodos-qa', vpc: 'esq', mascara: 24 }) });
      assert.equal(a.status, 201);
    } finally { await s.parar(); }
    assert.deepEqual(await tablas(b), [], 'public sigue vacío después de usar el servicio');
  } finally { await b.borrar(); }
});

test('DATABASE_URL_FILE: el servicio arranca leyendo la cadena de conexión desde un archivo', opts, async () => {
  const b = await crearBaseAislada();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-sec-'));
  fs.writeFileSync(path.join(dir, 'url'), `${b.url}\n`);
  const s = await lanzarServicio({ DATABASE_URL_FILE: path.join(dir, 'url') });
  try {
    assert.equal((await fetch(`${s.url}/readyz`)).status, 200);
    assert.ok(!s.crudo().includes(b.url), 'la cadena de conexión no aparece en los logs');
  } finally { await s.parar(); await b.borrar(); fs.rmSync(dir, { recursive: true }); }
});

test('ROL=worker: expone solo sondas (no la API)', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url, ROL: 'worker' });
  try {
    assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.url}/readyz`)).status, 200);
    assert.equal((await fetch(`${s.url}/api/pools`)).status, 404);
  } finally { await s.parar(); await b.borrar(); }
});

test('apagado ordenado: con SIGTERM deja de aceptar conexiones, termina la petición en curso y cierra con código 0', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url });
  try {
    // Petición «en vuelo»: cabeceras enviadas, cuerpo a medias.
    const cuerpo = JSON.stringify({ pool: 'gke-nodos-qa', vpc: 'apagado-ordenado', mascara: 24 });
    const sock = net.connect(s.puerto, '127.0.0.1');
    let respuesta = '';
    sock.on('data', (d) => { respuesta += d; });
    await new Promise((ok) => sock.on('connect', ok));
    sock.write(`POST /api/solicitudes HTTP/1.1\r\nHost: x\r\nX-Requested-With: ipam\r\nContent-Type: application/json\r\nContent-Length: ${cuerpo.length}\r\nConnection: close\r\n\r\n${cuerpo.slice(0, 10)}`);
    await dormir(100);
    s.proceso.kill('SIGTERM');
    await dormir(300);
    // Ya no acepta conexiones nuevas…
    await assert.rejects(fetch(`${s.url}/healthz`, { signal: AbortSignal.timeout(1500) }));
    // …pero la petición en curso se completa.
    sock.write(cuerpo.slice(10));
    const fin = await Promise.race([s.salida, dormir(10000).then(() => ({ codigo: 'tiempo' }))]);
    assert.equal(fin.codigo, 0, s.crudo());
    assert.match(respuesta, /^HTTP\/1\.1 201/);
    assert.ok(s.logs().some((l) => l.mensaje === 'Apagado completo'));
    assert.equal((await b.sql("select count(*)::int as n from asignaciones where vpc='apagado-ordenado'")).rows[0].n, 1);
  } finally { await s.parar('SIGKILL'); await b.borrar(); }
});

test('barredor con varias réplicas: solo una lo ejecuta a la vez y no se repite sin necesidad', opts, async () => {
  const b = await crearBaseAislada();
  const p1 = new Pool({ connectionString: b.url, max: 3 });
  const p2 = new Pool({ connectionString: b.url, max: 3 });
  try {
    const r1 = crearRepositorio(p1), r2 = crearRepositorio(p2);
    const ejecuciones = [];
    const tarea = (nombre) => async () => { ejecuciones.push(nombre); await dormir(200); return { expiradas: [] }; };
    const ahora = new Date();
    const [a, c] = await Promise.all([
      r1.conBarredor({ ahora, minimoMs: 1000, instancia: 'A' }, tarea('A')),
      r2.conBarredor({ ahora, minimoMs: 1000, instancia: 'B' }, tarea('B')),
    ]);
    assert.equal([a, c].filter((x) => x.ejecutado).length, 1, 'exactamente una réplica lo ejecutó');
    assert.equal([a, c].find((x) => !x.ejecutado).motivo, 'otra_instancia');
    // Justo después, otra réplica ve que ya se ejecutó hace poco y no repite el trabajo.
    const d = await r2.conBarredor({ ahora: new Date(), minimoMs: 60_000, instancia: 'B' }, tarea('B'));
    assert.deepEqual({ e: d.ejecutado, m: d.motivo }, { e: false, m: 'reciente' });
    assert.equal(ejecuciones.length, 1);
    const est = (await b.sql('select instancia, ultima_ejecucion is not null as hecho from barredor_estado')).rows[0];
    assert.equal(est.hecho, true);
  } finally { await p1.end(); await p2.end(); await b.borrar(); }
});

test('dos instancias contra la misma base: no duplican asignaciones bajo concurrencia', opts, async () => {
  const b = await crearBaseAislada();
  const [s1, s2] = await Promise.all([lanzarServicio({ DATABASE_URL: b.url }), lanzarServicio({ DATABASE_URL: b.url })]);
  try {
    const pedir = (s, i) => fetch(`${s.url}/api/solicitudes`, { method: 'POST', headers: H, body: JSON.stringify({ pool: 'gke-nodos-qa', vpc: `dos-${i}`, mascara: 24 }) });
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => pedir(i % 2 ? s1 : s2, i)));
    assert.ok(rs.every((r) => r.status === 201), 'todas se asignaron');
    const cidrs = (await Promise.all(rs.map((r) => r.json()))).map((x) => x.cidr);
    assert.equal(new Set(cidrs).size, 30, 'ningún segmento repetido entre instancias');
  } finally { await Promise.all([s1.parar(), s2.parar()]); await b.borrar(); }
});

test('el SQL del esquema es PostgreSQL estándar: solo la extensión contrib btree_gist', () => {
  const sql = SQL('schema.sql');
  const exts = [...sql.matchAll(/create extension[^;]*?(\w+);/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(exts)], ['btree_gist']);
});
