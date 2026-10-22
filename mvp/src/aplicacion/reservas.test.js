// Casos de uso de reservas probados SIN base de datos, con el repositorio en memoria y un reloj controlado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearRepositorioMemoria } = require('../adaptadores/persistencia/memoria/repositorio');
const { crearReservas } = require('./reservas');
const { crearAsignaciones } = require('./asignaciones');
const { crearBarrido } = require('./barrido');

// Rangos FICTICIOS (RFC1918 inventados).
const POOLS = [
  { id: 'qa-nodos', tipo: 'Nodos', ambiente: 'qa', proveedor: 'GCP', cidr: '10.220.0.0/16' },
  { id: 'qa-pods-a', tipo: 'Pods', ambiente: 'qa', proveedor: 'GCP', cidr: '10.221.0.0/16' },
  { id: 'qa-pods-b', tipo: 'Pods', ambiente: 'qa', proveedor: 'GCP', cidr: '10.222.0.0/16' },
  { id: 'dev-nodos', tipo: 'Nodos', ambiente: 'dev', proveedor: 'GCP', cidr: '10.210.0.0/16' },
];
const AGENTE = { nombre: 'svc:agente-redes', rol: 'agente', tipo: 'token' };
const OTRO = { nombre: 'svc:otro', rol: 'agente', tipo: 'token' };
const ADMIN = { nombre: 'jefe@empresa.example', rol: 'admin', tipo: 'oidc' };
const aprob = { aprobado_por: 'ana@empresa.example', referencia: 'https://gitlab.example/redes/-/merge_requests/12' };

function entorno({ cuota = 3, exigeAprobador = true } = {}) {
  const reloj = { t: new Date('2026-10-21T12:00:00Z'), ahora() { return this.t; }, avanzar(h) { this.t = new Date(this.t.getTime() + h * 3600_000); } };
  const repo = crearRepositorioMemoria({ reloj, pools: POOLS });
  const publicados = [];
  const eventos = { publicar: async (tipo, d) => { publicados.push({ tipo, ...d }); } };
  const config = { reservas: { ttlHoras: 24, ttlMaxHoras: 72, exigeAprobador }, limite: { cuotaReservasPorToken: cuota } };
  const reservas = crearReservas({ repo, eventos, config });
  const asignaciones = crearAsignaciones({ repo, eventos, tickets: { activo: () => false, faltantes: () => [] } });
  const barrido = crearBarrido({ repo, eventos, intervaloMs: 60_000, instancia: 'test' });
  return { reloj, repo, publicados, reservas, asignaciones, barrido };
}
const pedir = (e, actor, extra = {}, clave) => e.reservas.reservar(actor, { ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'vpc-pagos', ...extra }, clave);

test('reserva por ambiente y tipo: elige el pool, calcula el primer rango libre y fija el TTL por defecto (24 h)', async () => {
  const e = entorno();
  const r = await pedir(e, AGENTE, { ticket: 'NET-900' });
  assert.equal(r.ok, true);
  assert.deepEqual({ pool: r.reserva.pool_id, cidr: r.reserva.cidr, estado: r.reserva.estado, ticket: r.reserva.ticket, repetida: r.repetida }, { pool: 'qa-nodos', cidr: '10.220.0.0/24', estado: 'reservada', ticket: 'NET-900', repetida: false });
  assert.equal(r.reserva.segundos_restantes, 24 * 3600);
  assert.equal(r.reserva.solicitante, 'svc:agente-redes');
  assert.ok(!('clave_idem' in r.reserva), 'la clave de idempotencia no se expone');
  assert.deepEqual(e.publicados.map((p) => p.tipo), ['reserva_creada']);
  const r2 = await pedir(e, AGENTE);
  assert.equal(r2.reserva.cidr, '10.220.1.0/24', 'la segunda reserva toma el siguiente rango libre');
  assert.match(r2.reserva.ticket, /^NET-\d+$/, 'sin ticket, se genera uno');
});

