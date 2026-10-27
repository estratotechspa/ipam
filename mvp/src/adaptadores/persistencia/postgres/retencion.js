'use strict';
// Retención de `eventos`: borra lo más antiguo que N días, por lotes (sin bloquear la tabla ni hacer una transacción gigante).
//
// La AUDITORÍA no se purga aquí a propósito: es de solo inserción incluso para el dueño de la tabla (disparador
// `trg_auditoria_solo_insercion`), para que nadie pueda borrar el rastro de lo que se hizo. Si una política exige acotarla, hay que
// archivarla fuera (p. ej. exportarla a almacenamiento frío) y decidirlo caso por caso: ver docs/OPERACION.md.
//
// `eventos` tampoco se borra desde la aplicación: el rol `ipam_app` no tiene DELETE sobre ella. Esto lo ejecuta una persona o un job
// con el usuario MIGRADOR (DATABASE_URL_MIGRACION): `npm run purgar`.
const { crearCliente, prepararSesion } = require('./pool');

const LOTE = 5000;
const SQL_CONTAR = `select count(*)::int as n from eventos where ts < now() - make_interval(days => $1::int)`;
const SQL_BORRAR = `delete from eventos where id in (
  select id from eventos where ts < now() - make_interval(days => $1::int) order by id limit $2) `;

/**
 * @param {{url: string, bd: object, dias: number, simular?: boolean, log: {info: Function, warn: Function}}} o
 * @returns {Promise<{dias: number, eventos: number, simulado: boolean}>}
 */
async function purgarEventos({ url, bd, dias, simular = false, log }) {
  if (!url) throw new Error('Falta la URL de conexión (DATABASE_URL_MIGRACION, o DATABASE_URL si falta).');
  if (!Number.isInteger(dias) || dias < 1) throw new Error('RETENCION_DIAS debe ser un entero mayor o igual a 1 (0 = no purgar nunca).');
  const client = await crearCliente(url, bd);
  try {
    await prepararSesion(client, bd);
    if (simular) return { dias, eventos: (await client.query(SQL_CONTAR, [dias])).rows[0].n, simulado: true };
    let borrados = 0;
    for (;;) {
      const n = (await client.query(SQL_BORRAR, [dias, LOTE])).rowCount;
      borrados += n;
      if (n > 0) log.info('Eventos purgados', { lote: n, total: borrados });
      if (n < LOTE) return { dias, eventos: borrados, simulado: false };
    }
  } catch (e) {
    if (e && e.code === '42501') {
      throw new Error('Este usuario no puede borrar eventos (permiso denegado). La purga se ejecuta con el usuario migrador: define DATABASE_URL_MIGRACION.', {
        cause: e,
      });
    }
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { purgarEventos, LOTE };
