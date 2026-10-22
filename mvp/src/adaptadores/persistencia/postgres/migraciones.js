'use strict';
// Aplica db/schema.sql (idempotente: se puede ejecutar muchas veces y sobre el esquema viejo).
// Se ejecuta aparte (`npm run migrar`), no al arrancar la app, salvo la excepción MIGRAR_AL_ARRANCAR=true.
const fs = require('node:fs');
const path = require('node:path');
const { crearCliente, prepararSesion, comillas } = require('./pool');
const { reintentar, dormir } = require('./resiliencia');
const { versionActual } = require('./esquema');

const RUTA_SQL = path.join(__dirname, '..', '..', '..', '..', 'db', 'schema.sql');

/**
 * @param {{url: string, bd: object, log: object, esperarMs?: number, rutaSql?: string}} o
 * @returns {Promise<{version: number, esquema: string}>}
 */
async function migrar({ url, bd, log, esperarMs = 60000, rutaSql = RUTA_SQL }) {
  if (!url) throw new Error('Falta la URL de conexión del migrador (DATABASE_URL_MIGRACION o DATABASE_URL).');
  const sql = fs.readFileSync(rutaSql, 'utf8');
  const limite = Date.now() + esperarMs;
  let client;
  // La base puede estar arrancando (docker compose, Cloud SQL tras un reinicio): se espera con retroceso.
  for (let n = 1; ; n++) {
    try { client = await crearCliente(url, bd); break; } catch (e) {
      if (Date.now() > limite) throw e;
      log.warn(`Esperando a la base de datos (intento ${n})`, e);
      await dormir(Math.min(5000, 500 * n));
    }
  }
  try {
    await reintentar(async () => {
      await client.query('begin');
      try {
        // Un solo migrador a la vez aunque se lancen dos jobs por error.
        await client.query("select pg_advisory_xact_lock(hashtext('ipam:migrar'))");
        if (bd.esquema !== 'public') {
          // El nombre ya está validado (IDENTIFICADOR) y se cita con %I en el servidor: nada se concatena en JS.
          const ddl = (await client.query("select format('create schema if not exists %I', $1::text) as sql", [bd.esquema])).rows[0].sql;
          await client.query(ddl);
        }
        await prepararSesion(client, bd);
        await client.query(sql);
        await client.query('commit');
      } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
    }, { intentos: 3, baseMs: 500, alReintentar: (e, n) => log.warn(`Migración: error transitorio, reintento ${n}`, e) });
    const version = await versionActual(client);
    log.info('Esquema aplicado', { version, esquema: comillas(bd.esquema) });
    return { version, esquema: bd.esquema };
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { migrar, RUTA_SQL };
