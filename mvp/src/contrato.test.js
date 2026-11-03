// Pruebas de contrato: las respuestas REALES del servicio (contra PostgreSQL) cumplen los esquemas del contrato OpenAPI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');
const { construirOpenApi } = require('./openapi');
const { crearValidador } = require('./adaptadores/http/validacion');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const doc = construirOpenApi();
const validador = crearValidador(doc);

let b, s, url, tokenAgente;
const escapar = (p) => p.replace(/~/g, '~0').replace(/\//g, '~1');
/** Valida cuerpo y estado de una respuesta real contra la operación del contrato (plantilla = ruta con {parametros}). */
async function verificar(r, metodo, plantilla) {
  const op = doc.paths[plantilla][metodo.toLowerCase()];
  assert.ok(op, `el contrato no tiene ${metodo} ${plantilla}`);
  const def = op.responses[String(r.status)];
  assert.ok(def, `${metodo} ${plantilla} devolvió ${r.status}, que el contrato NO documenta (documenta: ${Object.keys(op.responses).join(', ')})`);
  const tipo = r.headers.get('content-type') || '';
  if (!tipo.includes('application/json')) return null;
  const resuelta = def.$ref ? doc.components.responses[def.$ref.split('/').pop()] : def;
  assert.ok(
    resuelta.content && resuelta.content['application/json'],
    `${metodo} ${plantilla} ${r.status}: devuelve JSON pero el contrato no describe su cuerpo`,
  );
  const cuerpo = await r.json();
  const ref = def.$ref ? def.$ref.replace('#', '') : `/paths/${escapar(plantilla)}/${metodo.toLowerCase()}/responses/${r.status}`;
  const validar = validador.ajv.compile({ $ref: `openapi#${ref}/content/application~1json/schema` });
  assert.equal(
    validar(cuerpo),
    true,
    `${metodo} ${plantilla} ${r.status}: la respuesta no cumple el contrato\n${JSON.stringify(validar.errors, null, 1)}\ncuerpo: ${JSON.stringify(cuerpo)}`,
  );
  return cuerpo;
}
const llamar = (metodo, ruta, cuerpo, h = ADM) =>
  fetch(url + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const comoAgente = (extra = {}) => ({ Authorization: `Bearer ${tokenAgente}`, 'Content-Type': 'application/json', ...extra });

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  s = await lanzarServicio({ DATABASE_URL: b.url });
  url = s.url;
  const t = await (await llamar('POST', '/api/v1/tokens', { nombre: 'agente-contrato', rol: 'agente', cuota_reservas: 2 })).json();
  tokenAgente = t.token;
});
test.after(async () => {
  if (!hayBase) return;
  await s.parar();
  await b.borrar();
});

test('el contrato publicado por el servicio es el mismo que construye el código', opts, async () => {
  for (const ruta of ['/api/v1/openapi.json', '/api/v1/openapi.json']) {
    const r = await llamar('GET', ruta);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), JSON.parse(JSON.stringify({ ...doc })));
  }
  assert.equal(
    (await fetch(`${url}/api/v1/openapi.json`, { headers: { Authorization: `Bearer ipam_${'Z'.repeat(43)}` } })).status,
    401,
    'el contrato exige credenciales',
  );
});

test('lecturas: sondas, sesión, marca, pools, resumen, asignaciones, eventos', opts, async () => {
  await verificar(await fetch(`${url}/healthz`), 'GET', '/healthz');
  await verificar(await fetch(`${url}/readyz`), 'GET', '/readyz');
  await verificar(await fetch(`${url}/api/health`), 'GET', '/api/health');
  await verificar(await fetch(`${url}/api/config`), 'GET', '/api/config');
  await verificar(await llamar('GET', '/api/v1/me'), 'GET', '/api/v1/me');
  await verificar(await llamar('GET', '/api/v1/me', undefined, comoAgente()), 'GET', '/api/v1/me');
  const pools = await verificar(await llamar('GET', '/api/v1/pools?ambiente=qa'), 'GET', '/api/v1/pools');
  assert.ok(pools.length >= 1);
  await verificar(await llamar('GET', '/api/v1/pools'), 'GET', '/api/v1/pools');
  assert.equal((await verificar(await llamar('GET', '/api/v1/pools/gke-nodos-qa/libres?mascara=24'), 'GET', '/api/v1/pools/{id}/libres')).length, 3);
  await verificar(await llamar('GET', '/api/v1/pools/no-existe/libres?mascara=24'), 'GET', '/api/v1/pools/{id}/libres');
  await verificar(await llamar('GET', '/api/v1/pools/gke-nodos-qa/libres?mascara=3'), 'GET', '/api/v1/pools/{id}/libres');
  await verificar(await llamar('GET', '/api/v1/resumen'), 'GET', '/api/v1/resumen');
  await verificar(await llamar('GET', '/api/v1/asignaciones'), 'GET', '/api/v1/asignaciones');
  await verificar(await llamar('GET', '/api/v1/eventos'), 'GET', '/api/v1/eventos');
  await verificar(await llamar('GET', '/api/v1/jira/estado'), 'GET', '/api/v1/jira/estado');
});

