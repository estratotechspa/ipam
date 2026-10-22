// @ts-check
'use strict';
// Tokens de servicio (credenciales para agentes y sistemas, no para personas). Reglas puras.
//
//  - Formato: «ipam_» + 43 caracteres base64url (256 bits de un generador criptográfico). Se muestra UNA sola vez; en la base solo vive su hash SHA-256.
//  - Rol: «lector» (solo consulta) o «agente» (además reserva, confirma y libera SUS reservas).
//  - Vigencia: de 1 a 365 días (90 por defecto). Se puede revocar en cualquier momento.

const NOMBRE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const FORMATO = /^ipam_[A-Za-z0-9_-]{43}$/;
const PREFIJO_LARGO = 9; // «ipam_» + 4 caracteres: sirve para reconocer un token en una lista, no para adivinarlo
const MAX_DIAS = 365;
const DIAS_POR_VENCER = 7;
const ROLES = ['lector', 'agente'];

/** ¿Parece un token IPAM? (comprobación barata antes de ir a la base) @param {unknown} v */
const pareceToken = (v) => typeof v === 'string' && FORMATO.test(v);

/** @param {string} token */
const prefijoDe = (token) => token.slice(0, PREFIJO_LARGO);

/**
 * Valida la petición de crear un token.
 * @param {{nombre?: unknown, rol?: unknown, expira_dias?: unknown, cuota_reservas?: unknown}} e
 * @param {{vidaDefectoDias: number}} cfg
 * @returns {{ok: true, nombre: string, rol: string, dias: number, cuota: number|null} | {ok: false, error: string, mensaje: string}}
 */
function validarCreacion(e, { vidaDefectoDias }) {
  const malo = (/** @type {string} */ error, /** @type {string} */ mensaje) => ({ ok: /** @type {false} */ (false), error, mensaje });
  if (typeof e.nombre !== 'string' || !NOMBRE.test(e.nombre)) return malo('nombre_invalido', 'nombre: de 2 a 41 caracteres, en minúsculas, números y guiones, empezando con letra o número (p. ej. agente-redes).');
  if (typeof e.rol !== 'string' || !ROLES.includes(e.rol)) return malo('rol_invalido', `rol debe ser uno de: ${ROLES.join(', ')}.`);
  let dias = vidaDefectoDias;
  if (e.expira_dias !== undefined && e.expira_dias !== null && e.expira_dias !== '') {
    dias = Number(e.expira_dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > MAX_DIAS) return malo('vigencia_invalida', `expira_dias debe ser un entero entre 1 y ${MAX_DIAS}.`);
  }
  let cuota = null;
  if (e.cuota_reservas !== undefined && e.cuota_reservas !== null && e.cuota_reservas !== '') {
    cuota = Number(e.cuota_reservas);
    if (!Number.isInteger(cuota) || cuota < 1 || cuota > 100000) return malo('cuota_invalida', 'cuota_reservas debe ser un entero de 1 en adelante.');
  }
  return { ok: true, nombre: e.nombre, rol: e.rol, dias, cuota };
}

/** Estado según las fechas. @param {{expira_en: Date|string, revocado_en?: Date|string|null}} t @param {Date} ahora */
function estadoToken(t, ahora) {
  if (t.revocado_en) return 'revocado';
  return new Date(t.expira_en).getTime() <= ahora.getTime() ? 'vencido' : 'activo';
}

/** ¿Vence en menos de 7 días (y sigue activo)? @param {{expira_en: Date|string, revocado_en?: Date|string|null}} t @param {Date} ahora */
const porVencer = (t, ahora) => estadoToken(t, ahora) === 'activo' && new Date(t.expira_en).getTime() - ahora.getTime() < DIAS_POR_VENCER * 86400_000;

module.exports = { NOMBRE, FORMATO, ROLES, MAX_DIAS, DIAS_POR_VENCER, pareceToken, prefijoDe, validarCreacion, estadoToken, porVencer };
