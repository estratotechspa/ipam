// @ts-check
'use strict';
// Roles y reglas de acceso (puras). Orden de menor a mayor poder.
// Los usuarios pueden ser lector, solicitante o admin. Los tokens de servicio, lector o agente (se agrega en la fase 2).

/** @typedef {'lector'|'agente'|'solicitante'|'admin'} Rol */
const ORDEN = ['lector', 'solicitante', 'admin'];
const ROLES_USUARIO = ['lector', 'solicitante', 'admin'];

/** ¿`rol` alcanza el nivel `minimo`? @param {string|undefined} rol @param {string} minimo */
const tiene = (rol, minimo) => ORDEN.indexOf(String(rol)) >= 0 && ORDEN.indexOf(String(rol)) >= ORDEN.indexOf(minimo);

/** @param {unknown} v @returns {string[]} */
const lista = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/**
 * Rol que le toca a una persona que inició sesión con OIDC.
 * Prioridad: correos admin de la configuración > rol asignado en la base > grupos del proveedor > rol por defecto.
 * @param {Record<string, any>} claims  datos del proveedor (email, groups…)
 * @param {{rol?: string|null}|null|undefined} filaDb
 * @param {{correosAdmin: string[], correosSolicitante: string[], correosLector: string[], claimGrupos: string,
 *          gruposAdmin: string[], gruposSolicitante: string[], gruposLector: string[], rolPorDefecto: string}} cfg
 * @returns {string|null} null = sin acceso
 */
function resolverRol(claims, filaDb, cfg) {
  const email = String(claims.email || '').toLowerCase();
  if (cfg.correosAdmin.includes(email)) return 'admin';
  if (filaDb && filaDb.rol) return filaDb.rol;
  const g = claims[cfg.claimGrupos || 'groups'];
  const grupos = (Array.isArray(g) ? g : typeof g === 'string' ? [g] : []).map((x) => String(x).toLowerCase());
  const en = (/** @type {string[]} */ v) => v.some((x) => grupos.includes(x));
  if (en(cfg.gruposAdmin)) return 'admin';
  if (en(cfg.gruposSolicitante) || cfg.correosSolicitante.includes(email)) return 'solicitante';
  if (en(cfg.gruposLector) || cfg.correosLector.includes(email)) return 'lector';
  return ROLES_USUARIO.includes(cfg.rolPorDefecto) ? cfg.rolPorDefecto : null;
}

/** @param {Record<string, any>} claims @param {string[]} dominios */
function dominioPermitido(claims, dominios) {
  if (!dominios.length) return true;
  const dom = String(claims.email || '').toLowerCase().split('@')[1];
  return dominios.includes(dom);
}

module.exports = { ORDEN, ROLES_USUARIO, tiene, lista, resolverRol, dominioPermitido };