test('ambiente y tipo ambiguos → 422 con las opciones; sin pools → 422', async () => {
  const e = entorno();
  const r = await pedir(e, AGENTE, { tipo: 'Pods' });
  assert.deepEqual({ ok: r.ok, tipo: r.tipo, error: r.error }, { ok: false, tipo: 'ambiguo', error: 'ambiguo' });
  assert.deepEqual(r.opciones.map((o) => o.pool), ['qa-pods-a', 'qa-pods-b']);
  const n = await pedir(e, AGENTE, { ambiente: 'prod' });
  assert.equal(n.error, 'sin_pool');
  assert.deepEqual(n.opciones, []);
  assert.equal((await pedir(e, AGENTE, { tipo: 'Pods', pool: 'qa-pods-b' })).reserva.pool_id, 'qa-pods-b', 'indicando el pool ya no es ambiguo');
});

test('validaciones de la petición', async () => {
  const e = entorno();
  const falla = async (extra, codigo) => { const r = await pedir(e, AGENTE, extra); assert.equal(r.ok, false); assert.equal(r.error, codigo, JSON.stringify(extra)); };
  await falla({ vpc: '' }, 'vpc_invalido');
  await falla({ vpc: 123 }, 'vpc_invalido');
  await falla({ ambiente: 'staging' }, 'falta_destino');
  await falla({ mascara: undefined }, 'falta_tamano');
  await falla({ mascara: 7 }, 'mascara_invalida');
  await falla({ mascara: 33 }, 'mascara_invalida');
  await falla({ mascara: 'x' }, 'mascara_invalida');
  await falla({ mascara: undefined, cidr: 'hola' }, 'cidr_invalido');
  await falla({ mascara: undefined, cidr: '10.220.1.0/23' }, 'cidr_desalineado');
  await falla({ mascara: undefined, cidr: '10.99.0.0/24' }, 'cidr_fuera_del_pool');
  await falla({ mascara: 22, cidr: '10.220.0.0/24' }, 'mascara_no_coincide');
  await falla({ mascara: 12 }, 'mascara_invalida');
  await falla({ ttl_horas: 0 }, 'ttl_invalido');
  await falla({ ttl_horas: 73 }, 'ttl_excede_maximo');
  await falla({ ticket: 'con espacios' }, 'ticket_invalido');
  assert.equal((await e.reservas.reservar(AGENTE, { ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'v' }, 'clave mala')).error, 'clave_idem_invalida');
  assert.equal((await pedir(e, AGENTE, { pool: 'no-existe', ambiente: undefined, tipo: undefined })).error, 'pool_no_existe');
  assert.equal((await pedir(e, AGENTE, { ttl_horas: 72 })).ok, true, 'el máximo (72 h) sí se acepta');
  assert.equal((await pedir(e, AGENTE, { mascara: undefined, cidr: '10.220.8.0/22', ttl_horas: 2 })).reserva.cidr, '10.220.8.0/22');
});

test('sin solapes: dos reservas, o una reserva y una asignación, nunca pisan el mismo rango', async () => {
  const e = entorno();
  assert.equal((await pedir(e, AGENTE, { mascara: undefined, cidr: '10.220.4.0/22' })).ok, true);
  const choque = await pedir(e, OTRO, { mascara: undefined, cidr: '10.220.5.0/24' });
  assert.deepEqual({ tipo: choque.tipo, error: choque.error, fuente: choque.conflicto.fuente }, { tipo: 'conflicto', error: 'solapamiento', fuente: 'reserva' });
  assert.ok(choque.sugeridos.length > 0 && !choque.sugeridos.some((s) => s.startsWith('10.220.4.') || s.startsWith('10.220.5.')));
  // Una asignación directa también respeta la reserva vigente.
  const a = await e.asignaciones.asignar({ pool: 'qa-nodos', vpc: 'panel', cidr: '10.220.12.0/24', solicitante: 'ana', origen: 'panel' });
  assert.equal(a.ok, true);
  const contraAsig = await pedir(e, OTRO, { mascara: undefined, cidr: '10.220.12.0/24' });
  assert.equal(contraAsig.conflicto.fuente, 'asignacion');
  const panel = await e.asignaciones.asignar({ pool: 'qa-nodos', vpc: 'panel', cidr: '10.220.4.0/24', solicitante: 'ana', origen: 'panel' });
  assert.equal(panel.ok, false, 'la asignación del panel no pisa una reserva vigente');
  assert.equal(panel.error, 'solapamiento');
});

