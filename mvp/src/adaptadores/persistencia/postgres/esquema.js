'use strict';
// Versión del esquema que esta versión de la app necesita. Debe coincidir con la última fila que inserta db/schema.sql
// (una prueba lo comprueba). /readyz la usa: la app NO modifica el esquema al arrancar.
const VERSION_MINIMA = 4;

/** @param {{query: Function}} db */
async function versionActual(db) {
  try {
    const r = await db.query('select coalesce(max(version), 0)::int as v from esquema_version');
    return r.rows[0].v;
  } catch (e) {
    if (e.code === '42P01') return 0; // la tabla no existe: esquema viejo o sin aplicar
    throw e;
  }
}

module.exports = { VERSION_MINIMA, versionActual };
