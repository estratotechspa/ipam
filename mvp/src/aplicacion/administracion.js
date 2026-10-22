// @ts-check
'use strict';
const { ok, fallo } = require('./resultado');

/** Correo o nombre de usuario: minúsculas, sin espacios; con o sin dominio. */
const USUARIO = /^[a-z0-9][a-z0-9._%+-]{1,63}(@[a-z0-9][a-z0-9.-]{1,120})?$/;
const CLAVE_MIN = 12;

/**
 * Lecturas generales, usuarios y auditoría. Las cuentas se administran por dos caminos:
 *  A) SSO (OIDC): el admin pre-registra por correo con su rol, o da de baja (la identidad la guarda el proveedor).
 *  B) Cuentas locales (AUTH_LOCAL, modo Basic): el admin crea la cuenta con una clave temporal que se muestra una sola vez.
 * @param {{repo: any, rolesUsuario: string[], contrasenas: {hashear: (c: string) => Promise<string>, verificar: (c: string, h: string) => Promise<boolean>, generarTemporal: () => string}, cuentasLocales?: () => boolean}} deps
 */
function crearAdministracion({ repo, rolesUsuario, contrasenas, cuentasLocales = () => false }) {
  const normalizar = (email) =>
    String(email || '')
      .trim()
      .toLowerCase();
  const noEsUno = (actor, email) => actor && normalizar(actor.nombre) === email;

  async function crearUsuario(actor, { email, nombre, rol, local }) {
    const e = normalizar(email);
    if (!USUARIO.test(e))
      return fallo('validacion', 'usuario_invalido', { mensaje: 'Indica un correo o nombre de usuario válido (minúsculas, números y . _ - +).' });
    if (!rolesUsuario.includes(rol)) return fallo('validacion', 'rol_invalido', { mensaje: `El rol debe ser uno de: ${rolesUsuario.join(', ')}.` });
    if (local && !cuentasLocales())
      return fallo('validacion', 'cuentas_locales_deshabilitadas', { mensaje: 'Las cuentas locales están deshabilitadas (AUTH_LOCAL).' });
    const temporal = local ? contrasenas.generarTemporal() : null;
    const claveHash = temporal ? await contrasenas.hashear(temporal) : null;
    const fila = await repo.crearUsuario({
      email: e,
      nombre:
        String(nombre || '')
          .trim()
          .slice(0, 120) || e,
      rol,
      claveHash,
      debeCambiar: Boolean(local),
      creadoPor: actor ? actor.nombre : null,
    });
    if (!fila) return fallo('conflicto', 'usuario_existe', { mensaje: 'Ya existe un usuario con ese correo o nombre.' });
    return ok({ email: fila.email, nombre: fila.nombre, rol: fila.rol, local: Boolean(local), ...(temporal ? { clave_temporal: temporal } : {}) });
  }

  async function cambiarActivo(actor, email, activo) {
    const e = normalizar(email);
    if (!activo && noEsUno(actor, e)) return fallo('conflicto', 'auto_baja', { mensaje: 'No puedes desactivarte a ti mismo.' });
    if (!(await repo.fijarActivo(e, activo))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El usuario no existe.' });
    return ok({ email: e, activo });
  }

  async function restablecerClave(email) {
    const e = normalizar(email);
    const u = await repo.usuarioPorEmail(e);
    if (!u) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El usuario no existe.' });
    if (!u.clave_hash)
      return fallo('validacion', 'no_es_local', { mensaje: 'Solo las cuentas locales tienen contraseña en el IPAM; las de SSO la gestiona el proveedor.' });
    const temporal = contrasenas.generarTemporal();
    await repo.fijarClave(e, await contrasenas.hashear(temporal), true);
    return ok({ email: e, clave_temporal: temporal });
  }

  async function eliminarUsuario(actor, email) {
    const e = normalizar(email);
    if (noEsUno(actor, e)) return fallo('conflicto', 'auto_baja', { mensaje: 'No puedes eliminarte a ti mismo.' });
    if (!(await repo.eliminarUsuario(e))) return fallo('no_encontrado', 'no_encontrado', { mensaje: 'El usuario no existe.' });
    return ok({ email: e });
  }

  /** Cambio de la contraseña propia (solo cuentas locales): exige la actual y una nueva distinta y larga. */
  async function cambiarClavePropia(actor, { actual, nueva }) {
    if (!actor || !actor.local) return fallo('validacion', 'no_es_local', { mensaje: 'Solo las cuentas locales cambian su contraseña aquí.' });
    if (typeof nueva !== 'string' || nueva.length < CLAVE_MIN)
      return fallo('validacion', 'clave_corta', { mensaje: `La contraseña nueva debe tener al menos ${CLAVE_MIN} caracteres.` });
    if (nueva === actual) return fallo('validacion', 'clave_repetida', { mensaje: 'La contraseña nueva debe ser distinta de la actual.' });
    const u = await repo.usuarioPorEmail(normalizar(actor.nombre));
    if (!u || !u.clave_hash || !(await contrasenas.verificar(String(actual || ''), u.clave_hash)))
      return fallo('prohibido', 'clave_actual_incorrecta', { mensaje: 'La contraseña actual no coincide.' });
    await repo.fijarClave(u.email, await contrasenas.hashear(nueva), false);
    return ok({ email: u.email });
  }

  return {
    pools: (filtros = {}) => repo.poolsConUso(filtros),
    resumen: async () => ({ ...(await repo.resumen()), solapamientos: 0 }), // la restricción de exclusión impide solapes
    asignaciones: () => repo.listarAsignaciones(),
    asignacionesParaExcel: async () => ({ ...(await repo.asignacionesParaExcel()), direcciones: await repo.listarDirecciones({}) }),
    usuarios: () => repo.listarUsuarios(),
    auditoria: (filtros = {}) => repo.listarAuditoria(filtros),
    eventos: () => repo.listarEventos(),
    async cambiarRol(email, rol) {
      if (rol !== null && !rolesUsuario.includes(rol)) return fallo('validacion', 'rol inválido');
      const e = normalizar(email);
      await repo.asignarRol(e, rol);
      return ok({ email: e, rol });
    },
    crearUsuario,
    cambiarActivo,
    restablecerClave,
    eliminarUsuario,
    cambiarClavePropia,
  };
}

module.exports = { crearAdministracion, CLAVE_MIN };