test('idempotencia: misma clave y reserva viva → repetida; liberada o expirada → 409 (nunca 200)', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE, {}, 'mr-1:crear');
  const b = await pedir(e, AGENTE, {}, 'mr-1:crear');
  assert.deepEqual({ ok: b.ok, rep: b.repetida, mismo: b.reserva.id === a.reserva.id }, { ok: true, rep: true, mismo: true });
  assert.equal(e.publicados.filter((p) => p.tipo === 'reserva_creada').length, 1, 'repetir no genera otro evento');
  assert.equal((await pedir(e, AGENTE, { vpc: 'otra-vpc' }, 'mr-1:crear')).error, 'idempotencia_conflicto');
  assert.equal((await pedir(e, OTRO, {}, 'mr-1:crear')).repetida, false, 'la clave es por solicitante');

  await e.reservas.liberar(AGENTE, a.reserva.id);
  const tras = await pedir(e, AGENTE, {}, 'mr-1:crear');
  assert.deepEqual({ ok: tras.ok, tipo: tras.tipo, error: tras.error, estado: tras.estado }, { ok: false, tipo: 'conflicto', error: 'clave_idem_usada', estado: 'liberada' });

  const c = await pedir(e, AGENTE, {}, 'mr-2:crear');
  e.reloj.avanzar(25);
  const exp = await pedir(e, AGENTE, {}, 'mr-2:crear');
  assert.deepEqual({ ok: exp.ok, error: exp.error, estado: exp.estado }, { ok: false, error: 'clave_idem_usada', estado: 'expirada' });
  assert.ok(c.ok);
});

test('expiración perezosa: una reserva vencida deja de ocupar y de poder confirmarse sin esperar al barredor', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE, { mascara: undefined, cidr: '10.220.8.0/24' });
  e.reloj.avanzar(23);
  assert.equal((await e.reservas.obtener(a.reserva.id)).reserva.estado, 'reservada');
  assert.equal((await pedir(e, OTRO, { mascara: undefined, cidr: '10.220.8.0/24' })).ok, false, 'aún vigente');
  e.reloj.avanzar(2);
  assert.equal((await e.reservas.obtener(a.reserva.id)).reserva.estado, 'expirada', 'ya expirada al consultar');
  assert.equal((await e.reservas.listar({ estado: 'expirada' })).reservas.length, 1);
  const c = await e.reservas.confirmar(AGENTE, a.reserva.id, aprob);
  assert.deepEqual({ ok: c.ok, tipo: c.tipo, error: c.error, estado: c.estado }, { ok: false, tipo: 'conflicto', error: 'reserva_no_vigente', estado: 'expirada' });
  assert.equal((await pedir(e, OTRO, { mascara: undefined, cidr: '10.220.8.0/24' })).ok, true, 'el rango quedó libre');
  assert.ok(e.publicados.some((p) => p.tipo === 'reserva_expirada' && p.reserva === a.reserva.id));
});