test('asignaciones directas: 201, 400, 404, 409 con conflicto y sugeridos, y liberar', opts, async () => {
  const a = await verificar(await llamar('POST', '/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'contrato', mascara: 24 }), 'POST', '/api/v1/solicitudes');
  assert.equal(a.origen, 'panel');
  await verificar(await llamar('POST', '/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'contrato', cidr: a.cidr }), 'POST', '/api/v1/solicitudes');
  await verificar(await llamar('POST', '/api/v1/solicitudes', { pool: 'no-existe', vpc: 'x', mascara: 24 }), 'POST', '/api/v1/solicitudes');
  await verificar(await llamar('POST', '/api/v1/solicitudes', { pool: 'gke-nodos-qa', vpc: 'x', cidr: 'hola' }), 'POST', '/api/v1/solicitudes');
  const malo = await llamar('POST', '/api/v1/solicitudes', { pool: 5 });
  assert.equal(malo.status, 400);
  assert.equal((await verificar(malo, 'POST', '/api/v1/solicitudes')).error, 'validacion');
  await verificar(await llamar('POST', '/api/v1/solicitudes', { vpc: 'x' }, comoAgente()), 'POST', '/api/v1/solicitudes');
  await verificar(await llamar('DELETE', `/api/v1/asignaciones/${a.id}`), 'DELETE', '/api/v1/asignaciones/{id}');
  await verificar(await llamar('DELETE', `/api/v1/asignaciones/${a.id}`), 'DELETE', '/api/v1/asignaciones/{id}');
});

test('reservas: todos los códigos de respuesta reales cumplen el contrato', opts, async () => {
  const R = '/api/v1/reservas';
  const base = { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'contrato' };
  const crear = await llamar('POST', R, { ...base, ticket: 'NET-901' }, comoAgente({ 'Idempotency-Key': 'ct-1' }));
  assert.equal(crear.status, 201);
  const r = await verificar(crear, 'POST', R);
  const rep = await llamar('POST', R, { ...base, ticket: 'NET-901' }, comoAgente({ 'Idempotency-Key': 'ct-1' }));
  assert.equal(rep.status, 200);
  assert.equal((await verificar(rep, 'POST', R)).repetida, true);
  await verificar(await llamar('POST', R, { ...base, vpc: 'otra' }, comoAgente({ 'Idempotency-Key': 'ct-1' })), 'POST', R); // 409 idempotencia
  await verificar(await llamar('POST', R, { ...base, mascara: undefined, cidr: r.cidr }, comoAgente()), 'POST', R); // 409 solapamiento
  await verificar(await llamar('POST', R, { ...base, ttl_horas: 99 }, comoAgente()), 'POST', R); // 400
  await verificar(await llamar('POST', R, { ...base, campo_raro: 1 }, comoAgente()), 'POST', R); // 400 forma
  await verificar(await llamar('POST', R, { ...base, pool: 'no-existe', ambiente: undefined, tipo: undefined }, comoAgente()), 'POST', R); // 404
  await verificar(await llamar('POST', R, base, { ...ADM }), 'POST', R); // admin: 201
  await verificar(await llamar('POST', R, base, comoAgente()), 'POST', R); // 2.ª del token (cuota 2)
  await verificar(await llamar('POST', R, base, comoAgente()), 'POST', R); // 429 cuota
  await b.sql("insert into pools (id,tipo,ambiente,proveedor,cidr) values ('gke-nodos-qa-2','Nodos','qa','GCP','10.77.0.0/16')");
  await verificar(await llamar('POST', R, base, ADM), 'POST', R); // 422 ambiguo
  await verificar(await llamar('GET', R), 'GET', R);
  await verificar(await llamar('GET', `${R}?estado=rara`), 'GET', R); // 400
  await verificar(await llamar('GET', `${R}/${r.id}`), 'GET', `${R}/{id}`);
  await verificar(await llamar('GET', `${R}/no-es-uuid`), 'GET', `${R}/{id}`); // 404

  // Un token de servicio NO confirma (403): la aprobación humana es solo del admin.
  const noPuede = await llamar(
    'POST',
    `${R}/${r.id}/confirmar`,
    { aprobado_por: 'ana@empresa.example', referencia: 'https://gitlab.example/mr/1' },
    comoAgente(),
  );
  assert.equal(noPuede.status, 403);
  await verificar(noPuede, 'POST', `${R}/{id}/confirmar`);
  const conf = await llamar('POST', `${R}/${r.id}/confirmar`, { aprobado_por: 'ana@empresa.example', referencia: 'https://gitlab.example/mr/1' }, ADM);
  assert.equal(conf.status, 200);
  await verificar(conf, 'POST', `${R}/{id}/confirmar`);
  await verificar(await llamar('POST', `${R}/${r.id}/confirmar`, {}, ADM), 'POST', `${R}/{id}/confirmar`); // repetida
  await verificar(await llamar('POST', `${R}/${r.id}/confirmar`, { raro: 1 }, ADM), 'POST', `${R}/{id}/confirmar`); // 400 forma
  await verificar(await llamar('POST', `${R}/11111111-1111-4111-8111-111111111111/confirmar`, {}, ADM), 'POST', `${R}/{id}/confirmar`); // 404
  const otro = await (await llamar('POST', '/api/v1/tokens', { nombre: 'otro-contrato', rol: 'agente' })).json();
  await verificar(await llamar('DELETE', `${R}/${r.id}`, undefined, { Authorization: `Bearer ${otro.token}` }), 'DELETE', `${R}/{id}`); // 403 no es dueño
  const denegada = await llamar('DELETE', `${R}/${r.id}`, undefined, comoAgente()); // 403: la asignación definitiva solo la libera un admin
  assert.equal(denegada.status, 403);
  assert.equal((await verificar(denegada, 'DELETE', `${R}/{id}`)).error, 'solo_admin_libera_asignacion');
  const lib = await verificar(await llamar('DELETE', `${R}/${r.id}`, undefined, ADM), 'DELETE', `${R}/{id}`);
  assert.equal(lib.asignacion_borrada, true);
  await verificar(await llamar('DELETE', `${R}/${r.id}`, undefined, ADM), 'DELETE', `${R}/{id}`); // repetida
  const vieja = await (await llamar('POST', R, { ...base, pool: 'gke-nodos-qa-2', ambiente: undefined, tipo: undefined, ttl_horas: 1 }, ADM)).json();
  await b.sql("update reservas set expira_en = now() - interval '1 minute' where id = $1", [vieja.id]);
  await verificar(await llamar('POST', `${R}/${vieja.id}/confirmar`, {}, ADM), 'POST', `${R}/{id}/confirmar`); // 409 expirada
});

test('tokens, usuarios, auditoría, respaldo y Jira cumplen el contrato', opts, async () => {
  const T = '/api/v1/tokens';
  const creado = await verificar(await llamar('POST', T, { nombre: 'ct-token', rol: 'lector', expira_dias: 30 }), 'POST', T);
  assert.match(creado.token, /^ipam_/);
  await verificar(await llamar('POST', T, { nombre: 'ct-token', rol: 'lector' }), 'POST', T); // 409
  await verificar(await llamar('POST', T, { nombre: 'x', rol: 'admin' }), 'POST', T); // 400
  await verificar(await llamar('POST', T, { nombre: 'ct-2', rol: 'lector' }, comoAgente()), 'POST', T); // 403
  const lista = await verificar(await llamar('GET', T), 'GET', T);
  assert.ok(lista.every((t) => !('token' in t) && !('hash' in t)));
  await verificar(await llamar('GET', T, undefined, comoAgente()), 'GET', T); // 403
  await verificar(await llamar('DELETE', `${T}/${creado.id}`), 'DELETE', `${T}/{id}`);
  await verificar(await llamar('DELETE', `${T}/11111111-1111-4111-8111-111111111111`), 'DELETE', `${T}/{id}`); // 404

  await verificar(await llamar('GET', '/api/v1/usuarios'), 'GET', '/api/v1/usuarios');
  await verificar(await llamar('PUT', '/api/v1/usuarios/ana%40empresa.example', { rol: 'solicitante' }), 'PUT', '/api/v1/usuarios/{email}');
  await verificar(await llamar('PUT', '/api/v1/usuarios/ana%40empresa.example', { rol: 'dios' }), 'PUT', '/api/v1/usuarios/{email}'); // 400
  const aud = await verificar(await llamar('GET', '/api/v1/auditoria'), 'GET', '/api/v1/auditoria');
  assert.ok(aud.some((f) => f.accion === 'crear_token'));

  const resp = await verificar(await llamar('GET', '/api/v1/exportar.json'), 'GET', '/api/v1/exportar.json');
  await verificar(await llamar('POST', '/api/v1/importar', resp), 'POST', '/api/v1/importar');
  await verificar(await llamar('POST', '/api/v1/importar', { hola: 1 }), 'POST', '/api/v1/importar'); // 400

  await verificar(
    await llamar('POST', '/api/v1/jira/simular', { ambiente: 'dev', tipo: 'Nodos', mascara: 28, vpc: 'jira-ct' }),
    'POST',
    '/api/v1/jira/simular',
  );
  await verificar(
    await llamar('POST', '/api/v1/jira/simular', { ambiente: 'prod', tipo: 'Inexistente', mascara: 28, vpc: 'x' }),
    'POST',
    '/api/v1/jira/simular',
  ); // 422
  const x = await fetch(`${url}/api/v1/exportar.xlsx`, { headers: ADM });
  assert.equal(x.status, 200);
  await verificar(x, 'GET', '/api/v1/exportar.xlsx');
});

test('reserva en grupo y tabla ambiente + uso → pool: las respuestas reales cumplen el contrato y las reglas de rol', opts, async () => {
  const G = '/api/v1/reservas/grupo';
  const tg = await (await llamar('POST', '/api/v1/tokens', { nombre: 'agente-grupo', rol: 'agente', cuota_reservas: 5 })).json();
  const comoAgente = (extra = {}) => ({ Authorization: `Bearer ${tg.token}`, 'Content-Type': 'application/json', ...extra }); // un clúster pide 3 reservas
  for (const [id, cidr, limites] of [
    ['ct-lab-nodos', '10.160.0.0/16', { mascara_maxima: 29 }],
    ['ct-lab-pods', '10.168.0.0/13', { mascara_defecto: 14, mascara_minima: 13, mascara_maxima: 24 }],
    ['ct-lab-svc', '10.180.0.0/16', { mascara_defecto: 20 }],
  ])
    assert.equal((await llamar('POST', '/api/v1/pools', { id, tipo: 'x', ambiente: 'lab', proveedor: 'GCP', cidr, ...limites })).status, 201);
  // Los límites de máscara se ven en el pool y se editan (nulo los quita).
  const lp = (await (await llamar('GET', '/api/v1/pools?ambiente=lab')).json()).find((x) => x.id === 'ct-lab-pods');
  assert.deepEqual([lp.mascara_defecto, lp.mascara_minima, lp.mascara_maxima], [14, 13, 24]);
  assert.equal(
    (await llamar('PATCH', '/api/v1/pools/ct-lab-pods', { tipo: 'x', proveedor: 'GCP', mascara_minima: 20, mascara_maxima: 16 })).status,
    400,
    'mínima > máxima',
  );
  assert.equal(
    (await llamar('PATCH', '/api/v1/pools/ct-lab-pods', { tipo: 'x', proveedor: 'GCP', mascara_defecto: 12 })).status,
    400,
    'más grande que el pool',
  );
  const ed = await llamar('PATCH', '/api/v1/pools/ct-lab-pods', { tipo: 'Pods', proveedor: 'GCP' });
  assert.equal((await ed.json()).mascara_defecto, 14, 'sin límites en el pedido, se conservan');
  for (const [uso, pool] of [
    ['nodos', 'ct-lab-nodos'],
    ['pods', 'ct-lab-pods'],
    ['servicios', 'ct-lab-svc'],
  ]) {
    const put = await llamar('PUT', `/api/v1/pool-uso/lab/${uso}`, { pool });
    assert.equal(put.status, 200);
    await verificar(put, 'PUT', '/api/v1/pool-uso/{ambiente}/{uso}');
  }
  assert.equal((await llamar('PUT', '/api/v1/pool-uso/lab/pods', { pool: 'ct-lab-pods' }, comoAgente())).status, 403, 'solo un admin cambia la tabla');
  const tabla = await verificar(await llamar('GET', '/api/v1/pool-uso', undefined, comoAgente()), 'GET', '/api/v1/pool-uso');
  assert.equal(tabla.filter((f) => f.ambiente === 'lab').length, 3);

  const pedido = { ambiente: 'lab', proyecto: 'proy-ct', subred: 'gke-ct', rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'pods' }, { uso: 'servicios' }] };
  const sim = await llamar('POST', '/api/v1/reservas/lote?simular=true', pedido, comoAgente());
  assert.equal(sim.status, 200);
  assert.equal((await verificar(sim, 'POST', '/api/v1/reservas/lote')).simulacion, true);
  const r = await llamar('POST', '/api/v1/reservas/lote', pedido, comoAgente({ 'Idempotency-Key': 'ct-grupo-1' }));
  assert.equal(r.status, 201);
  const g = (await verificar(r, 'POST', '/api/v1/reservas/lote')).grupo;
  assert.deepEqual(
    g.rangos.map((x) => [x.rango, x.cidr]),
    [
      ['principal', '10.160.0.0/24'],
      ['pods', '10.168.0.0/14'],
      ['servicios', '10.180.0.0/20'],
    ],
  );
  const otra = await llamar('POST', '/api/v1/reservas/lote', pedido, comoAgente({ 'Idempotency-Key': 'ct-grupo-1' }));
  assert.equal((await verificar(otra, 'POST', '/api/v1/reservas/lote')).repetida, true);
  await verificar(await llamar('GET', `${G}/${g.grupo}`), 'GET', `${G}/{id}`);
  await verificar(await llamar('GET', `${G}/no-es-uuid`), 'GET', `${G}/{id}`); // 404

  // Una reserva de un grupo no se opera suelta: ni liberar (agente) ni confirmar (admin).
  const miembro = g.rangos[1].id;
  const l1 = await llamar('DELETE', `/api/v1/reservas/${miembro}`, undefined, comoAgente());
  assert.equal(l1.status, 409);
  assert.equal((await verificar(l1, 'DELETE', '/api/v1/reservas/{id}')).error, 'reserva_de_grupo');
  const c1 = await llamar('POST', `/api/v1/reservas/${miembro}/confirmar`, {});
  assert.equal(c1.status, 409);
  assert.equal((await verificar(c1, 'POST', '/api/v1/reservas/{id}/confirmar')).error, 'reserva_de_grupo');
  // Misma clave con otros parámetros: conflicto. «prd» es alias de «prod».
  const otraClave = await llamar('POST', '/api/v1/reservas/lote', { ...pedido, proyecto: 'otro' }, comoAgente({ 'Idempotency-Key': 'ct-grupo-1' }));
  assert.equal(otraClave.status, 409);
  assert.equal((await otraClave.json()).error, 'idempotencia_conflicto');
  assert.equal((await llamar('PUT', '/api/v1/pool-uso/prd/pods', { pool: 'ct-lab-pods' })).status, 400, 'prd = prod: el pool es de lab');
  // Agregar un rango con nombre al mismo grupo (sin nodos).
  const mas = await llamar(
    'POST',
    '/api/v1/reservas/lote',
    { ambiente: 'lab', grupo: g.grupo, rangos: [{ uso: 'pods', nombre: 'pods-b', subred: 'gke-ct' }] },
    comoAgente(),
  );
  assert.equal(mas.status, 201);
  const gm = (await verificar(mas, 'POST', '/api/v1/reservas/lote')).grupo;
  assert.deepEqual([gm.grupo, gm.rangos.length, gm.rangos.filter((x) => x.nombre === 'pods-b').length], [g.grupo, 4, 1]);

  // Renovar: mismos CIDR, nunca acorta, tope acumulado; solo el dueño o un admin; no renueva lo que no está vigente.
  const antes = gm.rangos.map((x) => x.cidr);
  const ren = await llamar('POST', `${G}/${g.grupo}/renovar`, { ttl_horas: 120 }, comoAgente());
  assert.equal(ren.status, 200);
  const renovado = await verificar(ren, 'POST', `${G}/{id}/renovar`);
  assert.deepEqual(
    renovado.rangos.map((x) => x.cidr),
    antes,
  );
  assert.ok(renovado.segundos_restantes > 119 * 3600);
  const tope = await llamar('POST', `${G}/${g.grupo}/renovar`, { ttl_horas: 170 }, comoAgente());
  assert.equal(tope.status, 400);
  assert.equal((await verificar(tope, 'POST', `${G}/{id}/renovar`)).error, 'ttl_excede_maximo');
  await verificar(await llamar('POST', `${G}/11111111-1111-4111-8111-111111111111/renovar`, {}, comoAgente()), 'POST', `${G}/{id}/renovar`); // 404

  // Buscar: por Idempotency-Key (los del que llama), por ticket y por vencer.
  const porClave = await verificar(await llamar('GET', `${G}?clave=ct-grupo-1`, undefined, comoAgente()), 'GET', G);
  assert.deepEqual(
    porClave.map((x) => x.grupo),
    [g.grupo],
  );
  const porTicket = await verificar(await llamar('GET', `${G}?ticket=${encodeURIComponent(g.ticket)}`), 'GET', G);
  assert.ok(porTicket.some((x) => x.grupo === g.grupo));
  assert.deepEqual(await verificar(await llamar('GET', `${G}?clave=no-existe`, undefined, comoAgente()), 'GET', G), []);
  assert.equal((await llamar('GET', `${G}?estado=rara`)).status, 400);
  assert.equal((await llamar('GET', `${G}?por_expirar_horas=1`, undefined, comoAgente())).status, 200);

  // Límites de máscara por pool: Pods entre /13 y /24; fuera de eso, 400. Sin máscara y sin default (nodos), falta_tamano.
  const mal = await llamar('POST', '/api/v1/reservas/lote', { ambiente: 'lab', rangos: [{ uso: 'pods', mascara: 26 }] }, comoAgente());
  assert.equal(mal.status, 400);
  assert.equal((await verificar(mal, 'POST', '/api/v1/reservas/lote')).error, 'mascara_invalida');
  const sinTamano = await llamar('POST', '/api/v1/reservas/lote', { ambiente: 'lab', rangos: [{ uso: 'nodos' }] }, comoAgente());
  assert.equal((await verificar(sinTamano, 'POST', '/api/v1/reservas/lote')).error, 'falta_tamano');
  // Simulación con contexto y version_tabla.
  const pedidoChico = { ambiente: 'lab', rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'servicios' }] }; // el pool de Pods ya no tiene otro /14 libre
  const sim2 = await llamar('POST', '/api/v1/reservas/lote?simular=true', pedidoChico, comoAgente());
  const ctx = await verificar(sim2, 'POST', '/api/v1/reservas/lote');
  assert.equal(ctx.cuota.necesaria, 2);
  assert.ok(ctx.pools.length === 2 && typeof ctx.version_tabla === 'string');
  const cab = (await llamar('GET', '/api/v1/pool-uso', undefined, comoAgente())).headers.get('x-version-tabla');
  assert.equal(cab, ctx.version_tabla, 'la cabecera y la simulación dan la misma versión');
  const vieja = await llamar('POST', '/api/v1/reservas/lote?simular=true', { ...pedidoChico, version_tabla: 'otra' }, comoAgente());
  assert.equal(vieja.status, 409);
  assert.equal((await vieja.json()).error, 'version_tabla_cambiada');

  // Un token no confirma; un admin sí, y los tres rangos pasan juntos.
  assert.equal((await llamar('POST', `${G}/${g.grupo}/confirmar`, {}, comoAgente())).status, 403);
  const conf = await llamar('POST', `${G}/${g.grupo}/confirmar`, { aprobado_por: 'ana@empresa.example', referencia: 'MR-1' });
  assert.equal(conf.status, 200);
  assert.equal((await verificar(conf, 'POST', `${G}/{id}/confirmar`)).grupo.estado, 'confirmada');
  const asigs = await (await llamar('GET', '/api/v1/asignaciones?pool=ct-lab-pods')).json();
  assert.deepEqual([asigs[0].grupo, asigs[0].rango], [g.grupo, 'pods']);

  // Ya confirmado, un agente no lo libera; un admin sí y se borran las tres asignaciones.
  assert.equal((await llamar('DELETE', `${G}/${g.grupo}`, undefined, comoAgente())).status, 403);
  const lib = await llamar('DELETE', `${G}/${g.grupo}`);
  assert.equal((await verificar(lib, 'DELETE', `${G}/{id}`)).asignaciones_borradas, 4);
  const sinPool = await llamar('POST', '/api/v1/reservas/lote', { ambiente: 'pre', rangos: [{ uso: 'pods' }] }, comoAgente());
  assert.equal(sinPool.status, 422);
  assert.equal((await llamar('DELETE', '/api/v1/pool-uso/lab/servicios')).status, 200);
});
