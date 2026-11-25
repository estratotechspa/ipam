// «El pool es la VPC» (0.5.0) contra PostgreSQL real, por HTTP: pools anidados, nodos por VPC, bloque de VPC, coherencia de nombres y
// seguimiento del grupo. Rangos FICTICIOS. Los criterios de aceptación de la tarea van numerados en el nombre de cada prueba.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' }; // el admin entra «abierto» (modo anónimo del servicio de pruebas)
const bearer = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }); // sin X-Requested-With

let b, s, estricto, url;
const llamar = (metodo, ruta, cuerpo, h = ADM, base = url) =>
  fetch(base + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const json = async (r) => {
  const x = await r; // acepta la promesa de fetch o la respuesta ya esperada
  return { estado: x.status, cuerpo: await x.json() };
};
const admin = async (metodo, ruta, cuerpo, base) => json(await llamar(metodo, ruta, cuerpo, ADM, base));
const pool = (id, cidr, extra = {}) => ({ id, tipo: 'Nodos', ambiente: 'dev', proveedor: 'GCP', cidr, ...extra });
let agente, otroAgente;
let clave = 0;
const lote = (cuerpo, h = {}, base = url, token = agente) =>
  json(
    fetch(base + '/api/v1/reservas/lote', {
      method: 'POST',
      headers: bearer(token, { 'Idempotency-Key': `vpc-${++clave}`, ...h }),
      body: JSON.stringify({ ambiente: 'dev', ...cuerpo }),
    }),
  );
const poolsPorId = async () => Object.fromEntries((await (await llamar('GET', '/api/v1/pools')).json()).map((p) => [p.id, p]));

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  const env = { DATABASE_URL: b.url, CUOTA_RESERVAS_POR_TOKEN: '100' };
  s = await lanzarServicio(env);
  estricto = await lanzarServicio({ ...env, EXIGIR_POOL_VPC: 'dev' });
  url = s.url;
  const crear = async (nombre) => (await admin('POST', '/api/v1/tokens', { nombre, rol: 'agente' })).cuerpo.token;
  agente = await crear('agente-vpc');
  otroAgente = await crear('otro-agente');
  // Padre de los nodos de dev (con límites de máscara de subred), y pods y servicios de dev.
  const padre = await admin('POST', '/api/v1/pools', pool('dev-gcp-ccla', '10.200.0.0/16', { mascara_defecto: 24, mascara_minima: 20, mascara_maxima: 28 }));
  assert.equal(padre.estado, 201, JSON.stringify(padre.cuerpo));
  await admin('POST', '/api/v1/pools', pool('dev-pods', '10.128.0.0/12', { tipo: 'Pods', mascara_defecto: 20 }));
  await admin('POST', '/api/v1/pools', pool('dev-svc', '10.240.0.0/16', { tipo: 'Servicios', mascara_defecto: 24 }));
  for (const [uso, p] of [
    ['nodos', 'dev-gcp-ccla'],
    ['pods', 'dev-pods'],
    ['servicios', 'dev-svc'],
  ])
    await admin('PUT', `/api/v1/pool-uso/dev/${uso}`, { pool: p });
});
test.after(async () => {
  if (!hayBase) return;
  await Promise.all([s.parar(), estricto.parar()]);
  await b.borrar();
});

