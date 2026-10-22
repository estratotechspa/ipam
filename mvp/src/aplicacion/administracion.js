// @ts-check
'use strict';
const { ok, fallo } = require('./resultado');

/**
 * Lecturas generales, usuarios y auditoría.
 * @param {{repo: any, reloj: import('./puertos').Reloj, rolesUsuario: string[]}} deps
 */
function crearAdministracion({ repo, reloj, rolesUsuario }) {
  return {
    pools: (filtros = {}) => repo.poolsConUso(filtros, reloj.ahora()),
    resumen: async () => ({ ...(await repo.resumen(reloj.ahora())), solapamientos: 0 }), // la restricción de exclusión impide solapes
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
