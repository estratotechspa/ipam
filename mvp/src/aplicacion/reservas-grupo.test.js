// Reserva en grupo (clúster GKE) probada SIN base de datos, con el repositorio en memoria. Rangos FICTICIOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearRepositorioMemoria } = require('../adaptadores/persistencia/memoria/repositorio');
const { crearReservasGrupo } = require('./reservas-grupo');
const { crearPoolUso } = require('./pool-uso');

const POOLS = [
  { id: 'dev-nodos', tipo: 'Nodos', ambiente: 'dev', proveedor: 'GCP', cidr: '172.31.0.0/18' },
  { id: 'dev-pods', tipo: 'Pods', ambiente: 'dev', proveedor: 'GCP', cidr: '10.236.0.0/13' }, // dos /14
  { id: 'dev-svc', tipo: 'Servicios', ambiente: 'dev', proveedor: 'GCP', cidr: '10.240.0.0/16' },
  { id: 'qa-todo', tipo: 'Todo', ambiente: 'qa', proveedor: 'GCP', cidr: '10.100.0.0/12' },
];
const AGENTE = { nombre: 'svc:agente-redes', rol: 'agente', tipo: 'token' };
const OTRO = { nombre: 'svc:otro', rol: 'agente', tipo: 'token' };
const ADMIN = { nombre: 'jefe@empresa.example', rol: 'admin', tipo: 'oidc' };
const PEDIDO = {
  ambiente: 'dev',
  proyecto: 'proy-pagos',
  subred: 'gke-principal',
  rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'pods' }, { uso: 'servicios' }],
};

async function entorno({ cuota = 10, mapear = true } = {}) {
  const reloj = {
    t: new Date('2026-11-03T12:00:00Z'),
    ahora() {
      return this.t;
    },
  };
  const repo = crearRepositorioMemoria({ reloj, pools: POOLS });
  const publicados = [];
  const eventos = { publicar: async (tipo, d) => void publicados.push({ tipo, ...d }) };
  const config = { reservas: { ttlHoras: 72, ttlMaxHoras: 168, exigeAprobador: false }, limite: { cuotaReservasPorToken: cuota } };
  const g = crearReservasGrupo({ repo, eventos, config });
  const uso = crearPoolUso({ repo });
  if (mapear) {
    await uso.guardar('dev', 'nodos', 'dev-nodos');
    await uso.guardar('dev', 'pods', 'dev-pods');
    await uso.guardar('dev', 'servicios', 'dev-svc');
  }
  return { g, uso, repo, publicados };
}

test('reserva los tres rangos juntos: nodos /24, pods /14 y servicios /20 por defecto de GKE, con grupo y rango', async () => {
  const { g, publicados } = await entorno();
  const r = await g.reservarLote(AGENTE, PEDIDO);
  assert.equal(r.ok, true, JSON.stringify(r));
  const filas = r.grupo.rangos.map((x) => [x.rango, x.pool_id, x.cidr]);
  assert.deepEqual(filas, [
    ['principal', 'dev-nodos', '172.31.0.0/24'],
    ['pods', 'dev-pods', '10.236.0.0/14'],
    ['servicios', 'dev-svc', '10.240.0.0/20'],
  ]);
  assert.equal(new Set(r.grupo.rangos.map((x) => x.grupo)).size, 1, 'todos comparten el grupo');
  assert.equal(r.grupo.estado, 'reservada');
  assert.equal(r.grupo.segundos_restantes, 72 * 3600, 'vigencia por defecto de 72 h');
  assert.ok(r.grupo.rangos.every((x) => x.ticket === r.grupo.ticket && x.proyecto === 'proy-pagos' && x.subred === 'gke-principal'));
  assert.deepEqual(
    publicados.map((p) => p.tipo),
    ['grupo_reservado'],
  );
});

test('todo o nada: si un rango no cabe no se reserva ninguno', async () => {
  const { g, repo } = await entorno();
  assert.equal((await g.reservarLote(AGENTE, { ...PEDIDO, rangos: [{ uso: 'pods' }] })).ok, true);
  assert.equal((await g.reservarLote(AGENTE, { ...PEDIDO, rangos: [{ uso: 'pods' }] })).ok, true); // el pool tiene dos /14
  const antes = (await repo.listarReservas({ limite: 100 })).length;
  const r = await g.reservarLote(AGENTE, PEDIDO); // nodos y servicios caben, pods ya no
  assert.deepEqual([r.ok, r.error, r.uso], [false, 'sin_espacio', 'pods']);
  assert.equal((await repo.listarReservas({ limite: 100 })).length, antes, 'no quedó ningún rango suelto');
});

