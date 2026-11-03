// @ts-check
'use strict';
// Ambientes válidos y sus alias de entrada. El nombre canónico es siempre el de IPAM: «prd» se acepta como alias de «prod».
const AMBIENTES = ['dev', 'qa', 'lab', 'pre', 'prod'];
const ALIAS = { prd: 'prod' };

/** Lleva el ambiente escrito por quien llama a su nombre canónico (sin importar mayúsculas). Si no es válido, lo devuelve igual. @param {unknown} v */
function normalizarAmbiente(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : v;
  return typeof t === 'string' && Object.hasOwn(ALIAS, t) ? ALIAS[/** @type {'prd'} */ (t)] : t;
}

module.exports = { AMBIENTES, ALIAS, normalizarAmbiente };
