'use strict';
// Contraseñas y comparaciones en tiempo constante.
//  - Hash con scrypt (incluido en Node, sin dependencias nativas). Formato: scrypt$N$r$p$sal(base64)$hash(base64)
//  - Comparar con `===` filtra información por el tiempo que tarda; aquí todo se compara con timingSafeEqual.
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const N = 16384, R = 8, P = 1, LARGO = 32;

/** Compara dos textos sin filtrar su contenido ni su largo por tiempo. */
function igualConstante(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** @param {string} contrasena @returns {Promise<string>} */
async function hashear(contrasena) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(contrasena, sal, LARGO, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

/** ¿La contraseña coincide con lo guardado (hash scrypt o texto plano)? @param {string} contrasena @param {string} guardado */
async function verificar(contrasena, guardado) {
  if (!String(guardado).startsWith('scrypt$')) return igualConstante(contrasena, guardado);
  const [, n, r, p, sal, hash] = String(guardado).split('$');
  if (!n || !r || !p || !sal || !hash) return false;
  try {
    const esperado = Buffer.from(hash, 'base64');
    const h = await scrypt(contrasena, Buffer.from(sal, 'base64'), esperado.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
    return h.length === esperado.length && crypto.timingSafeEqual(h, esperado);
  } catch { return false; }
}

module.exports = { igualConstante, hashear, verificar };
