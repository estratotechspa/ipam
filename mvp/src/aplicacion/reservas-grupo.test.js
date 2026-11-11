// Reserva en grupo (clúster GKE) probada SIN base de datos, con el repositorio en memoria. Rangos FICTICIOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearRepositorioMemoria } = require('../adaptadores/persistencia/memoria/repositorio');
const { crearReservasGrupo } = require('./reservas-grupo');
const { crearGestionGrupo } = require('./gestion-grupo');
const { crearPoolUso } = require('./pool-uso');

const POOLS = [
  { id: 'dev-nodos', tipo: 'Nodos', ambiente: 'dev', proveedor: 'GCP', cidr: '172.31.0.0/18' },
  { id: 'dev-pods', tipo: 'Pods', ambiente: 'dev', proveedor: 'GCP', cidr: '10.236.0.0/13', mascara_defecto: 14, mascara_minima: 13, mascara_maxima: 22 }, // dos /14
  { id: 'dev-svc', tipo: 'Servicios', ambiente: 'dev', proveedor: 'GCP', cidr: '10.240.0.0/16', mascara_defecto: 20 },
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

async function entorno({ cuota = 10, mapear = true, exigir = [], cidrManual = [] } = {}) {
  const reloj = {
    t: new Date('2026-11-03T12:00:00Z'),
    ahora() {
      return this.t;
    },
    avanzar(h) {
      this.t = new Date(this.t.getTime() + h * 3600_000);
    },
  };
  const repo = crearRepositorioMemoria({ reloj, pools: POOLS });
  const publicados = [];
  const eventos = { publicar: async (tipo, d) => void publicados.push({ tipo, ...d }) };
  const config = {
    reservas: { ttlHoras: 72, ttlMaxHoras: 168, exigeAprobador: false, exigirPoolVpc: exigir, cidrManualAmbientes: cidrManual },
    limite: { cuotaReservasPorToken: cuota },
  };
  const g = { ...crearReservasGrupo({ repo, eventos, config }), ...crearGestionGrupo({ repo, eventos, config }) };
  const uso = crearPoolUso({ repo });
  if (mapear) {
    await uso.guardar('dev', 'nodos', 'dev-nodos');
    await uso.guardar('dev', 'pods', 'dev-pods');
    await uso.guardar('dev', 'servicios', 'dev-svc');
  }
  return { g, uso, repo, publicados, reloj };
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
      ['subnet', '172.31.0.0/24'],
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
  const r = await g.reservarLote(AGENTE, {
    ambiente: 'qa',
    rangos: [
      { uso: 'pods', mascara: 14 },
      { uso: 'servicios', mascara: 20 },
    ],
  });
  assert.deepEqual(
    r.grupo.rangos.map((x) => x.cidr),
    ['10.100.0.0/14', '10.104.0.0/20'],
  );
});

test('sin pool configurado para un uso: 422 con el motivo y no reserva nada', async () => {
  const { g } = await entorno({ mapear: false });
  const r = await g.reservarLote(AGENTE, PEDIDO);
  assert.deepEqual([r.ok, r.tipo, r.error, r.uso], [false, 'ambiguo', 'uso_sin_pool', 'subnet']);
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
  assert.equal(
    (await g.reservarLote(AGENTE, { ambiente: 'qa', grupo: a.grupo.grupo, rangos: [{ uso: 'pods', mascara: 14 }] })).error,
    'grupo_de_otro_ambiente',
  );
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

test('límites de máscara por pool: sin tamaño y sin default → falta_tamano; fuera de mínima/máxima → mascara_invalida; global /8 a /29', async () => {
  const { g } = await entorno();
  // nodos: el pool no tiene default
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'dev', rangos: [{ uso: 'nodos' }] })).error, 'falta_tamano');
  // dev-pods: mínima /13, máxima /22
  const err = async (mascara) => (await g.reservarLote(AGENTE, { ambiente: 'dev', rangos: [{ uso: 'pods', mascara }] })).error;
  assert.equal(await err(12), 'mascara_invalida', 'más grande que el pool (y que la mínima)');
  assert.equal(await err(23), 'mascara_invalida', 'más chico que la máxima');
  assert.equal(await err(30), 'mascara_invalida', 'fuera de /8 a /29');
  assert.equal(await err(33), 'mascara_invalida');
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'dev', rangos: [{ uso: 'pods', mascara: 22 }] })).ok, true);
  // el default del pool se usa solo cuando falta la máscara
  const d = await g.reservarLote(AGENTE, { ambiente: 'dev', rangos: [{ uso: 'servicios' }] });
  assert.equal(d.grupo.rangos[0].cidr.split('/')[1], '20');
});