test('1 · un pool hijo descuenta su espacio del padre (disponibilidad, libres y uso) y queda con su identidad', opts, async () => {
  const antes = (await poolsPorId())['dev-gcp-ccla'];
  const r = await admin('POST', '/api/v1/pools', pool('dev-vpc-x', '10.200.0.0/20', { proyecto: 'Proy-X', vpc: 'Dev-VPC-X', padre_id: 'dev-gcp-ccla' }));
  assert.equal(r.estado, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.proyecto, r.cuerpo.vpc, r.cuerpo.padre_id], ['proy-x', 'dev-vpc-x', 'dev-gcp-ccla'], 'se normaliza a minúsculas');
  const p = await poolsPorId();
  assert.equal(p['dev-gcp-ccla'].hijos, 1);
  assert.ok(Math.abs(p['dev-gcp-ccla'].uso - antes.uso - 4096 / 65536) < 1e-9, 'el /20 cuenta como usado en el padre');
  const disp = await (await llamar('GET', '/api/v1/pools/dev-gcp-ccla/disponibilidad')).json();
  assert.equal(disp.ocupadas, 4096, 'el /20 del hijo cuenta como ocupado en el padre');
  assert.equal(disp.libres, 65536 - 4096);
  const libres = await (await llamar('GET', '/api/v1/pools/dev-gcp-ccla/libres?mascara=20')).json();
  assert.equal(libres[0], '10.200.16.0/20', 'el primer /20 libre del padre ya no es el del hijo');
  const hist = await admin('GET', '/api/v1/auditoria?pool=dev-vpc-x');
  assert.ok(hist.cuerpo.some((a) => a.accion === 'crear_pool' && a.detalle.padre === 'dev-gcp-ccla' && a.detalle.vpc === 'dev-vpc-x'));
});

test('2 · hijo fuera del padre, solapado o VPC duplicada: error con el código indicado; con hijos no se borra el padre', opts, async () => {
  const fuera = await admin('POST', '/api/v1/pools', pool('dev-fuera', '10.201.0.0/20', { padre_id: 'dev-gcp-ccla' }));
  assert.deepEqual([fuera.estado, fuera.cuerpo.error], [422, 'pool_fuera_del_padre']);
  const igual = await admin('POST', '/api/v1/pools', pool('dev-igual', '10.200.0.0/16', { padre_id: 'dev-gcp-ccla' }));
  assert.deepEqual([igual.estado, igual.cuerpo.error], [422, 'pool_fuera_del_padre'], 'el hijo debe ser más chico que el padre');
  const solapa = await admin('POST', '/api/v1/pools', pool('dev-solapa', '10.200.8.0/21', { padre_id: 'dev-gcp-ccla' }));
  assert.deepEqual([solapa.estado, solapa.cuerpo.error], [409, 'pool_solapado']);
  assert.equal(solapa.cuerpo.conflicto.id, 'dev-vpc-x');
  const sinPadre = await admin('POST', '/api/v1/pools', pool('dev-sinpadre', '10.200.8.0/21'));
  assert.deepEqual([sinPadre.estado, sinPadre.cuerpo.error], [409, 'pool_solapado'], 'sin padre no hay permiso para solaparse');
  const duplicada = await admin('POST', '/api/v1/pools', pool('dev-dup', '10.200.16.0/20', { proyecto: 'proy-x', vpc: 'dev-vpc-x', padre_id: 'dev-gcp-ccla' }));
  assert.deepEqual([duplicada.estado, duplicada.cuerpo.error], [409, 'vpc_duplicada']);
  const otroProyecto = await admin(
    'POST',
    '/api/v1/pools',
    pool('dev-otro', '10.200.16.0/20', { proyecto: 'proy-z', vpc: 'dev-vpc-x', padre_id: 'dev-gcp-ccla' }),
  );
  assert.equal(otroProyecto.estado, 201, 'la identidad es (proveedor, proyecto, vpc): otro proyecto es otra VPC');
  await admin('DELETE', '/api/v1/pools/dev-otro');
  const sinPadreReal = await admin('POST', '/api/v1/pools', pool('dev-huerfano', '10.200.16.0/20', { padre_id: 'no-existe' }));
  assert.deepEqual([sinPadreReal.estado, sinPadreReal.cuerpo.error], [422, 'padre_no_existe']);
  const ambiente = await admin('POST', '/api/v1/pools', pool('qa-hijo', '10.200.16.0/20', { ambiente: 'qa', padre_id: 'dev-gcp-ccla' }));
  assert.deepEqual([ambiente.estado, ambiente.cuerpo.error], [422, 'padre_incompatible']);
  const borrar = await admin('DELETE', '/api/v1/pools/dev-gcp-ccla');
  assert.deepEqual([borrar.estado, borrar.cuerpo.error], [409, 'pool_con_hijos']);
  const asign = await admin('POST', '/api/v1/solicitudes', { pool: 'dev-gcp-ccla', cidr: '10.200.4.0/24', vpc: 'a mano' });
  assert.equal(asign.estado, 409, 'nadie asigna dentro del bloque de un pool hijo');
  assert.equal((await b.sql("select count(*)::int as n from asignaciones where pool_id = 'dev-gcp-ccla'")).rows[0].n, 0);
});

