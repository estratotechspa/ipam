'use strict';
// Contexto de la petición en curso (request_id, actor, trace_id). Viaja con la ejecución asíncrona sin pasarlo por parámetro,
// así los logs y la auditoría salen correlacionados.
const { AsyncLocalStorage } = require('node:async_hooks');

const almacen = new AsyncLocalStorage();
/** @template T @param {Record<string, unknown>} datos @param {() => T} fn @returns {T} */
const correr = (datos, fn) => almacen.run(datos, fn);
/** @returns {Record<string, any>} */
const actual = () => almacen.getStore() || {};

module.exports = { correr, actual };
