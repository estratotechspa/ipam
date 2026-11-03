// @ts-check
'use strict';
// Reglas de un bloque base (pool): datos válidos y que no se solape con NINGÚN otro pool, sea cual sea su ambiente o proveedor
// (los rangos no se repiten entre dev, qa, lab, pre y prod).
const { parse, overlap } = require('./cidr');

const AMBIENTES = ['dev', 'qa', 'lab', 'pre', 'prod'];
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const TEXTO = /^[^\p{Cc}]{1,40}$/u;
const malo = (error, mensaje) => ({ ok: /** @type {false} */ (false), error, mensaje });

/** Valida tipo y proveedor (lo único editable). */
function validarTexto(e) {
  const tipo = String(e.tipo ?? '').trim();
  const proveedor = String(e.proveedor ?? '').trim();
  if (!TEXTO.test(tipo)) return malo('tipo_invalido', 'Indica el tipo (p. ej. Nodos, Pods, LAN), hasta 40 caracteres.');
  if (!TEXTO.test(proveedor)) return malo('proveedor_invalido', 'Indica el proveedor (p. ej. GCP u On-prem), hasta 40 caracteres.');
  return { ok: /** @type {true} */ (true), tipo, proveedor };
}

/** Valida un pool nuevo y lo normaliza (id en minúsculas, CIDR alineado entre /8 y /30). */
function validarPoolNuevo(e) {
  const id = String(e.id ?? '')
    .trim()
    .toLowerCase();
  if (!ID.test(id)) return malo('id_invalido', 'El nombre del pool usa minúsculas, números y guiones (2 a 63), p. ej. gke-nodos-qa.');
  const t = validarTexto(e);
  if (!t.ok) return t;
  const ambiente = String(e.ambiente ?? '')
    .trim()
    .toLowerCase();
  if (!AMBIENTES.includes(ambiente)) return malo('ambiente_invalido', `El ambiente debe ser ${AMBIENTES.join(', ')}.`);
  const c = parse(String(e.cidr ?? '').trim());
  if (!c) return malo('cidr_invalido', 'CIDR inválido. Formato: 10.30.0.0/16.');
  if (!c.aligned) return malo('cidr_desalineado', `${e.cidr} no está alineado: la dirección de red debe ser múltiplo de su tamaño.`);
  if (c.len < 8 || c.len > 30) return malo('mascara_invalida', 'El bloque base debe ir de /8 a /30.');
  const lim = validarLimitesMascara(e, c.len);
  if (!lim.ok) return lim;
  const { ok: _ok, ...limites } = lim;
  return { ok: /** @type {true} */ (true), datos: { id, tipo: t.tipo, ambiente, proveedor: t.proveedor, cidr: String(e.cidr).trim(), ...limites } };
}

/**
 * Límites de máscara de un pool: por defecto, mínima (bloque más grande) y máxima (bloque más chico). Todos opcionales; nulo los quita.
 * Cada uno debe caber en el pool (no ser más grande que él) y cumplir mínima <= defecto <= máxima.
 * @param {Record<string, unknown>} e @param {number} largoPool máscara del pool (p. ej. 14 para un /14)
 * @returns {{ok: true, mascara_defecto: number|null, mascara_minima: number|null, mascara_maxima: number|null} | {ok: false, error: string, mensaje: string}}
 */
function validarLimitesMascara(e, largoPool) {
  const salida = { mascara_defecto: null, mascara_minima: null, mascara_maxima: null };
  for (const campo of Object.keys(salida)) {
    const v = e[campo];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < Math.max(8, largoPool) || n > 32)
      return malo(`${campo}_invalida`, `${campo} debe ser un entero entre /${Math.max(8, largoPool)} (el tamaño del pool) y /32.`);
    salida[campo] = n;
  }
  const { mascara_defecto: d, mascara_minima: mi, mascara_maxima: ma } = salida;
  if (mi !== null && ma !== null && mi > ma)
    return malo('limites_incoherentes', 'mascara_minima no puede ser mayor que mascara_maxima (la mínima es el bloque más grande).');
  if (d !== null && mi !== null && d < mi)
    return malo('limites_incoherentes', 'mascara_defecto no puede ser más grande que el bloque mínimo (mascara_minima).');
  if (d !== null && ma !== null && d > ma) return malo('limites_incoherentes', 'mascara_defecto no puede ser más chica que el bloque máximo (mascara_maxima).');
  return { ok: /** @type {true} */ (true), ...salida };
}

/**
 * Primer pool existente que choca con `nuevo` (mismo proveedor, sin distinguir mayúsculas, y mismo ambiente). Ignora el propio id.
 * @param {{id: string, ambiente: string, proveedor: string, cidr: string}} nuevo
 * @param {Array<{id: string, ambiente: string, proveedor: string, cidr: string}>} pools
 */
function chocaConPool(nuevo, pools) {
  const c = parse(nuevo.cidr);
  if (!c) return null;
  return (
    pools.find((p) => {
      const pc = parse(p.cidr);
      return p.id !== nuevo.id && pc && overlap(pc, c);
    }) || null
  );
}

module.exports = { validarPoolNuevo, validarTexto, validarLimitesMascara, chocaConPool };
