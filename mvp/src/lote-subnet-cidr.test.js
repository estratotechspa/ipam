// «subnet» (antes «nodos») y CIDR exacto en el lote (0.6.0), contra PostgreSQL real y por HTTP. Rangos FICTICIOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' }; // el admin entra «abierto» (modo anónimo del servicio de pruebas)
let b, apagado, habilitado, agente;
let clave = 0;
const json = async (r) => {
  const x = await r;
  return { estado: x.status, cuerpo: await x.json() };
};
const admin = (base, metodo, ruta, cuerpo) =>
  json(fetch(base + ruta, { method: metodo, headers: ADM, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }));
const lote = (base, cuerpo, simular = false) =>
  json(
    fetch(`${base}/api/v1/reservas/lote${simular ? '?simular=true' : ''}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agente}`, 'Content-Type': 'application/json', 'Idempotency-Key': `sc-${++clave}` },
      body: JSON.stringify({ ambiente: 'dev', proyecto: 'proy-s', vpc: 'vpc-s', ...cuerpo }),
    }),
  );
const pool = (id, tipo, cidr, extra = {}) => ({ id, tipo, ambiente: 'dev', proveedor: 'GCP', cidr, ...extra });

test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  const env = { DATABASE_URL: b.url, CUOTA_RESERVAS_POR_TOKEN: '100' };
  apagado = await lanzarServicio(env); // CIDR_MANUAL_AMBIENTES sin definir: apagado
  habilitado = await lanzarServicio({ ...env, CIDR_MANUAL_AMBIENTES: 'dev' });
  agente = (await admin(apagado.url, 'POST', '/api/v1/tokens', { nombre: 'agente-subnet', rol: 'agente' })).cuerpo.token;
  assert.equal(
    (await admin(apagado.url, 'POST', '/api/v1/pools', pool('s-subnet', 'Subnet', '10.150.0.0/16', { mascara_minima: 20, mascara_maxima: 29 }))).estado,
    201,
  );
  assert.equal(
    (
      await admin(
        apagado.url,
        'POST',
        '/api/v1/pools',
        pool('s-pods', 'Pods', '10.160.0.0/14', { mascara_defecto: 20, mascara_minima: 14, mascara_maxima: 24 }),
      )
    ).estado,
    201,
  );
  assert.equal(
    (
      await admin(
        apagado.url,
        'POST',
        '/api/v1/pools',
        pool('s-svc', 'Servicios', '10.170.0.0/16', { mascara_defecto: 24, mascara_minima: 16, mascara_maxima: 27 }),
      )
    ).estado,
    201,
  );
  // La tabla se configura con el nombre nuevo (subnet) y también se acepta el alias (nodos).
  assert.equal((await admin(apagado.url, 'PUT', '/api/v1/pool-uso/dev/subnet', { pool: 's-subnet' })).estado, 200);
  assert.equal((await admin(apagado.url, 'PUT', '/api/v1/pool-uso/dev/pods', { pool: 's-pods' })).estado, 200);
  assert.equal((await admin(apagado.url, 'PUT', '/api/v1/pool-uso/dev/servicios', { pool: 's-svc' })).estado, 200);
});
test.after(async () => {
  if (!hayBase) return;
  await Promise.all([apagado.parar(), habilitado.parar()]);
  await b.borrar();
});

test('la tabla ambiente + uso → pool habla de subnet; «nodos» se acepta como alias y no duplica', opts, async () => {
  const lista = await admin(apagado.url, 'GET', '/api/v1/pool-uso');
  assert.deepEqual(lista.cuerpo.map((f) => f.uso).sort(), ['pods', 'servicios', 'subnet']);
  const alias = await admin(apagado.url, 'PUT', '/api/v1/pool-uso/dev/nodos', { pool: 's-subnet' });
  assert.deepEqual([alias.estado, alias.cuerpo.uso], [200, 'subnet']);
  assert.equal((await admin(apagado.url, 'GET', '/api/v1/pool-uso')).cuerpo.length, 3);
});

