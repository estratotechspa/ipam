const test = require('node:test');
const assert = require('node:assert/strict');
const { crearRepositorioMemoria } = require('../adaptadores/persistencia/memoria/repositorio');
const generador = require('../adaptadores/auth/token');
const { crearTokens } = require('./tokens');

const ADMIN = { nombre: 'jefe@empresa.example', rol: 'admin', tipo: 'oidc' };
function entorno() {
  const reloj = { t: new Date('2026-10-21T12:00:00Z'), ahora() { return this.t; }, avanzar(ms) { this.t = new Date(this.t.getTime() + ms); } };
  const repo = crearRepositorioMemoria({ reloj });
  const tokens = crearTokens({ repo, generador, config: { auth: { tokenVidaDias: 90 } } });
  return { reloj, repo, tokens };
}

test('crear: devuelve el token una sola vez; en el repositorio solo queda el hash', async () => {
  const e = entorno();
  const r = await e.tokens.crear(ADMIN, { nombre: 'agente-redes', rol: 'agente' });
  assert.equal(r.ok, true);
  assert.match(r.token, /^ipam_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ nombre: r.meta.nombre, rol: r.meta.rol, estado: r.meta.estado, creado_por: r.meta.creado_por, prefijo: r.meta.prefijo }, { nombre: 'agente-redes', rol: 'agente', estado: 'activo', creado_por: ADMIN.nombre, prefijo: r.token.slice(0, 9) });
  assert.ok(!('hash' in r.meta) && !('token' in r.meta));
  const guardado = e.repo.datos.tokens[0];
  assert.equal(guardado.hash, generador.hashear(r.token));
  assert.ok(!JSON.stringify(guardado).includes(r.token), 'el token en claro no se guarda');
  assert.equal(Math.round((guardado.expira_en - e.reloj.ahora()) / 86400_000), 90, '90 días por defecto');
  const lista = await e.tokens.listar();
  assert.ok(!JSON.stringify(lista).includes(r.token) && !JSON.stringify(lista).includes(guardado.hash), 'el listado no revela el token ni el hash');
});

test('crear: validaciones y nombre repetido (409, sugiere rotar con otro nombre)', async () => {
  const e = entorno();
  assert.equal((await e.tokens.crear(ADMIN, { nombre: 'Mal Nombre', rol: 'agente' })).error, 'nombre_invalido');
  assert.equal((await e.tokens.crear(ADMIN, { nombre: 'ok', rol: 'admin' })).error, 'rol_invalido');
  assert.equal((await e.tokens.crear(ADMIN, { nombre: 'ok', rol: 'agente', expira_dias: 400 })).error, 'vigencia_invalida');
  await e.tokens.crear(ADMIN, { nombre: 'dup', rol: 'lector' });
  const d = await e.tokens.crear(ADMIN, { nombre: 'dup', rol: 'lector' });
  assert.deepEqual({ ok: d.ok, tipo: d.tipo, error: d.error }, { ok: false, tipo: 'conflicto', error: 'nombre_en_uso' });
  assert.match(d.mensaje, /dup-2/);
});

test('autenticar: actor svc:<nombre> con su rol; formato, desconocido, vencido y revocado se rechazan', async () => {
  const e = entorno();
  const { token, meta } = await e.tokens.crear(ADMIN, { nombre: 'agente-redes', rol: 'agente', cuota_reservas: 7, expira_dias: 2 });
  const a = await e.tokens.autenticar(token);
  assert.deepEqual(a, { ok: true, actor: { nombre: 'svc:agente-redes', rol: 'agente', tipo: 'token', tokenId: meta.id, cuota: 7 } });
  assert.deepEqual(await e.tokens.autenticar('no-es-un-token'), { ok: false, motivo: 'formato' });
  assert.deepEqual(await e.tokens.autenticar(generador.generar().token), { ok: false, motivo: 'desconocido' });
  e.reloj.avanzar(3 * 86400_000);
  assert.deepEqual(await e.tokens.autenticar(token), { ok: false, motivo: 'vencido', nombre: 'agente-redes' });
  const otro = await e.tokens.crear(ADMIN, { nombre: 'otro', rol: 'lector' });
  assert.equal((await e.tokens.autenticar(otro.token)).ok, true);
  await e.tokens.revocar(otro.meta.id);
  assert.deepEqual(await e.tokens.autenticar(otro.token), { ok: false, motivo: 'revocado', nombre: 'otro' });
});

test('revocar es idempotente y un id desconocido da 404', async () => {
  const e = entorno();
  const { meta } = await e.tokens.crear(ADMIN, { nombre: 'x1', rol: 'lector' });
  const a = await e.tokens.revocar(meta.id);
  const b = await e.tokens.revocar(meta.id);
  assert.deepEqual({ a: a.token.estado, b: b.token.estado, igual: String(a.token.revocado_en) === String(b.token.revocado_en) }, { a: 'revocado', b: 'revocado', igual: true });
  assert.equal((await e.tokens.revocar('11111111-1111-4111-8111-111111111111')).error, 'no_encontrado');
  assert.equal((await e.tokens.revocar('zz')).error, 'no_encontrado');
});

test('ultimo_uso se actualiza como máximo una vez por minuto', async () => {
  const e = entorno();
  const { token } = await e.tokens.crear(ADMIN, { nombre: 'uso', rol: 'agente' });
  const ultimo = () => e.repo.datos.tokens[0].ultimo_uso;
  assert.equal(ultimo(), null);
  await e.tokens.autenticar(token);
  const primero = ultimo();
  assert.ok(primero);
  e.reloj.avanzar(30_000);
  await e.tokens.autenticar(token);
  assert.equal(ultimo(), primero, 'dentro del minuto no se vuelve a escribir');
  e.reloj.avanzar(31_000);
  await e.tokens.autenticar(token);
  assert.notEqual(ultimo(), primero);
});

test('por_vencer: aparece cuando faltan menos de 7 días', async () => {
  const e = entorno();
  await e.tokens.crear(ADMIN, { nombre: 'corto', rol: 'agente', expira_dias: 5 });
  await e.tokens.crear(ADMIN, { nombre: 'largo', rol: 'agente', expira_dias: 30 });
  const l = (await e.tokens.listar()).tokens;
  assert.deepEqual(l.map((t) => [t.nombre, t.por_vencer]).sort(), [['corto', true], ['largo', false]]);
});