test('renovar: extiende sin cambiar los CIDR, nunca acorta, respeta el tope acumulado y no renueva lo que no está vigente', async () => {
  const { g, reloj } = await entorno();
  const a = await g.reservarLote(AGENTE, { ...PEDIDO, ttl_horas: 24 });
  const cidrs = a.grupo.rangos.map((x) => x.cidr);
  reloj.avanzar(10); // pasaron 10 h: quedan 14
  const r = await g.renovarGrupo(AGENTE, a.grupo.grupo, { ttl_horas: 48 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.grupo.rangos.map((x) => x.cidr),
    cidrs,
    'mismos CIDR',
  );
  assert.equal(r.grupo.segundos_restantes, 48 * 3600);
  assert.equal((await g.renovarGrupo(AGENTE, a.grupo.grupo, { ttl_horas: 2 })).grupo.segundos_restantes, 48 * 3600, 'renovar con menos nunca acorta');
  // tope acumulado: 168 h desde la creación; ya pasaron 10, así que pedir 160 h más (170) lo excede
  const excede = await g.renovarGrupo(AGENTE, a.grupo.grupo, { ttl_horas: 160 });
  assert.equal(excede.error, 'ttl_excede_maximo');
  assert.match(excede.mensaje, /hasta 158 h/);
  assert.equal((await g.renovarGrupo(AGENTE, a.grupo.grupo, { ttl_horas: 158 })).ok, true);
  assert.equal((await g.renovarGrupo(OTRO, a.grupo.grupo, {})).error, 'no_es_dueno');
  // confirmado o liberado: no se renueva
  await g.confirmarGrupo(ADMIN, a.grupo.grupo, {});
  assert.equal((await g.renovarGrupo(AGENTE, a.grupo.grupo, {})).error, 'grupo_no_vigente');
  const b = await g.reservarLote(AGENTE, PEDIDO);
  await g.liberarGrupo(AGENTE, b.grupo.grupo);
  assert.equal((await g.renovarGrupo(AGENTE, b.grupo.grupo, {})).error, 'grupo_no_vigente');
  assert.equal((await g.renovarGrupo(AGENTE, 'x', {})).tipo, 'no_encontrado');
});

test('un grupo vencido no se renueva', async () => {
  const { g, reloj } = await entorno();
  const a = await g.reservarLote(AGENTE, { ...PEDIDO, ttl_horas: 1 });
  reloj.avanzar(2);
  assert.equal((await g.renovarGrupo(AGENTE, a.grupo.grupo, {})).error, 'grupo_no_vigente');
});

test('un rango agregado caduca con el grupo (una sola caducidad), también después de renovar', async () => {
  const { g, reloj } = await entorno();
  const a = await g.reservarLote(AGENTE, { ...PEDIDO, ttl_horas: 24 });
  reloj.avanzar(6);
  const b = await g.reservarLote(AGENTE, { ambiente: 'dev', grupo: a.grupo.grupo, ttl_horas: 100, rangos: [{ uso: 'pods', nombre: 'otro' }] });
  assert.equal(b.ok, true);
  assert.equal(new Set(b.grupo.rangos.map((x) => new Date(x.expira_en).getTime())).size, 1, 'todos caducan a la vez');
  assert.equal(b.grupo.segundos_restantes, 18 * 3600, 'la del grupo (24 h desde la creación), no la del pedido nuevo');
});

test('buscar grupos por clave, ticket, estado y por vencer; un token solo ve los suyos', async () => {
  const { g, reloj } = await entorno();
  const a = await g.reservarLote(AGENTE, { ...PEDIDO, ticket: 'NET-1' }, 'mr-1');
  await g.reservarLote(OTRO, { ...PEDIDO, ticket: 'NET-2' }, 'mr-1'); // la misma clave, otro dueño
  const porClave = await g.buscarGrupos(AGENTE, { clave: 'mr-1' });
  assert.deepEqual(
    porClave.grupos.map((x) => x.grupo),
    [a.grupo.grupo],
  );
  assert.deepEqual((await g.buscarGrupos(AGENTE, { ticket: 'NET-2' })).grupos, [], 'un token no ve lo de otro, ni por ticket');
  assert.equal((await g.buscarGrupos(ADMIN, { ticket: 'NET-2' })).grupos.length, 1, 'una persona ve todos');
  assert.equal((await g.buscarGrupos(AGENTE, { clave: 'no-existe' })).grupos.length, 0);
  assert.equal((await g.buscarGrupos(AGENTE, { estado: 'confirmada' })).grupos.length, 0);
  assert.equal((await g.buscarGrupos(AGENTE, { estado: 'reservada' })).grupos.length, 1);
  reloj.avanzar(70); // quedan 2 h de las 72
  assert.equal((await g.buscarGrupos(AGENTE, { por_expirar_horas: 3 })).grupos.length, 1);
  assert.equal((await g.buscarGrupos(AGENTE, { por_expirar_horas: 1 })).grupos.length, 0);
  assert.equal((await g.buscarGrupos(AGENTE, { estado: 'rara' })).error, 'estado_invalido');
  assert.equal((await g.buscarGrupos(AGENTE, { por_expirar_horas: 'x' })).error, 'por_expirar_invalido');
});

test('simulación con contexto: cuota, libre de cada pool y versión de la tabla; version_tabla vieja se rechaza', async () => {
  const { g, uso } = await entorno({ cuota: 5 });
  const s = await g.reservarLote(AGENTE, PEDIDO, undefined, { simular: true });
  assert.deepEqual(s.cuota, { usada: 0, limite: 5, necesaria: 3, alcanza: true });
  assert.deepEqual(
    s.pools.map((p) => p.pool),
    ['dev-nodos', 'dev-pods', 'dev-svc'],
  );
  assert.equal(s.pools.find((p) => p.pool === 'dev-nodos').direcciones_libres, 2 ** 14);
  await g.reservarLote(AGENTE, PEDIDO);
  const s2 = await g.reservarLote(AGENTE, PEDIDO, undefined, { simular: true });
  assert.deepEqual(s2.cuota, { usada: 3, limite: 5, necesaria: 3, alcanza: false }, 'informa que no alcanza, sin gastar cuota');
  const con = await g.reservarLote(ADMIN, PEDIDO, undefined, { simular: true });
  assert.equal(con.cuota, null, 'una persona no tiene cuota');
  // version_tabla: la misma pasa; si la tabla cambia entre la simulación y la reserva, 409
  const v = s.version_tabla;
  const nuevo = { ...PEDIDO, rangos: [{ uso: 'pods', mascara: 22 }] };
  const ok = await g.reservarLote(ADMIN, { ...nuevo, version_tabla: v });
  assert.equal(ok.ok, true);
  assert.equal(ok.version_tabla, v);
  await uso.guardar('dev', 'servicios', 'dev-svc'); // mismo valor: no cambia
  assert.equal((await g.reservarLote(ADMIN, { ...nuevo, version_tabla: v })).ok, true);
  await uso.borrar('dev', 'servicios');
  const r = await g.reservarLote(ADMIN, { ...nuevo, version_tabla: v });
  assert.deepEqual([r.ok, r.error], [false, 'version_tabla_cambiada']);
});

const BLOQUE = { ambiente: 'dev', proyecto: 'proy-x', vpc: 'vpc-x', rangos: [{ uso: 'vpc', mascara: 20 }] };

test('el pool de la VPC: el bloque se reserva sin crear nada y, al confirmar, nace el pool hijo; los nodos salen de él', async () => {
  const { g, repo, publicados } = await entorno();
  const r = await g.reservarLote(AGENTE, BLOQUE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.grupo.rangos[0].rango, r.grupo.rangos[0].pool_id, r.grupo.rangos[0].cidr], ['vpc', 'dev-nodos', '172.31.0.0/20']);
  assert.equal(await repo.obtenerPool('vpc-x'), undefined, 'reservar no crea el pool');
  const c = await g.confirmarGrupo(ADMIN, r.grupo.grupo, {});
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(
    c.pools_creados.map((p) => [p.id, p.padre_id, p.proyecto, p.vpc, p.cidr]),
    [['vpc-x', 'dev-nodos', 'proy-x', 'vpc-x', '172.31.0.0/20']],
  );
  assert.ok(
    publicados.some((e) => e.id === 'vpc-x' && e.grupo === r.grupo.grupo),
    'se publica pool_creado',
  ); // (el arnés mezcla el tipo del pool con el del evento)
  const nodos = await g.reservarLote(AGENTE, { ambiente: 'dev', proyecto: 'proy-x', vpc: 'vpc-x', rangos: [{ uso: 'nodos', mascara: 24 }] });
  assert.equal(nodos.grupo.rangos[0].pool_id, 'vpc-x');
  assert.equal((await repo.ocupados('dev-nodos')).includes('172.31.0.0/20'), true, 'el bloque cuenta como ocupado en el padre');
  const sim = await g.reservarLote(
    AGENTE,
    { ambiente: 'dev', vpc: 'vpc-x', proyecto: 'proy-x', rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'pods' }] },
    undefined,
    { simular: true },
  );
  assert.deepEqual(
    sim.rangos.map((x) => [x.pool, x.criterio]),
    [
      ['vpc-x', 'vpc'],
      ['dev-pods', 'pool_uso'],
    ],
  );
  // Liberar el grupo del bloque con una subred dentro se rechaza; sin ella, retira el pool.
  const rechazo = await g.liberarGrupo(ADMIN, r.grupo.grupo);
  assert.deepEqual([rechazo.ok, rechazo.error], [false, 'pool_en_uso']);
  assert.notEqual(await repo.obtenerPool('vpc-x'), undefined);
  await g.liberarGrupo(AGENTE, nodos.grupo.grupo);
  assert.equal((await g.liberarGrupo(ADMIN, r.grupo.grupo)).pools_eliminados.length, 1);
  assert.equal(await repo.obtenerPool('vpc-x'), undefined, 'vacío, el pool se retira con su bloque');
});