test('human-in-the-loop: un agente solo confirma con aprobación humana declarada; una persona desde la interfaz no necesita declararla', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE, { ticket: 'NET-901' });
  const sin = await e.reservas.confirmar(AGENTE, a.reserva.id, {});
  assert.deepEqual({ tipo: sin.tipo, error: sin.error }, { tipo: 'validacion', error: 'falta_aprobacion' });
  assert.equal((await e.reservas.obtener(a.reserva.id)).reserva.estado, 'reservada', 'sin aprobación sigue sin ser definitiva');
  assert.equal(e.repo.datos.asignaciones.length, 0);

  const c = await e.reservas.confirmar(AGENTE, a.reserva.id, aprob);
  assert.equal(c.ok, true);
  assert.deepEqual({ estado: c.reserva.estado, origen: c.asignacion.origen, cidr: c.asignacion.cidr, ticket: c.asignacion.ticket, solicitante: c.asignacion.solicitante, rep: c.repetida },
    { estado: 'confirmada', origen: 'agente', cidr: a.reserva.cidr, ticket: 'NET-901', solicitante: 'svc:agente-redes', rep: false });
  assert.equal(c.reserva.asignacion_id, c.asignacion.id);
  assert.deepEqual(c.aprobacion, aprob);
  const ev = e.publicados.find((p) => p.tipo === 'reserva_confirmada');
  assert.equal(ev.aprobado_por, aprob.aprobado_por);

  const otra = await e.reservas.confirmar(AGENTE, a.reserva.id, aprob);
  assert.deepEqual({ ok: otra.ok, rep: otra.repetida, igual: otra.asignacion.id === c.asignacion.id }, { ok: true, rep: true, igual: true });
  assert.equal(e.repo.datos.asignaciones.length, 1, 'confirmar dos veces no duplica la asignación');

  const h = await pedir(e, ADMIN);
  const ch = await e.reservas.confirmar(ADMIN, h.reserva.id, {});
  assert.equal(ch.ok, true, 'una persona que confirma en la interfaz ya es quien aprueba');
  assert.equal(ch.aprobacion.aprobado_por, 'jefe@empresa.example');
});

test('con CONFIRMACION_EXIGE_APROBADOR=false el agente puede confirmar sin datos de aprobación', async () => {
  const e = entorno({ exigeAprobador: false });
  const a = await pedir(e, AGENTE);
  assert.equal((await e.reservas.confirmar(AGENTE, a.reserva.id, {})).ok, true);
});

test('liberar: reservada → liberada; confirmada → borra también la asignación; idempotente', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE);
  const l = await e.reservas.liberar(AGENTE, a.reserva.id);
  assert.deepEqual({ estado: l.reserva.estado, rep: l.repetida, borrada: l.asignacionBorrada }, { estado: 'liberada', rep: false, borrada: false });
  assert.equal((await e.reservas.liberar(AGENTE, a.reserva.id)).repetida, true, 'liberar de nuevo es idempotente');
  assert.equal((await pedir(e, OTRO, { mascara: undefined, cidr: a.reserva.cidr })).ok, true, 'el rango quedó libre');

  const b = await pedir(e, AGENTE);
  const c = await e.reservas.confirmar(AGENTE, b.reserva.id, aprob);
  assert.equal(e.repo.datos.asignaciones.length, 1);
  const lb = await e.reservas.liberar(AGENTE, b.reserva.id);
  assert.deepEqual({ estado: lb.reserva.estado, borrada: lb.asignacionBorrada }, { estado: 'liberada', borrada: true });
  assert.equal(e.repo.datos.asignaciones.length, 0, 'la asignación definitiva se borró');
  assert.ok(c.ok);

  const x = await pedir(e, AGENTE);
  e.reloj.avanzar(30);
  const lx = await e.reservas.liberar(AGENTE, x.reserva.id);
  assert.deepEqual({ ok: lx.ok, rep: lx.repetida, estado: lx.reserva.estado }, { ok: true, rep: true, estado: 'expirada' }, 'liberar una expirada es un no-op');
});

test('solo el dueño o un admin opera sobre una reserva', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE);
  for (const op of [() => e.reservas.confirmar(OTRO, a.reserva.id, aprob), () => e.reservas.liberar(OTRO, a.reserva.id)]) {
    const r = await op();
    assert.deepEqual({ ok: r.ok, tipo: r.tipo, error: r.error }, { ok: false, tipo: 'prohibido', error: 'no_es_dueno' });
  }
  assert.equal((await e.reservas.confirmar(ADMIN, a.reserva.id, {})).ok, true, 'un admin sí puede');
  assert.equal((await e.reservas.confirmar(AGENTE, 'no-es-uuid', aprob)).error, 'no_encontrado');
  assert.equal((await e.reservas.confirmar(AGENTE, '11111111-1111-4111-8111-111111111111', aprob)).error, 'no_encontrado');
});

