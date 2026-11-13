// @ts-check
'use strict';
// Reconciliación pura (sin red, sin base de datos, sin SDKs de nube).
// Compara las subredes reales de la nube contra las asignaciones registradas en el IPAM.
const { parse, overlap } = require('./cidr');

/**
 * @typedef {{cidr: string, proyecto?: string|null, vpc?: string|null, subred?: string|null, region?: string|null, id_nube?: string|null}} SubredNube
 * @typedef {{id?: number|string, codigo?: string, pool_id?: string, cidr: string, vpc?: string|null, proyecto?: string|null, subred?: string|null}} AsignacionIpam
 *
 * @typedef {'en_sincronia' | 'desviacion_no_registrada' | 'huerfana_en_ipam' | 'discrepancia_metadatos'} EstadoReconciliacion
 */

/**
 * Normaliza cadenas para comparación insensible a mayúsculas y espacios.
 * @param {string|null|undefined} s
 */
const normalizar = (s) => (s ? String(s).trim().toLowerCase() : '');

/**
 * Compara metadatos entre una subred de nube y su asignación en IPAM.
 * @param {SubredNube} n
 * @param {AsignacionIpam} a
 * @returns {string[]}
 */
function compararMetadatos(n, a) {
  const diferencias = [];
  if (n.vpc && a.vpc && normalizar(n.vpc) !== normalizar(a.vpc)) {
    diferencias.push(`VPC distinta (nube: ${n.vpc}, ipam: ${a.vpc})`);
  }
  if (n.proyecto && a.proyecto && normalizar(n.proyecto) !== normalizar(a.proyecto)) {
    diferencias.push(`Proyecto distinto (nube: ${n.proyecto}, ipam: ${a.proyecto})`);
  }
  if (n.subred && a.subred && normalizar(n.subred) !== normalizar(a.subred)) {
    diferencias.push(`Subred distinta (nube: ${n.subred}, ipam: ${a.subred})`);
  }
  return diferencias;
}

/**
 * Detecta solapamientos entre subredes no registradas y segmentos existentes del IPAM.
 * @param {SubredNube[]} noRegistradas
 * @param {AsignacionIpam[]} ipamValidas
 */
function buscarChoquesParciales(noRegistradas, ipamValidas) {
  const choques = [];
  for (const n of noRegistradas) {
    const cn = parse(n.cidr);
    if (!cn) continue;
    for (const a of ipamValidas) {
      const ca = parse(a.cidr);
      if (ca && overlap(cn, ca)) {
        choques.push({
          subredNube: n,
          asignacionIpam: a,
          motivo: `${n.cidr} en nube se solapa con ${a.cidr} (${a.codigo || 'asignación'}) en IPAM`,
        });
      }
    }
  }
  return choques;
}

/**
 * Reconcilia la lista de subredes descubiertas en la nube contra las asignaciones del IPAM.
 * @param {SubredNube[]} subredesNube
 * @param {AsignacionIpam[]} asignacionesIpam
 */
function reconciliarSubredes(subredesNube, asignacionesIpam) {
  const nubeValidas = (subredesNube || []).filter((s) => Boolean(s && parse(s.cidr)));
  const ipamValidas = (asignacionesIpam || []).filter((a) => Boolean(a && parse(a.cidr)));

  const ipamPorCidr = new Map();
  for (const a of ipamValidas) {
    const c = parse(a.cidr);
    if (c) ipamPorCidr.set(a.cidr.trim(), a);
  }

  const procesadasIpam = new Set();
  /** @type {Array<{nube: SubredNube, ipam: AsignacionIpam}>} */
  const sincronizadas = [];
  /** @type {Array<{nube: SubredNube, ipam: AsignacionIpam, diferencias: string[]}>} */
  const discrepanciasMetadatos = [];
  /** @type {SubredNube[]} */
  const noRegistradasEnIpam = [];

  for (const n of nubeValidas) {
    const cidrNorm = n.cidr.trim();
    const coincidencia = ipamPorCidr.get(cidrNorm);

    if (coincidencia) {
      procesadasIpam.add(coincidencia);
      const diferencias = compararMetadatos(n, coincidencia);
      if (diferencias.length > 0) {
        discrepanciasMetadatos.push({ nube: n, ipam: coincidencia, diferencias });
      } else {
        sincronizadas.push({ nube: n, ipam: coincidencia });
      }
    } else {
      noRegistradasEnIpam.push(n);
    }
  }

  const huerfanasEnIpam = ipamValidas.filter((a) => !procesadasIpam.has(a));
  const choquesParciales = buscarChoquesParciales(noRegistradasEnIpam, ipamValidas);

  const total = nubeValidas.length + huerfanasEnIpam.length;
  const enSincroniaCount = sincronizadas.length;
  const porcentajeAlineacion = total === 0 ? 100 : Number(((enSincroniaCount / total) * 100).toFixed(1));

  return {
    resumen: {
      total_nube: nubeValidas.length,
      total_ipam: ipamValidas.length,
      sincronizadas: sincronizadas.length,
      desviaciones_no_registradas: noRegistradasEnIpam.length,
      huerfanas_en_ipam: huerfanasEnIpam.length,
      discrepancias_metadatos: discrepanciasMetadatos.length,
      choques_parciales: choquesParciales.length,
      porcentaje_alineacion: porcentajeAlineacion,
      hay_drift: noRegistradasEnIpam.length > 0 || huerfanasEnIpam.length > 0 || discrepanciasMetadatos.length > 0,
    },
    sincronizadas,
    desviaciones_no_registradas: noRegistradasEnIpam,
    huerfanas_en_ipam: huerfanasEnIpam,
    discrepancias_metadatos: discrepanciasMetadatos,
    choques_parciales: choquesParciales,
  };
}

module.exports = { reconciliarSubredes };