test('el bloque de la VPC expirado o liberado no crea pool; confirmar uno expirado se rechaza', async () => {
  const { g, repo, reloj } = await entorno();
  const a = await g.reservarLote(AGENTE, BLOQUE);
  await g.liberarGrupo(AGENTE, a.grupo.grupo);
  assert.equal(await repo.obtenerPool('vpc-x'), undefined);
  const b = await g.reservarLote(AGENTE, { ...BLOQUE, vpc: 'vpc-y' });
  reloj.avanzar(80);
  const c = await g.confirmarGrupo(ADMIN, b.grupo.grupo, {});
  assert.deepEqual([c.ok, c.error], [false, 'reserva_no_vigente']);
  assert.equal(await repo.obtenerPool('vpc-y'), undefined);
});

test('exigir_pool_vpc por ambiente: sin pool, vpc_sin_pool; apagado, pool-uso como siempre; otro ambiente no se afecta', async () => {
  const { g } = await entorno({ exigir: ['dev'] });
  const r = await g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'sin-pool', proyecto: 'p', rangos: [{ uso: 'nodos', mascara: 24 }] });
  assert.deepEqual([r.ok, r.error], [false, 'vpc_sin_pool']);
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'dev', rangos: [{ uso: 'nodos', mascara: 24 }] })).error, 'vpc_requerida');
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'sin-pool', rangos: [{ uso: 'pods' }] })).ok, true, 'solo los nodos se exigen por VPC');
  const apagado = await entorno({ exigir: [] });
  const ok = await apagado.g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'sin-pool', proyecto: 'p', rangos: [{ uso: 'nodos', mascara: 24 }] });
  assert.deepEqual([ok.ok, ok.grupo.rangos[0].pool_id], [true, 'dev-nodos']);
  const todos = await entorno({ exigir: ['todos'] });
  assert.equal((await todos.g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'sin-pool', rangos: [{ uso: 'nodos', mascara: 24 }] })).error, 'vpc_sin_pool');
});

