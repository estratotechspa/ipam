// @ts-check
'use strict';
// Resultado uniforme de los casos de uso. La capa HTTP traduce `tipo` a un código de estado; aquí no hay HTTP.
/** @typedef {'validacion'|'no_encontrado'|'conflicto'|'ambiguo'|'prohibido'|'cuota'|'no_autenticado'|'no_disponible'} TipoFallo */

/** @template T @param {T} [datos] */
const ok = (datos) => ({ ok: /** @type {true} */ (true), ...(datos || /** @type {any} */ ({})) });

/** @param {TipoFallo} tipo @param {string} error @param {Record<string, unknown>} [extra] */
const fallo = (tipo, error, extra = {}) => ({ ok: /** @type {false} */ (false), tipo, error, ...extra });

/** Un dato guardado choca con una restricción de la base (solapamiento, fuera del pool, pool inexistente). */
class ConflictoDeDatos extends Error {
  /** @param {string} mensaje @param {string} [codigo] */
  constructor(mensaje, codigo) { super(mensaje); this.name = 'ConflictoDeDatos'; this.codigo = codigo; }
}

module.exports = { ok, fallo, ConflictoDeDatos };
