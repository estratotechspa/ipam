// @ts-check
'use strict';
// Alcance de un token de servicio: qué grupos de la API puede usar. Un token sin alcance (null) usa todo lo que su rol permite
// (así siguen funcionando los creados antes). Con alcance, una ruta fuera de sus grupos responde 403 aunque el rol la permitiera.
// Solo se agrupan rutas de lector/agente: las de admin no las alcanza ningún token.

/** @type {Record<string, {descripcion: string, rutas: string[]}>} */
const GRUPOS = {
  reservas: {
    descripcion: 'Reservar, consultar, renovar y liberar reservas propias (confirmar es solo de admin)',
    rutas: [
      'POST /reservas',
      'GET /reservas',
      'GET /reservas/:id',
      'DELETE /reservas/:id',
      'POST /reservas/lote',
      'GET /reservas/grupo',
      'POST /reservas/grupo/:id/renovar',
      'GET /reservas/grupo/:id',
      'GET /reservas/grupo/:id/eventos',
      'DELETE /reservas/grupo/:id',
    ],
  },
  consulta: {
    descripcion: 'Consultar pools, disponibilidad y asignaciones (para comprobar que no haya solapamientos)',
    rutas: ['GET /pools', 'GET /pools/:id/libres', 'GET /pools/:id/disponibilidad', 'GET /resumen', 'GET /asignaciones', 'GET /pool-uso'],
  },
  direcciones: {
    descripcion: 'Consultar y registrar direcciones IP fijas',
    rutas: ['GET /direcciones', 'POST /direcciones', 'PATCH /direcciones/:id'],
  },
};
const NOMBRES = Object.keys(GRUPOS);

/** Rutas que un token con alcance puede usar siempre (no exponen datos del inventario). */
const SIEMPRE = ['GET /me', 'GET /openapi.json'];

const aRegex = (/** @type {string} */ ruta) => {
  const [metodo, camino] = ruta.split(' ');
  return { metodo, re: new RegExp(`^/api/v1${camino.replace(/:[a-z]+/g, '[^/]+').replace(/\./g, '\\.')}/?$`) };
};
const PATRONES = [
  ...Object.entries(GRUPOS).flatMap(([grupo, g]) => g.rutas.map((r) => ({ grupo, ...aRegex(r) }))),
  ...SIEMPRE.map((r) => ({ grupo: '*', ...aRegex(r) })),
];

/** Grupo de una petición ('*' = siempre permitida; undefined = fuera de todo grupo). @param {string} metodo @param {string} camino */
const grupoDe = (metodo, camino) => PATRONES.find((p) => p.metodo === metodo.toUpperCase() && p.re.test(camino))?.grupo;

/** ¿Puede este alcance (null = sin restricción) usar la petición? @param {string[]|null|undefined} alcance @param {string} metodo @param {string} camino */
function permite(alcance, metodo, camino) {
  if (!alcance) return true;
  const g = grupoDe(metodo, camino);
  return g === '*' || (g !== undefined && alcance.includes(g));
}

/**
 * Valida el alcance pedido al crear un token. Sin alcance (o null) = todo lo que permita el rol.
 * @param {unknown} entrada
 * @returns {{ok: true, alcance: string[]|null} | {ok: false, error: string, mensaje: string}}
 */
function validarAlcance(entrada) {
  if (entrada === undefined || entrada === null) return { ok: true, alcance: null };
  if (!Array.isArray(entrada) || !entrada.length || entrada.some((g) => typeof g !== 'string' || !NOMBRES.includes(g)))
    return { ok: false, error: 'alcance_invalido', mensaje: `alcance debe ser una lista no vacía con valores de: ${NOMBRES.join(', ')}.` };
  return { ok: true, alcance: NOMBRES.filter((g) => entrada.includes(g)) };
}

module.exports = { GRUPOS, NOMBRES, SIEMPRE, grupoDe, permite, validarAlcance };