test('vpc_incoherente: una VPC con otro proyecto en el mismo ambiente; vpc_ambigua si dos pools la comparten y no se indica el proyecto', async () => {
  const { g, repo } = await entorno();
  await g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'vpc-z', proyecto: 'uno', rangos: [{ uso: 'pods' }] });
  const mal = await g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'vpc-z', proyecto: 'dos', rangos: [{ uso: 'servicios' }] });
  assert.deepEqual([mal.ok, mal.error, mal.proyectos_existentes], [false, 'vpc_incoherente', ['uno']]);
  assert.equal((await g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'vpc-z', proyecto: 'uno', rangos: [{ uso: 'servicios' }] })).ok, true);
  await repo.insertarPoolSiNoExiste({
    id: 'z-uno',
    tipo: 'VPC',
    ambiente: 'dev',
    proveedor: 'GCP',
    cidr: '172.31.16.0/20',
    vpc: 'otra',
    proyecto: 'uno',
    padre_id: 'dev-nodos',
  });
  await repo.insertarPoolSiNoExiste({
    id: 'z-dos',
    tipo: 'VPC',
    ambiente: 'dev',
    proveedor: 'GCP',
    cidr: '172.31.32.0/20',
    vpc: 'otra',
    proyecto: 'dos',
    padre_id: 'dev-nodos',
  });
  const amb = await g.reservarLote(AGENTE, { ambiente: 'dev', vpc: 'otra', rangos: [{ uso: 'nodos', mascara: 24 }] });
  assert.deepEqual([amb.error, amb.opciones.length], ['vpc_ambigua', 2]);
});