test('2b · la base también lo impide si se saltan la API (hijo fuera del padre; asignación dentro de un hijo)', opts, async () => {
  await assert.rejects(
    b.sql("insert into pools (id,tipo,ambiente,proveedor,cidr,padre_id) values ('sql-fuera','VPC','dev','GCP','10.150.0.0/20','dev-gcp-ccla')"),
    /no cabe dentro de su padre/,
  );
  await assert.rejects(
    b.sql("insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket) values ('dev-gcp-ccla','10.200.2.0/24','x','sql','NET-1')"),
    /cae dentro de un pool hijo/,
  );
  await assert.rejects(
    b.sql("insert into pools (id,tipo,ambiente,proveedor,cidr,vpc,proyecto) values ('sql-dup','VPC','dev','gcp','10.150.0.0/24','dev-vpc-x','proy-x')"),
    /pools_vpc_unica_idx/,
  );
});

test('3 · el lote con vpc saca los nodos del pool de la VPC; lleno, 409 sin_espacio en ESE pool; pods y servicios siguen en pool-uso', opts, async () => {
  const sim = await lote(
    { vpc: 'dev-vpc-x', proyecto: 'proy-x', rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'pods' }, { uso: 'servicios' }] },
    {},
    url,
    agente,
  ).then((x) => x);
  assert.ok(sim.estado === 201, JSON.stringify(sim.cuerpo));
  const filas = Object.fromEntries(sim.cuerpo.grupo.rangos.map((r) => [r.rango, r.pool_id]));
  assert.deepEqual(filas, { principal: 'dev-vpc-x', pods: 'dev-pods', servicios: 'dev-svc' });
  assert.match(sim.cuerpo.grupo.rangos.find((r) => r.rango === 'principal').cidr, /^10\.200\.[0-9]+\.0\/24$/);
  // La simulación dice qué pool eligió y por qué.
  const s2 = await json(
    fetch(`${url}/api/v1/reservas/lote?simular=true`, {
      method: 'POST',
      headers: bearer(agente),
      body: JSON.stringify({ ambiente: 'dev', vpc: 'dev-vpc-x', proyecto: 'proy-x', rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'pods' }] }),
    }),
  );
  assert.equal(s2.estado, 200);
  const [nodos, pods] = s2.cuerpo.rangos;
  assert.deepEqual([nodos.pool, nodos.criterio], ['dev-vpc-x', 'vpc']);
  assert.match(nodos.motivo, /dev-vpc-x/);
  assert.deepEqual([pods.pool, pods.criterio], ['dev-pods', 'pool_uso']);
  // Se llena el /20 (16 subredes /24; ya hay una): 15 más y la siguiente no cabe.
  const llenar = await lote({ vpc: 'dev-vpc-x', proyecto: 'proy-x', rangos: Array.from({ length: 15 }, () => ({ uso: 'nodos', mascara: 24 })) });
  assert.equal(llenar.estado, 201, JSON.stringify(llenar.cuerpo));
  const lleno = await lote({ vpc: 'dev-vpc-x', proyecto: 'proy-x', rangos: [{ uso: 'nodos', mascara: 24 }] });
  assert.deepEqual([lleno.estado, lleno.cuerpo.error], [409, 'sin_espacio']);
  assert.match(lleno.cuerpo.mensaje, /dev-vpc-x/);
  assert.doesNotMatch(lleno.cuerpo.mensaje, /dev-gcp-ccla/);
});