test('simular dice qué reservaría sin reservar nada', async () => {
  const { g, repo } = await entorno();
  const r = await g.reservarLote(AGENTE, PEDIDO, undefined, { simular: true });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.rangos.map((x) => [x.uso, x.cidr]),
    [
      ['nodos', '172.31.0.0/24'],
      ['pods', '10.236.0.0/14'],
      ['servicios', '10.240.0.0/20'],
    ],
  );
  assert.equal((await repo.listarReservas({ limite: 100 })).length, 0);
});

test('si dos usos comparten pool no se pisan entre sí', async () => {
  const { g, uso } = await entorno({ mapear: false });
  await uso.guardar('qa', 'pods', 'qa-todo');
  await uso.guardar('qa', 'servicios', 'qa-todo');
  const r = await g.reservarLote(AGENTE, { ambiente: 'qa', rangos: [{ uso: 'pods' }, { uso: 'servicios' }] });
  assert.deepEqual(
    r.grupo.rangos.map((x) => x.cidr),
    ['10.100.0.0/14', '10.104.0.0/20'],
  );
});

test('sin pool configurado para un uso: 422 con el motivo y no reserva nada', async () => {
  const { g } = await entorno({ mapear: false });
  const r = await g.reservarLote(AGENTE, PEDIDO);
  assert.deepEqual([r.ok, r.tipo, r.error, r.uso], [false, 'ambiguo', 'uso_sin_pool', 'nodos']);
});

test('validaciones: nodos exigen máscara, usos repetidos o desconocidos, ambiente y TTL', async () => {
  const { g } = await entorno();
  const err = async (cambio) => (await g.reservarLote(AGENTE, { ...PEDIDO, ...cambio })).error;
  assert.equal(await err({ rangos: [{ uso: 'nodos' }] }), 'falta_tamano');
  assert.equal(await err({ rangos: Array.from({ length: 21 }, () => ({ uso: 'servicios' })) }), 'rangos_invalidos');
  assert.equal(await err({ rangos: [{ uso: 'pods', nombre: 'x'.repeat(81) }] }), 'nombre_invalido');
  assert.equal(await err({ grupo: 'no-uuid' }), 'grupo_invalido');
  assert.equal(await err({ rangos: [{ uso: 'otro' }] }), 'uso_invalido');
  assert.equal(await err({ rangos: [] }), 'rangos_invalidos');
  assert.equal(await err({ ambiente: 'staging' }), 'ambiente_invalido');
  assert.equal(await err({ ttl_horas: 169 }), 'ttl_excede_maximo');
  assert.equal(await err({ rangos: [{ uso: 'pods', mascara: 7 }] }), 'mascara_invalida');
});

test('idempotente: la misma clave devuelve el mismo grupo; liberado, la clave ya no sirve', async () => {
  const { g } = await entorno();
  const a = await g.reservarLote(AGENTE, PEDIDO, 'mr-12');
  const b = await g.reservarLote(AGENTE, PEDIDO, 'mr-12');
  assert.deepEqual([b.repetida, b.grupo.grupo], [true, a.grupo.grupo]);
  assert.equal(b.grupo.rangos.length, 3);
  await g.liberarGrupo(AGENTE, a.grupo.grupo);
  assert.equal((await g.reservarLote(AGENTE, PEDIDO, 'mr-12')).error, 'clave_idem_usada');
});

test('la cuota cuenta cada rango como una reserva', async () => {
  const { g } = await entorno({ cuota: 5 });
  assert.equal((await g.reservarLote(AGENTE, PEDIDO)).ok, true); // 3 de 5
  const r = await g.reservarLote(AGENTE, PEDIDO); // pediría 3 más
  assert.deepEqual([r.ok, r.tipo, r.error, r.vigentes], [false, 'cuota', 'cuota_excedida', 3]);
});