test('el bloque de la VPC: va solo, con proyecto y máscara; el padre es de su ambiente y la VPC no se repite', async () => {
  const { g } = await entorno();
  assert.equal((await g.reservarLote(AGENTE, { ...BLOQUE, rangos: [{ uso: 'vpc', mascara: 20 }, { uso: 'pods' }] })).error, 'vpc_no_se_mezcla');
  assert.equal((await g.reservarLote(AGENTE, { ...BLOQUE, proyecto: undefined })).error, 'proyecto_requerido');
  assert.equal((await g.reservarLote(AGENTE, { ...BLOQUE, rangos: [{ uso: 'vpc' }] })).error, 'falta_tamano');
  assert.equal((await g.reservarLote(AGENTE, { ...BLOQUE, padre: 'qa-todo' })).error, 'pool_de_otro_ambiente');
  assert.equal((await g.reservarLote(AGENTE, { ...BLOQUE, rangos: [{ uso: 'vpc', mascara: 18 }] })).error, 'mascara_invalida', 'no más grande que el padre');
  const bien = await g.reservarLote(AGENTE, { ...BLOQUE, padre: 'dev-nodos' }, 'k-1');
  assert.equal(bien.ok, true, JSON.stringify(bien));
  assert.equal((await g.reservarLote(AGENTE, { ...BLOQUE, padre: 'dev-nodos' }, 'k-1')).repetida, true, 'la repetición idempotente devuelve el mismo grupo');
  assert.equal((await g.reservarLote(OTRO, BLOQUE)).error, 'vpc_duplicada');
});