test('4 · con exigir_pool_vpc, una VPC sin pool es 422 vpc_sin_pool; apagado, el comportamiento actual queda intacto', opts, async () => {
  const pedido = { vpc: 'dev-vpc-nueva', proyecto: 'proy-n', rangos: [{ uso: 'nodos', mascara: 28 }] };
  const exige = await lote(pedido, {}, estricto.url);
  assert.deepEqual([exige.estado, exige.cuerpo.error], [422, 'vpc_sin_pool']);
  const sinVpc = await lote({ rangos: [{ uso: 'nodos', mascara: 28 }] }, {}, estricto.url);
  assert.deepEqual([sinVpc.estado, sinVpc.cuerpo.error], [422, 'vpc_requerida']);
  const conPool = await lote({ vpc: 'dev-vpc-x', proyecto: 'proy-x', rangos: [{ uso: 'nodos', mascara: 28 }, { uso: 'pods' }] }, {}, estricto.url);
  assert.equal(conPool.estado, 409, 'la VPC existe pero está llena: error de espacio, no de pool');
  assert.equal(conPool.cuerpo.error, 'sin_espacio');
  // Apagado (servicio principal): una VPC sin pool sigue saliendo de pool-uso, y se ve el motivo en la simulación.
  const apagado = await lote(pedido);
  assert.equal(apagado.estado, 201, JSON.stringify(apagado.cuerpo));
  assert.equal(apagado.cuerpo.grupo.rangos[0].pool_id, 'dev-gcp-ccla');
  const sim = await json(
    fetch(`${url}/api/v1/reservas/lote?simular=true`, { method: 'POST', headers: bearer(agente), body: JSON.stringify({ ambiente: 'dev', ...pedido }) }),
  );
  assert.equal(sim.cuerpo.rangos[0].criterio, 'pool_uso');
  assert.match(sim.cuerpo.rangos[0].motivo, /no tiene pool propio/);
  await json(fetch(`${url}/api/v1/reservas/grupo/${apagado.cuerpo.grupo.grupo}`, { method: 'DELETE', headers: bearer(agente) }));
});

test('5 · flujo: reservar uso vpc → un admin confirma → aparece el pool → el lote de subredes con esa VPC funciona (y es idempotente)', opts, async () => {
  const pedido = { vpc: 'dev-vpc-y', proyecto: 'proy-y', rangos: [{ uso: 'vpc', mascara: 20 }] };
  const llave = { 'Idempotency-Key': 'flujo-vpc-y' };
  const r = await lote(pedido, llave);
  assert.equal(r.estado, 201, JSON.stringify(r.cuerpo));
  const grupo = r.cuerpo.grupo;
  assert.deepEqual([grupo.rangos[0].rango, grupo.rangos[0].pool_id, grupo.estado], ['vpc', 'dev-gcp-ccla', 'reservada']);
  assert.equal((await poolsPorId())['dev-vpc-y'], undefined, 'reservar no crea el pool');
  const repetida = await lote(pedido, llave);
  assert.deepEqual([repetida.estado, repetida.cuerpo.repetida, repetida.cuerpo.grupo.grupo], [200, true, grupo.grupo]);
  const dup = await lote(pedido); // otra clave: la misma VPC ya tiene un bloque esperando
  assert.deepEqual([dup.estado, dup.cuerpo.error], [409, 'vpc_duplicada']);
  const sinPool = await lote({ vpc: 'dev-vpc-y', proyecto: 'proy-y', rangos: [{ uso: 'nodos', mascara: 24 }] }, {}, estricto.url);
  assert.equal(sinPool.cuerpo.error, 'vpc_sin_pool', 'antes de confirmar la VPC no tiene pool');
  // El agente no confirma (criterio 6); un admin sí, y entonces nace el pool.
  const no = await json(fetch(`${url}/api/v1/reservas/grupo/${grupo.grupo}/confirmar`, { method: 'POST', headers: bearer(agente), body: '{}' }));
  assert.equal(no.estado, 403);
  const c = await admin('POST', `/api/v1/reservas/grupo/${grupo.grupo}/confirmar`, { aprobado_por: 'ana@empresa.example', referencia: 'MR-1' });
  assert.equal(c.estado, 200, JSON.stringify(c.cuerpo));
  assert.equal(c.cuerpo.pools_creados[0].id, 'dev-vpc-y');
  const hijo = (await poolsPorId())['dev-vpc-y'];
  assert.deepEqual([hijo.proyecto, hijo.vpc, hijo.padre_id, hijo.cidr, hijo.tipo], ['proy-y', 'dev-vpc-y', 'dev-gcp-ccla', grupo.rangos[0].cidr, 'VPC']);
  assert.equal(
    (await b.sql('select count(*)::int as n from asignaciones where cidr = $1', [grupo.rangos[0].cidr])).rows[0].n,
    0,
    'el bloque no es una asignación',
  );
  const subred = await lote({ vpc: 'dev-vpc-y', proyecto: 'proy-y', rangos: [{ uso: 'nodos', mascara: 24 }] });
  assert.equal(subred.estado, 201, JSON.stringify(subred.cuerpo));
  assert.equal(subred.cuerpo.grupo.rangos[0].pool_id, 'dev-vpc-y');
  const rep2 = await admin('POST', `/api/v1/reservas/grupo/${grupo.grupo}/confirmar`, {});
  assert.equal(rep2.cuerpo.repetida, true, 'confirmar de nuevo no crea otro pool');
  assert.ok((await admin('GET', '/api/v1/auditoria?pool=dev-vpc-y')).cuerpo.some((a) => a.accion === 'crear_pool'));
});

