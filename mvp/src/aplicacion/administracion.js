// @ts-check
'use strict';
const { ok, fallo } = require('./resultado');

/**
 * Lecturas generales, usuarios y auditoría.
 * @param {{repo: any, rolesUsuario: string[]}} deps
 */
function crearAdministracion({ repo, rolesUsuario }) {
  return {
    pools: (filtros = {}) => repo.poolsConUso(filtros),
    resumen: async () => ({ ...(await repo.resumen()), solapamientos: 0 }), // la restricción de exclusión impide solapes
    asignaciones: () => repo.listarAsignaciones(),
    asignacionesParaExcel: () => repo.asignacionesParaExcel(),
    usuarios: () => repo.listarUsuarios(),
    auditoria: () => repo.listarAuditoria(),
    eventos: () => repo.listarEventos(),
    async cambiarRol(email, rol) {
      if (rol !== null && !rolesUsuario.includes(rol)) return fallo('validacion', 'rol inválido');
      const e = String(email).toLowerCase();
      await repo.asignarRol(e, rol);
      return ok({ email: e, rol });
    },
  };
}

module.exports = { crearAdministracion };
