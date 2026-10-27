// @ts-check
'use strict';
// Reglas de un bloque base (pool): datos válidos y que no se solape con otro del MISMO proveedor y ambiente.
// Entre ambientes o proveedores distintos sí puede repetirse (el mismo rango privado se reutiliza en otra nube o en on-prem).
const { parse, overlap } = require('./cidr');

const AMBIENTES = ['dev', 'qa', 'pre', 'prod'];
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
  return { ok: /** @type {true} */ (true), datos: { id, tipo: t.tipo, ambiente, proveedor: t.proveedor, cidr: String(e.cidr).trim() } };
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
      return p.id !== nuevo.id && p.ambiente === nuevo.ambiente && p.proveedor.toLowerCase() === nuevo.proveedor.toLowerCase() && pc && overlap(pc, c);
    }) || null
  );
}

module.exports = { validarPoolNuevo, validarTexto, chocaConPool };
