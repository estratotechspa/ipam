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
 * Intervalos libres contiguos [inicio, fin] dentro de un pool.
 * @param {Cidr} p
 * @param {string[]} ocupadosCidr
 * @returns {Array<[number, number]>}
 */
function obtenerIntervalosLibres(p, ocupadosCidr) {
  const ocup = /** @type {Cidr[]} */ (ocupadosCidr.map(parse).filter(Boolean)).filter((o) => overlap(o, p)).sort((x, y) => x.start - y.start);
  /** @type {Array<[number, number]>} */
  const libresIntervalos = [];
  let cur = p.start;
  for (const o of ocup) {
    const ini = Math.max(o.start, p.start),
      fin = Math.min(o.end, p.end);
    if (fin < cur) continue;
    if (ini > cur) libresIntervalos.push([cur, ini - 1]);
    cur = Math.max(cur, fin + 1);
  }
  if (cur <= p.end) libresIntervalos.push([cur, p.end]);
  return libresIntervalos;
}

/**
 * Mide el grado de fragmentación del espacio libre en un pool.
 * @param {string} poolCidr
 * @param {string[]} ocupadosCidr
 * @returns {{total: number, ocupadas: number, libres: number, huecos: number, bloque_maximo: number, indice: number}}
 */
function calcularFragmentacion(poolCidr, ocupadosCidr) {
  const p = parse(poolCidr);
  if (!p) return { total: 0, ocupadas: 0, libres: 0, huecos: 0, bloque_maximo: 0, indice: 0 };
  const intervalos = obtenerIntervalosLibres(p, ocupadosCidr);
  const total = p.end - p.start + 1;
  let libresTotal = 0;
  let maxHueco = 0;
  for (const [s, e] of intervalos) {
    const tam = e - s + 1;
    libresTotal += tam;
    if (tam > maxHueco) maxHueco = tam;
  }
  const ocupadas = total - libresTotal;
  const huecos = intervalos.length;
  const indice = libresTotal <= 0 ? 0 : Number((1 - maxHueco / libresTotal).toFixed(4));
  return { total, ocupadas, libres: libresTotal, huecos, bloque_maximo: maxHueco, indice };
}

/**
 * Búsqueda secuencial estándar (First-fit).
 * @param {Cidr} p
 * @param {string[]} ocupadosCidr
 * @param {number} len
 * @param {number} max
 * @param {number} size
 */
function libresSecuencial(p, ocupadosCidr, len, max, size) {
  const out = [];
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

/**
 * Ordena los candidatos según la estrategia indicada.
 * @param {Array<{s: number, e: number, primero: number, capacidad: number, tamano: number}>} candidatos
 * @param {string} estrategia
 * @param {number} len
 */
function ordenarCandidatos(candidatos, estrategia, len) {
  if (estrategia === 'mejor_ajuste') {
    candidatos.sort((a, b) => a.tamano - b.tamano || a.s - b.s);
  } else if (estrategia === 'biseccion') {
    if (len >= 24) {
      candidatos.sort((a, b) => a.tamano - b.tamano || b.s - a.s);
    } else {
      candidatos.sort((a, b) => b.tamano - a.tamano || a.s - b.s);
    }
  } else if (estrategia === 'inverso') {
    candidatos.sort((a, b) => b.s - a.s);
  }
}

/**
 * Bloques /len alineados, dentro del pool y fuera de los ocupados (lista de CIDR en texto).
 * Estrategias soportadas:
 *  - 'primero' (First-fit, por defecto): asigna desde el inicio en orden secuencial.
 *  - 'mejor_ajuste' (Best-fit): asigna primero en el hueco libre más ajustado para preservar bloques contiguos grandes.
 *  - 'biseccion': subredes chicas (>= /24) usan el hueco más ajustado; subredes grandes (< /24) usan el hueco más amplio desde el inicio.
 *  - 'inverso': asigna desde el final del pool hacia atrás.
 * @param {string} poolCidr @param {string[]} ocupadosCidr @param {number} len @param {number} [max]
 * @param {'primero'|'mejor_ajuste'|'biseccion'|'inverso'} [estrategia]
 * @returns {string[]}
 */
function libres(poolCidr, ocupadosCidr, len, max = 3, estrategia = 'primero') {
  const p = parse(poolCidr);
  /** @type {string[]} */
  const out = [];
  if (!p || len < p.len || len > 32) return out;
  const size = 2 ** (32 - len);

  if (estrategia === 'primero') {
    return libresSecuencial(p, ocupadosCidr, len, max, size);
  }

  const intervalos = obtenerIntervalosLibres(p, ocupadosCidr);
  const candidatos = [];
  for (const [s, e] of intervalos) {
    const primero = Math.ceil(s / size) * size;
    if (primero + size - 1 <= e) {
      const capacidad = Math.floor((e + 1 - primero) / size);
      candidatos.push({ s, e, primero, capacidad, tamano: e - s + 1 });
    }
  }

  if (candidatos.length === 0) return out;

  ordenarCandidatos(candidatos, estrategia, len);

  for (const c of candidatos) {
    let cur = c.primero;
    while (out.length < max && cur + size - 1 <= c.e) {
      out.push(`${n2ip(cur)}/${len}`);
      cur += size;
    }
    if (out.length >= max) break;
  }

  return out;
}

/**
 * Cuánto queda disponible en un pool, por tamaño de bloque. Para cada máscara desde la del pool hasta /32:
 * cuántos bloques ALINEADOS caben enteros en lo libre, y cuántas direcciones tiene cada bloque (totales y utilizables:
 * en IPv4 un bloque ≤ /30 pierde la dirección de red y la de difusión; /31 y /32 no).
 * @param {string} poolCidr @param {string[]} ocupadosCidr  asignaciones y reservas vigentes del pool
 * @returns {{total: number, ocupadas: number, libres: number, fragmentacion: {total: number, ocupadas: number, libres: number, huecos: number, bloque_maximo: number, indice: number}, por_mascara: Array<{mascara: number, direcciones: number, utilizables: number, bloques_libres: number, direcciones_libres: number}>}}
 */
function disponibilidad(poolCidr, ocupadosCidr) {
  const p = parse(poolCidr);
  if (!p)
    return {
      total: 0,
      ocupadas: 0,
      libres: 0,
      fragmentacion: { total: 0, ocupadas: 0, libres: 0, huecos: 0, bloque_maximo: 0, indice: 0 },
      por_mascara: [],
    };
  const libresIntervalos = obtenerIntervalosLibres(p, ocupadosCidr);
  const fragmentacion = calcularFragmentacion(poolCidr, ocupadosCidr);
  const total = p.end - p.start + 1;
  const por_mascara = [];
  for (let m = p.len; m <= 32; m++) {
    const size = 2 ** (32 - m);
    let bloques = 0;
    for (const [s, e] of libresIntervalos) {
      const primero = Math.ceil(s / size) * size;
      if (primero + size - 1 <= e) bloques += Math.floor((e + 1 - primero) / size);
    }
    por_mascara.push({
      mascara: m,
      direcciones: size,
      utilizables: m >= 31 ? size : size - 2,
      bloques_libres: bloques,
      direcciones_libres: bloques * size,
    });
  }
  return { total, ocupadas: fragmentacion.ocupadas, libres: fragmentacion.libres, fragmentacion, por_mascara };
}

module.exports = { parse, overlap, libres, disponibilidad, calcularFragmentacion, n2ip, ip2n, contenido, aTexto, tamano };
