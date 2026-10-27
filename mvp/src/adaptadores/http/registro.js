'use strict';
// Registro de rutas. Toda ruta pasa por aquí o por `api()`: así queda un solo estilo y la prueba de paridad
// (rutas de Express ↔ contrato OpenAPI) puede recorrerlas.
const METODOS = new Set(['get', 'post', 'put', 'delete', 'patch']);

/** Registra una ruta tal cual. */
function ruta(app, metodo, camino, ...manejadores) {
  if (!METODOS.has(metodo)) throw new Error(`Método no soportado: ${metodo}`);
  app[metodo](camino, ...manejadores);
}

/** Registra una ruta de la API en su forma versionada (/api/v1/…) y en la forma histórica (/api/…, alias compatible). */
function api(app, metodo, subruta, ...manejadores) {
  ruta(app, metodo, `/api/v1${subruta}`, ...manejadores);
  ruta(app, metodo, `/api${subruta}`, ...manejadores);
}

/** Lista las rutas registradas en una app de Express 5: [{metodo, camino}]. */
function listarRutas(app) {
  const salida = [];
  const pila = (app.router || app._router).stack;
  for (const capa of pila) {
    if (!capa.route) continue;
    for (const m of Object.keys(capa.route.methods)) salida.push({ metodo: m.toUpperCase(), camino: capa.route.path });
  }
  return salida;
}

module.exports = { ruta, api, listarRutas };