test('5b · liberar o expirar el bloque no deja pool; liberar uno confirmado retira su pool solo si está vacío', opts, async () => {
  const r = await lote({ vpc: 'dev-vpc-l', proyecto: 'proy-l', rangos: [{ uso: 'vpc', mascara: 22 }] });
  assert.equal(r.estado, 201, JSON.stringify(r.cuerpo));
  const del = await json(fetch(`${url}/api/v1/reservas/grupo/${r.cuerpo.grupo.grupo}`, { method: 'DELETE', headers: bearer(agente) }));
  assert.equal(del.estado, 200);
  assert.equal((await poolsPorId())['dev-vpc-l'], undefined);
  const e = await lote({ vpc: 'dev-vpc-e', proyecto: 'proy-e', ttl_horas: 1, rangos: [{ uso: 'vpc', mascara: 22 }] });
  await b.sql("update reservas set expira_en = now() - interval '1 minute' where grupo = $1", [e.cuerpo.grupo.grupo]);
  const conf = await admin('POST', `/api/v1/reservas/grupo/${e.cuerpo.grupo.grupo}/confirmar`, {});
  assert.deepEqual([conf.estado, conf.cuerpo.error], [409, 'reserva_no_vigente']);
  assert.equal((await poolsPorId())['dev-vpc-e'], undefined, 'expirada: no se crea nada');
  // Confirmado y con una subred dentro: liberar el bloque se rechaza; vacío, retira el pool.
  const c = await lote({ vpc: 'dev-vpc-m', proyecto: 'proy-m', rangos: [{ uso: 'vpc', mascara: 22 }] });
  await admin('POST', `/api/v1/reservas/grupo/${c.cuerpo.grupo.grupo}/confirmar`, {});
  const sub = await lote({ vpc: 'dev-vpc-m', proyecto: 'proy-m', rangos: [{ uso: 'nodos', mascara: 24 }] });
  await admin('POST', `/api/v1/reservas/grupo/${sub.cuerpo.grupo.grupo}/confirmar`, {});
  const bloqueado = await admin('DELETE', `/api/v1/reservas/grupo/${c.cuerpo.grupo.grupo}`);
  assert.deepEqual([bloqueado.estado, bloqueado.cuerpo.error], [409, 'pool_en_uso']);
  await admin('DELETE', `/api/v1/reservas/grupo/${sub.cuerpo.grupo.grupo}`);
  const libre = await admin('DELETE', `/api/v1/reservas/grupo/${c.cuerpo.grupo.grupo}`);
  assert.equal(libre.estado, 200, JSON.stringify(libre.cuerpo));
  assert.equal((await poolsPorId())['dev-vpc-m'], undefined, 'el pool vacío se retira con su bloque');
});