test('B1: el dueño ve los eventos de su grupo; otro token no', async () => {
  const { g, repo } = await entorno();
  const r = await g.reservarLote(AGENTE, PEDIDO);
  await repo.registrarEvento('grupo_reservado', { grupo: r.grupo.grupo });
  assert.equal((await g.eventosDeGrupo(AGENTE, r.grupo.grupo)).eventos.length, 1);
  assert.equal((await g.eventosDeGrupo(ADMIN, r.grupo.grupo)).ok, true);
  assert.equal((await g.eventosDeGrupo(OTRO, r.grupo.grupo)).error, 'no_es_dueno');
  assert.equal((await g.eventosDeGrupo(AGENTE, 'no-uuid')).error, 'no_encontrado');
});

// ---- «subnet» (antes «nodos») y CIDR exacto opcional -----------------------------------------------------------
const PEDIDO_SUBNET = {
  ambiente: 'dev',
  proyecto: 'proy-pagos',
  subred: 'gke-principal',
  rangos: [
    { uso: 'subnet', mascara: 25 },
    { uso: 'pods', mascara: 22 },
    { uso: 'servicios', mascara: 24 },
  ],
};

test('«subnet» es el uso del rango principal y «nodos» sigue funcionando como alias, respondiendo siempre subnet', async () => {
  const { g, uso } = await entorno({ mapear: false });
  await uso.guardar('dev', 'subnet', 'dev-nodos');
  await uso.guardar('dev', 'pods', 'dev-pods');
  const nuevo = await g.reservarLote(
    AGENTE,
    {
      ...PEDIDO_SUBNET,
      rangos: [
        { uso: 'subnet', mascara: 25 },
        { uso: 'pods', mascara: 22 },
      ],
    },
    undefined,
    { simular: true },
  );
  const alias = await g.reservarLote(
    AGENTE,
    {
      ...PEDIDO_SUBNET,
      rangos: [
        { uso: 'nodos', mascara: 25 },
        { uso: 'pods', mascara: 22 },
      ],
    },
    undefined,
    { simular: true },
  );
  assert.equal(nuevo.ok && alias.ok, true);
  assert.deepEqual(
    nuevo.rangos.map((x) => x.uso),
    ['subnet', 'pods'],
  );
  assert.deepEqual(
    alias.rangos.map((x) => [x.uso, x.cidr]),
    nuevo.rangos.map((x) => [x.uso, x.cidr]),
  );
  assert.equal((await uso.guardar('dev', 'nodos', 'dev-nodos')).fila.uso, 'subnet'); // el alias también al configurar la tabla
  assert.deepEqual((await uso.listar()).filas.map((f) => f.uso).sort(), ['pods', 'subnet']);
});

test('subnet /25 y secundarios más chicos: se reservan juntos, cada uno de su pool', async () => {
  const { g } = await entorno();
  const r = await g.reservarLote(AGENTE, PEDIDO_SUBNET);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.grupo.rangos.map((x) => [x.rango, x.cidr.split('/')[1]]),
    [
      ['principal', '25'],
      ['pods', '22'],
      ['servicios', '24'],
    ],
  );
});

