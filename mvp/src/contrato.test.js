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
  assert.ok(resuelta.content && resuelta.content['application/json'], `${metodo} ${plantilla} ${r.status}: devuelve JSON pero el contrato no describe su cuerpo`);
  const cuerpo = await r.json();
  const ref = def.$ref ? def.$ref.replace('#', '') : `/paths/${escapar(plantilla)}/${metodo.toLowerCase()}/responses/${r.status}`;
  const validar = validador.ajv.compile({ $ref: `openapi#${ref}/content/application~1json/schema` });
  assert.equal(validar(cuerpo), true, `${metodo} ${plantilla} ${r.status}: la respuesta no cumple el contrato\n${JSON.stringify(validar.errors, null, 1)}\ncuerpo: ${JSON.stringify(cuerpo)}`);
  return cuerpo;
}
const llamar = (metodo, ruta, cuerpo, h = ADM) => fetch(url + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const comoAgente = (extra = {}) => ({ Authorization: `Bearer ${tokenAgente}`, 'Content-Type': 'application/json', ...extra });

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  s = await lanzarServicio({ DATABASE_URL: b.url });
  url = s.url;
  const t = await (await llamar('POST', '/api/v1/tokens', { nombre: 'agente-contrato', rol: 'agente', cuota_reservas: 2 })).json();
  tokenAgente = t.token;
});
test.after(async () => { if (!hayBase) return; await s.parar(); await b.borrar(); });

test('el contrato publicado por el servicio es el mismo que construye el código', opts, async () => {
  for (const ruta of ['/api/openapi.json', '/api/v1/openapi.json']) {
    const r = await llamar('GET', ruta);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), JSON.parse(JSON.stringify({ ...doc })));
  }
  assert.equal((await fetch(`${url}/api/openapi.json`, { headers: { Authorization: `Bearer ipam_${'Z'.repeat(43)}` } })).status, 401, 'el contrato exige credenciales');
});

test('lecturas: sondas, sesión, marca, pools, resumen, asignaciones, eventos', opts, async () => {
  await verificar(await fetch(`${url}/healthz`), 'GET', '/healthz');
  await verificar(await fetch(`${url}/readyz`), 'GET', '/readyz');
  await verificar(await fetch(`${url}/api/health`), 'GET', '/api/health');
  await verificar(await fetch(`${url}/api/config`), 'GET', '/api/config');
  await verificar(await llamar('GET', '/api/v1/me'), 'GET', '/api/v1/me');
  await verificar(await llamar('GET', '/api/me', undefined, comoAgente()), 'GET', '/api/v1/me');
  const pools = await verificar(await llamar('GET', '/api/v1/pools?ambiente=qa'), 'GET', '/api/v1/pools');
  assert.ok(pools.length >= 1);
  await verificar(await llamar('GET', '/api/pools'), 'GET', '/api/v1/pools');
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
  await verificar(await llamar('POST', '/api/solicitudes', { pool: 'gke-nodos-qa', vpc: 'contrato', cidr: a.cidr }), 'POST', '/api/v1/solicitudes');
  await verificar(await llamar('POST', '/api/solicitudes', { pool: 'no-existe', vpc: 'x', mascara: 24 }), 'POST', '/api/v1/solicitudes');
  await verificar(await llamar('POST', '/api/solicitudes', { pool: 'gke-nodos-qa', vpc: 'x', cidr: 'hola' }), 'POST', '/api/v1/solicitudes');
  const malo = await llamar('POST', '/api/solicitudes', { pool: 5 });
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
  await verificar(await llamar('POST', R, { ...base, vpc: 'otra' }, comoAgente({ 'Idempotency-Key': 'ct-1' })), 'POST', R);          // 409 idempotencia
  await verificar(await llamar('POST', R, { ...base, mascara: undefined, cidr: r.cidr }, comoAgente()), 'POST', R);                // 409 solapamiento
  await verificar(await llamar('POST', R, { ...base, ttl_horas: 99 }, comoAgente()), 'POST', R);                                     // 400
  await verificar(await llamar('POST', R, { ...base, campo_raro: 1 }, comoAgente()), 'POST', R);                                    // 400 forma
  await verificar(await llamar('POST', R, { ...base, pool: 'no-existe', ambiente: undefined, tipo: undefined }, comoAgente()), 'POST', R); // 404
  await verificar(await llamar('POST', R, base, { ...ADM }), 'POST', R);                                                             // admin: 201
  await verificar(await llamar('POST', R, base, comoAgente()), 'POST', R);                                                           // 2.ª del token (cuota 2)
  await verificar(await llamar('POST', R, base, comoAgente()), 'POST', R);                                                           // 429 cuota
  await b.sql("insert into pools (id,tipo,ambiente,proveedor,cidr) values ('gke-nodos-qa-2','Nodos','qa','GCP','10.77.0.0/16')");
  await verificar(await llamar('POST', R, base, ADM), 'POST', R);                                                                    // 422 ambiguo
  await verificar(await llamar('GET', R), 'GET', R);
  await verificar(await llamar('GET', `${R}?estado=rara`), 'GET', R);                                                                // 400
  await verificar(await llamar('GET', `${R}/${r.id}`), 'GET', `${R}/{id}`);
  await verificar(await llamar('GET', `${R}/no-es-uuid`), 'GET', `${R}/{id}`);                                                       // 404

  await verificar(await llamar('POST', `${R}/${r.id}/confirmar`, {}, comoAgente()), 'POST', `${R}/{id}/confirmar`);                  // 400 falta aprobación
  const conf = await llamar('POST', `${R}/${r.id}/confirmar`, { aprobado_por: 'ana@empresa.example', referencia: 'https://gitlab.example/mr/1' }, comoAgente());
  assert.equal(conf.status, 200);
  assert.equal((await verificar(conf, 'POST', `${R}/{id}/confirmar`)).asignacion.origen, 'agente');
  await verificar(await llamar('POST', `${R}/${r.id}/confirmar`, {}, ADM), 'POST', `${R}/{id}/confirmar`);                           // repetida
  await verificar(await llamar('POST', `${R}/${r.id}/confirmar`, { raro: 1 }, comoAgente()), 'POST', `${R}/{id}/confirmar`);        // 400 forma
  await verificar(await llamar('POST', `${R}/11111111-1111-4111-8111-111111111111/confirmar`, {}, ADM), 'POST', `${R}/{id}/confirmar`); // 404
  const otro = await (await llamar('POST', '/api/tokens', { nombre: 'otro-contrato', rol: 'agente' })).json();
  await verificar(await llamar('DELETE', `${R}/${r.id}`, undefined, { Authorization: `Bearer ${otro.token}` }), 'DELETE', `${R}/{id}`); // 403 no es dueño
  const lib = await verificar(await llamar('DELETE', `${R}/${r.id}`, undefined, comoAgente()), 'DELETE', `${R}/{id}`);
  assert.equal(lib.asignacion_borrada, true);
  await verificar(await llamar('DELETE', `${R}/${r.id}`, undefined, comoAgente()), 'DELETE', `${R}/{id}`);                           // repetida
  const vieja = await (await llamar('POST', R, { ...base, pool: 'gke-nodos-qa-2', ambiente: undefined, tipo: undefined, ttl_horas: 1 }, ADM)).json();
  await b.sql("update reservas set expira_en = now() - interval '1 minute' where id = $1", [vieja.id]);
  await verificar(await llamar('POST', `${R}/${vieja.id}/confirmar`, {}, ADM), 'POST', `${R}/{id}/confirmar`);                       // 409 expirada
});