test('6 · con token de agente, crear o editar pools y confirmar responden 403; el agente nunca crea pools', opts, async () => {
  const crear = await json(
    fetch(`${url}/api/v1/pools`, { method: 'POST', headers: bearer(agente), body: JSON.stringify(pool('agente-pool', '10.210.0.0/20')) }),
  );
  assert.equal(crear.estado, 403);
  const editar = await json(
    fetch(`${url}/api/v1/pools/dev-vpc-x`, { method: 'PATCH', headers: bearer(agente), body: JSON.stringify({ tipo: 'x', proveedor: 'GCP' }) }),
  );
  assert.equal(editar.estado, 403);
  const r = await lote({ vpc: 'dev-vpc-c', proyecto: 'proy-c', rangos: [{ uso: 'vpc', mascara: 22 }] });
  const conf = await json(fetch(`${url}/api/v1/reservas/grupo/${r.cuerpo.grupo.grupo}/confirmar`, { method: 'POST', headers: bearer(agente), body: '{}' }));
  assert.equal(conf.estado, 403);
  assert.equal((await poolsPorId())['dev-vpc-c'], undefined);
});

test('PATCH /pools: un admin cambia la identidad y el padre con las mismas invariantes', opts, async () => {
  const hijo = await admin('POST', '/api/v1/pools', pool('dev-vpc-p', '10.200.64.0/20', { padre_id: 'dev-gcp-ccla' }));
  assert.equal(hijo.estado, 201, JSON.stringify(hijo.cuerpo));
  const ident = await admin('PATCH', '/api/v1/pools/dev-vpc-p', { tipo: 'VPC', proveedor: 'GCP', proyecto: 'proy-p', vpc: 'dev-vpc-p' });
  assert.equal(ident.estado, 200, JSON.stringify(ident.cuerpo));
  assert.deepEqual([ident.cuerpo.padre_id, ident.cuerpo.vpc], ['dev-gcp-ccla', 'dev-vpc-p'], 'lo que no viene se conserva');
  const choca = await admin('PATCH', '/api/v1/pools/dev-vpc-p', { tipo: 'VPC', proveedor: 'GCP', proyecto: 'proy-x', vpc: 'dev-vpc-x' });
  assert.deepEqual([choca.estado, choca.cuerpo.error], [409, 'vpc_duplicada']);
  const sinPadre = await admin('PATCH', '/api/v1/pools/dev-vpc-p', { tipo: 'VPC', proveedor: 'GCP', padre_id: null });
  assert.deepEqual([sinPadre.estado, sinPadre.cuerpo.error], [409, 'pool_solapado'], 'sin padre, el bloque pisaría al pool del que sale');
  const propio = await admin('PATCH', '/api/v1/pools/dev-gcp-ccla', { tipo: 'Nodos', proveedor: 'GCP', padre_id: 'dev-vpc-p' });
  assert.equal(propio.estado, 422, 'un pool no puede colgar de su propio hijo');
  const quitaIdentidad = await admin('PATCH', '/api/v1/pools/dev-vpc-p', { tipo: 'VPC', proveedor: 'GCP', proyecto: null, vpc: null });
  assert.deepEqual([quitaIdentidad.estado, quitaIdentidad.cuerpo.vpc], [200, null]);
  assert.equal((await admin('DELETE', '/api/v1/pools/dev-vpc-p')).estado, 200);
});

test('respaldo: exporta padres antes que hijos y restaura un pool hijo con su identidad', opts, async () => {
  const c = await admin('POST', '/api/v1/pools', pool('dev-vpc-r', '10.200.96.0/20', { proyecto: 'proy-r', vpc: 'dev-vpc-r', padre_id: 'dev-gcp-ccla' }));
  assert.equal(c.estado, 201, JSON.stringify(c.cuerpo));
  const resp = await (await llamar('GET', '/api/v1/exportar.json')).json();
  const ids = resp.pools.map((p) => p.id);
  assert.ok(ids.indexOf('dev-gcp-ccla') < ids.indexOf('dev-vpc-r'), 'el padre va antes que el hijo');
  assert.equal((await admin('DELETE', '/api/v1/pools/dev-vpc-r')).estado, 200);
  const rest = await admin('POST', '/api/v1/importar', resp);
  assert.equal(rest.estado, 200, JSON.stringify(rest.cuerpo));
  const vuelta = (await poolsPorId())['dev-vpc-r'];
  assert.deepEqual([vuelta.padre_id, vuelta.vpc, vuelta.proyecto], ['dev-gcp-ccla', 'dev-vpc-r', 'proy-r']);
  await admin('DELETE', '/api/v1/pools/dev-vpc-r');
});