test('cuota por token: máximo de reservas vigentes simultáneas; confirmar o liberar libera cupo; no aplica a personas', async () => {
  const e = entorno({ cuota: 2 });
  const a = await pedir(e, AGENTE);
  assert.equal((await pedir(e, AGENTE)).ok, true);
  const tercera = await pedir(e, AGENTE);
  assert.deepEqual({ ok: tercera.ok, tipo: tercera.tipo, error: tercera.error, vigentes: tercera.vigentes, limite: tercera.limite }, { ok: false, tipo: 'cuota', error: 'cuota_excedida', vigentes: 2, limite: 2 });
  assert.match(tercera.mensaje, /Tienes 2 reservas vigentes de 2/);
  assert.equal((await pedir(e, OTRO)).ok, true, 'la cuota es por token');
  await e.reservas.liberar(AGENTE, a.reserva.id);
  assert.equal((await pedir(e, AGENTE)).ok, true, 'al liberar queda cupo');
  assert.equal((await pedir(e, { ...AGENTE, nombre: 'svc:vip', cuota: 5 })).ok, true);
  for (let i = 0; i < 4; i++) assert.equal((await pedir(e, { ...AGENTE, nombre: 'svc:vip', cuota: 5 })).ok, true);
  assert.equal((await pedir(e, { ...AGENTE, nombre: 'svc:vip', cuota: 5 })).error, 'cuota_excedida', 'cuota propia del token');
  for (let i = 0; i < 3; i++) assert.equal((await pedir(e, ADMIN)).ok, true, 'las personas no tienen cuota de token');
  e.reloj.avanzar(25);
  assert.equal((await pedir(e, AGENTE)).ok, true, 'las vencidas dejan de contar');
  // Una repetición idempotente no gasta cuota ni se bloquea por ella.
  const k = await pedir(e, { ...AGENTE, nombre: 'svc:k', cuota: 1 }, {}, 'k1');
  assert.equal((await pedir(e, { ...AGENTE, nombre: 'svc:k', cuota: 1 }, {}, 'k1')).repetida, true);
  assert.ok(k.ok);
});

test('listar con filtros por estado, pool y solicitante; obtener', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE);
  const b = await pedir(e, OTRO, { ambiente: 'dev' });
  await e.reservas.confirmar(OTRO, b.reserva.id, aprob);
  assert.equal((await e.reservas.listar({})).reservas.length, 2);
  assert.deepEqual((await e.reservas.listar({ estado: 'confirmada' })).reservas.map((r) => r.id), [b.reserva.id]);
  assert.deepEqual((await e.reservas.listar({ pool: 'qa-nodos' })).reservas.map((r) => r.id), [a.reserva.id]);
  assert.deepEqual((await e.reservas.listar({ solicitante: 'svc:otro' })).reservas.map((r) => r.id), [b.reserva.id]);
  assert.equal((await e.reservas.listar({ estado: 'rara' })).error, 'estado_invalido');
  assert.equal((await e.reservas.obtener(a.reserva.id)).reserva.id, a.reserva.id);
  assert.equal((await e.reservas.obtener('xx')).error, 'no_encontrado');
});

test('barredor: marca las vencidas, publica el evento y no repite el trabajo demasiado pronto', async () => {
  const e = entorno();
  const a = await pedir(e, AGENTE);
  assert.deepEqual((await e.barrido.barrer()).expiradas, [], 'nada que limpiar todavía');
  e.reloj.avanzar(26);
  const r = await e.barrido.barrer();
  assert.equal(r.ejecutado, true);
  assert.deepEqual(r.expiradas.map((x) => x.id), [a.reserva.id]);
  assert.ok(e.publicados.some((p) => p.tipo === 'reserva_expirada' && p.reserva === a.reserva.id));
  const otraVez = await e.barrido.barrer();
  assert.deepEqual({ ejecutado: otraVez.ejecutado, motivo: otraVez.motivo }, { ejecutado: false, motivo: 'reciente' }, 'no repite el trabajo enseguida');
  e.reloj.avanzar(2 / 60);
  assert.equal((await e.barrido.barrer()).ejecutado, true, 'pasado el intervalo mínimo vuelve a correr');
});