test('tokens, usuarios, auditoría, respaldo y Jira cumplen el contrato', opts, async () => {
  const T = '/api/v1/tokens';
  const creado = await verificar(await llamar('POST', T, { nombre: 'ct-token', rol: 'lector', expira_dias: 30 }), 'POST', T);
  assert.match(creado.token, /^ipam_/);
  await verificar(await llamar('POST', T, { nombre: 'ct-token', rol: 'lector' }), 'POST', T);                       // 409
  await verificar(await llamar('POST', T, { nombre: 'x', rol: 'admin' }), 'POST', T);                               // 400
  await verificar(await llamar('POST', T, { nombre: 'ct-2', rol: 'lector' }, comoAgente()), 'POST', T);             // 403
  const lista = await verificar(await llamar('GET', T), 'GET', T);
  assert.ok(lista.every((t) => !('token' in t) && !('hash' in t)));
  await verificar(await llamar('GET', T, undefined, comoAgente()), 'GET', T);                                       // 403
  await verificar(await llamar('DELETE', `${T}/${creado.id}`), 'DELETE', `${T}/{id}`);
  await verificar(await llamar('DELETE', `${T}/11111111-1111-4111-8111-111111111111`), 'DELETE', `${T}/{id}`);      // 404

  await verificar(await llamar('GET', '/api/v1/usuarios'), 'GET', '/api/v1/usuarios');
  await verificar(await llamar('PUT', '/api/v1/usuarios/ana%40empresa.example', { rol: 'solicitante' }), 'PUT', '/api/v1/usuarios/{email}');
  await verificar(await llamar('PUT', '/api/v1/usuarios/ana%40empresa.example', { rol: 'dios' }), 'PUT', '/api/v1/usuarios/{email}'); // 400
  const aud = await verificar(await llamar('GET', '/api/v1/auditoria'), 'GET', '/api/v1/auditoria');
  assert.ok(aud.some((f) => f.accion === 'crear_token'));

  const resp = await verificar(await llamar('GET', '/api/v1/exportar.json'), 'GET', '/api/v1/exportar.json');
  await verificar(await llamar('POST', '/api/v1/importar', resp), 'POST', '/api/v1/importar');
  await verificar(await llamar('POST', '/api/v1/importar', { hola: 1 }), 'POST', '/api/v1/importar');                // 400

  await verificar(await llamar('POST', '/api/v1/jira/simular', { ambiente: 'dev', tipo: 'Nodos', mascara: 28, vpc: 'jira-ct' }), 'POST', '/api/v1/jira/simular');
  await verificar(await llamar('POST', '/api/v1/jira/simular', { ambiente: 'prod', tipo: 'Inexistente', mascara: 28, vpc: 'x' }), 'POST', '/api/v1/jira/simular'); // 422
  const x = await fetch(`${url}/api/v1/exportar.xlsx`, { headers: ADM });
  assert.equal(x.status, 200);
  await verificar(x, 'GET', '/api/v1/exportar.xlsx');
});