test('A2 · vpc, proyecto y subred se normalizan y validan; una VPC con otro proyecto es 422 vpc_incoherente', opts, async () => {
  for (const [campo, valor] of [
    ['vpc', 'Mi VPC'],
    ['vpc', 'vpc_x'],
    ['proyecto', '1proyecto'],
    ['subred', 'sub red'],
  ]) {
    const x = await lote({ [campo]: valor, rangos: [{ uso: 'pods' }] });
    assert.deepEqual([x.estado, x.cuerpo.error], [400, `${campo}_invalido`], `${campo}=${valor}`);
  }
  const bien = await lote({ vpc: '  DEV-VPC-X  ', proyecto: ' Proy-X ', subred: 'Subred-A', rangos: [{ uso: 'servicios', mascara: 28 }] });
  assert.equal(bien.estado, 201, JSON.stringify(bien.cuerpo));
  assert.deepEqual(
    [bien.cuerpo.grupo.rangos[0].vpc, bien.cuerpo.grupo.rangos[0].proyecto, bien.cuerpo.grupo.rangos[0].subred],
    ['dev-vpc-x', 'proy-x', 'subred-a'],
  );
  const mal = await lote({ vpc: 'dev-vpc-x', proyecto: 'otro-proyecto', rangos: [{ uso: 'pods' }] });
  assert.deepEqual([mal.estado, mal.cuerpo.error], [422, 'vpc_incoherente']);
  assert.deepEqual(
    mal.cuerpo.proyectos_existentes.sort(),
    ['proy-x', 'proy-z'].filter((p) => p === 'proy-x'),
  );
  const reservaVpc = await lote({ vpc: 'dev-vpc-x', proyecto: 'otro-proyecto', rangos: [{ uso: 'vpc', mascara: 22 }] });
  assert.deepEqual([reservaVpc.estado, reservaVpc.cuerpo.error], [422, 'vpc_incoherente']);
  const mezcla = await lote({
    vpc: 'dev-vpc-q',
    proyecto: 'proy-q',
    rangos: [
      { uso: 'vpc', mascara: 22 },
      { uso: 'nodos', mascara: 24 },
    ],
  });
  assert.deepEqual([mezcla.estado, mezcla.cuerpo.error], [400, 'vpc_no_se_mezcla']);
  const sinProyecto = await lote({ vpc: 'dev-vpc-q', rangos: [{ uso: 'vpc', mascara: 22 }] });
  assert.deepEqual([sinProyecto.estado, sinProyecto.cuerpo.error], [400, 'proyecto_requerido']);
});

test('B1 · el dueño del grupo ve sus eventos; otro agente no; /eventos sigue siendo solo de admin', opts, async () => {
  const r = await lote({ vpc: 'dev-vpc-ev', proyecto: 'proy-ev', rangos: [{ uso: 'pods' }] });
  const id = r.cuerpo.grupo.grupo;
  await json(fetch(`${url}/api/v1/reservas/grupo/${id}/renovar`, { method: 'POST', headers: bearer(agente), body: JSON.stringify({ ttl_horas: 100 }) }));
  await admin('POST', `/api/v1/reservas/grupo/${id}/confirmar`, {});
  const mios = await json(fetch(`${url}/api/v1/reservas/grupo/${id}/eventos`, { headers: bearer(agente) }));
  assert.equal(mios.estado, 200);
  assert.deepEqual(
    mios.cuerpo.map((e) => e.tipo),
    ['grupo_reservado', 'grupo_renovado', 'grupo_confirmado'],
  );
  const ajeno = await json(fetch(`${url}/api/v1/reservas/grupo/${id}/eventos`, { headers: bearer(otroAgente) }));
  assert.deepEqual([ajeno.estado, ajeno.cuerpo.error], [403, 'no_es_dueno']);
  assert.equal((await json(fetch(`${url}/api/v1/eventos`, { headers: bearer(agente) }))).estado, 403);
  assert.equal((await admin('GET', `/api/v1/reservas/grupo/${id}/eventos`)).estado, 200, 'un admin también');
  assert.equal((await json(fetch(`${url}/api/v1/reservas/grupo/00000000-0000-4000-8000-000000000000/eventos`, { headers: bearer(agente) }))).estado, 404);
  // Un grupo que expira deja su evento con el grupo (lo ve el dueño).
  const e = await lote({ vpc: 'dev-vpc-ex', proyecto: 'proy-ex', ttl_horas: 1, rangos: [{ uso: 'pods' }] });
  await b.sql("update reservas set expira_en = now() - interval '1 minute' where grupo = $1", [e.cuerpo.grupo.grupo]);
  await lote({ vpc: 'dev-vpc-ex', proyecto: 'proy-ex', rangos: [{ uso: 'pods' }] }); // reservar en el mismo pool barre lo vencido
  const ev = await json(fetch(`${url}/api/v1/reservas/grupo/${e.cuerpo.grupo.grupo}/eventos`, { headers: bearer(agente) }));
  assert.ok(
    ev.cuerpo.some((x) => x.tipo === 'reserva_expirada'),
    JSON.stringify(ev.cuerpo.map((x) => x.tipo)),
  );
});

