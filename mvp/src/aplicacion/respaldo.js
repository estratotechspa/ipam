// @ts-check
'use strict';
const { parse } = require('../dominio/cidr');
const { ok, fallo, ConflictoDeDatos } = require('./resultado');

const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
const ORIGENES_IMPORTABLES = ['panel', 'jira', 'semilla', 'agente', 'importado'];

/**
 * Respaldo lógico completo y su restauración (portabilidad hacia otra infraestructura).
 * @param {{repo: any, reloj: import('./puertos').Reloj, rolesUsuario: string[]}} deps
 */
function crearRespaldo({ repo, reloj, rolesUsuario }) {
  async function exportar() {
    const d = await repo.exportarDatos();
    return ok({
      respaldo: { formato: 'ipam-respaldo', version: 1, generado: reloj.ahora().toISOString(), ...d },
      resumen: { pools: d.pools.length, asignaciones: d.asignaciones.length },
    });
  }

  /** Todo o nada: si algún segmento se solapa, no se importa nada. */
  async function importar(d) {
    d = d || {};
    if (d.formato !== 'ipam-respaldo' || d.version !== 1 || !Array.isArray(d.pools) || !Array.isArray(d.asignaciones)) {
      return fallo('validacion', 'No es un respaldo de IPAM (formato ipam-respaldo, versión 1).');
    }
    for (const p of d.pools) {
      if (!p.id || !p.tipo || !AMBIENTES.includes(p.ambiente) || !p.proveedor || !parse(String(p.cidr)))
        return fallo('validacion', `Pool inválido: ${JSON.stringify(p).slice(0, 120)}`);
    }
    for (const a of d.asignaciones) {
      const c = parse(String(a.cidr));
      if (!a.pool_id || !a.vpc || !a.ticket || !c || !c.aligned) return fallo('validacion', `Asignación inválida: ${JSON.stringify(a).slice(0, 120)}`);
    }
    const r = { pools: 0, asignaciones: 0, omitidas: 0, usuarios: 0 };
    try {
      await repo.transaccion(async (tx) => {
        await tx.bloquear('importar');
        for (const p of d.pools) r.pools += await tx.insertarPoolSiNoExiste(p);
        for (const a of d.asignaciones) {
          const origen = ORIGENES_IMPORTABLES.includes(a.origen) ? a.origen : 'panel';
          if (await tx.insertarAsignacionImportada({ ...a, origen })) r.asignaciones += 1;
          else r.omitidas += 1;
        }
        for (const u of Array.isArray(d.usuarios) ? d.usuarios : []) {
          if (u.email && rolesUsuario.includes(u.rol)) r.usuarios += await tx.insertarUsuarioSiNoExiste(u);
        }
        await tx.ajustarSecuenciaTicket();
      });
    } catch (e) {
      if (e instanceof ConflictoDeDatos) {
        return fallo('conflicto', 'Importación rechazada: hay segmentos que se solapan, quedan fuera de su pool o su pool no existe.', { detalle: e.message });
      }
      throw e;
    }
    return ok({ resultado: r });
  }

  return { exportar, importar };
}

module.exports = { crearRespaldo };
