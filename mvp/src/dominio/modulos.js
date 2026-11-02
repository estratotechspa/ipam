// @ts-check
'use strict';
// Módulos de la API que se pueden apagar con MODULOS_DESACTIVADOS (lista separada por comas). Un módulo apagado responde 404
// `modulo_desactivado`: lo que no se usa no debe quedar expuesto. Las rutas de salud, la marca, /metrics y la autenticación no se apagan.

/** @type {Record<string, {descripcion: string, rutas: RegExp[]}>} */
const MODULOS = {
  jira: { descripcion: 'Integración con Jira: webhook de entrada, estado y simulador', rutas: [/^\/webhook\/jira\/?$/, /^\/api\/v1\/jira(\/|$)/] },
  importacion: { descripcion: 'Importación masiva de segmentos desde Excel o CSV', rutas: [/^\/api\/v1\/importaciones(\/|$)/] },
  direcciones: { descripcion: 'IP fijas por segmento', rutas: [/^\/api\/v1\/direcciones(\/|$)/] },
  respaldo: { descripcion: 'Respaldo y restauración lógica (JSON)', rutas: [/^\/api\/v1\/(exportar\.json|importar)\/?$/] },
  excel: { descripcion: 'Exportación a Excel', rutas: [/^\/api\/v1\/exportar\.xlsx\/?$/] },
};
const NOMBRES = Object.keys(MODULOS);

/** Nombres que no son módulos conocidos. @param {string[]} lista */
const desconocidos = (lista) => lista.filter((n) => !NOMBRES.includes(n));

/** ¿Está apagada la ruta? @param {string[]} apagados @param {string} camino */
const apagado = (apagados, camino) => apagados.some((m) => MODULOS[m] && MODULOS[m].rutas.some((r) => r.test(camino)));

module.exports = { MODULOS, NOMBRES, desconocidos, apagado };
