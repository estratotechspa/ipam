// Roles de base de datos separados: ipam_migrador (DDL, dueño) e ipam_app (solo DML). Se prueba con roles REALES contra PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { hayBase, crearBaseAislada, lanzarServicio, RAIZ } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const CLAVE_APP = 'clave-app-solo-pruebas-1';
const CLAVE_MIG = 'clave-migrador-solo-pruebas-1';
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };

const con = (urlBase, usuario, clave) => {
  const u = new URL(urlBase);
  u.username = usuario;
  u.password = clave;
  return u.toString();
};
async function como(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}
/** Intenta ejecutar y devuelve el código de error de PostgreSQL (o null si funcionó). */
const codigo = async (c, sql, params) => {
  try {
    await c.query(sql, params);
    return null;
  } catch (e) {
    return e.code;
  }
};

// Los roles son globales en el servidor PostgreSQL: se crean al empezar y se borran al terminar (el servidor de pruebas es desechable).
async function prepararRoles(b) {
  await b.aplicar(fs.readFileSync(path.join(RAIZ, 'db', 'roles.sql'), 'utf8'));
  await b.sql("select format('alter role ipam_app password %L', $1::text) as q", [CLAVE_APP]).then((r) => b.sql(r.rows[0].q));
  await b.sql("select format('alter role ipam_migrador password %L', $1::text) as q", [CLAVE_MIG]).then((r) => b.sql(r.rows[0].q));
  await b.sql('alter schema ipam owner to ipam_migrador');
}
async function soltarRoles(b) {
  await b.sql('drop owned by ipam_app, ipam_migrador cascade').catch(() => {});
  await b.sql('drop role if exists ipam_app').catch(() => {});
  await b.sql('drop role if exists ipam_migrador').catch(() => {});
}

