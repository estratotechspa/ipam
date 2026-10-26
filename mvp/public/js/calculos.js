// Lógica pura de la interfaz (sin DOM ni red): aritmética CIDR, umbrales de uso, resumen de pools y mapa de bloques.
// Es la contraparte en el navegador de src/cidr.js: el servidor sigue siendo quien decide; esto solo anticipa errores.

export const fmt = (n) => Number(n).toLocaleString('es-CL');

export function ipANumero(texto) {
  const partes = String(texto).split('.');
  if (partes.length !== 4) return null;
  let n = 0;
  for (const p of partes) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export const numeroAIp = (n) => [Math.floor(n / 16777216), Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');

// → { ip, len, tamano, inicio, fin, alineado } o null si no es un CIDR IPv4 válido.
export function parseCidr(texto) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(texto || '').trim());
  if (!m) return null;
  const ip = ipANumero(m[1]);
  const len = Number(m[2]);
  if (ip === null || len > 32) return null;
  const tamano = 2 ** (32 - len);
  return { ip, len, tamano, inicio: ip, fin: ip + tamano - 1, alineado: ip % tamano === 0 };
}

export const tamanoCidr = (cidr) => 2 ** (32 - Number(String(cidr).split('/')[1]));

// ---------- Uso de los pools ----------
// Verde por debajo de 70 %, ámbar de 70 % a 90 % (incluido), rojo por encima de 90 %.
export function nivelUso(uso) {
  if (uso < 0.7) return 'bajo';
  if (uso <= 0.9) return 'medio';
  return 'alto';
}
export const porcentaje = (uso, decimales = 1) => `${(uso * 100).toFixed(decimales).replace('.', ',')} %`;

// Totales del tablero a partir de /api/pools (una sola consulta en el servidor).
export function resumirPools(pools) {
  const uso = pools.length ? pools.reduce((n, p) => n + p.uso, 0) / pools.length : 0;
  return {
    pools: pools.length,
    asignaciones: pools.reduce((n, p) => n + p.asignaciones, 0),
    usoPromedio: uso,
    sobre80: pools.filter((p) => p.uso > 0.8).length,
    libres: pools.reduce((n, p) => n + p.libres, 0),
  };
}

// ---------- Validación del CIDR mientras se escribe ----------
// → { estado: 'vacio' | 'ok' | 'error', mensaje }. `poolCidr` (opcional) permite avisar si queda fuera del pool.
export function validarCidr(texto, poolCidr) {
  const t = String(texto || '').trim();
  if (!t) return { estado: 'vacio', mensaje: '' };
  const error = (mensaje) => ({ estado: 'error', mensaje });
  const m = /^(\d{1,3}(?:\.\d{1,3}){0,3})(?:\/(\d*))?$/.exec(t);
  if (!m || (m[2] === undefined && t.includes('/'))) return error('Formato inválido. Escribe la dirección y la máscara, por ejemplo 10.64.16.0/22.');
  if (m[2] === undefined || m[2] === '') return error('Falta la máscara, por ejemplo 10.64.16.0/22.');
  if (m[1].split('.').length !== 4) return error('La dirección necesita cuatro números separados por puntos, por ejemplo 10.64.16.0/22.');
  if (ipANumero(m[1]) === null) return error('Cada número de la dirección debe estar entre 0 y 255.');
  if (Number(m[2]) > 32) return error('La máscara debe estar entre /0 y /32.');
  const c = parseCidr(t);
  if (!c.alineado) {
    const red = numeroAIp(Math.floor(c.ip / c.tamano) * c.tamano);
    return error(`${t} no está alineado: la dirección de red debe ser múltiplo de su tamaño. ¿Quisiste decir ${red}/${c.len}?`);
  }
  const base = poolCidr ? parseCidr(poolCidr) : null;
  if (base && (c.inicio < base.inicio || c.fin > base.fin)) return error(`${t} queda fuera del pool ${poolCidr}.`);
  return { estado: 'ok', mensaje: `${t} · ${fmt(c.tamano)} direcciones` };
}

// ---------- Mapa de bloques de un pool ----------
// Divide el pool en hasta 256 bloques iguales (nunca más pequeños que una dirección) y marca cada uno:
//   libre (ninguna dirección asignada), parcial (algunas) u ocupado (todas).
// `asignaciones`: [{cidr, ...}] del pool. Devuelve { granularidad, bloques: [{cidr, estado, asignaciones}], resumen }.
const BITS_DE_BLOQUES = 8;
export function mapaBloques(poolCidr, asignaciones) {
  const p = parseCidr(poolCidr);
  if (!p) return { granularidad: null, bloques: [], resumen: { libre: 0, parcial: 0, ocupado: 0 } };
  const granularidad = Math.min(32, p.len + BITS_DE_BLOQUES);
  const tamano = 2 ** (32 - granularidad);
  const cuantos = 2 ** (granularidad - p.len);
  const ordenadas = asignaciones
    .map((a) => ({ a, c: parseCidr(a.cidr) }))
    .filter((x) => x.c)
    .sort((x, y) => x.c.inicio - y.c.inicio);
  const resumen = { libre: 0, parcial: 0, ocupado: 0 };
  const bloques = [];
  let desde = 0;
  for (let i = 0; i < cuantos; i++) {
    const ini = p.inicio + i * tamano;
    const fin = ini + tamano - 1;
    while (desde < ordenadas.length && ordenadas[desde].c.fin < ini) desde++;
    let ocupadas = 0;
    const tocan = [];
    for (let j = desde; j < ordenadas.length && ordenadas[j].c.inicio <= fin; j++) {
      const solape = Math.min(fin, ordenadas[j].c.fin) - Math.max(ini, ordenadas[j].c.inicio) + 1;
      if (solape > 0) { ocupadas += solape; tocan.push(ordenadas[j].a); }
    }
    const estado = ocupadas === 0 ? 'libre' : ocupadas >= tamano ? 'ocupado' : 'parcial';
    resumen[estado]++;
    bloques.push({ cidr: `${numeroAIp(ini)}/${granularidad}`, estado, asignaciones: tocan });
  }
  return { granularidad, bloques, resumen };
}