test('CIDR exacto: apagado por defecto (400 cidr_manual_no_permitido) y solo donde un admin lo habilita', async () => {
  const pedido = { ...PEDIDO_SUBNET, rangos: [{ uso: 'subnet', cidr: '172.31.0.128/25' }] };
  const apagado = await (await entorno()).g.reservarLote(AGENTE, pedido);
  assert.deepEqual([apagado.ok, apagado.error], [false, 'cidr_manual_no_permitido']);
  const soloQa = await (await entorno({ cidrManual: ['qa'] })).g.reservarLote(AGENTE, pedido);
  assert.equal(soloQa.error, 'cidr_manual_no_permitido'); // habilitado en qa, no en dev
  const { g, repo } = await entorno({ cidrManual: ['dev'] });
  const r = await g.reservarLote(AGENTE, pedido);
  assert.equal(r.ok, true);
  assert.equal(r.grupo.rangos[0].cidr, '172.31.0.128/25'); // exactamente el pedido, no el primero libre
  assert.equal((await repo.ocupados('dev-nodos')).includes('172.31.0.128/25'), true);
  assert.equal((await (await entorno({ cidrManual: ['todos'] })).g.reservarLote(AGENTE, pedido)).ok, true);
});

test('CIDR exacto: IPAM sigue decidiendo (alineado, dentro del pool de su uso, libre y todo o nada)', async () => {
  const { g, repo } = await entorno({ cidrManual: ['dev'] });
  const pide = (rangos) => g.reservarLote(AGENTE, { ...PEDIDO_SUBNET, rangos });
  assert.equal((await pide([{ uso: 'subnet', cidr: 'nada' }])).error, 'cidr_invalido');
  assert.equal((await pide([{ uso: 'subnet', cidr: '172.31.0.64/25' }])).error, 'cidr_desalineado');
  assert.equal((await pide([{ uso: 'subnet', cidr: '172.31.0.0/25', mascara: 24 }])).error, 'mascara_no_coincide');
  assert.equal((await pide([{ uso: 'subnet', cidr: '10.99.0.0/25' }])).error, 'cidr_fuera_del_pool'); // existe, pero no es del pool de «subnet»
  const primero = await pide([{ uso: 'subnet', cidr: '172.31.0.0/25' }]);
  assert.equal(primero.ok, true);
  const choque = await pide([
    { uso: 'pods', mascara: 22 },
    { uso: 'subnet', cidr: '172.31.0.0/24' },
  ]); // pisa el /25 ya reservado
  assert.deepEqual([choque.ok, choque.tipo, choque.error], [false, 'conflicto', 'solapamiento']);
  assert.equal(choque.conflicto.cidr, '172.31.0.0/25');
  assert.ok(choque.sugeridos.length > 0);
  assert.equal((await repo.ocupados('dev-pods')).length, 0, 'todo o nada: el /22 de pods que sí cabía no quedó reservado');
  // dos rangos del mismo grupo que se pisan entre sí
  const mismo = await pide([
    { uso: 'subnet', cidr: '172.31.1.0/25' },
    { uso: 'subnet', cidr: '172.31.1.0/24' },
  ]);
  assert.equal(mismo.error, 'solapamiento');
});

test('CIDR exacto: repetir el pedido con la misma clave devuelve el mismo grupo; con otro CIDR, conflicto', async () => {
  const { g } = await entorno({ cidrManual: ['dev'] });
  const pedido = { ...PEDIDO_SUBNET, rangos: [{ uso: 'subnet', cidr: '172.31.2.0/25' }] };
  const a = await g.reservarLote(AGENTE, pedido, 'clave-cidr-1');
  const b = await g.reservarLote(AGENTE, pedido, 'clave-cidr-1');
  assert.equal(b.repetida, true);
  assert.equal(b.grupo.grupo, a.grupo.grupo);
  const otro = await g.reservarLote(AGENTE, { ...pedido, rangos: [{ uso: 'subnet', cidr: '172.31.3.0/25' }] }, 'clave-cidr-1');
  assert.equal(otro.error, 'idempotencia_conflicto');
});