test('confirmar el grupo (admin) pasa los tres rangos a asignación; repetir no duplica; las asignaciones llevan grupo y rango', async () => {
  const { g, repo } = await entorno();
  const a = await g.reservarLote(AGENTE, PEDIDO);
  const c = await g.confirmarGrupo(ADMIN, a.grupo.grupo, { aprobado_por: 'ana@empresa.example', referencia: 'MR-12' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.grupo.estado, 'confirmada');
  assert.deepEqual(c.aprobacion, { aprobado_por: 'ana@empresa.example', referencia: 'MR-12' });
  const asig = await repo.asignacionPorId(c.grupo.rangos[1].asignacion_id);
  assert.deepEqual([asig.grupo, asig.rango], [a.grupo.grupo, 'pods']);
  const otra = await g.confirmarGrupo(ADMIN, a.grupo.grupo, {});
  assert.equal(otra.repetida, true);
});

test('un grupo con un rango expirado no se confirma, y no deja a medias a los demás', async () => {
  const { g, repo } = await entorno();
  const a = await g.reservarLote(AGENTE, PEDIDO);
  await repo.marcarExpirada(a.grupo.rangos[2].id);
  const c = await g.confirmarGrupo(ADMIN, a.grupo.grupo, {});
  assert.deepEqual([c.ok, c.error], [false, 'reserva_no_vigente']);
  const v = await g.obtenerGrupo(a.grupo.grupo);
  assert.deepEqual(
    v.grupo.rangos.map((x) => x.estado),
    ['reservada', 'reservada', 'expirada'],
  );
  assert.equal(v.grupo.estado, 'mixto');
});

test('liberar: el dueño libera lo vigente; otro token no; ya confirmado, solo un admin y se borran las asignaciones', async () => {
  const { g } = await entorno();
  const a = await g.reservarLote(AGENTE, PEDIDO);
  assert.equal((await g.liberarGrupo(OTRO, a.grupo.grupo)).error, 'no_es_dueno');
  const l = await g.liberarGrupo(AGENTE, a.grupo.grupo);
  assert.deepEqual([l.ok, l.grupo.estado, l.asignaciones_borradas], [true, 'liberada', 0]);
  const b = await g.reservarLote(AGENTE, PEDIDO);
  await g.confirmarGrupo(ADMIN, b.grupo.grupo, {});
  assert.equal((await g.liberarGrupo(AGENTE, b.grupo.grupo)).error, 'solo_admin_libera_asignacion');
  const ll = await g.liberarGrupo(ADMIN, b.grupo.grupo);
  assert.deepEqual([ll.ok, ll.asignaciones_borradas], [true, 3]);
});

test('tabla ambiente + uso → pool: valida ambiente, uso y que el pool sea del mismo ambiente', async () => {
  const { uso } = await entorno({ mapear: false });
  assert.equal((await uso.guardar('dev', 'pods', 'dev-pods')).ok, true);
  assert.equal((await uso.guardar('dev', 'pods', 'qa-todo')).error, 'pool_de_otro_ambiente');
  assert.equal((await uso.guardar('dev', 'pods', 'no-existe')).error, 'pool_no_existe');
  assert.equal((await uso.guardar('dev', 'x', 'dev-pods')).error, 'uso_invalido');
  assert.deepEqual((await uso.listar()).filas, [{ ambiente: 'dev', uso: 'pods', pool_id: 'dev-pods' }]);
  assert.equal((await uso.borrar('dev', 'pods')).ok, true);
  assert.equal((await uso.borrar('dev', 'pods')).ok, false);
});

test('un grupo inexistente o con id mal formado es 404', async () => {
  const { g } = await entorno();
  for (const f of [g.obtenerGrupo('x'), g.obtenerGrupo('11111111-1111-4111-8111-111111111111'), g.confirmarGrupo(ADMIN, 'x', {}), g.liberarGrupo(ADMIN, 'x')])
    assert.equal((await f).tipo, 'no_encontrado');
});

test('nodos y servicios son opcionales: solo pods, o solo servicios', async () => {
  const { g } = await entorno();
  const r = await g.reservarLote(AGENTE, { ambiente: 'dev', proyecto: 'proy-x', rangos: [{ uso: 'pods' }] });
  assert.deepEqual(
    r.grupo.rangos.map((x) => x.rango),
    ['pods'],
  );
});

test('varias subredes y varios rangos del mismo uso en UN solo grupo, con nombre por rango', async () => {
  const { g } = await entorno();
  const r = await g.reservarLote(AGENTE, {
    ambiente: 'dev',
    proyecto: 'proy-pagos',
    rangos: [
      { uso: 'nodos', mascara: 24, subred: 'gke-a' },
      { uso: 'pods', nombre: 'pods-a', subred: 'gke-a' },
      { uso: 'servicios', nombre: 'svc-a', subred: 'gke-a' },
      { uso: 'nodos', mascara: 26, subred: 'gke-b' },
      { uso: 'pods', nombre: 'pods-b', subred: 'gke-b' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(new Set(r.grupo.rangos.map((x) => x.grupo)).size, 1, 'un solo grupo');
  assert.equal(r.grupo.rangos.length, 5);
  const pods = r.grupo.rangos.filter((x) => x.rango === 'pods');
  assert.deepEqual(
    pods.map((x) => [x.nombre, x.subred]),
    [
      ['pods-a', 'gke-a'],
      ['pods-b', 'gke-b'],
    ],
  );
  assert.notEqual(pods[0].cidr, pods[1].cidr, 'cada rango de pods es distinto');
  const nodos = r.grupo.rangos.filter((x) => x.rango === 'principal');
  assert.deepEqual(
    nodos.map((x) => [x.subred, x.cidr.split('/')[1]]),
    [
      ['gke-a', '24'],
      ['gke-b', '26'],
    ].sort(),
  );
  const c = await g.confirmarGrupo(ADMIN, r.grupo.grupo, {});
  assert.equal(c.grupo.rangos.length, 5, 'se aprueba el pedido entero de una vez');
});

test('agregar rangos a una subred existente: mismo grupo, sin reservar nodos', async () => {
  const { g, uso } = await entorno();
  const a = await g.reservarLote(AGENTE, PEDIDO);
  const b = await g.reservarLote(AGENTE, { ambiente: 'dev', grupo: a.grupo.grupo, rangos: [{ uso: 'pods', nombre: 'pods-extra', subred: 'gke-principal' }] });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.grupo.grupo, a.grupo.grupo);
  assert.equal(b.grupo.rangos.length, 4);
  assert.deepEqual([b.grupo.proyecto, b.grupo.ticket], [a.grupo.proyecto, a.grupo.ticket], 'hereda proyecto y ticket del grupo');
  // reglas: dueño, ambiente y vigencia
  await uso.guardar('qa', 'pods', 'qa-todo');
  assert.equal((await g.reservarLote(OTRO, { ambiente: 'dev', grupo: a.grupo.grupo, rangos: [{ uso: 'pods' }] })).error, 'no_es_dueno');
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'qa', grupo: a.grupo.grupo, rangos: [{ uso: 'pods' }] })).error, 'grupo_de_otro_ambiente');
  assert.equal(
    (await g.reservarLote(AGENTE, { ambiente: 'dev', grupo: '11111111-1111-4111-8111-111111111111', rangos: [{ uso: 'pods' }] })).tipo,
    'no_encontrado',
  );
  await g.liberarGrupo(AGENTE, a.grupo.grupo);
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'dev', grupo: a.grupo.grupo, rangos: [{ uso: 'pods' }] })).error, 'grupo_no_vigente');
});

