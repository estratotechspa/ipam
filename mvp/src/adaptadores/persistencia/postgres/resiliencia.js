'use strict';
// Reintentos con retroceso exponencial, solo para errores transitorios (red caída momentánea, reinicio de la base,
// choque de transacciones). Un error de negocio o de sintaxis NUNCA se reintenta.
const CODIGOS_TRANSITORIOS = new Set([
  '40001',
  '40P01', // fallo de serialización / interbloqueo
  '57P01',
  '57P02',
  '57P03', // base apagándose o arrancando
  '53300', // demasiadas conexiones
  '08000',
  '08003',
  '08006',
  '08001',
  '08004', // problemas de conexión
]);
const ERRNO_TRANSITORIOS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

const esTransitorio = (e) =>
  !!e &&
  (CODIGOS_TRANSITORIOS.has(e.code) ||
    ERRNO_TRANSITORIOS.has(e.code) ||
    /Connection terminated|timeout expired|Client has encountered a connection error/i.test(e.message || ''));

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{intentos?: number, baseMs?: number, maxMs?: number, transitorio?: (e: Error) => boolean, alReintentar?: (e: Error, n: number, espera: number) => void}} [o]
 * @returns {Promise<T>}
 */
async function reintentar(fn, { intentos = 3, baseMs = 100, maxMs = 2000, transitorio = esTransitorio, alReintentar } = {}) {
  let ultimo;
  for (let n = 1; n <= intentos; n++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (n === intentos || !transitorio(e)) throw e;
      const espera = Math.min(maxMs, baseMs * 2 ** (n - 1)) * (0.5 + Math.random() / 2); // con algo de azar para no sincronizar réplicas
      if (alReintentar) alReintentar(e, n, espera);
      await dormir(espera);
    }
  }
  throw ultimo;
}

module.exports = { reintentar, esTransitorio, dormir };