test('lote con subnet /25 y secundarios /24: cada rango sale de su pool y la respuesta dice subnet', opts, async () => {
  const sim = await lote(
    apagado.url,
    {
      rangos: [
        { uso: 'subnet', mascara: 25 },
        { uso: 'pods', mascara: 24 },
        { uso: 'servicios', mascara: 24 },
      ],
    },
    true,
  );
  assert.equal(sim.estado, 200, JSON.stringify(sim.cuerpo));
  assert.deepEqual(
    sim.cuerpo.rangos.map((r) => [r.uso, r.cidr]),
    [
      ['subnet', '10.150.0.0/25'],
      ['pods', '10.160.0.0/24'],
      ['servicios', '10.170.0.0/24'],
    ],
  );
  const alias = await lote(apagado.url, { rangos: [{ uso: 'nodos', mascara: 25 }] }, true);
  assert.equal(alias.estado, 200);
  assert.equal(alias.cuerpo.rangos[0].uso, 'subnet');
  const malo = await lote(apagado.url, { rangos: [{ uso: 'gateway', mascara: 25 }] });
  assert.equal(malo.estado, 400); // un uso que no es subnet, nodos, pods, servicios ni vpc se rechaza
});

test('CIDR exacto: apagado por defecto → 400; habilitado en dev → se reserva ese rango y no el primero libre', opts, async () => {
  const pedido = { rangos: [{ uso: 'subnet', cidr: '10.150.7.128/25' }] };
  const no = await lote(apagado.url, pedido);
  assert.deepEqual([no.estado, no.cuerpo.error], [400, 'cidr_manual_no_permitido']);
  const si = await lote(habilitado.url, pedido);
  assert.equal(si.estado, 201, JSON.stringify(si.cuerpo));
  assert.equal(si.cuerpo.grupo.rangos[0].cidr, '10.150.7.128/25');
  assert.equal(si.cuerpo.grupo.rangos[0].rango, 'principal');
  // el rango quedó ocupado: el primer /25 libre sigue siendo el de siempre, y pedir el mismo CIDR choca
  const libres = await (await fetch(`${habilitado.url}/api/v1/pools/s-subnet/libres?mascara=25`, { headers: ADM })).json();
  assert.equal(libres[0], '10.150.0.0/25');
  const choque = await lote(habilitado.url, pedido);
  assert.deepEqual([choque.estado, choque.cuerpo.error], [409, 'solapamiento']);
  assert.ok(choque.cuerpo.sugeridos.length > 0);
});

test('CIDR exacto: IPAM valida alineación, pool y coherencia, y es todo o nada', opts, async () => {
  const pide = (rangos) => lote(habilitado.url, { rangos });
  assert.equal((await pide([{ uso: 'subnet', cidr: '10.150.9.64/25' }])).cuerpo.error, 'cidr_desalineado');
  assert.equal((await pide([{ uso: 'subnet', cidr: '10.150.9.0/25', mascara: 24 }])).cuerpo.error, 'mascara_no_coincide');
  const fuera = await pide([{ uso: 'subnet', cidr: '10.99.0.0/25' }]);
  assert.deepEqual([fuera.estado, fuera.cuerpo.error], [400, 'cidr_fuera_del_pool']);
  const antes = (await (await fetch(`${habilitado.url}/api/v1/pools/s-pods/libres?mascara=24`, { headers: ADM })).json())[0];
  const mixto = await pide([
    { uso: 'pods', mascara: 24 },
    { uso: 'subnet', cidr: '10.150.7.0/24' },
  ]); // el /24 pisa al /25 reservado antes
  assert.equal(mixto.estado, 409);
  const despues = (await (await fetch(`${habilitado.url}/api/v1/pools/s-pods/libres?mascara=24`, { headers: ADM })).json())[0];
  assert.equal(despues, antes, 'el rango de pods no quedó reservado');
});
