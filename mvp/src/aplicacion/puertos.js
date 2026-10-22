// @ts-check
'use strict';
// Puertos: las interfaces que la aplicación necesita del mundo exterior. Los adaptadores las implementan.
// (Solo documentación y tipos: no hay código que ejecutar aquí.)

/**
 * @typedef {Object} Reloj
 * @property {() => Date} ahora
 */

/**
 * @typedef {Object} PublicadorEventos  Publica hechos del negocio (asignación creada, reserva expirada…). Nunca lanza.
 * @property {(tipo: string, detalle?: Record<string, unknown>) => Promise<void>} publicar
 */

/**
 * @typedef {Object} Auditor  Bitácora de solo inserción. Nunca lanza ni bloquea la operación.
 * @property {(r: {accion: string, usuario: string, rol?: string|null, detalle?: Record<string, unknown>, ip?: string|null}) => Promise<void>} registrar
 */

/**
 * @typedef {Object} TicketsExternos  Integración saliente con un gestor de tickets (Jira). Opcional.
 * @property {() => boolean} activo
 * @property {() => string[]} faltantes
 * @property {(a: any) => Promise<string>} crear
 * @property {(clave: string, a: any) => Promise<void>} actualizar
 */

/**
 * @typedef {Object} Repositorio  Persistencia. Ver adaptadores/persistencia/postgres/repositorio.js (y la versión en memoria de pruebas).
 * @property {(fn: (tx: any) => Promise<any>) => Promise<any>} transaccion
 */

module.exports = {};
