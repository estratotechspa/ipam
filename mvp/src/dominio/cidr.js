// @ts-check
'use strict';
// Aritmética CIDR IPv4 pura (sin dependencias, sin red, sin base de datos). Solo IPv4.

/** @param {string} s @returns {number|null} */
function ip2n(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || +x > 255) return null;
    n = n * 256 + +x;
  }
  return n;
}

/** @param {number} n */
const n2ip = (n) => [Math.floor(n / 16777216), Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');

/**
 * @typedef {{ip: number, len: number, size: number, start: number, end: number, aligned: boolean}} Cidr
 * @param {unknown} c
 * @returns {Cidr|null}
 */
function parse(c) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(c || '').trim());
  if (!m) return null;
  const ip = ip2n(m[1]);
  const len = +m[2];
  if (ip === null || len > 32) return null;
  const size = 2 ** (32 - len);
  return { ip, len, size, start: ip, end: ip + size - 1, aligned: ip % size === 0 };
}

/** @param {Cidr} a @param {Cidr} b */
const overlap = (a, b) => a.start <= b.end && b.start <= a.end;

/** ¿`interior` cabe completamente dentro de `exterior`? @param {Cidr} interior @param {Cidr} exterior */
const contenido = (interior, exterior) => interior.start >= exterior.start && interior.end <= exterior.end;

/** @param {Cidr} c */
const aTexto = (c) => `${n2ip(c.start)}/${c.len}`;

/** Cantidad de direcciones de un CIDR en texto. @param {string} c */
const tamano = (c) => 2 ** (32 - Number(String(c).split('/')[1]));

/**
 * Primeros `max` bloques /len alineados, dentro del pool y fuera de los ocupados (lista de CIDR en texto).
 * @param {string} poolCidr @param {string[]} ocupadosCidr @param {number} len @param {number} [max]
 * @returns {string[]}
 */
function libres(poolCidr, ocupadosCidr, len, max = 3) {
  const p = parse(poolCidr);
  /** @type {string[]} */
  const out = [];
  if (!p || len < p.len || len > 32) return out;
  const size = 2 ** (32 - len);
  const ocup = /** @type {Cidr[]} */ (ocupadosCidr.map(parse).filter(Boolean)).sort((x, y) => x.start - y.start);
  let cur = p.start;
  for (const o of ocup) {
    if (o.end < cur) continue;
    while (out.length < max && cur + size - 1 < o.start && cur + size - 1 <= p.end) {
      out.push(`${n2ip(cur)}/${len}`);
      cur += size;
    }
    if (out.length >= max) return out;
    cur = Math.max(cur, Math.ceil((o.end + 1) / size) * size);
  }
  while (out.length < max && cur + size - 1 <= p.end) {
    out.push(`${n2ip(cur)}/${len}`);
    cur += size;
  }
  return out;
}

module.exports = { parse, overlap, libres, n2ip, ip2n, contenido, aTexto, tamano };