test('roles.sql es idempotente (se puede ejecutar dos veces) y crea roles sin superusuario', opts, async () => {
  const b = await crearBaseAislada({ esquema: false });
  try {
    await prepararRoles(b);
    await prepararRoles(b);
    const r = (
      await b.sql("select rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin from pg_roles where rolname in ('ipam_app','ipam_migrador') order by 1")
    ).rows;
    assert.deepEqual(r, [
      { rolname: 'ipam_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true },
      { rolname: 'ipam_migrador', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true },
    ]);
  } finally {
    await soltarRoles(b);
    await b.borrar();
  }
});

test('el migrador aplica el esquema (dos veces) en el esquema «ipam»; la app solo tiene DML y no toca la auditoría', opts, async () => {
  const b = await crearBaseAislada({ esquema: false });
  let app, mig;
  try {
    await prepararRoles(b);
    await b.sql('create schema ajeno');
    await b.sql('create table ajeno.secreto (x int)');
    await b.sql('insert into ajeno.secreto values (1)');
    const urlMig = con(b.url, 'ipam_migrador', CLAVE_MIG);
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, [path.join(RAIZ, 'src', 'cli', 'migrar.js')], {
        env: { PATH: process.env.PATH, DATABASE_URL: con(b.url, 'ipam_app', CLAVE_APP), DATABASE_URL_MIGRACION: urlMig, DATABASE_SCHEMA: 'ipam' },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    assert.equal((await b.sql("select count(distinct tableowner)::int as n from pg_tables where schemaname = 'ipam'")).rows[0].n, 1);
    assert.equal(
      (await b.sql("select distinct tableowner from pg_tables where schemaname = 'ipam'")).rows[0].tableowner,
      'ipam_migrador',
      'el migrador es el dueño',
    );
    await b.sql('set search_path to ipam');
    await b.aplicarSemilla();

    app = await como(con(b.url, 'ipam_app', CLAVE_APP));
    await app.query('set search_path to ipam');
    // Lo que la app SÍ puede: DML y secuencias.
    assert.equal(await codigo(app, 'select count(*) from asignaciones'), null);
    assert.equal(
      await codigo(app, "insert into asignaciones (pool_id, cidr, vpc, solicitante, ticket) values ('gke-nodos-qa','10.20.99.0/24','v','x','NET-R')"),
      null,
    );
    assert.equal(await codigo(app, "update asignaciones set vpc = 'otra' where ticket = 'NET-R'"), null);
    assert.equal(await codigo(app, "delete from asignaciones where ticket = 'NET-R'"), null);
    assert.equal(await codigo(app, "select nextval('ticket_seq')"), null);
    assert.equal(await codigo(app, 'select hash from tokens_servicio'), null, 'la app necesita el hash para autenticar tokens');
    // Lo que NO puede: la auditoría y los eventos son de solo inserción.
    assert.equal(await codigo(app, "insert into auditoria (usuario, accion) values ('t','x')"), null);
    for (const sql of [
      "update auditoria set accion = 'y'",
      'delete from auditoria',
      'truncate auditoria',
      "update eventos set tipo = 'y'",
      'delete from eventos',
      'truncate eventos',
    ]) {
      assert.equal(await codigo(app, sql), '42501', `${sql} debería dar «permiso denegado»`);
    }
    // Ni cambiar la versión del esquema, ni DDL, ni tablas ajenas, ni escalar al rol migrador.
    assert.equal(await codigo(app, 'update esquema_version set version = 99'), '42501');
    assert.equal(await codigo(app, "insert into esquema_version (version, descripcion) values (99, 'x')"), '42501');
    assert.equal(await codigo(app, 'create table intruso (x int)'), '42501', 'sin CREATE en el esquema');
    assert.equal(await codigo(app, 'drop table asignaciones'), '42501', 'no es dueña de las tablas');
    assert.equal(await codigo(app, 'alter table asignaciones add column x int'), '42501');
    assert.equal(await codigo(app, 'select * from ajeno.secreto'), '42501', 'no lee fuera de su esquema');
    assert.equal(await codigo(app, 'set role ipam_migrador'), '42501');
    assert.equal(await codigo(app, 'create role otro'), '42501');
    assert.equal(await codigo(app, 'create extension if not exists pgcrypto'), '42501');
    // El migrador tampoco puede tocar la auditoría (disparador), aunque sea dueño.
    mig = await como(urlMig);
    await mig.query('set search_path to ipam');
    assert.equal(await codigo(mig, "update auditoria set accion = 'y'"), '42501');
    assert.equal(await codigo(mig, 'delete from auditoria'), '42501');
  } finally {
    if (app) await app.end();
    if (mig) await mig.end();
    await soltarRoles(b);
    await b.borrar();
  }
});

test('el servicio funciona de punta a punta usando SOLO el rol ipam_app (y /readyz ve el esquema que dejó el migrador)', opts, async () => {
  const b = await crearBaseAislada({ esquema: false });
  let s;
  try {
    await prepararRoles(b);
    const r = spawnSync(process.execPath, [path.join(RAIZ, 'src', 'cli', 'migrar.js')], {
      env: { PATH: process.env.PATH, DATABASE_URL_MIGRACION: con(b.url, 'ipam_migrador', CLAVE_MIG), DATABASE_SCHEMA: 'ipam' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    await b.sql('set search_path to ipam');
    await b.aplicarSemilla();
    s = await lanzarServicio({ DATABASE_URL: con(b.url, 'ipam_app', CLAVE_APP), DATABASE_SCHEMA: 'ipam', BARREDOR_INTERVALO_SEGUNDOS: '5' });
    assert.equal((await fetch(`${s.url}/readyz`)).status, 200);
    const t = await (
      await fetch(`${s.url}/api/tokens`, { method: 'POST', headers: ADM, body: JSON.stringify({ nombre: 'con-rol-app', rol: 'agente' }) })
    ).json();
    const res = await fetch(`${s.url}/api/reservas`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: 'rol-app' }),
    });
    assert.equal(res.status, 201);
    const rr = await res.json();
    assert.equal(
      (
        await fetch(`${s.url}/api/reservas/${rr.id}/confirmar`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ aprobado_por: 'ana', referencia: 'mr' }),
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${s.url}/api/auditoria`, { headers: ADM })).status, 200);
    assert.equal((await fetch(`${s.url}/api/pools`, { headers: ADM })).status, 200);
    const log = s.logs();
    assert.ok(!log.some((l) => l.nivel === 'error'), `errores en el log: ${JSON.stringify(log.filter((l) => l.nivel === 'error')).slice(0, 400)}`);
  } finally {
    if (s) await s.parar();
    await soltarRoles(b);
    await b.borrar();
  }
});
