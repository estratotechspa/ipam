// @ts-check
'use strict';
const { analizar, seleccionar, MAX_FILAS } = require('../dominio/importacion');
const { ok, fallo, ConflictoDeDatos } = require('./resultado');

/**
 * Importación masiva de segmentos que ya existen (Excel/CSV). Solo admin (lo exige la ruta).
 * `simular` NO escribe nada; `aplicar` es todo o nada y solo importa lo válido (y lo que un admin aprobó).
 * @param {{repo: any, eventos: import('./puertos').PublicadorEventos}} deps
 */
function crearImportacion({ repo, eventos }) {
  async function analizarArchivo(filas, defectos) {
    if (!Array.isArray(filas) || !filas.length) return fallo('validacion', 'archivo_vacio', { mensaje: 'El archivo no tiene filas con datos.' });
    if (filas.length > MAX_FILAS)
      return fallo('validacion', 'demasiadas_filas', {
        mensaje: `El archivo tiene ${filas.length} filas; el máximo por importación es ${MAX_FILAS}. Divídelo en partes.`,
      });
    const [pools, ocupados] = await Promise.all([repo.todosLosPools(), repo.todosOcupados()]);
    return ok(analizar({ filas, pools, ocupados, defectos }));
  }

  /** Muestra qué pasaría, sin escribir nada. */
  const simular = (filas, defectos) => analizarArchivo(filas, defectos);

  /** Importa lo válido. `aprobadas` = números de fila con solapamiento (con otro pool) que el admin decidió aceptar. */
  async function aplicar(actor, filas, defectos, aprobadas = []) {
    const a = await analizarArchivo(filas, defectos);
    if (!a.ok) return a;
    const elegidas = /** @type {any[]} */ (seleccionar(a.filas, aprobadas));
    const usados = new Set(elegidas.map((f) => f.pool));
    const poolsACrear = a.pools_a_crear.filter((p) => usados.has(p.id));
    const resultado = { importadas: 0, pools_creados: 0 };
    if (elegidas.length) {
      try {
        await repo.transaccion(async (tx) => {
          await tx.bloquear('importar');
          for (const p of poolsACrear) resultado.pools_creados += await tx.insertarPoolSiNoExiste(p);
          for (const f of elegidas) {
            resultado.importadas += await tx.insertarAsignacionImportada({
              pool_id: f.pool,
              cidr: f.cidr,
              vpc: f.vpc,
              solicitante: actor && actor.nombre ? actor.nombre : 'importado',
              ticket: f.ticket,
              origen: 'importado',
            });
          }
        });
      } catch (e) {
        if (e instanceof ConflictoDeDatos)
          return fallo('conflicto', 'importacion_rechazada', {
            mensaje: 'La base de datos rechazó la importación (solapamiento dentro de un pool o fuera de su pool). No se importó nada.',
            detalle: e.message,
          });
        throw e;
      }
    }
    const r = a.resumen;
    const salida = {
      ...resultado,
      omitidas: r.ya_existe,
      rechazadas_por_solapamiento: r.solapa_otro_pool - elegidas.filter((f) => f.estado === 'solapa_otro_pool').length,
      no_importables: r.choca_mismo_pool + r.invalida,
      aprobadas: elegidas.filter((f) => f.estado === 'solapa_otro_pool').length,
    };
    await eventos.publicar('importacion', { ...salida, solicitante: actor && actor.nombre });
    return ok(salida);
  }

  return { simular, aplicar };
}

module.exports = { crearImportacion };
