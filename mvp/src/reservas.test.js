// Reservas tentativas contra PostgreSQL real, a través de HTTP: ciclo completo, expiración (reloj de la base), barredor,
// concurrencia con dos instancias y garantías que la base da aunque se salten la API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio, dormir } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const H = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const SIN_SOLAPES = `select count(*)::int as n from (
    select 'r' || id::text as id, pool_id, cidr from reservas where estado = 'reservada'
    union all select 'a' || id::text, pool_id, cidr from asignaciones) x
  join (select 'r' || id::text as id, pool_id, cidr from reservas where estado = 'reservada'
    union all select 'a' || id::text, pool_id, cidr from asignaciones) y
    on x.id < y.id and x.pool_id = y.pool_id and x.cidr && y.cidr`;

let b, s, s2, url;
const llamar = (metodo, ruta, cuerpo, h = {}, base = url) =>
  fetch(base + ruta, { method: metodo, headers: { ...H, ...h }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const json = async (r) => ({ estado: r.status, cuerpo: await r.json() });
const reservar = (cuerpo, clave, base) =>
  llamar(
    'POST',
    '/api/reservas',
    { ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'vpc-prueba', ...cuerpo },
    clave ? { 'Idempotency-Key': clave } : {},
    base,
  );

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  s = await lanzarServicio({ DATABASE_URL: b.url, BARREDOR_INTERVALO_SEGUNDOS: '5' });
  s2 = await lanzarServicio({ DATABASE_URL: b.url, BARREDOR_INTERVALO_SEGUNDOS: '5' });
  url = s.url;
});
test.after(async () => {
  if (!hayBase) return;
  await Promise.all([s.parar(), s2.parar()]);
  await b.borrar();
});

test('ciclo completo: reservar → ver → confirmar (origen agente) → liberar borra la asignación; todo idempotente', opts, async () => {
  const r = await json(await reservar({ ticket: 'NET-901' }, 'ciclo-1'));
  assert.equal(r.estado, 201);
  assert.deepEqual(
    { pool: r.cuerpo.pool_id, estado: r.cuerpo.estado, rep: r.cuerpo.repetida, ticket: r.cuerpo.ticket },
    { pool: 'gke-nodos-qa', estado: 'reservada', rep: false, ticket: 'NET-901' },
  );
  assert.ok(r.cuerpo.segundos_restantes > 86000 && r.cuerpo.segundos_restantes <= 86400);
  const id = r.cuerpo.id;

  const rep = await json(await reservar({ ticket: 'NET-901' }, 'ciclo-1'));
  assert.deepEqual({ estado: rep.estado, rep: rep.cuerpo.repetida, id: rep.cuerpo.id }, { estado: 200, rep: true, id });

  const pools = await (await fetch(`${url}/api/pools?ambiente=qa&tipo=Nodos`)).json();
  assert.equal(pools.length, 1);
  assert.equal(pools[0].reservas_vigentes, 1);
  assert.equal(pools[0].asignaciones, 1, 'la asignación semilla; la reserva aún no cuenta como definitiva');
  assert.equal((await (await fetch(`${url}/api/v1/pools?ambiente=dev&tipo=NoExiste`)).json()).length, 0);

  assert.equal((await json(await fetch(`${url}/api/reservas/${id}`))).cuerpo.estado, 'reservada');
  assert.ok((await (await fetch(`${url}/api/v1/reservas?estado=reservada&pool=gke-nodos-qa`)).json()).some((x) => x.id === id));

  const c = await json(await llamar('POST', `/api/reservas/${id}/confirmar`, {}));
  assert.equal(c.estado, 200);
  assert.deepEqual(
    { estado: c.cuerpo.estado, origen: c.cuerpo.asignacion.origen, cidr: c.cuerpo.asignacion.cidr, rep: c.cuerpo.repetida },
    { estado: 'confirmada', origen: 'agente', cidr: r.cuerpo.cidr, rep: false },
  );
  assert.ok((await (await fetch(`${url}/api/asignaciones`)).json()).some((a) => a.origen === 'agente' && a.cidr === r.cuerpo.cidr));
  const c2 = await json(await llamar('POST', `/api/reservas/${id}/confirmar`, {}));
  assert.deepEqual({ estado: c2.estado, rep: c2.cuerpo.repetida }, { estado: 200, rep: true });
  assert.equal((await b.sql("select count(*)::int as n from asignaciones where origen = 'agente'")).rows[0].n, 1);

  const l = await json(await llamar('DELETE', `/api/reservas/${id}`));
  assert.deepEqual({ estado: l.estado, est: l.cuerpo.estado, borrada: l.cuerpo.asignacion_borrada }, { estado: 200, est: 'liberada', borrada: true });
  assert.equal((await b.sql("select count(*)::int as n from asignaciones where origen = 'agente'")).rows[0].n, 0);
  const l2 = await json(await llamar('DELETE', `/api/reservas/${id}`));
  assert.deepEqual({ estado: l2.estado, rep: l2.cuerpo.repetida }, { estado: 200, rep: true });

  const aud = (await b.sql("select accion from auditoria where accion like '%reserva%' or accion = 'reservar' order by id")).rows.map((x) => x.accion);
  assert.deepEqual(aud, ['reservar', 'confirmar_reserva', 'liberar_reserva']);
  assert.deepEqual(
    (await b.sql("select distinct tipo from eventos where tipo like 'reserva_%' order by 1")).rows.map((x) => x.tipo),
    ['reserva_confirmada', 'reserva_creada', 'reserva_liberada'],
  );
});

test('misma clave con reserva liberada → 409 (nunca 200); con otra petición → 409; errores con código y request_id', opts, async () => {
  const a = await json(await reservar({}, 'idem-409'));
  await llamar('DELETE', `/api/reservas/${a.cuerpo.id}`);
  const r = await json(await reservar({}, 'idem-409'));
  assert.equal(r.estado, 409);
  assert.deepEqual({ e: r.cuerpo.error, est: r.cuerpo.estado }, { e: 'clave_idem_usada', est: 'liberada' });
  assert.ok(r.cuerpo.request_id && r.cuerpo.mensaje);

  const b1 = await json(await reservar({}, 'idem-otra'));
  const b2 = await json(await reservar({ vpc: 'otra-vpc' }, 'idem-otra'));
  assert.deepEqual({ estado: b2.estado, e: b2.cuerpo.error }, { estado: 409, e: 'idempotencia_conflicto' });
  await llamar('DELETE', `/api/reservas/${b1.cuerpo.id}`);
});

test('expiración con el reloj de la base: vencida = expirada al consultar; deja de ocupar; confirmar → 409; misma clave → 409', opts, async () => {
  const a = await json(await reservar({ mascara: undefined, cidr: '10.20.200.0/24' }, 'exp-1'));
  assert.equal(a.estado, 201);
  const choque = await json(await reservar({ mascara: undefined, cidr: '10.20.200.0/24' }));
  assert.deepEqual({ estado: choque.estado, e: choque.cuerpo.error, f: choque.cuerpo.conflicto.fuente }, { estado: 409, e: 'solapamiento', f: 'reserva' });
  assert.ok(choque.cuerpo.sugeridos.length > 0);

  await b.sql("update reservas set expira_en = now() - interval '1 minute' where id = $1", [a.cuerpo.id]);
  assert.equal((await json(await fetch(`${url}/api/reservas/${a.cuerpo.id}`))).cuerpo.estado, 'expirada');
  assert.equal(
    (await b.sql('select estado from reservas where id = $1', [a.cuerpo.id])).rows[0].estado,
    'reservada',
    'la base aún dice «reservada»: la expiración es perezosa',
  );
  assert.equal((await (await fetch(`${url}/api/pools?ambiente=qa`)).json())[0].reservas_vigentes, 0);
  const c = await json(await llamar('POST', `/api/reservas/${a.cuerpo.id}/confirmar`, {}));
  assert.deepEqual({ estado: c.estado, e: c.cuerpo.error }, { estado: 409, e: 'reserva_no_vigente' });
  assert.equal((await json(await reservar({ mascara: undefined, cidr: '10.20.200.0/24' }, 'exp-1'))).estado, 409, 'misma clave con reserva expirada');
  const nueva = await json(await reservar({ mascara: undefined, cidr: '10.20.200.0/24' }));
  assert.equal(nueva.estado, 201, 'el rango vencido quedó libre');
  await llamar('DELETE', `/api/reservas/${nueva.cuerpo.id}`);
});

test('barredor real: marca como expiradas las vencidas y deja evento (cada ~5 s), aunque haya dos réplicas', opts, async () => {
  const a = await json(await reservar({ mascara: undefined, cidr: '10.20.201.0/24' }));
  await b.sql("update reservas set expira_en = now() - interval '1 second' where id = $1", [a.cuerpo.id]);
  let estado;
  for (let i = 0; i < 40; i++) {
    estado = (await b.sql('select estado from reservas where id = $1', [a.cuerpo.id])).rows[0].estado;
    if (estado === 'expirada') break;
    await dormir(500);
  }
  assert.equal(estado, 'expirada', 'el barredor la limpió');
  const ev = (await b.sql("select detalle from eventos where tipo = 'reserva_expirada' and detalle->>'reserva' = $1", [a.cuerpo.id])).rows;
  assert.equal(ev.length, 1, 'un solo evento aunque haya dos réplicas');
  const est = (await b.sql('select ultima_ejecucion is not null as hecho from barredor_estado')).rows[0];
  assert.equal(est.hecho, true);
});

test('pool ambiguo → 422 con las opciones; mascara y cidr inconsistentes y TTL sobre el máximo → 400', opts, async () => {
  await b.sql("insert into pools (id,tipo,ambiente,proveedor,cidr) values ('gke-nodos-qa-2','Nodos','qa','GCP','10.77.0.0/16')");
  const r = await json(await reservar({}));
  assert.equal(r.estado, 422);
  assert.deepEqual({ e: r.cuerpo.error, pools: r.cuerpo.opciones.map((o) => o.pool) }, { e: 'ambiguo', pools: ['gke-nodos-qa', 'gke-nodos-qa-2'] });
  const ok = await json(await reservar({ pool: 'gke-nodos-qa-2' }));
  assert.equal(ok.estado, 201);
  await llamar('DELETE', `/api/reservas/${ok.cuerpo.id}`);
  await b.sql("delete from reservas where pool_id = 'gke-nodos-qa-2'");
  await b.sql("delete from pools where id = 'gke-nodos-qa-2'");
  assert.equal((await json(await reservar({ ttl_horas: 73 }))).cuerpo.error, 'ttl_excede_maximo');
  assert.equal((await json(await reservar({ ttl_horas: 72 }))).estado, 201);
  assert.equal((await json(await reservar({ mascara: 22, cidr: '10.20.8.0/24' }))).cuerpo.error, 'mascara_no_coincide');
  assert.equal((await json(await reservar({ pool: 'nope', ambiente: undefined, tipo: undefined }))).estado, 404);
  assert.equal((await json(await llamar('POST', '/api/reservas/no-es-uuid/confirmar', {}))).estado, 404);
  const forma = await json(await llamar('POST', '/api/reservas', { vpc: 5 }));
  assert.deepEqual(
    { e: forma.estado, c: forma.cuerpo.error, campo: forma.cuerpo.detalles[0].campo },
    { e: 400, c: 'validacion', campo: '/vpc' },
    'la forma la valida el contrato',
  );
  assert.equal(
    (await json(await llamar('POST', '/api/reservas', { vpc: '   ', ambiente: 'qa', tipo: 'Nodos', mascara: 24 }))).cuerpo.error,
    'vpc_invalido',
    'las reglas de negocio las valida el dominio',
  );
  await b.sql("update reservas set estado = 'liberada' where estado = 'reservada'");
});

test('concurrencia entre DOS instancias: 40 reservas y 20 asignaciones a la vez → ninguna se solapa', opts, async () => {
  const pedir = (i) =>
    i % 3 === 0
      ? llamar('POST', '/api/solicitudes', { pool: 'gke-nodos-qa', vpc: `conc-a-${i}`, mascara: 24 }, {}, i % 2 ? s.url : s2.url)
      : reservar({ vpc: `conc-r-${i}` }, `conc-${i}`, i % 2 ? s.url : s2.url);
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => pedir(i)));
  const estados = rs.map((r) => r.status);
  assert.ok(
    estados.every((e) => e === 201),
    `estados inesperados: ${JSON.stringify(estados.filter((e) => e !== 201))}`,
  );
  const cuerpos = await Promise.all(rs.map((r) => r.json()));
  assert.equal(new Set(cuerpos.map((c) => c.cidr)).size, 60, 'ningún rango repetido');
  assert.equal((await b.sql(SIN_SOLAPES)).rows[0].n, 0, 'sin solapes entre reservas y asignaciones');
  // Reintentos simultáneos con la MISMA clave desde las dos instancias: una sola reserva.
  const mismas = await Promise.all(Array.from({ length: 10 }, (_, i) => reservar({ vpc: 'misma-clave' }, 'clave-compartida', i % 2 ? s.url : s2.url)));
  const ids = new Set((await Promise.all(mismas.map((r) => r.json()))).map((c) => c.id));
  assert.equal(ids.size, 1);
  assert.equal(mismas.filter((r) => r.status === 201).length, 1, 'solo una creó; las demás repiten');
  assert.equal((await b.sql(SIN_SOLAPES)).rows[0].n, 0);
});

test('garantías de la base aunque se salten la API (disparadores y restricciones)', opts, async () => {
  const insertarReserva = (cidr, pool = 'gke-nodos-qa', clave = null, solicitante = 'directo') =>
    b.sql("insert into reservas (pool_id, cidr, vpc, solicitante, ticket, clave_idem, expira_en) values ($1,$2,'v',$3,'NET-1',$4, now() + interval '1 hour')", [
      pool,
      cidr,
      solicitante,
      clave,
    ]);
  await insertarReserva('10.20.230.0/24');
  await assert.rejects(insertarReserva('10.20.230.128/25'), (e) => e.code === '23P01', 'dos reservas vigentes no se solapan (exclusión GiST)');
  await assert.rejects(
    b.sql("insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket) values ('gke-nodos-qa','10.20.230.0/25','v','x','NET-2')"),
    (e) => e.code === '23P01',
    'una asignación no pisa una reserva vigente',
  );
  await assert.rejects(insertarReserva('10.20.0.0/22'), (e) => e.code === '23P01', 'una reserva no pisa una asignación (semilla 10.20.0.0/20)');
  await assert.rejects(insertarReserva('10.99.0.0/24'), (e) => e.code === '23514', 'fuera del pool');
  await insertarReserva('10.20.231.0/24', 'gke-nodos-qa', 'k-unica', 'dup');
  await assert.rejects(
    insertarReserva('10.20.232.0/24', 'gke-nodos-qa', 'k-unica', 'dup'),
    (e) => e.code === '23505',
    'índice único (solicitante, clave_idem)',
  );
  await insertarReserva('10.20.232.0/24', 'gke-nodos-qa', 'k-unica', 'otro');
  // Una reserva VENCIDA no bloquea una asignación aunque el barredor aún no la haya marcado.
  await b.sql("update reservas set expira_en = now() - interval '1 minute' where cidr = '10.20.230.0/24'");
  await b.sql("insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen) values ('gke-nodos-qa','10.20.230.0/25','v','x','NET-3','agente')");
  assert.equal((await b.sql("select origen from asignaciones where ticket = 'NET-3'")).rows[0].origen, 'agente', 'el origen «agente» es válido');
  await assert.rejects(
    b.sql("insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket, origen) values ('gke-nodos-qa','10.20.240.0/24','v','x','NET-4','otro')"),
    (e) => e.code === '23514',
  );
});

test('rutas versionadas: /api/v1/reservas es equivalente al alias /api/reservas', opts, async () => {
  const a = await json(await llamar('POST', '/api/v1/reservas', { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'v1' }, { 'Idempotency-Key': 'v1-1' }));
  assert.equal(a.estado, 201);
  const b2 = await json(await llamar('POST', '/api/reservas', { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'v1' }, { 'Idempotency-Key': 'v1-1' }));
  assert.deepEqual({ e: b2.estado, id: b2.cuerpo.id }, { e: 200, id: a.cuerpo.id });
  assert.equal((await json(await fetch(`${url}/api/v1/reservas/${a.cuerpo.id}`))).cuerpo.id, a.cuerpo.id);
});
