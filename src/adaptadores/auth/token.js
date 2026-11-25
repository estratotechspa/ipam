'use strict';
// Generador de tokens de servicio (puerto GeneradorToken): aleatoriedad criptográfica y hash SHA-256.
const crypto = require('node:crypto');

/** SHA-256 en hexadecimal del token completo. Un token tiene 256 bits de entropía, así que no hace falta un hash «lento». */
const hashear = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** `ipam_` + 43 caracteres base64url (32 bytes aleatorios). */
function generar() {
  const token = `ipam_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: hashear(token) };
}

module.exports = { generar, hashear };
