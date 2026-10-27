// Retención de eventos (`npm run purgar`): contra PostgreSQL real, con el CLI como proceso aparte.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { hayBase, crearBaseAislada, RAIZ } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const CLI = path.join(RAIZ, 'src', 'cli', 'purgar.js');
let b;

const purgar = (env) =>
  spawnSync(process.execPath, [CLI, ...(env.ARGS || [])], {
    env: { PATH: process.env.PATH, ...env, ARGS: undefined },
    encoding: 'utf8',
  });
const eventos = async () => (await b.sql('select tipo from eventos order by id')).rows.map((r) => r.tipo);

test.before(async () => {
  if (hayBase) b = await crearBaseAislada();
});
test.after(async () => {
  if (b) await b.borrar();
});
test.beforeEach(async () => {
  if (!b) return;
  await b.sql('delete from eventos');
  await b.sql(
    `insert into eventos (tipo, ts) values ('muy_viejo', now() - interval '800 days'), ('viejo', now() - interval '400 days'),
       ('justo_dentro', now() - interval '360 days'), ('reciente', now() - interval '1 day'), ('hoy', now())`,
  );
});

test('borra lo anterior a RETENCION_DIAS (365 por defecto) y conserva lo reciente', opts, async () => {
  const r = purgar({ DATABASE_URL: b.url });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(await eventos(), ['justo_dentro', 'reciente', 'hoy']);
  assert.match(r.stdout, /Purga terminada/);
  assert.match(r.stdout, /"eventos":2/);
});

test('RETENCION_DIAS configurable, y 0 conserva todo', opts, async () => {
  assert.equal(purgar({ DATABASE_URL: b.url, RETENCION_DIAS: '30' }).status, 0);
  assert.deepEqual(await eventos(), ['reciente', 'hoy']);
  await b.sql("insert into eventos (tipo, ts) values ('viejo_otra_vez', now() - interval '900 days')");
  const cero = purgar({ DATABASE_URL: b.url, RETENCION_DIAS: '0' });
  assert.equal(cero.status, 0);
  assert.match(cero.stdout, /se conserva todo/);
  assert.ok((await eventos()).includes('viejo_otra_vez'), 'con 0 no se borra nada');
});

test('--simular cuenta lo que borraría sin borrar', opts, async () => {
  const r = purgar({ DATABASE_URL: b.url, ARGS: ['--simular'] });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Simulación/);
  assert.match(r.stdout, /"eventos":2/);
  assert.equal((await eventos()).length, 5);
});

test('borra por lotes: muchos más eventos que un lote', opts, async () => {
  await b.sql("insert into eventos (tipo, ts) select 'masivo', now() - interval '500 days' from generate_series(1, 12000)");
  const r = purgar({ DATABASE_URL: b.url });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /"total":12002/);
  assert.deepEqual(await eventos(), ['justo_dentro', 'reciente', 'hoy']);
});

test('la auditoría NO se purga (es de solo inserción) y el índice por fecha existe', opts, async () => {
  await b.sql("insert into auditoria (usuario, accion, detalle, ts) values ('prueba', 'antigua', '{}', now() - interval '900 days')");
  assert.equal(purgar({ DATABASE_URL: b.url }).status, 0);
  assert.equal((await b.sql("select count(*)::int as n from auditoria where accion = 'antigua'")).rows[0].n, 1);
  await assert.rejects(() => b.sql("delete from auditoria where accion = 'antigua'"), /solo inserción/);
  assert.equal((await b.sql("select 1 from pg_indexes where indexname = 'eventos_ts_idx'")).rowCount, 1);
});

test('sin permiso de borrado (usuario de la aplicación) falla con un mensaje claro que apunta a DATABASE_URL_MIGRACION', opts, async () => {
  const rol = `ipam_ret_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: b.url });
  await admin.connect();
  try {
    // DDL no admite parámetros; el nombre del rol lo genera esta misma prueba (hexadecimal), no viene de ningún dato externo.
    const ddl = [`create role ${rol} login password 'x-solo-pruebas'`, `grant select, insert on eventos to ${rol}`, `grant usage on schema public to ${rol}`];
    for (const sql of ddl) await admin.query(sql);
    const u = new URL(b.url);
    u.username = rol;
    u.password = 'x-solo-pruebas';
    const r = purgar({ DATABASE_URL: u.toString() });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /DATABASE_URL_MIGRACION/);
    assert.equal((await eventos()).length, 5, 'no borró nada');
  } finally {
    for (const sql of [`drop owned by ${rol}`, `drop role if exists ${rol}`]) await admin.query(sql).catch(() => {});
    await admin.end();
  }
});

test('usa DATABASE_URL_MIGRACION cuando está definida', opts, async () => {
  const r = purgar({ DATABASE_URL: 'postgres://nadie:nada@127.0.0.1:1/ninguna', DATABASE_URL_MIGRACION: b.url });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(await eventos(), ['justo_dentro', 'reciente', 'hoy']);
});