test('idempotencia: la misma clave con otros parámetros es conflicto; con los mismos, el mismo grupo', async () => {
  const { g } = await entorno();
  const a = await g.reservarLote(AGENTE, PEDIDO, 'mr-77');
  const cambiado = { ...PEDIDO, rangos: [{ uso: 'nodos', mascara: 25 }, { uso: 'pods' }, { uso: 'servicios' }] };
  assert.equal((await g.reservarLote(AGENTE, cambiado, 'mr-77')).error, 'idempotencia_conflicto');
  assert.equal((await g.reservarLote(AGENTE, { ...PEDIDO, proyecto: 'otro' }, 'mr-77')).error, 'idempotencia_conflicto');
  const mismo = await g.reservarLote(AGENTE, { ...PEDIDO, rangos: [...PEDIDO.rangos].reverse() }, 'mr-77'); // el orden no importa
  assert.deepEqual([mismo.repetida, mismo.grupo.grupo], [true, a.grupo.grupo]);
});

test('«prd» es alias de «prod» en el lote y en la tabla ambiente + uso → pool', async () => {
  const { g, uso, repo } = await entorno({ mapear: false });
  repo.pools?.set?.('x', {});
  assert.equal((await uso.guardar('prd', 'pods', 'dev-pods')).error, 'pool_de_otro_ambiente', 'prd se trata como prod: el pool es de dev');
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'prd', rangos: [{ uso: 'pods' }] })).error, 'uso_sin_pool');
  assert.equal((await uso.borrar('prd', 'pods')).error, 'no_encontrado');
});