test('7 · idempotencia, todo o nada, TTL y renovar siguen funcionando con el pool de la VPC', opts, async () => {
  const antes = (await b.sql('select count(*)::int as n from reservas')).rows[0].n;
  // Todo o nada: el segundo rango no cabe → no se reserva ninguno.
  const nada = await lote({
    vpc: 'dev-vpc-x',
    proyecto: 'proy-x',
    rangos: [
      { uso: 'servicios', mascara: 28 },
      { uso: 'nodos', mascara: 24 },
    ],
  });
  assert.equal(nada.estado, 409);
  assert.equal((await b.sql('select count(*)::int as n from reservas')).rows[0].n, antes);
  const r = await lote({ vpc: 'dev-vpc-t', proyecto: 'proy-t', ttl_horas: 2, rangos: [{ uso: 'pods' }] }, { 'Idempotency-Key': 'ttl-1' });
  assert.equal(r.estado, 201);
  assert.ok(r.cuerpo.grupo.segundos_restantes <= 7200);
  const igual = await lote({ vpc: 'dev-vpc-t', proyecto: 'proy-t', ttl_horas: 2, rangos: [{ uso: 'pods' }] }, { 'Idempotency-Key': 'ttl-1' });
  assert.deepEqual([igual.estado, igual.cuerpo.repetida], [200, true]);
  const otro = await lote({ vpc: 'dev-vpc-otra', proyecto: 'proy-t', rangos: [{ uso: 'pods' }] }, { 'Idempotency-Key': 'ttl-1' });
  assert.deepEqual([otro.estado, otro.cuerpo.error], [409, 'idempotencia_conflicto']);
  const reno = await json(
    fetch(`${url}/api/v1/reservas/grupo/${r.cuerpo.grupo.grupo}/renovar`, { method: 'POST', headers: bearer(agente), body: JSON.stringify({ ttl_horas: 48 }) }),
  );
  assert.equal(reno.estado, 200);
  assert.ok(reno.cuerpo.segundos_restantes > 7200);
});

test('8 · el OpenAPI refleja los campos nuevos y la versión es 0.6.0', opts, async () => {
  const api = await (await fetch(`${url}/api/v1/openapi.json`)).json();
  assert.equal(api.info.version, '0.6.0');
  const sc = api.components.schemas;
  for (const n of ['Pool', 'PoolCrear', 'PoolEditar']) for (const c of ['proyecto', 'vpc', 'padre_id']) assert.ok(sc[n].properties[c], `${n}.${c}`);
  assert.ok(sc.LoteCrear.properties.padre);
  assert.ok(sc.RangoPedido.properties.uso.enum.includes('vpc'));
  assert.ok(api.paths['/api/v1/reservas/grupo/{id}/eventos'].get);
  assert.ok(sc.Simulacion.properties.rangos.items.properties.motivo);
});
